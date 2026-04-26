import { MemoryStateAdapter } from "./adapters/memory.js";
import { NoAvailableKeyError, SchedulerConfigurationError } from "./errors.js";
import { MinHeap } from "./heap.js";
import { parseRetryAfter } from "./retryAfter.js";
import type {
  AcquireRequest,
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
  config: KeyConfig;
  provider: string;
  model: string;
  lastUsedAt: number;
  resetAt?: number;
  leased: boolean;
}

interface KeyGroup {
  provider: ProviderConfig;
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
      group.availableIds.delete(selected.config.id);
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

        keysById.set(key.id, {
          config: key,
          provider: provider.name,
          model: provider.model,
          lastUsedAt: 0,
          leased: false
        });
        availableIds.add(key.id);
      }

      this.groups.set(groupId, {
        provider,
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
          group.availableIds.delete(key.config.id);
          group.cooldowns.push({ keyId: key.config.id, resetAt: key.resetAt });
        } else {
          key.resetAt = undefined;
        }
      }
    }
  }

  private getGroup(provider: string, model: string): KeyGroup {
    const group = this.groups.get(createGroupId(provider, model));
    if (!group || group.keysById.size === 0) {
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
      if (!key.leased) {
        group.availableIds.add(key.config.id);
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

      if (!selected || key.lastUsedAt < selected.lastUsedAt || (key.lastUsedAt === selected.lastUsedAt && key.config.id < selected.config.id)) {
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
      key: key.config,
      provider: key.provider,
      model: key.model,
      success: () =>
        settle(async () => {
          key.lastUsedAt = this.now();
          key.leased = false;
          key.resetAt = undefined;
          this.groups.get(createGroupId(key.provider, key.model))?.availableIds.add(key.config.id);
          await this.persist();
        }),
      release: () =>
        settle(async () => {
          key.leased = false;
          if (key.resetAt === undefined) {
            this.groups.get(createGroupId(key.provider, key.model))?.availableIds.add(key.config.id);
          }
        }),
      rateLimited: (options: RateLimitedOptions = {}) =>
        settle(async () => {
          const group = this.getGroup(key.provider, key.model);
          const parsedRetryAfter = parseRetryAfter(options.retryAfter, this.now());
          const cooldownMs = options.cooldownMs ?? parsedRetryAfter ?? group.provider.defaultCooldownMs;
          key.leased = false;
          key.resetAt = this.now() + Math.max(0, cooldownMs);
          group.availableIds.delete(key.config.id);
          group.cooldowns.push({ keyId: key.config.id, resetAt: key.resetAt });
          await this.persist();
        })
    };
  }

  private async persist(): Promise<void> {
    const keys: PersistedKeyState[] = [];
    for (const group of this.groups.values()) {
      for (const key of group.keysById.values()) {
        keys.push({
          id: key.config.id,
          provider: key.provider,
          model: key.model,
          lastUsedAt: key.lastUsedAt || undefined,
          resetAt: key.resetAt,
          metadata: key.config.metadata
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
