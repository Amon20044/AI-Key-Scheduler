import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileStateAdapter,
  KeyIdentityMismatchError,
  KeyScheduler,
  MemoryStateAdapter,
  NoAvailableKeyError,
  ProviderNotFoundError,
  RateLimitError,
  isRateLimitError,
  parseRetryAfter
} from "../src/index.js";
import type { PersistedSchedulerState, ProviderConfig, StateAdapter } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: "openrouter",
    model: "test-model",
    defaultCooldownMs: 60_000,
    keys: [
      { id: "key-0", value: "secret-0" },
      { id: "key-1", value: "secret-1" }
    ],
    ...overrides
  };
}

describe("KeyScheduler", () => {
  it("acquires the least recently used available key", async () => {
    let now = 1_000;
    const scheduler = new KeyScheduler({
      providers: [provider()],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    const first = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(first.key.id).toBe("key-0");

    now = 2_000;
    await first.success();

    const second = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(second.key.id).toBe("key-1");
  });

  it("releases keys from cooldown before acquire", async () => {
    let now = 1_000;
    const scheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "secret-0" }], defaultCooldownMs: 500 })],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    const lease = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    await lease.rateLimited();

    await expect(scheduler.acquire({ provider: "openrouter", model: "test-model" })).rejects.toMatchObject({
      nextResetAt: 1_500
    });

    now = 1_500;
    const next = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(next.key.id).toBe("key-0");
  });

  it("uses Retry-After over the provider default cooldown", async () => {
    let now = 1_000;
    const scheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "secret-0" }], defaultCooldownMs: 60_000 })],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    const lease = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    await lease.rateLimited({ retryAfter: "2" });

    await expect(scheduler.acquire({ provider: "openrouter", model: "test-model" })).rejects.toMatchObject({
      nextResetAt: 3_000
    });
  });

  it("persists non-secret key state to a file and restores it", async () => {
    let now = 10_000;
    const dir = await mkdtemp(join(tmpdir(), "key-scheduler-"));
    tempDirs.push(dir);
    const filePath = join(dir, "state.json");
    const state = new FileStateAdapter(filePath);

    const firstScheduler = new KeyScheduler({
      providers: [provider()],
      state,
      now: () => now
    });

    const first = await firstScheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(first.key.id).toBe("key-0");
    await first.success();

    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("key-0");
    expect(raw).not.toContain("secret-0");
    expect(raw).not.toContain("secret-1");

    now = 20_000;
    const secondScheduler = new KeyScheduler({
      providers: [provider()],
      state: new FileStateAdapter(filePath),
      now: () => now
    });

    const restored = await secondScheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(restored.key.id).toBe("key-1");
  });

  it("persists an HMAC key fingerprint without persisting the raw key", async () => {
    let now = 10_000;
    const dir = await mkdtemp(join(tmpdir(), "key-scheduler-identity-"));
    tempDirs.push(dir);
    const filePath = join(dir, "state.json");

    const scheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "secret-0" }] })],
      state: new FileStateAdapter(filePath),
      keyIdentity: { hmacSecret: "local-hmac-secret" },
      now: () => now
    });

    const lease = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    now = 11_000;
    await lease.success();

    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("keyFingerprint");
    expect(raw).not.toContain("secret-0");
    expect(raw).not.toContain("local-hmac-secret");
  });

  it("resets persisted cooldown and health when HMAC identity detects a swapped key", async () => {
    let now = 1_000;
    const state = new MemoryStateAdapter();

    const firstScheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "old-secret" }] })],
      state,
      keyIdentity: { hmacSecret: "local-hmac-secret" },
      now: () => now
    });

    const lease = await firstScheduler.acquire({ provider: "openrouter", model: "test-model" });
    await lease.rateLimited({ cooldownMs: 60_000 });

    const secondScheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "new-secret" }] })],
      state,
      keyIdentity: { hmacSecret: "local-hmac-secret" },
      now: () => now
    });

    const resetLease = await secondScheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(resetLease.key.id).toBe("key-0");
    expect(resetLease.key.exhausted).toBe(false);
    expect(resetLease.key.healthScore).toBe(1);
  });

  it("throws a safe error for HMAC identity mismatch when configured to throw", async () => {
    let now = 1_000;
    const state = new MemoryStateAdapter();

    const firstScheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "old-secret" }] })],
      state,
      keyIdentity: { hmacSecret: "local-hmac-secret" },
      now: () => now
    });

    const lease = await firstScheduler.acquire({ provider: "openrouter", model: "test-model" });
    await lease.rateLimited({ cooldownMs: 60_000 });

    const secondScheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "new-secret" }] })],
      state,
      keyIdentity: { hmacSecret: "local-hmac-secret", onMismatch: "throw" },
      now: () => now
    });

    await expect(secondScheduler.acquire({ provider: "openrouter", model: "test-model" })).rejects.toMatchObject({
      name: "KeyIdentityMismatchError",
      keyId: "key-0",
      provider: "openrouter",
      model: "test-model"
    });
    await expect(secondScheduler.acquire({ provider: "openrouter", model: "test-model" })).rejects.not.toThrow("old-secret");
    await expect(secondScheduler.acquire({ provider: "openrouter", model: "test-model" })).rejects.not.toThrow("new-secret");
  });

  it("restores expired persisted cooldowns as available", async () => {
    const state = new MemoryStateAdapter({
      version: 1,
      keys: [
        {
          id: "key-0",
          provider: "openrouter",
          model: "test-model",
          resetAt: 1_000
        }
      ]
    });

    const scheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "secret-0" }] })],
      state,
      now: () => 2_000
    });

    const lease = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(lease.key.id).toBe("key-0");
  });

  it("keeps future persisted cooldowns unavailable until reset", async () => {
    let now = 2_000;
    const state = new MemoryStateAdapter({
      version: 1,
      keys: [
        {
          id: "key-0",
          provider: "openrouter",
          model: "test-model",
          resetAt: 3_000
        }
      ]
    });

    const scheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "secret-0" }] })],
      state,
      now: () => now
    });

    await expect(scheduler.acquire({ provider: "openrouter", model: "test-model" })).rejects.toMatchObject({
      nextResetAt: 3_000
    });

    now = 3_000;
    const lease = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(lease.key.id).toBe("key-0");
  });

  it("keeps provider/model groups independent", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        provider({ name: "openrouter", model: "model-a", keys: [{ id: "shared-id", value: "a" }] }),
        provider({ name: "google", model: "model-b", keys: [{ id: "shared-id", value: "b" }] })
      ],
      state: new MemoryStateAdapter()
    });

    const openrouter = await scheduler.acquire({ provider: "openrouter", model: "model-a" });
    const google = await scheduler.acquire({ provider: "google", model: "model-b" });

    expect(openrouter.provider).toBe("openrouter");
    expect(openrouter.key.secret.value()).toBe("a");
    expect(google.provider).toBe("google");
    expect(google.key.secret.value()).toBe("b");
  });

  it("tracks health and uses health score as a tie-breaker for equally unused keys", async () => {
    let now = 1_000;
    const scheduler = new KeyScheduler({
      providers: [provider({ defaultCooldownMs: 100 })],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    const unhealthy = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    await unhealthy.rateLimited();
    expect(unhealthy.key.healthScore).toBeLessThan(1);
    expect(unhealthy.key.rateLimitCount).toBe(1);

    now = 1_100;
    const next = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(next.key.id).toBe("key-1");
    await next.success();
    expect(next.key.successCount).toBe(1);
    expect(next.key.consecutiveRateLimits).toBe(0);
  });

  it("serializes concurrent acquires inside one process", async () => {
    const scheduler = new KeyScheduler({
      providers: [provider()],
      state: new MemoryStateAdapter()
    });

    const leases = await Promise.all([
      scheduler.acquire({ provider: "openrouter", model: "test-model" }),
      scheduler.acquire({ provider: "openrouter", model: "test-model" })
    ]);

    expect(new Set(leases.map((lease) => lease.key.id))).toEqual(new Set(["key-0", "key-1"]));
  });

  it("reports the soonest reset time when every key is cooling down", async () => {
    let now = 1_000;
    const scheduler = new KeyScheduler({
      providers: [provider({ defaultCooldownMs: 1_000 })],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    const first = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    await first.rateLimited({ cooldownMs: 5_000 });
    const second = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    await second.rateLimited({ cooldownMs: 2_000 });

    try {
      await scheduler.acquire({ provider: "openrouter", model: "test-model" });
      throw new Error("Expected acquire to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(NoAvailableKeyError);
      expect((error as NoAvailableKeyError).nextResetAt).toBe(3_000);
    }
  });

  it("throws a clear configuration error when no group exists", async () => {
    const scheduler = new KeyScheduler({ providers: [provider()] });

    await expect(scheduler.acquire({ provider: "missing", model: "test-model" })).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it("rejects duplicate provider/model groups", () => {
    expect(
      () =>
        new KeyScheduler({
          providers: [provider(), provider()]
        })
    ).toThrow('Duplicate provider/model group "openrouter" / "test-model".');
  });

  it("rejects duplicate key IDs inside a group", () => {
    expect(
      () =>
        new KeyScheduler({
          providers: [provider({ keys: [{ id: "same", value: "a" }, { id: "same", value: "b" }] })]
        })
    ).toThrow('Duplicate key id "same" in "openrouter" / "test-model".');
  });

  it("does not settle the same lease twice under concurrent calls", async () => {
    let saves = 0;
    const state: StateAdapter = {
      async load() {
        return undefined;
      },
      async save(_state: PersistedSchedulerState) {
        saves += 1;
      }
    };

    const scheduler = new KeyScheduler({
      providers: [provider({ keys: [{ id: "key-0", value: "secret-0" }] })],
      state
    });

    const lease = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    await Promise.all([lease.success(), lease.rateLimited(), lease.release()]);

    expect(saves).toBe(1);
    const next = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(next.key.id).toBe("key-0");
  });
});

describe("helpers", () => {
  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("3", 1_000)).toBe(3_000);
    expect(parseRetryAfter(new Date(4_000), 1_000)).toBe(3_000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:04 GMT", 1_000)).toBe(3_000);
  });

  it("identifies rate limit errors", () => {
    expect(isRateLimitError(new RateLimitError())).toBe(true);
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ code: "rate_limit_exceeded" })).toBe(true);
    expect(isRateLimitError({ status: 500 })).toBe(false);
  });
});
