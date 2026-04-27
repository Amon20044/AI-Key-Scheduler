import { describe, expect, it } from "vitest";
import { KeyScheduler, MemoryStateAdapter } from "@ai-key-manager/core";
import { generateTextWithKey, streamTextWithKey } from "../src/index.js";

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

describe("Vercel AI SDK adapter", () => {
  it("creates the AI SDK model with the scheduled key", async () => {
    const result = await generateTextWithKey({
      scheduler: createScheduler(),
      provider: "openai",
      model: "gpt-test",
      options: { prompt: "hello" },
      createModel: ({ apiKey }) => ({ provider: "openai", apiKey }),
      call: async (options) => options
    });

    expect(result).toMatchObject({
      prompt: "hello",
      model: {
        provider: "openai",
        apiKey: "sk-openai-a"
      }
    });
  });

  it("uses the same retry wrapper for streamText calls", async () => {
    const result = await streamTextWithKey({
      scheduler: createScheduler(),
      provider: "openai",
      model: "gpt-test",
      options: ({ attempt }) => ({ attempt }),
      createModel: ({ key }) => ({ keyId: key.id }),
      call: async (options) => options
    });

    expect(result).toMatchObject({
      attempt: 1,
      model: {
        keyId: "openai-a"
      }
    });
  });
});
