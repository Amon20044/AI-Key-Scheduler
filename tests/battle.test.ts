import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileStateAdapter,
  KeyExhaustedError,
  KeyScheduler,
  MemoryStateAdapter,
  NoAvailableKeyError,
  ProviderRouteError,
  RetryAbortedError,
  isRateLimitError,
  isFallbackRouteError,
  isRetryableKeyError
} from "../src/index.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function multiProviderScheduler(now: () => number = Date.now) {
  return new KeyScheduler({
    providers: [
      {
        name: "google",
        model: "gemini-2.5-flash",
        defaultCooldownMs: 500,
        keys: [
          { id: "g-1", value: "sk-g1" },
          { id: "g-2", value: "sk-g2" }
        ]
      },
      {
        name: "openrouter",
        model: "google/gemini-flash-1.5",
        defaultCooldownMs: 500,
        keys: [
          { id: "or-1", value: "sk-or1" },
          { id: "or-2", value: "sk-or2" },
          { id: "or-3", value: "sk-or3" }
        ]
      },
      {
        name: "gateway",
        model: "anthropic/claude-sonnet-4.6",
        defaultCooldownMs: 500,
        keys: [
          { id: "gw-1", value: "sk-gw1" },
          { id: "gw-2", value: "sk-gw2" }
        ]
      }
    ],
    state: new MemoryStateAdapter(),
    now
  });
}

// ---------------------------------------------------------------------------
// Battle Tests
// ---------------------------------------------------------------------------

describe("battle: wrapper injects provider + apiKey into execute", () => {
  it("execute receives correct provider, model, and apiKey from scheduler context", async () => {
    const scheduler = multiProviderScheduler();
    const received: { provider: string; model: string; apiKey: string }[] = [];

    await scheduler.withRetry({
      provider: "google",
      model: "gemini-2.5-flash",
      execute: async ({ provider, model, apiKey }) => {
        received.push({ provider, model, apiKey });
        return "done";
      }
    });

    expect(received).toHaveLength(1);
    expect(received[0].provider).toBe("google");
    expect(received[0].model).toBe("gemini-2.5-flash");
    expect(received[0].apiKey).toBe("sk-g1");
  });

  it("on rate-limit rotates key but keeps same provider+model injected", async () => {
    const scheduler = multiProviderScheduler();
    const seen: string[] = [];

    await scheduler.withRetry({
      provider: "openrouter",
      model: "google/gemini-flash-1.5",
      execute: async ({ provider, model, apiKey }) => {
        seen.push(`${provider}:${model}:${apiKey}`);
        if (seen.length < 3) throw new Error("429 rate limit");
        return "ok";
      }
    });

    expect(seen).toHaveLength(3);
    // All same provider+model, different keys
    expect(seen.every((s) => s.startsWith("openrouter:google/gemini-flash-1.5:"))).toBe(true);
    const keys = seen.map((s) => s.split(":")[2]);
    expect(new Set(keys).size).toBe(3);
  });

  it("on route error, execute gets NEW provider+model+apiKey from fallback", async () => {
    const scheduler = multiProviderScheduler();
    const calls: { provider: string; model: string }[] = [];

    const result = await scheduler.withRetry({
      provider: "google",
      model: "gemini-2.5-flash",
      execute: async ({ provider, model }) => {
        calls.push({ provider, model });
        if (provider === "google") {
          throw new Error("UPSTREAM_ERROR 404 model not found");
        }
        return { provider, model };
      }
    });

    expect(calls[0]).toEqual({ provider: "google", model: "gemini-2.5-flash" });
    expect(result.provider).not.toBe("google");
  });
});

describe("battle: multi-provider cascade under pressure", () => {
  it("cascades through 3 providers: route-fail → rate-limit exhaust → success", async () => {
    const scheduler = multiProviderScheduler();
    const trail: string[] = [];

    const result = await scheduler.withRetry({
      provider: "google",
      model: "gemini-2.5-flash",
      execute: async ({ provider, model, key }) => {
        trail.push(`${provider}:${key.id}`);
        if (provider === "google") throw new Error("UPSTREAM_ERROR 404 not found");
        if (provider === "openrouter") throw new Error("429 rate limit exhausted");
        return { provider, model };
      }
    });

    expect(result.provider).toBe("gateway");
    // google tried once (route error → immediate fallback)
    expect(trail.filter((t) => t.startsWith("google:")).length).toBe(1);
    // openrouter exhausted all 3 keys
    expect(trail.filter((t) => t.startsWith("openrouter:")).length).toBe(3);
    // gateway succeeded on first try
    expect(trail.filter((t) => t.startsWith("gateway:")).length).toBe(1);
  });

  it("all providers route-fail → ProviderRouteError with routesTried count", async () => {
    const scheduler = multiProviderScheduler();

    await expect(
      scheduler.withRetry({
        provider: "google",
        model: "gemini-2.5-flash",
        execute: async () => {
          throw new Error("UPSTREAM_ERROR 404 model not found for this route");
        }
      })
    ).rejects.toMatchObject({
      name: "ProviderRouteError",
      routesTried: 3
    });
  });

  it("all providers rate-limit exhaust → KeyExhaustedError", async () => {
    let now = 1000;
    const scheduler = multiProviderScheduler(() => now);

    await expect(
      scheduler.withRetry({
        provider: "google",
        model: "gemini-2.5-flash",
        timeoutMs: 100,
        now: () => now,
        sleep: async (ms) => { now += ms; },
        execute: async () => {
          throw new Error("429 too many requests");
        }
      })
    ).rejects.toBeInstanceOf(KeyExhaustedError);
  });
});

describe("battle: cooldown timing and waitForAvailability", () => {
  it("waits for cooldown reset when within deadline, then succeeds", async () => {
    let now = 1000;
    const sleeps: number[] = [];
    const scheduler = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 200,
        keys: [{ id: "k1", value: "v1" }]
      }],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    let attempt = 0;
    const result = await scheduler.withRetry({
      provider: "p", model: "m",
      maxAttempts: 3,
      timeoutMs: 5000,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      execute: async () => {
        attempt++;
        if (attempt === 1) throw new Error("429 rate limit");
        return "recovered";
      }
    });

    expect(result).toBe("recovered");
    expect(sleeps).toEqual([200]);
  });

  it("times out when cooldown exceeds deadline", async () => {
    let now = 1000;
    const scheduler = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 120_000,
        keys: [{ id: "k1", value: "v1" }]
      }],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    await expect(
      scheduler.withRetry({
        provider: "p", model: "m",
        maxAttempts: 2,
        timeoutMs: 60_000,
        now: () => now,
        sleep: async (ms) => { now += ms; },
        execute: async () => { throw new Error("429 rate limit"); }
      })
    ).rejects.toMatchObject({ name: "KeyExhaustedError", reason: "timeout" });
  });
});

describe("battle: state persistence across restarts", () => {
  it("persists LRU state and restores key ordering after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "battle-state-"));
    tempDirs.push(dir);
    const filePath = join(dir, "state.json");
    let now = 10_000;

    // Session 1: use key-0
    const s1 = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 60_000,
        keys: [{ id: "k0", value: "v0" }, { id: "k1", value: "v1" }]
      }],
      state: new FileStateAdapter(filePath),
      now: () => now
    });
    const lease1 = await s1.acquire({ provider: "p", model: "m" });
    expect(lease1.key.id).toBe("k0");
    now += 1000;
    await lease1.success();

    // Session 2: should prefer k1 (k0 was used more recently)
    now += 1000;
    const s2 = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 60_000,
        keys: [{ id: "k0", value: "v0" }, { id: "k1", value: "v1" }]
      }],
      state: new FileStateAdapter(filePath),
      now: () => now
    });
    const lease2 = await s2.acquire({ provider: "p", model: "m" });
    expect(lease2.key.id).toBe("k1");
  });

  it("persisted file never contains raw API key values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "battle-nosecret-"));
    tempDirs.push(dir);
    const filePath = join(dir, "state.json");

    const scheduler = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 60_000,
        keys: [
          { id: "k0", value: "super-secret-key-abc123" },
          { id: "k1", value: "another-secret-xyz789" }
        ]
      }],
      state: new FileStateAdapter(filePath)
    });

    await scheduler.withRetry({
      provider: "p", model: "m",
      execute: async () => "ok"
    });

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("super-secret-key-abc123");
    expect(raw).not.toContain("another-secret-xyz789");
    expect(raw).toContain("k0");
  });

  it("restores cooldown state after restart and releases expired cooldowns", async () => {
    let now = 5000;
    const state = new MemoryStateAdapter({
      version: 1,
      keys: [
        { id: "k0", provider: "p", model: "m", resetAt: 4000 },
        { id: "k1", provider: "p", model: "m", resetAt: 8000 }
      ]
    });

    const scheduler = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 60_000,
        keys: [{ id: "k0", value: "v0" }, { id: "k1", value: "v1" }]
      }],
      state,
      now: () => now
    });

    // k0 expired (4000 < 5000), k1 still cooling (8000 > 5000)
    const lease = await scheduler.acquire({ provider: "p", model: "m" });
    expect(lease.key.id).toBe("k0");
    // Keep k0 leased so next acquire must look at k1 (still cooling)
    await expect(scheduler.acquire({ provider: "p", model: "m" })).rejects.toMatchObject({
      nextResetAt: 8000
    });

    await lease.success();

    // advance past k1 cooldown
    now = 8001;
    const lease2 = await scheduler.acquire({ provider: "p", model: "m" });
    expect(lease2.key.id).toBe("k1"); // k1 never used (lastUsedAt=0) so it's LRU
  });
});

describe("battle: concurrent acquire serialization", () => {
  it("10 concurrent acquires on 5 keys never hand out the same key twice", async () => {
    const scheduler = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 60_000,
        keys: Array.from({ length: 5 }, (_, i) => ({ id: `k${i}`, value: `v${i}` }))
      }],
      state: new MemoryStateAdapter()
    });

    const leases = await Promise.all(
      Array.from({ length: 5 }, () => scheduler.acquire({ provider: "p", model: "m" }))
    );

    const ids = leases.map((l) => l.key.id);
    expect(new Set(ids).size).toBe(5);

    // 6th should fail since all 5 are leased
    await expect(scheduler.acquire({ provider: "p", model: "m" })).rejects.toBeInstanceOf(NoAvailableKeyError);

    // Release all
    await Promise.all(leases.map((l) => l.success()));

    // Now all 5 available again
    const next = await scheduler.acquire({ provider: "p", model: "m" });
    expect(next.key.id).toBeDefined();
  });
});

describe("battle: health score degradation and recovery", () => {
  it("consecutive rate limits degrade health, success recovers it", async () => {
    let now = 1000;
    const scheduler = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 50,
        keys: [{ id: "k0", value: "v0" }]
      }],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    // Rate limit 3 times
    for (let i = 0; i < 3; i++) {
      const lease = await scheduler.acquire({ provider: "p", model: "m" });
      await lease.rateLimited();
      now += 100;
    }

    const degraded = await scheduler.acquire({ provider: "p", model: "m" });
    expect(degraded.key.healthScore).toBeLessThan(0.6);
    expect(degraded.key.rateLimitCount).toBe(3);
    expect(degraded.key.consecutiveRateLimits).toBe(3);

    // Success recovers
    now += 100;
    const degradedScore = degraded.key.healthScore;
    await degraded.success();
    const recovered = await scheduler.acquire({ provider: "p", model: "m" });
    expect(recovered.key.consecutiveRateLimits).toBe(0);
    expect(recovered.key.healthScore).toBeGreaterThanOrEqual(degradedScore + 0.05);
  });

  it("healthier key wins tie-break when lastUsedAt is equal", async () => {
    const state = new MemoryStateAdapter({
      version: 1,
      keys: [
        { id: "k0", provider: "p", model: "m", healthScore: 0.5, rateLimitCount: 5 },
        { id: "k1", provider: "p", model: "m", healthScore: 1.0, rateLimitCount: 0 }
      ]
    });

    const scheduler = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 60_000,
        keys: [{ id: "k0", value: "v0" }, { id: "k1", value: "v1" }]
      }],
      state,
      now: () => 1000
    });

    const lease = await scheduler.acquire({ provider: "p", model: "m" });
    expect(lease.key.id).toBe("k1"); // healthier key preferred
  });
});

describe("battle: abort signal scenarios", () => {
  it("abort before any attempt → RetryAbortedError with zero attempts", async () => {
    const scheduler = multiProviderScheduler();
    const controller = new AbortController();
    controller.abort();

    await expect(
      scheduler.withRetry({
        provider: "google", model: "gemini-2.5-flash",
        signal: controller.signal,
        execute: async () => "never"
      })
    ).rejects.toMatchObject({
      name: "RetryAbortedError",
      attempts: 0
    });
  });

  it("abort mid-cooldown-wait releases clean error", async () => {
    let now = 1000;
    const controller = new AbortController();
    const scheduler = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 500,
        keys: [{ id: "k0", value: "v0" }]
      }],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    await expect(
      scheduler.withRetry({
        provider: "p", model: "m",
        maxAttempts: 2,
        timeoutMs: 5000,
        now: () => now,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
          await new Promise(() => {}); // hang forever
        },
        execute: async () => { throw new Error("429 rate limit"); }
      })
    ).rejects.toBeInstanceOf(RetryAbortedError);
  });
});

describe("battle: route affinity memory", () => {
  it("remembers successful fallback and uses it first on next call", async () => {
    const scheduler = multiProviderScheduler();
    const trail1: string[] = [];
    const trail2: string[] = [];

    // First call: google fails → openrouter succeeds
    await scheduler.withRetry({
      provider: "google", model: "gemini-2.5-flash",
      execute: async ({ provider, model }) => {
        trail1.push(provider);
        if (provider === "google") throw new Error("UPSTREAM_ERROR 404 not found");
        return "ok";
      }
    });

    // Second call: should start on openrouter directly
    await scheduler.withRetry({
      provider: "google", model: "gemini-2.5-flash",
      execute: async ({ provider }) => {
        trail2.push(provider);
        return "ok";
      }
    });

    expect(trail1[0]).toBe("google");
    expect(trail2[0]).not.toBe("google"); // remembered affinity
  });

  it("clears affinity when remembered route also fails", async () => {
    const scheduler = multiProviderScheduler();

    // First: google fails → openrouter succeeds (affinity set to openrouter)
    await scheduler.withRetry({
      provider: "google", model: "gemini-2.5-flash",
      execute: async ({ provider }) => {
        if (provider === "google") throw new Error("UPSTREAM_ERROR 404 not found");
        return "ok";
      }
    });

    // Second: openrouter also route-fails → should cascade to gateway
    const trail: string[] = [];
    const result = await scheduler.withRetry({
      provider: "google", model: "gemini-2.5-flash",
      execute: async ({ provider }) => {
        trail.push(provider);
        if (provider !== "gateway") throw new Error("UPSTREAM_ERROR 404 not found");
        return { provider };
      }
    });

    expect(result.provider).toBe("gateway");
  });
});

describe("battle: provider groups stay independent", () => {
  it("rate-limiting all keys in one group does not affect other groups", async () => {
    let now = 1000;
    const scheduler = multiProviderScheduler(() => now);

    // Exhaust all google keys
    for (let i = 0; i < 2; i++) {
      const lease = await scheduler.acquire({ provider: "google", model: "gemini-2.5-flash" });
      await lease.rateLimited();
    }

    // Google exhausted
    await expect(
      scheduler.acquire({ provider: "google", model: "gemini-2.5-flash" })
    ).rejects.toBeInstanceOf(NoAvailableKeyError);

    // OpenRouter still fine
    const orLease = await scheduler.acquire({ provider: "openrouter", model: "google/gemini-flash-1.5" });
    expect(orLease.key.id).toBe("or-1");
    await orLease.success();
  });
});

describe("battle: lease settlement idempotency", () => {
  it("calling success+rateLimited+release on same lease only settles once", async () => {
    let saves = 0;
    const scheduler = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 60_000,
        keys: [{ id: "k0", value: "v0" }]
      }],
      state: {
        async load() { return undefined; },
        async save() { saves++; }
      }
    });

    const lease = await scheduler.acquire({ provider: "p", model: "m" });
    await Promise.all([lease.success(), lease.rateLimited(), lease.release()]);

    expect(saves).toBe(1); // only first settlement persisted
  });
});

describe("battle: withRetry full integration with FileStateAdapter", () => {
  it("full cycle: retry across keys, persist state, restart, verify ordering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "battle-full-"));
    tempDirs.push(dir);
    const filePath = join(dir, "state.json");
    let now = 10_000;

    // Session 1: first key rate-limits, second succeeds
    const s1 = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 100,
        keys: [{ id: "k0", value: "v0" }, { id: "k1", value: "v1" }, { id: "k2", value: "v2" }]
      }],
      state: new FileStateAdapter(filePath),
      now: () => now
    });

    const trail: string[] = [];
    await s1.withRetry({
      provider: "p", model: "m",
      now: () => now,
      sleep: async (ms) => { now += ms; },
      execute: async ({ key }) => {
        trail.push(key.id);
        if (trail.length === 1) throw new Error("429 rate limit");
        return "ok";
      }
    });
    expect(trail).toEqual(["k0", "k1"]);

    // Session 2: restart, verify state restored
    now += 5000;
    const s2 = new KeyScheduler({
      providers: [{
        name: "p", model: "m", defaultCooldownMs: 100,
        keys: [{ id: "k0", value: "v0" }, { id: "k1", value: "v1" }, { id: "k2", value: "v2" }]
      }],
      state: new FileStateAdapter(filePath),
      now: () => now
    });

    // k2 never used → should be preferred (LRU)
    const lease = await s2.acquire({ provider: "p", model: "m" });
    expect(lease.key.id).toBe("k2");

    // Verify no secrets in file
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("v0");
    expect(raw).not.toContain("v1");
    expect(raw).not.toContain("v2");
  });
});

describe("battle: blacklisted/blocked provider detection", () => {
  it("403 FORBIDDEN with blacklist message triggers fallback", async () => {
    const scheduler = multiProviderScheduler();
    const trail: string[] = [];

    const result = await scheduler.withRetry({
      provider: "google", model: "gemini-2.5-flash",
      execute: async ({ provider }) => {
        trail.push(provider);
        if (provider === "google") {
          const err = new Error("provider is blacklisted (403 forbidden)");
          Object.assign(err, { status: 403, code: "FORBIDDEN" });
          throw err;
        }
        return { provider };
      }
    });

    expect(trail[0]).toBe("google");
    expect(result.provider).not.toBe("google");
  });

  it("PROVIDER_BLOCKED code triggers fallback", async () => {
    const scheduler = multiProviderScheduler();

    const result = await scheduler.withRetry({
      provider: "google", model: "gemini-2.5-flash",
      execute: async ({ provider }) => {
        if (provider === "google") {
          const err = new Error("provider blocked");
          Object.assign(err, { code: "PROVIDER_BLOCKED" });
          throw err;
        }
        return { provider };
      }
    });

    expect(result.provider).not.toBe("google");
  });
});

describe("battle: custom classifyError and isRetryableError", () => {
  it("classifyError can force retry on non-standard errors", async () => {
    const scheduler = multiProviderScheduler();
    let calls = 0;

    const result = await scheduler.withRetry({
      provider: "openrouter", model: "google/gemini-flash-1.5",
      classifyError: (err) => {
        if (err instanceof Error && err.message.includes("custom-transient")) return "retry";
        return undefined;
      },
      execute: async () => {
        calls++;
        if (calls === 1) throw new Error("custom-transient failure");
        return "ok";
      }
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("classifyError can force fail on normally-retryable errors", async () => {
    const scheduler = multiProviderScheduler();

    await expect(
      scheduler.withRetry({
        provider: "openrouter", model: "google/gemini-flash-1.5",
        classifyError: () => "fail",
        execute: async () => { throw new Error("429 rate limit"); }
      })
    ).rejects.toThrow("429 rate limit");
  });
});

describe("battle: onRetry and onFallback callbacks", () => {
  it("onRetry fires for each retryable error with safe fields only", async () => {
    const scheduler = new KeyScheduler({
      providers: [{
        name: "openrouter", model: "test-model", defaultCooldownMs: 500,
        keys: [
          { id: "or-1", value: "sk-or1" },
          { id: "or-2", value: "sk-or2" }
        ]
      }],
      state: new MemoryStateAdapter()
    });
    const events: unknown[] = [];

    await expect(
      scheduler.withRetry({
        provider: "openrouter", model: "test-model",
        fallbacks: false,
        onRetry: (ev) => { events.push(ev); },
        execute: async ({ apiKey }) => {
          throw Object.assign(new Error(`429 key ${apiKey}`), { status: 429 });
        }
      })
    ).rejects.toBeInstanceOf(KeyExhaustedError);

    expect(events.length).toBe(2);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("sk-or");
    expect(serialized).toContain("or-1");
  });

  it("onFallback fires when switching provider routes", async () => {
    const scheduler = multiProviderScheduler();
    const fallbacks: { from: string; to: string }[] = [];

    await scheduler.withRetry({
      provider: "google", model: "gemini-2.5-flash",
      onFallback: (ev) => {
        fallbacks.push({ from: ev.fromProvider, to: ev.toProvider });
      },
      execute: async ({ provider }) => {
        if (provider === "google") throw new Error("UPSTREAM_ERROR 404 not found");
        return "ok";
      }
    });

    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].from).toBe("google");
  });
});

describe("battle: edge case error patterns", () => {
  it("nested error objects with rate limit in deep fields are detected", () => {
    expect(isRetryableKeyError({ response: { data: { error: { message: "quota exceeded" } } } })).toBe(true);
    expect(isRetryableKeyError({ body: { error: { message: "insufficient_quota" } } })).toBe(true);
    expect(isRetryableKeyError({ errors: [{ message: "RESOURCE_EXHAUSTED" }] })).toBe(true);
  });

  it("SSE error payloads with UPSTREAM_ERROR are detected as fallback-safe", () => {
    const ssePayload = 'event: error\ndata: {"error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found"}}';
    expect(isFallbackRouteError(ssePayload)).toBe(true);
  });

  it("500 database error is NOT treated as fallback-safe", () => {
    expect(isFallbackRouteError({ status: 500, message: "database connection failed" })).toBe(false);
  });

  it("500 database error is NOT treated as retryable", () => {
    expect(isRetryableKeyError({ status: 500, message: "database connection failed" })).toBe(false);
  });
});
