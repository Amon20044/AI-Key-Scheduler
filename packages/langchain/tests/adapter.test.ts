import { describe, expect, it } from "vitest";
import { KeyScheduler, MemoryStateAdapter } from "@ai-key-scheduler/core";
import { invokeWithKey, streamWithKey } from "../src/index.js";

function createScheduler(): KeyScheduler {
  return new KeyScheduler({
    providers: [
      {
        name: "openai",
        model: "gpt-test",
        defaultCooldownMs: 1_000,
        keys: [{ id: "openai-a", value: "sk-openai-a" }]
      }
    ],
    state: new MemoryStateAdapter()
  });
}

describe("LangChain adapter", () => {
  it("invokes a model created with the scheduled key", async () => {
    const result = await invokeWithKey({
      scheduler: createScheduler(),
      provider: "openai",
      model: "gpt-test",
      input: "hello",
      createModel: ({ apiKey }) => ({
        invoke: async (input: string) => ({ input, apiKey })
      })
    });

    expect(result).toEqual({
      input: "hello",
      apiKey: "sk-openai-a"
    });
  });

  it("streams with a model created from the scheduled lease", async () => {
    const result = await streamWithKey({
      scheduler: createScheduler(),
      provider: "openai",
      model: "gpt-test",
      input: ({ key }) => key.id,
      createModel: () => ({
        invoke: async () => "unused",
        stream: async (input: string) => ({ input, streamed: true })
      })
    });

    expect(result).toEqual({
      input: "openai-a",
      streamed: true
    });
  });
});
