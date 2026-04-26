import { MemoryStateAdapter } from "./adapters/memory.js";
import { NoAvailableKeyError, ProviderNotFoundError, SchedulerConfigurationError } from "./errors.js";
import { MinHeap } from "./heap.js";
import { parseRetryAfter } from "./retryAfter.js";
import { isSecretString, SecretString } from "./secret.js";
import type {
  AcquireRequest,
  APIKey,
  KeyConfig,
  KeyLease,
  PersistedKeyState,
  PersistedSchedulerState,
  ProviderConfig,
  RateLimitedOptions,
  SchedulerOptions,
  StateAdapter
} from "./types.js";

interface RuntimeKey {
  apiKey: APIKey;
  provider: string;
  model: string;
  lastUsedAt: number;
  resetAt?: number;
  leased: boolean;
}

interface KeyGroup {
  provider: {
    name: string;
    model: string;
    defaultCooldownMs: number;
  };
  keysById: Map<string, RuntimeKey>;
  availableIds: Set<string>;
  cooldowns: MinHeap;
}

export class KeyScheduler {
  private readonly groups = new Map<string, KeyGroup>();
  private readonly state: StateAdapter;
  private readonly now: () => number;
  private initPromise?: Promise<void>;
  private mutex: Promise<void> = Promise.resolve();

  constructor(options: SchedulerOptions) {
    this.state = options.state ?? new MemoryStateAdapter();
    this.now = options.now ?? Date.now;
    this.configure(options.providers);
  }

  async acquire(request: AcquireRequest): Promise<KeyLease> {
    return this.runExclusive(async () => {
      await this.ensureInitialized();
      const group = this.getGroup(request.provider, request.model);
      this.releaseExpiredCooldowns(group);

      const selected = this.selectLeastRecentlyUsed(group);
      if (!selected) {
        const nextResetAt = this.peekValidResetAt(group);
        if (nextResetAt !== undefined) {
          throw new NoAvailableKeyError(
            `All keys for provider "${request.provider}" and model "${request.model}" are cooling down.`,
            { provider: request.provider, model: request.model, nextResetAt }
          );
        }

        throw new NoAvailableKeyError(
          `All keys for provider "${request.provider}" and model "${request.model}" are currently leased.`,
          { provider: request.provider, model: request.model }
        );
      }

      selected.leased = true;
      group.availableIds.delete(selected.apiKey.id);
      return this.createLease(selected);
    });
  }

  private configure(providers: ProviderConfig[]): void {
    for (const provider of providers) {
      if (provider.defaultCooldownMs < 0) {
        throw new SchedulerConfigurationError(`Provider "${provider.name}" has a negative defaultCooldownMs.`);
      }

      const groupId = createGroupId(provider.name, provider.model);
      if (this.groups.has(groupId)) {
        throw new SchedulerConfigurationError(`Duplicate provider/model group "${provider.name}" / "${provider.model}".`);
      }

      const keysById = new Map<string, RuntimeKey>();
      const availableIds = new Set<string>();
      for (const key of provider.keys) {
        if (keysById.has(key.id)) {
          throw new SchedulerConfigurationError(`Duplicate key id "${key.id}" in "${provider.name}" / "${provider.model}".`);
        }

        const apiKey = normalizeKeyConfig(key, provider.name, provider.model);
        keysById.set(key.id, {
          apiKey,
          provider: provider.name,
          model: provider.model,
          lastUsedAt: 0,
          leased: false
        });
        availableIds.add(key.id);
      }

      this.groups.set(groupId, {
        provider: {
          name: provider.name,
          model: provider.model,
          defaultCooldownMs: provider.defaultCooldownMs
        },
        keysById,
        availableIds,
        cooldowns: new MinHeap()
      });
    }
  }

  private ensureInitialized(): Promise<void> {
    this.initPromise ??= this.loadState();
    return this.initPromise;
  }

  private async loadState(): Promise<void> {
    const saved = await this.state.load();
    if (!saved) {
      return;
    }

    for (const keyState of saved.keys) {
      const group = this.groups.get(createGroupId(keyState.provider, keyState.model));
      const key = group?.keysById.get(keyState.id);
      if (!group || !key) {
        continue;
      }

      key.lastUsedAt = keyState.lastUsedAt ?? 0;
      key.resetAt = keyState.resetAt;
      if (key.resetAt !== undefined) {
        if (key.resetAt > this.now()) {
          group.availableIds.delete(key.apiKey.id);
          group.cooldowns.push({ keyId: key.apiKey.id, resetAt: key.resetAt });
        } else {
          key.resetAt = undefined;
        }
      }
      syncApiKeyState(key);
    }
  }

  private getGroup(provider: string, model: string): KeyGroup {
    const group = this.groups.get(createGroupId(provider, model));
    if (!group || group.keysById.size === 0) {
      const providerExists = [...this.groups.values()].some((candidate) => candidate.provider.name === provider);
      if (!providerExists) {
        throw new ProviderNotFoundError(`No provider configured for "${provider}".`, { provider, model });
      }
      throw new SchedulerConfigurationError(`No keys configured for provider "${provider}" and model "${model}".`);
    }
    return group;
  }

  private releaseExpiredCooldowns(group: KeyGroup): void {
    const now = this.now();
    while (group.cooldowns.peek() && group.cooldowns.peek()!.resetAt <= now) {
      const item = group.cooldowns.pop()!;
      const key = group.keysById.get(item.keyId);
      if (!key || key.resetAt !== item.resetAt) {
        continue;
      }

      key.resetAt = undefined;
      syncApiKeyState(key);
      if (!key.leased) {
        group.availableIds.add(key.apiKey.id);
      }
    }
  }

  private selectLeastRecentlyUsed(group: KeyGroup): RuntimeKey | undefined {
    let selected: RuntimeKey | undefined;
    for (const id of group.availableIds) {
      const key = group.keysById.get(id);
      if (!key || key.leased || key.resetAt !== undefined) {
        continue;
      }

      if (!selected || key.lastUsedAt < selected.lastUsedAt || (key.lastUsedAt === selected.lastUsedAt && key.apiKey.id < selected.apiKey.id)) {
        selected = key;
      }
    }
    return selected;
  }

  private peekValidResetAt(group: KeyGroup): number | undefined {
    while (group.cooldowns.peek()) {
      const item = group.cooldowns.peek()!;
      const key = group.keysById.get(item.keyId);
      if (key?.resetAt === item.resetAt) {
        return item.resetAt;
      }
      group.cooldowns.pop();
    }
    return undefined;
  }

  private createLease(key: RuntimeKey): KeyLease {
    let settled = false;

    const settle = async (operation: () => Promise<void>): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      await this.runExclusive(operation);
    };

    return {
      key: syncApiKeyState(key),
      provider: key.provider,
      model: key.model,
      success: () =>
        settle(async () => {
          key.lastUsedAt = this.now();
          key.leased = false;
          key.resetAt = undefined;
          syncApiKeyState(key);
          this.groups.get(createGroupId(key.provider, key.model))?.availableIds.add(key.apiKey.id);
          await this.persist();
        }),
      release: () =>
        settle(async () => {
          key.leased = false;
          syncApiKeyState(key);
          if (key.resetAt === undefined) {
            this.groups.get(createGroupId(key.provider, key.model))?.availableIds.add(key.apiKey.id);
          }
        }),
      rateLimited: (options: RateLimitedOptions = {}) =>
        settle(async () => {
          const group = this.getGroup(key.provider, key.model);
          const parsedRetryAfter = parseRetryAfter(options.retryAfter, this.now());
          const cooldownMs = options.cooldownMs ?? parsedRetryAfter ?? group.provider.defaultCooldownMs;
          key.leased = false;
          key.resetAt = this.now() + Math.max(0, cooldownMs);
          syncApiKeyState(key);
          group.availableIds.delete(key.apiKey.id);
          group.cooldowns.push({ keyId: key.apiKey.id, resetAt: key.resetAt });
          await this.persist();
        })
    };
  }

  private async persist(): Promise<void> {
    const keys: PersistedKeyState[] = [];
    for (const group of this.groups.values()) {
      for (const key of group.keysById.values()) {
        keys.push({
          id: key.apiKey.id,
          provider: key.provider,
          model: key.model,
          lastUsedAt: key.lastUsedAt || undefined,
          resetAt: key.resetAt,
          metadata: key.apiKey.metadata
        });
      }
    }

    const state: PersistedSchedulerState = {
      version: 1,
      keys
    };
    await this.state.save(state);
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

function createGroupId(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function normalizeKeyConfig(key: KeyConfig, provider: string, model: string): APIKey {
  const secret = key.secret ?? (isSecretString(key.value) ? key.value : typeof key.value === "string" ? new SecretString(key.value) : undefined);
  if (!secret) {
    throw new SchedulerConfigurationError(`Key "${key.id}" in "${provider}" / "${model}" is missing a secret value.`);
  }

  return {
    id: key.id,
    provider,
    model,
    secret,
    exhausted: false,
    metadata: key.metadata
  };
}

function syncApiKeyState(key: RuntimeKey): APIKey {
  key.apiKey.lastUsedAt = key.lastUsedAt > 0 ? new Date(key.lastUsedAt) : undefined;
  key.apiKey.exhausted = key.resetAt !== undefined;
  key.apiKey.resetAt = key.resetAt !== undefined ? new Date(key.resetAt) : undefined;
  return key.apiKey;
}
