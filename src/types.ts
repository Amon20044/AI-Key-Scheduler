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
  healthScore: number;
  successCount: number;
  rateLimitCount: number;
  consecutiveRateLimits: number;
  lastFailedAt?: Date;
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
  keyIdentity?: KeyIdentityOptions;
}

export interface KeyIdentityOptions {
  hmacSecret: string | SecretString;
  onMismatch?: "reset" | "throw";
}

export interface AcquireRequest {
  provider: string;
  model: string;
}

export interface KeyGroupInfo extends AcquireRequest {
  totalKeys: number;
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

export interface KeyExecutionContext {
  key: APIKey;
  apiKey: string;
  lease: KeyLease;
  provider: string;
  model: string;
  attempt: number;
  maxAttempts: number;
  remainingMs: number;
  signal?: AbortSignal;
}

export interface KeyRetryEvent {
  keyId: string;
  provider: string;
  model: string;
  attempt: number;
  maxAttempts: number;
  remainingMs: number;
  retryAfter?: string | number | Date | null;
  errorName?: string;
  errorCode?: string | number;
  errorStatus?: number;
}

export interface KeyFallbackEvent {
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  attempt: number;
  maxAttempts: number;
  remainingMs: number;
  errorName?: string;
  errorCode?: string | number;
  errorStatus?: number;
}

export type KeyFallbackConfig = "all" | false | AcquireRequest[];

export interface WithKeyRetryOptions<T> {
  /**
   * Target provider. Optional — if omitted, the scheduler tries all configured
   * provider/model groups in order (with fallback).
   */
  provider?: string;
  /**
   * Target model. Optional — if omitted, the scheduler tries all configured
   * provider/model groups in order (with fallback).
   */
  model?: string;
  execute(context: KeyExecutionContext): Promise<T>;
  /**
   * Defaults to the number of keys configured for the exact provider/model group.
   */
  maxAttempts?: number;
  /**
   * Defaults to 60 seconds. The wrapper waits for cooling keys only while this
   * deadline still allows another attempt.
   */
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /**
   * Defaults to "all": model/route errors can fall back to other configured
   * provider/model groups. Set false to disable.
   */
  fallbacks?: KeyFallbackConfig;
  /**
   * Adds custom retry classification on top of the built-in 429/quota/exhausted
   * detector. Return true to force a retry.
   */
  isRetryableError?: (error: unknown) => boolean;
  isFallbackError?: (error: unknown) => boolean;
  classifyError?: (error: unknown) => "retry" | "fail" | undefined;
  getRetryAfter?: (error: unknown) => string | number | Date | null | undefined;
  onRetry?: (event: KeyRetryEvent) => void | Promise<void>;
  onFallback?: (event: KeyFallbackEvent) => void | Promise<void>;
}

export interface PersistedKeyState {
  id: string;
  provider: string;
  model: string;
  lastUsedAt?: number;
  resetAt?: number;
  keyFingerprint?: string;
  healthScore?: number;
  successCount?: number;
  rateLimitCount?: number;
  consecutiveRateLimits?: number;
  lastFailedAt?: number;
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
