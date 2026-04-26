import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractRetryAfter,
  FileStateAdapter,
  isRetryableKeyError,
  KeyExhaustedError,
  KeyScheduler,
  MemoryStateAdapter,
  withKeyRetry
} from "../src/index.js";

function schedulerWithThreeKeys(now: () => number = Date.now): KeyScheduler {
  return new KeyScheduler({
    providers: [
      {
        name: "openrouter",
        model: "test-model",
        defaultCooldownMs: 60_000,
        keys: [
          { id: "openrouter-a", value: "sk-env-a" },
          { id: "openrouter-b", value: "sk-env-b" },
          { id: "openrouter-c", value: "sk-env-c" }
        ]
      }
    ],
    state: new MemoryStateAdapter(),
    now
  });
}

describe("withKeyRetry", () => {
  it("wraps any AI function and retries across keys for retryable 429 messages", async () => {
    const scheduler = schedulerWithThreeKeys();
    const seenKeys: string[] = [];

    const result = await withKeyRetry(scheduler, {
      provider: "openrouter",
      model: "test-model",
      execute: async ({ key, apiKey }) => {
        seenKeys.push(`${key.id}:${apiKey}`);
        if (seenKeys.length < 3) {
          throw new Error("AI provider failed with 429 rate limit");
        }
        return "ok";
      }
    });

    expect(result).toBe("ok");
    expect(seenKeys).toEqual(["openrouter-a:sk-env-a", "openrouter-b:sk-env-b", "openrouter-c:sk-env-c"]);
  });

  it("can be called as scheduler.withRetry", async () => {
    const scheduler = schedulerWithThreeKeys();

    const result = await scheduler.withRetry({
      provider: "openrouter",
      model: "test-model",
      execute: async ({ key }) => key.id
    });

    expect(result).toBe("openrouter-a");
  });

  it("detects exhausted/quota/rate-limit messages as retryable", () => {
    expect(isRetryableKeyError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryableKeyError(new Error("RESOURCE_EXHAUSTED: quota exceeded"))).toBe(true);
    expect(isRetryableKeyError({ code: "rate_limit_exceeded" })).toBe(true);
    expect(isRetryableKeyError({ status: 500, message: "database failed" })).toBe(false);
  });

  it("uses Retry-After headers to override provider cooldown", async () => {
    let now = 1_000;
    const scheduler = schedulerWithThreeKeys(() => now);

    await expect(
      scheduler.withRetry({
        provider: "openrouter",
        model: "test-model",
        maxAttempts: 1,
        execute: async () => {
          throw {
            status: 429,
            response: {
              headers: {
                "retry-after": "2"
              }
            }
          };
        }
      })
    ).rejects.toBeInstanceOf(KeyExhaustedError);

    const next = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(next.key.id).toBe("openrouter-b");
    await next.release();

    now = 3_000;
    const released = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(released.key.id).toBe("openrouter-a");
  });

  it("stops after the total number of keys and throws a safe exhausted error", async () => {
    const scheduler = schedulerWithThreeKeys();
    const execute = vi.fn(async ({ apiKey }: { apiKey: string }) => {
      throw new Error(`429 exhausted key ${apiKey}`);
    });

    await expect(
      scheduler.withRetry({
        provider: "openrouter",
        model: "test-model",
        execute
      })
    ).rejects.toMatchObject({
      name: "KeyExhaustedError",
      provider: "openrouter",
      model: "test-model"
    });

    await expect(
      scheduler.withRetry({
        provider: "openrouter",
        model: "test-model",
        execute
      })
    ).rejects.not.toThrow("sk-env");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("releases the key and does not retry non-rate-limit failures", async () => {
    const scheduler = schedulerWithThreeKeys();
    const execute = vi.fn(async () => {
      throw new Error("validation failed");
    });

    await expect(
      scheduler.withRetry({
        provider: "openrouter",
        model: "test-model",
        execute
      })
    ).rejects.toThrow("validation failed");

    expect(execute).toHaveBeenCalledTimes(1);
    const lease = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(lease.key.id).toBe("openrouter-a");
  });

  it("extracts retry-after values from common SDK error shapes", () => {
    expect(extractRetryAfter({ retryAfter: "3" })).toBe("3");
    expect(extractRetryAfter({ headers: new Headers({ "retry-after": "4" }) })).toBe("4");
    expect(extractRetryAfter({ responseHeaders: { "Retry-After": "5" } })).toBe("5");
  });

  it("works with file state without persisting raw env keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-key-manager-wrapper-"));
    const state = new FileStateAdapter(join(dir, "state.json"));
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openrouter",
          model: "test-model",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-env-a" }]
        }
      ],
      state
    });

    await scheduler.withRetry({
      provider: "openrouter",
      model: "test-model",
      execute: async () => "ok"
    });

    await rm(dir, { recursive: true, force: true });
  });
});
