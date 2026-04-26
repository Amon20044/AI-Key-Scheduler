import { inspect } from "node:util";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import * as pkg from "../src/index.js";
import {
  KeyScheduler,
  MemoryStateAdapter,
  NoAvailableKeyError,
  REDACTED,
  SecretString,
  sanitizeForLog
} from "../src/index.js";

const RAW_SECRET = "sk-real-key-security-test";
const require = createRequire(import.meta.url);
const http = require("node:http") as typeof import("node:http");
const https = require("node:https") as typeof import("node:https");

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

describe("SecretString", () => {
  it("console.log does not expose the raw secret", () => {
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map((arg) => inspect(arg)).join(" "));
    });

    console.log(new SecretString(RAW_SECRET));

    log.mockRestore();
    expect(output.join("\n")).toContain(REDACTED);
    expect(output.join("\n")).not.toContain(RAW_SECRET);
  });

  it("String(secret), JSON.stringify, util.inspect, and object serialization redact", () => {
    const secret = new SecretString(RAW_SECRET);

    expect(String(secret)).toBe(REDACTED);
    expect(secret.toString()).toBe(REDACTED);
    expect(JSON.stringify(secret)).toBe(`"${REDACTED}"`);
    expect(inspect(secret)).toBe(REDACTED);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${REDACTED}"}`);
    expect(inspect({ secret })).not.toContain(RAW_SECRET);
  });

  it("value() returns the real secret only when explicitly called", () => {
    const secret = new SecretString(RAW_SECRET);

    expect(secret.value()).toBe(RAW_SECRET);
  });
});

describe("safe logging", () => {
  it("redacts nested secrets and sensitive field names", () => {
    const sanitized = sanitizeForLog({
      provider: "openai",
      request: {
        apiKey: RAW_SECRET,
        key: RAW_SECRET,
        secret: new SecretString(RAW_SECRET),
        token: RAW_SECRET,
        password: RAW_SECRET,
        accessToken: RAW_SECRET,
        refreshToken: RAW_SECRET,
        prompt: "private user prompt",
        response: "private model response",
        body: { text: "private request body" },
        metadata: { tenantId: "private-tenant" },
        nested: [{ authorization: `Bearer ${RAW_SECRET}` }]
      }
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(RAW_SECRET);
    expect(serialized).not.toContain("private user prompt");
    expect(serialized).not.toContain("private model response");
    expect(serialized).not.toContain("private request body");
    expect(serialized).not.toContain("private-tenant");
    expect(serialized).toContain(REDACTED);
  });

  it("redacts authorization headers and bearer tokens in strings", () => {
    const sanitized = sanitizeForLog({
      headers: {
        authorization: `Bearer ${RAW_SECRET}`
      },
      message: `provider returned Bearer ${RAW_SECRET}`
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(RAW_SECRET);
    expect(serialized).toContain(`Bearer ${REDACTED}`);
  });
});

describe("secure errors", () => {
  it("scheduler errors never include raw secrets and include only safe fields", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openai",
          model: "gpt-test",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openai-prod-1", value: RAW_SECRET }]
        }
      ],
      state: new MemoryStateAdapter()
    });

    const lease = await scheduler.acquire({ provider: "openai", model: "gpt-test" });
    await lease.rateLimited();

    try {
      await scheduler.acquire({ provider: "openai", model: "gpt-test" });
      throw new Error("Expected acquire to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(NoAvailableKeyError);
      const safeError = error as NoAvailableKeyError;
      expect(safeError.message).not.toContain(RAW_SECRET);
      expect(inspect(safeError)).not.toContain(RAW_SECRET);
      expect(safeError.provider).toBe("openai");
      expect(safeError.model).toBe("gpt-test");
    }
  });
});

describe("scheduler security behavior", () => {
  it("selecting the next key never leaks the raw key through inspect or JSON", async () => {
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openai",
          model: "gpt-test",
          defaultCooldownMs: 60_000,
          keys: [{ id: "openai-prod-1", value: RAW_SECRET }]
        }
      ]
    });

    const lease = await scheduler.acquire({ provider: "openai", model: "gpt-test" });

    expect(lease.key.secret.value()).toBe(RAW_SECRET);
    expect(JSON.stringify(lease.key)).not.toContain(RAW_SECRET);
    expect(inspect(lease.key)).not.toContain(RAW_SECRET);
  });

  it("uses provider cooldown, Retry-After override, and releases after resetAt", async () => {
    let now = 1_000;
    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openai",
          model: "gpt-test",
          defaultCooldownMs: 5_000,
          keys: [{ id: "openai-prod-1", value: RAW_SECRET }]
        }
      ],
      now: () => now
    });

    const defaultLease = await scheduler.acquire({ provider: "openai", model: "gpt-test" });
    await defaultLease.rateLimited();
    await expect(scheduler.acquire({ provider: "openai", model: "gpt-test" })).rejects.toMatchObject({ nextResetAt: 6_000 });

    now = 6_000;
    const retryAfterLease = await scheduler.acquire({ provider: "openai", model: "gpt-test" });
    await retryAfterLease.rateLimited({ retryAfter: "2" });
    await expect(scheduler.acquire({ provider: "openai", model: "gpt-test" })).rejects.toMatchObject({ nextResetAt: 8_000 });

    now = 8_000;
    const availableLease = await scheduler.acquire({ provider: "openai", model: "gpt-test" });
    expect(availableLease.key.id).toBe("openai-prod-1");
  });
});

describe("network silence", () => {
  it("does not call fetch, http.request, or https.request during scheduler operations", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not be called"));
    const httpSpy = vi.spyOn(http, "request");
    const httpsSpy = vi.spyOn(https, "request");

    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openai",
          model: "gpt-test",
          defaultCooldownMs: 1,
          keys: [{ id: "openai-prod-1", value: RAW_SECRET }]
        }
      ]
    });

    const lease = await scheduler.acquire({ provider: "openai", model: "gpt-test" });
    await lease.success();
    const secondLease = await scheduler.acquire({ provider: "openai", model: "gpt-test" });
    await secondLease.rateLimited();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
    httpSpy.mockRestore();
    httpsSpy.mockRestore();
  });

  it("does not export telemetry helpers or start background timers", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    expect(Object.keys(pkg).some((name) => name.toLowerCase().includes("telemetry"))).toBe(false);

    const scheduler = new KeyScheduler({
      providers: [
        {
          name: "openai",
          model: "gpt-test",
          defaultCooldownMs: 1,
          keys: [{ id: "openai-prod-1", value: RAW_SECRET }]
        }
      ]
    });
    const lease = await scheduler.acquire({ provider: "openai", model: "gpt-test" });
    await lease.release();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it("safe log output never contains the raw key", () => {
    const sanitized = sanitizeForLog({
      event: "cooldown",
      keyId: "openai-prod-1",
      provider: "openai",
      model: "gpt-test",
      cooldownMs: 60_000,
      apiKey: RAW_SECRET
    });

    expect(text(sanitized)).not.toContain(RAW_SECRET);
    expect(text(sanitized)).toContain("openai-prod-1");
  });
});
