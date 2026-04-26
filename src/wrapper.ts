import { isRateLimitError, KeyExhaustedError, NoAvailableKeyError, RetryAbortedError } from "./errors.js";
import type { KeyScheduler } from "./scheduler.js";
import type { KeyRetryEvent, WithKeyRetryOptions } from "./types.js";

export const DEFAULT_RETRY_TIMEOUT_MS = 60_000;
export const DEFAULT_RETRY_POLL_INTERVAL_MS = 50;
const RETRYABLE_ERROR_PATTERN =
  /\b429\b|rate[\s_-]?limit|too many requests|quota|exhausted|resource[\s_-]?exhausted|key[\s_-]?exhausted|insufficient[\s_-]?quota|quota[\s_-]?exceeded/i;

export async function withKeyRetry<T>(scheduler: KeyScheduler, options: WithKeyRetryOptions<T>): Promise<T> {
  const maxAttempts = options.maxAttempts ?? scheduler.getKeyCount({ provider: options.provider, model: options.model });
  const timeoutMs = options.timeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_RETRY_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;

  if (maxAttempts <= 0) {
    throw new NoAvailableKeyError(`No retry attempts available for provider "${options.provider}" and model "${options.model}".`, {
      provider: options.provider,
      model: options.model
    });
  }

  let lastRetryableKeyId: string | undefined;
  let attempts = 0;

  while (attempts < maxAttempts) {
    throwIfAborted(options, attempts, maxAttempts);

    if (isTimedOut(now(), deadline)) {
      throw exhaustedError(options, {
        keyId: lastRetryableKeyId,
        reason: "timeout",
        attempts,
        maxAttempts,
        timeoutMs
      });
    }

    let lease;
    try {
      throwIfAborted(options, attempts, maxAttempts);
      lease = await scheduler.acquire({ provider: options.provider, model: options.model });
    } catch (error) {
      if (error instanceof NoAvailableKeyError) {
        await waitForAvailability({
          error,
          provider: options.provider,
          model: options.model,
          keyId: lastRetryableKeyId,
          attempts,
          maxAttempts,
          timeoutMs,
          pollIntervalMs,
          now,
          deadline,
          sleep,
          signal: options.signal
        });
        continue;
      }
      throw error;
    }

    attempts += 1;
    const attempt = attempts;

    try {
      if (options.signal?.aborted) {
        await lease.release();
        throw abortedError({ provider: options.provider, model: options.model, attempts: attempts - 1, maxAttempts });
      }
      const result = await options.execute({
        key: lease.key,
        apiKey: lease.key.secret.value(),
        lease,
        provider: options.provider,
        model: options.model,
        attempt,
        maxAttempts,
        remainingMs: Math.max(0, deadline - now()),
        signal: options.signal
      });
      await lease.success();
      return result;
    } catch (error) {
      if (options.signal?.aborted) {
        await lease.release();
        throw abortedError({ provider: options.provider, model: options.model, attempts, maxAttempts });
      }

      const classification = classifyKeyError(error, options);
      if (classification === "retry") {
        lastRetryableKeyId = lease.key.id;
        const retryAfter = options.getRetryAfter?.(error) ?? extractRetryAfter(error);
        await lease.rateLimited({ retryAfter });
        await options.onRetry?.({
          keyId: lease.key.id,
          provider: options.provider,
          model: options.model,
          attempt,
          maxAttempts,
          remainingMs: Math.max(0, deadline - now()),
          retryAfter,
          ...safeErrorFields(error)
        });
        continue;
      }

      await lease.release();
      throw error;
    }
  }

  throw exhaustedError(options, {
    keyId: lastRetryableKeyId,
    reason: "max_attempts",
    attempts,
    maxAttempts,
    timeoutMs
  });
}

export async function withStreamKeyRetry<T>(scheduler: KeyScheduler, options: WithKeyRetryOptions<T>): Promise<T> {
  return withKeyRetry(scheduler, options);
}

export function isRetryableKeyError(error: unknown, custom?: (error: unknown) => boolean): boolean {
  if (custom?.(error)) {
    return true;
  }

  if (isRateLimitError(error)) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return RETRYABLE_ERROR_PATTERN.test(String(error));
  }

  const maybeError = error as { status?: unknown; statusCode?: unknown };

  if (maybeError.status === 429 || maybeError.statusCode === 429) {
    return true;
  }

  return RETRYABLE_ERROR_PATTERN.test(collectErrorText(error));
}

function classifyKeyError<T>(error: unknown, options: WithKeyRetryOptions<T>): "retry" | "fail" {
  const customClassification = options.classifyError?.(error);
  if (customClassification === "retry" || customClassification === "fail") {
    return customClassification;
  }

  return isRetryableKeyError(error, options.isRetryableError) ? "retry" : "fail";
}

export function extractRetryAfter(error: unknown): string | number | Date | null | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const maybeError = error as {
    retryAfter?: string | number | Date | null;
    headers?: RetryAfterHeaders;
    response?: { headers?: RetryAfterHeaders };
    responseHeaders?: RetryAfterHeaders;
  };

  return (
    maybeError.retryAfter ??
    readRetryAfterHeader(maybeError.headers) ??
    readRetryAfterHeader(maybeError.response?.headers) ??
    readRetryAfterHeader(maybeError.responseHeaders)
  );
}

interface WaitForAvailabilityOptions {
  error: NoAvailableKeyError;
  provider: string;
  model: string;
  keyId?: string;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

async function waitForAvailability(options: WaitForAvailabilityOptions): Promise<void> {
  throwIfAborted(options, options.attempts, options.maxAttempts);
  const currentTime = options.now();
  const remainingMs = options.deadline - currentTime;
  if (remainingMs <= 0) {
    throw exhaustedError(options, {
      keyId: options.keyId,
      reason: "timeout",
      attempts: options.attempts,
      maxAttempts: options.maxAttempts,
      timeoutMs: options.timeoutMs,
      resetAt: options.error.nextResetAt
    });
  }

  const waitMs =
    options.error.nextResetAt !== undefined
      ? Math.max(0, options.error.nextResetAt - currentTime)
      : Math.max(1, options.pollIntervalMs);

  if (waitMs > remainingMs) {
    throw exhaustedError(options, {
      keyId: options.keyId,
      reason: "timeout",
      attempts: options.attempts,
      maxAttempts: options.maxAttempts,
      timeoutMs: options.timeoutMs,
      resetAt: options.error.nextResetAt
    });
  }

  await sleepWithAbort(waitMs, options.sleep, options.signal, options);
}

function exhaustedError(
  options: { provider: string; model: string },
  details: {
    keyId?: string;
    reason: "max_attempts" | "timeout" | "no_available_key";
    attempts: number;
    maxAttempts: number;
    timeoutMs: number;
    resetAt?: number;
  }
): KeyExhaustedError {
  const reasonText = details.reason === "timeout" ? "Retry timeout reached" : "Retry key budget exhausted";
  return new KeyExhaustedError(`${reasonText} for provider "${options.provider}" and model "${options.model}".`, {
    keyId: details.keyId ?? "unknown",
    provider: options.provider,
    model: options.model,
    resetAt: details.resetAt,
    reason: details.reason,
    attempts: details.attempts,
    maxAttempts: details.maxAttempts,
    timeoutMs: details.timeoutMs
  });
}

function isTimedOut(currentTime: number, deadline: number): boolean {
  return currentTime >= deadline;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function sleepWithAbort(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
  options: { provider: string; model: string; attempts: number; maxAttempts: number }
): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }

  throwIfAborted({ provider: options.provider, model: options.model, signal }, options.attempts, options.maxAttempts);
  let onAbort: (() => void) | undefined;
  try {
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(abortedError(options));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([sleep(ms), abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
  throwIfAborted({ provider: options.provider, model: options.model, signal }, options.attempts, options.maxAttempts);
}

function throwIfAborted(
  options: { provider: string; model: string; signal?: AbortSignal },
  attempts: number,
  maxAttempts: number
): void {
  if (options.signal?.aborted) {
    throw abortedError({ ...options, attempts, maxAttempts });
  }
}

function abortedError(options: { provider: string; model: string; attempts: number; maxAttempts: number }): RetryAbortedError {
  return new RetryAbortedError(`Retry aborted for provider "${options.provider}" and model "${options.model}".`, {
    provider: options.provider,
    model: options.model,
    attempts: options.attempts,
    maxAttempts: options.maxAttempts
  });
}

function safeErrorFields(error: unknown): Pick<KeyRetryEvent, "errorName" | "errorCode" | "errorStatus"> {
  if (!error || typeof error !== "object") {
    return {};
  }

  const maybeError = error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  const status = typeof maybeError.status === "number" ? maybeError.status : typeof maybeError.statusCode === "number" ? maybeError.statusCode : undefined;
  return {
    errorName: typeof maybeError.name === "string" ? maybeError.name : undefined,
    errorCode: typeof maybeError.code === "string" || typeof maybeError.code === "number" ? maybeError.code : undefined,
    errorStatus: status
  };
}

function collectErrorText(error: unknown, seen = new WeakSet<object>(), depth = 0): string {
  if (depth > 4 || error === null || error === undefined) {
    return "";
  }

  if (typeof error === "string" || typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }

  if (error instanceof Error) {
    const cause = "cause" in error ? collectErrorText((error as { cause?: unknown }).cause, seen, depth + 1) : "";
    return [error.name, error.message, cause].join(" ");
  }

  if (typeof error !== "object") {
    return "";
  }

  if (Array.isArray(error)) {
    return error.map((item) => collectErrorText(item, seen, depth + 1)).join(" ");
  }

  if (seen.has(error)) {
    return "";
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  const directFields = ["status", "statusCode", "code", "name", "type", "message", "error", "errors", "cause", "response", "data", "body"];
  return directFields.map((field) => collectErrorText(record[field], seen, depth + 1)).join(" ");
}

type RetryAfterHeaders =
  | Headers
  | {
      get?: (name: string) => string | null | undefined;
      [key: string]: string | string[] | ((name: string) => string | null | undefined) | undefined;
    };

function readRetryAfterHeader(headers: RetryAfterHeaders | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (typeof headers.get === "function") {
    return headers.get("retry-after") ?? headers.get("Retry-After") ?? undefined;
  }

  const headerRecord = headers as Record<string, string | string[] | ((name: string) => string | null | undefined) | undefined>;
  const value = headerRecord["retry-after"] ?? headerRecord["Retry-After"];
  return typeof value === "function" ? undefined : Array.isArray(value) ? value[0] : value;
}

export type { KeyRetryEvent, WithKeyRetryOptions } from "./types.js";
