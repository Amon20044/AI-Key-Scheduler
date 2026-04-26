import type { APIKey, KeyStorage, PersistedSchedulerState, StateAdapter } from "../types.js";

export class MemoryStateAdapter implements StateAdapter {
  private state?: PersistedSchedulerState;

  constructor(initialState?: PersistedSchedulerState) {
    this.state = initialState ? structuredClone(initialState) : undefined;
  }

  async load(): Promise<PersistedSchedulerState | undefined> {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async save(state: PersistedSchedulerState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export class MemoryStorage implements KeyStorage {
  private keys: APIKey[];

  constructor(initialKeys: APIKey[] = []) {
    this.keys = [...initialKeys];
  }

  async load(): Promise<APIKey[]> {
    return [...this.keys];
  }

  async save(keys: APIKey[]): Promise<void> {
    this.keys = [...keys];
  }
}
