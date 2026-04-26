import { REDACTED, SecretString } from "./secret.js";

const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "key",
  "secret",
  "token",
  "authorization",
  "password",
  "bearer",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "prompt",
  "response",
  "body",
  "requestbody",
  "request_body",
  "metadata",
  "usermetadata",
  "user_metadata"
]);

export type LogSafeValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | LogSafeValue[]
  | { [key: string]: LogSafeValue };

export interface SafeKeyLogFields {
  id: string;
  provider: string;
  model: string;
  exhausted: boolean;
  resetAt?: string;
  cooldownMs?: number;
}

export function sanitizeForLog(value: unknown, seen = new WeakSet<object>()): LogSafeValue {
  if (value instanceof SecretString) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return redactBearerToken(value);
  }

  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, seen));
  }

  if (value instanceof Error) {
    return sanitizeForLog(
      {
        name: value.name,
        message: value.message
      },
      seen
    );
  }

  const output: Record<string, LogSafeValue> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : sanitizeForLog(nestedValue, seen);
  }

  return output;
}

export function safeKeyLogFields(input: {
  id: string;
  provider: string;
  model: string;
  exhausted: boolean;
  resetAt?: Date;
  cooldownMs?: number;
}): SafeKeyLogFields {
  return {
    id: input.id,
    provider: input.provider,
    model: input.model,
    exhausted: input.exhausted,
    resetAt: input.resetAt?.toISOString(),
    cooldownMs: input.cooldownMs
  };
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.replace(/[-\s]/g, "").toLowerCase()) || SENSITIVE_KEYS.has(key.toLowerCase());
}

function redactBearerToken(value: string): string {
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
