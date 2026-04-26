import type { SecretString } from "./secret.js";

export interface KeyConfig {
  id: string;
  value?: string | SecretString;
  secret?: SecretString;
  metadata?: Record<string, unknown>;
}

export interface APIKey {
  id: string;
  provider: string;
  model: string;
  secret: SecretString;
  lastUsedAt?: Date;
  exhausted: boolean;
  resetAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface ProviderConfig {
  name: string;
  model: string;
  defaultCooldownMs: number;
  keys: KeyConfig[];
}

export interface SchedulerOptions {
  providers: ProviderConfig[];
  state?: StateAdapter;
  now?: () => number;
}

export interface AcquireRequest {
  provider: string;
  model: string;
}

export interface RateLimitedOptions {
  retryAfter?: string | number | Date | null;
  cooldownMs?: number;
}

export interface KeyLease {
  key: APIKey;
  provider: string;
  model: string;
  success(): Promise<void>;
  release(): Promise<void>;
  rateLimited(options?: RateLimitedOptions): Promise<void>;
}

export interface PersistedKeyState {
  id: string;
  provider: string;
  model: string;
  lastUsedAt?: number;
  resetAt?: number;
  metadata?: Record<string, unknown>;
}

export interface PersistedSchedulerState {
  version: 1;
  keys: PersistedKeyState[];
}

export interface StateAdapter {
  load(): Promise<PersistedSchedulerState | undefined>;
  save(state: PersistedSchedulerState): Promise<void>;
}

export interface KeyStorage {
  load(): Promise<APIKey[]>;
  save(keys: APIKey[]): Promise<void>;
}
