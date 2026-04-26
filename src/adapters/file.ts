import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PersistedSchedulerState, StateAdapter } from "../types.js";

export class FileStateAdapter implements StateAdapter {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<PersistedSchedulerState | undefined> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as PersistedSchedulerState;
      if (parsed.version !== 1 || !Array.isArray(parsed.keys)) {
        return undefined;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async save(state: PersistedSchedulerState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(state, null, 2)}\n`;
    try {
      await writeFile(tempPath, body, { encoding: "utf8", flag: "wx" });
      await rename(tempPath, this.path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }
}
