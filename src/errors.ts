export class SchedulerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerConfigurationError";
  }
}

export class NoAvailableKeyError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly nextResetAt?: number;

  constructor(message: string, options: { provider: string; model: string; nextResetAt?: number }) {
    super(message);
    this.name = "NoAvailableKeyError";
    this.provider = options.provider;
    this.model = options.model;
    this.nextResetAt = options.nextResetAt;
  }
}

export class RateLimitError extends Error {
  readonly retryAfter?: string | number | Date;
  readonly status?: number;

  constructor(message = "Rate limit exceeded", options: { retryAfter?: string | number | Date; status?: number } = {}) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = options.retryAfter;
    this.status = options.status;
  }
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  if (error instanceof RateLimitError) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return maybeError.status === 429 || maybeError.statusCode === 429 || maybeError.code === "rate_limit_exceeded";
}
