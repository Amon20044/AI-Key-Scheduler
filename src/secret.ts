/*
 * secret.ts
 *
 * Small utility for holding sensitive strings in a way that prevents accidental
 * logging / inspection. `SecretString` exposes `value()` to access the raw
 * secret and overrides `toString`/`toJSON`/inspect to return a redacted token.
 */

import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

export class SecretString {
  readonly #raw: string;

  constructor(value: string) {
    this.#raw = value;
  }

  value(): string {
    return this.#raw;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export function isSecretString(value: unknown): value is SecretString {
  return value instanceof SecretString;
}

export { REDACTED };
