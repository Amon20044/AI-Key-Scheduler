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
  ProviderRouteError,
  RetryAbortedError,
  isFallbackRouteError,
  withStreamKeyRetry,
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
  it("falls back to another configured provider/model for upstream model route errors", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-3.0-flash",
          defaultCooldownMs: 60_000,
          keys: [{ id: "google-a", value: "sk-google-a" }]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-openrouter-a" }]
        }
      ],
      state: new MemoryStateAdapter()
    });
    const events: unknown[] = [];

    const result = await scheduler.withRetry({
      provider: "google",
      model: "gemini-3.0-flash",
      onFallback: (event) => {
        events.push(event);
      },
      execute: async ({ provider, model, apiKey }) => {
        if (provider === "google") {
          throw new Error(
            'event: error\ndata: {"success":false,"message":"Stream failed","error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent., Status: NOT_FOUND"}}'
          );
        }

        return { provider, model, apiKey };
      }
    });

    expect(result).toEqual({
      provider: "openrouter",
      model: "google/gemini-flash-1.5",
      apiKey: "sk-openrouter-a"
    });
    expect(JSON.stringify(events)).not.toContain("gemini-3.0-flash is not found");
    expect(events).toMatchObject([
      {
        fromProvider: "google",
        fromModel: "gemini-3.0-flash",
        toProvider: "openrouter",
        toModel: "google/gemini-flash-1.5"
      }
    ]);
  });

  it("remembers the last successful fallback route and prefers it on the next call", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-3.0-flash",
          defaultCooldownMs: 60_000,
          keys: [{ id: "google-a", value: "sk-google-a" }]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-openrouter-a" }]
        }
      ],
      state: new MemoryStateAdapter()
    });

    const firstCallRoutes: string[] = [];
    await scheduler.withRetry({
      provider: "google",
      model: "gemini-3.0-flash",
      execute: async ({ provider, model }) => {
        firstCallRoutes.push(`${provider}/${model}`);
        if (provider === "google") {
          throw new Error(
            'event: error\\ndata: {"error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent., Status: NOT_FOUND"}}'
          );
        }

        return `${provider}/${model}`;
      }
    });

    expect(firstCallRoutes).toEqual(["google/gemini-3.0-flash", "openrouter/google/gemini-flash-1.5"]);

    const secondCallRoutes: string[] = [];
    const second = await scheduler.withRetry({
      provider: "google",
      model: "gemini-3.0-flash",
      execute: async ({ provider, model }) => {
        secondCallRoutes.push(`${provider}/${model}`);
        if (provider === "google") {
          throw new Error("UPSTREAM_ERROR 404 model is not found");
        }

        return `${provider}/${model}`;
      }
    });

    expect(second).toBe("openrouter/google/gemini-flash-1.5");
    expect(secondCallRoutes).toEqual(["openrouter/google/gemini-flash-1.5"]);
  });

  it("moves to another provider/model when all keys in the first route are exhausted", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-2.5-flash",
          defaultCooldownMs: 60_000,
          keys: [{ id: "google-a", value: "sk-google-a" }]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-openrouter-a" }]
        }
      ],
      state: new MemoryStateAdapter()
    });

    const calls: string[] = [];
    const result = await scheduler.withRetry({
      provider: "google",
      model: "gemini-2.5-flash",
      execute: async ({ provider, model }) => {
        calls.push(`${provider}:${model}`);
        if (provider === "google") {
          throw new Error("429 rate limit exhausted for this key");
        }

        return { provider, model };
      }
    });

    expect(result).toEqual({
      provider: "openrouter",
      model: "google/gemini-flash-1.5"
    });
    expect(calls).toEqual(["google:gemini-2.5-flash", "openrouter:google/gemini-flash-1.5"]);
  });

  it("falls back when the selected provider route is blacklisted", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-2.5-flash",
          defaultCooldownMs: 60_000,
          keys: [{ id: "google-a", value: "sk-google-a" }]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-openrouter-a" }]
        }
      ],
      state: new MemoryStateAdapter()
    });

    const result = await scheduler.withRetry({
      provider: "google",
      model: "gemini-2.5-flash",
      execute: async ({ provider, model }) => {
        if (provider === "google") {
          const error = new Error("provider is blacklisted for this model (403 forbidden)");
          Object.assign(error, { status: 403, code: "FORBIDDEN" });
          throw error;
        }

        return { provider, model };
      }
    });

    expect(result).toEqual({
      provider: "openrouter",
      model: "google/gemini-flash-1.5"
    });
  });

  it("uses next provider immediately for the exact stream UPSTREAM_ERROR payload", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-3.0-flash",
          defaultCooldownMs: 60_000,
          keys: [{ id: "google-a", value: "sk-google-a" }]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-openrouter-a" }]
        }
      ],
      state: new MemoryStateAdapter()
    });

    const calls: string[] = [];
    const result = await scheduler.withStreamRetry({
      provider: "google",
      model: "gemini-3.0-flash",
      execute: async ({ provider, model }) => {
        calls.push(`${provider}:${model}`);
        if (provider === "google") {
          throw new Error(
            'event: error\\ndata: {"success":false,"message":"Stream failed","data":null,"error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods., Status: NOT_FOUND, Details: []"}}'
          );
        }

        return { provider, model };
      }
    });

    expect(result).toEqual({
      provider: "openrouter",
      model: "google/gemini-flash-1.5"
    });
    expect(calls).toEqual(["google:gemini-3.0-flash", "openrouter:google/gemini-flash-1.5"]);
  });

  it("with 2 google keys and 5 openrouter keys, route error on first google key jumps directly to openrouter", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-3.0-flash",
          defaultCooldownMs: 60_000,
          keys: [
            { id: "google-a", value: "sk-google-a" },
            { id: "google-b", value: "sk-google-b" }
          ]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [
            { id: "openrouter-a", value: "sk-openrouter-a" },
            { id: "openrouter-b", value: "sk-openrouter-b" },
            { id: "openrouter-c", value: "sk-openrouter-c" },
            { id: "openrouter-d", value: "sk-openrouter-d" },
            { id: "openrouter-e", value: "sk-openrouter-e" }
          ]
        }
      ],
      state: new MemoryStateAdapter()
    });

    const attempts: string[] = [];
    const result = await scheduler.withStreamRetry({
      provider: "google",
      model: "gemini-3.0-flash",
      execute: async ({ provider, key }) => {
        attempts.push(`${provider}:${key.id}`);
        if (provider === "google") {
          throw new Error(
            'event: error\\ndata: {"success":false,"message":"Stream failed","data":null,"error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods., Status: NOT_FOUND, Details: []"}}'
          );
        }

        return { provider, keyId: key.id };
      }
    });

    expect(result).toEqual({ provider: "openrouter", keyId: "openrouter-a" });
    expect(attempts).toEqual(["google:google-a", "openrouter:openrouter-a"]);
  });

  it("updates route memory as soon as fallback is chosen, then starts next request on that provider", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-3.0-flash",
          defaultCooldownMs: 60_000,
          keys: [
            { id: "google-a", value: "sk-google-a" },
            { id: "google-b", value: "sk-google-b" }
          ]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [
            { id: "openrouter-a", value: "sk-openrouter-a" },
            { id: "openrouter-b", value: "sk-openrouter-b" },
            { id: "openrouter-c", value: "sk-openrouter-c" },
            { id: "openrouter-d", value: "sk-openrouter-d" },
            { id: "openrouter-e", value: "sk-openrouter-e" }
          ]
        }
      ],
      state: new MemoryStateAdapter()
    });

    await expect(
      scheduler.withRetry({
        provider: "google",
        model: "gemini-3.0-flash",
        execute: async ({ provider }) => {
          if (provider === "google") {
            throw new Error(
              'event: error\\ndata: {"success":false,"message":"Stream failed","data":null,"error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods., Status: NOT_FOUND, Details: []"}}'
            );
          }

          throw new Error("openrouter temporary failure");
        }
      })
    ).rejects.toThrow("openrouter temporary failure");

    const nextRequestRoutes: string[] = [];
    const second = await scheduler.withRetry({
      provider: "google",
      model: "gemini-3.0-flash",
      execute: async ({ provider, model }) => {
        nextRequestRoutes.push(`${provider}:${model}`);
        return "ok";
      }
    });

    expect(second).toBe("ok");
    expect(nextRequestRoutes).toEqual(["openrouter:google/gemini-flash-1.5"]);
  });

  it("progresses across three providers: route error, then exhausted keys, then success", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-3.0-flash",
          defaultCooldownMs: 60_000,
          keys: [{ id: "google-a", value: "sk-google-a" }]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-openrouter-a" }]
        },
        {
          name: "vercel-ai-gateway",
          model: "anthropic/claude-sonnet-4.6",
          defaultCooldownMs: 60_000,
          keys: [{ id: "gateway-a", value: "sk-gateway-a" }]
        }
      ],
      state: new MemoryStateAdapter()
    });

    const calls: string[] = [];
    const result = await scheduler.withRetry({
      provider: "google",
      model: "gemini-3.0-flash",
      execute: async ({ provider, model }) => {
        calls.push(`${provider}:${model}`);

        if (provider === "google") {
          throw new Error(
            'event: error\\ndata: {"success":false,"message":"Stream failed","data":null,"error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods., Status: NOT_FOUND, Details: []"}}'
          );
        }

        if (provider === "openrouter") {
          throw new Error("429 exhausted key on fallback provider");
        }

        return { provider, model };
      }
    });

    expect(result).toEqual({
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4.6"
    });
    expect(calls).toEqual([
      "google:gemini-3.0-flash",
      "openrouter:google/gemini-flash-1.5",
      "vercel-ai-gateway:anthropic/claude-sonnet-4.6"
    ]);
  });

  it("returns clear access/not-found error when all provider routes fail with model route errors", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-3.0-flash",
          defaultCooldownMs: 60_000,
          keys: [{ id: "google-a", value: "sk-google-a" }]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-openrouter-a" }]
        }
      ],
      state: new MemoryStateAdapter()
    });

    const promise = scheduler.withRetry({
      provider: "google",
      model: "gemini-3.0-flash",
      execute: async ({ provider }) => {
        if (provider === "google") {
          throw new Error(
            'event: error\\ndata: {"success":false,"message":"Stream failed","data":null,"error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods., Status: NOT_FOUND, Details: []"}}'
          );
        }

        const error = new Error("provider access denied for this model");
        Object.assign(error, { status: 403, code: "FORBIDDEN" });
        throw error;
      }
    });

    await expect(promise).rejects.toMatchObject({
      name: "ProviderRouteError",
      routesTried: 2
    });
    await expect(promise).rejects.toThrow("Model access denied or not found (404)");
  });

  it("can disable provider/model fallback for route errors", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "google",
          model: "gemini-3.0-flash",
          defaultCooldownMs: 60_000,
          keys: [{ id: "google-a", value: "sk-google-a" }]
        },
        {
          name: "openrouter",
          model: "google/gemini-flash-1.5",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-openrouter-a" }]
        }
      ],
      state: new MemoryStateAdapter()
    });

    await expect(
      scheduler.withRetry({
        provider: "google",
        model: "gemini-3.0-flash",
        fallbacks: false,
        execute: async () => {
          throw new Error("UPSTREAM_ERROR 404 model is not found");
        }
      })
    ).rejects.toBeInstanceOf(ProviderRouteError);
  });

  it("detects model route errors from common SSE/provider payloads", () => {
    expect(
      isFallbackRouteError(
        'event: error\ndata: {"error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent., Status: NOT_FOUND"}}'
      )
    ).toBe(true);
    expect(isFallbackRouteError({ status: 404, response: { data: { error: { message: "model_not_found" } } } })).toBe(true);
    expect(isFallbackRouteError({ status: 403, code: "FORBIDDEN", message: "provider blacklisted" })).toBe(true);
    expect(isFallbackRouteError({ status: 500, message: "database failed" })).toBe(false);
  });

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

  it("can be called as scheduler.withStreamRetry and only retries stream startup failures", async () => {
    const scheduler = schedulerWithThreeKeys();
    const execute = vi.fn(async ({ key }) => {
      if (execute.mock.calls.length === 1) {
        throw new Error("429 stream start exhausted");
      }
      return { stream: true, keyId: key.id };
    });

    const result = await scheduler.withStreamRetry({
      provider: "openrouter",
      model: "test-model",
      execute
    });

    expect(result).toEqual({ stream: true, keyId: "openrouter-b" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("exports withStreamKeyRetry as a semantic start-stream alias", async () => {
    const scheduler = schedulerWithThreeKeys();

    const result = await withStreamKeyRetry(scheduler, {
      provider: "openrouter",
      model: "test-model",
      execute: async ({ key }) => ({ readable: true, keyId: key.id })
    });

    expect(result).toEqual({ readable: true, keyId: "openrouter-a" });
  });

  it("detects exhausted/quota/rate-limit messages as retryable", () => {
    expect(isRetryableKeyError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryableKeyError(new Error("RESOURCE_EXHAUSTED: quota exceeded"))).toBe(true);
    expect(isRetryableKeyError({ code: "rate_limit_exceeded" })).toBe(true);
    expect(isRetryableKeyError({ body: { error: { message: "insufficient_quota" } } })).toBe(true);
    expect(isRetryableKeyError({ response: { data: { message: "key_exhausted" } } })).toBe(true);
    expect(isRetryableKeyError({ errors: [{ message: "quota exceeded" }] })).toBe(true);
    expect(isRetryableKeyError({ status: 500, message: "database failed" })).toBe(false);
  });

  it("lets classifyError force retry or fail decisions", async () => {
    const retryScheduler = schedulerWithThreeKeys();
    let retryCalls = 0;
    let shouldRetry = true;
    const retryResult = await retryScheduler.withRetry({
      provider: "openrouter",
      model: "test-model",
      classifyError: () => {
        if (shouldRetry) {
          shouldRetry = false;
          return "retry";
        }
        return undefined;
      },
      execute: async () => {
        retryCalls += 1;
        if (retryCalls === 1) {
          throw new Error("custom transient");
        }
        return "retried";
      }
    });

    expect(retryResult).toBe("retried");

    const failScheduler = schedulerWithThreeKeys();
    await expect(
      failScheduler.withRetry({
        provider: "openrouter",
        model: "test-model",
        classifyError: () => "fail",
        execute: async () => {
          throw new Error("429 but user wants fail");
        }
      })
    ).rejects.toThrow("429 but user wants fail");
  });

  it("uses Retry-After headers to override provider cooldown", async () => {
    let now = 1_000;
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openrouter",
          model: "test-model",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openrouter-a", value: "sk-env-a" }]
        }
      ],
      state: new MemoryStateAdapter(),
      now: () => now
    });

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

    await expect(scheduler.acquire({ provider: "openrouter", model: "test-model" })).rejects.toMatchObject({
      nextResetAt: 3_000
    });

    now = 3_000;
    const released = await scheduler.acquire({ provider: "openrouter", model: "test-model" });
    expect(released.key.id).toBe("openrouter-a");
  });

  it("stops after the total number of keys and throws a safe exhausted error", async () => {
    const scheduler = schedulerWithThreeKeys();
    const execute = vi.fn(async ({ apiKey }: { apiKey: string }) => {
      throw new Error(`429 exhausted key ${apiKey}`);
    });

    const promise = scheduler.withRetry({
      provider: "openrouter",
      model: "test-model",
      execute
    });

    await expect(promise).rejects.toMatchObject({
      name: "KeyExhaustedError",
      provider: "openrouter",
      model: "test-model",
      reason: "max_attempts",
      attempts: 3,
      maxAttempts: 3
    });

    await expect(promise).rejects.not.toThrow("sk-env");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("waits for the next reset when all keys are cooling and timeout allows it", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openrouter",
          model: "test-model",
          defaultCooldownMs: 250,
          keys: [{ id: "openrouter-a", value: "sk-env-a" }]
        }
      ],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) {
        throw new Error("429 rate limit");
      }
      return "ok-after-reset";
    });

    const result = await scheduler.withRetry({
      provider: "openrouter",
      model: "test-model",
      maxAttempts: 2,
      timeoutMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      execute
    });

    expect(result).toBe("ok-after-reset");
    expect(sleeps).toEqual([250]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("throws a safe timeout error when the one-minute retry deadline is reached before reset", async () => {
    let now = 1_000;
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openrouter",
          model: "test-model",
          defaultCooldownMs: 60_001,
          keys: [{ id: "openrouter-a", value: "sk-env-a" }]
        }
      ],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    const promise = scheduler.withRetry({
      provider: "openrouter",
      model: "test-model",
      maxAttempts: 2,
      timeoutMs: 60_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      execute: async ({ apiKey }) => {
        throw new Error(`429 exhausted key ${apiKey}`);
      }
    });

    await expect(promise).rejects.toMatchObject({
      name: "KeyExhaustedError",
      provider: "openrouter",
      model: "test-model",
      reason: "timeout",
      attempts: 1,
      maxAttempts: 2,
      timeoutMs: 60_000
    });
    await expect(promise).rejects.not.toThrow("sk-env-a");
  });

  it("does not expose raw provider errors to onRetry handlers", async () => {
    const scheduler = schedulerWithThreeKeys();
    const events: unknown[] = [];

    await expect(
      scheduler.withRetry({
        provider: "openrouter",
        model: "test-model",
        maxAttempts: 1,
        onRetry: (event) => {
          events.push(event);
        },
        execute: async ({ apiKey }) => {
          const error = new Error(`429 exhausted key ${apiKey}`);
          Object.assign(error, { status: 429, code: "rate_limit_exceeded" });
          throw error;
        }
      })
    ).rejects.toBeInstanceOf(KeyExhaustedError);

    expect(JSON.stringify(events)).not.toContain("sk-env");
    expect(events).toMatchObject([
      {
        keyId: "openrouter-a",
        errorName: "Error",
        errorCode: "rate_limit_exceeded",
        errorStatus: 429
      }
    ]);
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
    expect(extractRetryAfter({ headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? "6" : null) } })).toBe("6");
  });

  it("aborts before the first attempt with a safe error", async () => {
    const scheduler = schedulerWithThreeKeys();
    const controller = new AbortController();
    controller.abort();

    await expect(
      scheduler.withRetry({
        provider: "openrouter",
        model: "test-model",
        signal: controller.signal,
        execute: async () => "never"
      })
    ).rejects.toMatchObject({
      name: "RetryAbortedError",
      provider: "openrouter",
      model: "test-model",
      attempts: 0,
      maxAttempts: 3
    });
  });

  it("passes AbortSignal into execute", async () => {
    const scheduler = schedulerWithThreeKeys();
    const controller = new AbortController();

    await scheduler.withRetry({
      provider: "openrouter",
      model: "test-model",
      signal: controller.signal,
      execute: async ({ signal }) => {
        expect(signal).toBe(controller.signal);
        return "ok";
      }
    });
  });

  it("aborts while sleeping for cooldown and releases safe RetryAbortedError", async () => {
    let now = 1_000;
    const controller = new AbortController();
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openrouter",
          model: "test-model",
          defaultCooldownMs: 250,
          keys: [{ id: "openrouter-a", value: "sk-env-a" }]
        }
      ],
      state: new MemoryStateAdapter(),
      now: () => now
    });

    await expect(
      scheduler.withRetry({
        provider: "openrouter",
        model: "test-model",
        maxAttempts: 2,
        timeoutMs: 1_000,
        now: () => now,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
          await new Promise(() => undefined);
        },
        execute: async () => {
          throw new Error("429 rate limit");
        }
      })
    ).rejects.toBeInstanceOf(RetryAbortedError);
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
