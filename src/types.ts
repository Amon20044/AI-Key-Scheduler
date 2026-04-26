export interface KeyConfig {
  id: string;
  value?: string;
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
  key: KeyConfig;
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
