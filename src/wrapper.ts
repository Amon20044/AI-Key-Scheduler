import { isRateLimitError, KeyExhaustedError, NoAvailableKeyError } from "./errors.js";
import type { KeyScheduler } from "./scheduler.js";
import type { KeyRetryEvent, WithKeyRetryOptions } from "./types.js";

const RETRYABLE_ERROR_PATTERN = /\b429\b|rate[-\s]?limit|too many requests|quota|exhausted|resource exhausted|key exhausted|insufficient quota/i;

export async function withKeyRetry<T>(scheduler: KeyScheduler, options: WithKeyRetryOptions<T>): Promise<T> {
  const maxAttempts = options.maxAttempts ?? scheduler.getKeyCount({ provider: options.provider, model: options.model });
  if (maxAttempts <= 0) {
    throw new NoAvailableKeyError(`No retry attempts available for provider "${options.provider}" and model "${options.model}".`, {
      provider: options.provider,
      model: options.model
    });
  }

  let lastRetryableKeyId: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const lease = await scheduler.acquire({ provider: options.provider, model: options.model });

    try {
      const result = await options.execute({
        key: lease.key,
        apiKey: lease.key.secret.value(),
        lease,
        provider: options.provider,
        model: options.model,
        attempt,
        maxAttempts
      });
      await lease.success();
      return result;
    } catch (error) {
      if (isRetryableKeyError(error, options.isRetryableError)) {
        lastRetryableKeyId = lease.key.id;
        const retryAfter = options.getRetryAfter?.(error) ?? extractRetryAfter(error);
        await lease.rateLimited({ retryAfter });
        await options.onRetry?.({
          keyId: lease.key.id,
          provider: options.provider,
          model: options.model,
          attempt,
          maxAttempts,
          retryAfter,
          error
        });
        continue;
      }

      await lease.release();
      throw error;
    }
  }

  throw new KeyExhaustedError(`All keys for provider "${options.provider}" and model "${options.model}" were exhausted.`, {
    keyId: lastRetryableKeyId ?? "unknown",
    provider: options.provider,
    model: options.model
  });
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

  const maybeError = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };

  if (maybeError.status === 429 || maybeError.statusCode === 429) {
    return true;
  }

  const haystack = [maybeError.code, maybeError.name, maybeError.message].filter((value): value is string => typeof value === "string").join(" ");
  return RETRYABLE_ERROR_PATTERN.test(haystack);
}

export function extractRetryAfter(error: unknown): string | number | Date | null | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const maybeError = error as {
    retryAfter?: string | number | Date | null;
    headers?: Headers | Record<string, string | string[] | undefined>;
    response?: { headers?: Headers | Record<string, string | string[] | undefined> };
    responseHeaders?: Headers | Record<string, string | string[] | undefined>;
  };

  return (
    maybeError.retryAfter ??
    readRetryAfterHeader(maybeError.headers) ??
    readRetryAfterHeader(maybeError.response?.headers) ??
    readRetryAfterHeader(maybeError.responseHeaders)
  );
}

function readRetryAfterHeader(headers: Headers | Record<string, string | string[] | undefined> | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get("retry-after") ?? undefined;
  }

  const value = headers["retry-after"] ?? headers["Retry-After"];
  return Array.isArray(value) ? value[0] : value;
}

export type { KeyRetryEvent, WithKeyRetryOptions } from "./types.js";
