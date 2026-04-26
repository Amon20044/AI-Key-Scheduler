import type { PersistedSchedulerState, StateAdapter } from "../types.js";

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
