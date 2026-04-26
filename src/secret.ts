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
