/*
 * retryAfter.ts
 *
 * Utility to parse `Retry-After` values commonly returned by HTTP APIs. It
 * accepts seconds, HTTP-date strings, Date objects, or numeric seconds and
 * returns a millisecond duration suitable for scheduling cooldowns.
 */

export function parseRetryAfter(value: string | number | Date | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "number") {
    return Math.max(0, value * 1000);
  }

  if (value instanceof Date) {
    return Math.max(0, value.getTime() - now);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }

  return Math.max(0, dateMs - now);
}
