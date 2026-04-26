# AI Key Manager

Rate-limit aware API key scheduling for TypeScript and Node.js.

Use it when your app has multiple API keys across AI providers and models, and you want each request to get a healthy key without hard-coding rotation logic into every SDK wrapper.

## What It Does

- Rotates keys per `provider + model`.
- Selects the least recently used available key.
- Avoids keys that recently hit rate limits.
- Uses `Retry-After` when the provider returns it.
- Persists only non-secret state: key IDs, provider/model names, `lastUsedAt`, and `resetAt`.
- Keeps real API key values in memory only and wraps them in `SecretString`.
- Redacts secrets from `console.log`, `String()`, `JSON.stringify()`, and `util.inspect`.
- Works with any SDK where you can pass an API key per request or per client.

## Install

```sh
npm install ai-key-manager
```

## Quick Start

```ts
import {
  FileStateAdapter,
  KeyScheduler,
  isRateLimitError
} from "ai-key-manager";

const scheduler = new KeyScheduler({
  providers: [
    {
      name: "openrouter",
      model: "google/gemma-4-26b-a4b-it:free",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "openrouter-a7f3", value: process.env.OPENROUTER_API_KEY_A7F3 },
        { id: "openrouter-k2m9", value: process.env.OPENROUTER_API_KEY_K2M9 },
        { id: "openrouter-q4x8", value: process.env.OPENROUTER_API_KEY_Q4X8 },
        { id: "openrouter-v6n1", value: process.env.OPENROUTER_API_KEY_V6N1 },
        { id: "openrouter-z9p5", value: process.env.OPENROUTER_API_KEY_Z9P5 }
      ]
    },
    {
      name: "google",
      model: "gemini-2.5-flash",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "google-b1r8", value: process.env.GOOGLE_API_KEY_B1R8 },
        { id: "google-c5t2", value: process.env.GOOGLE_API_KEY_C5T2 },
        { id: "google-h7w4", value: process.env.GOOGLE_API_KEY_H7W4 },
        { id: "google-m3d6", value: process.env.GOOGLE_API_KEY_M3D6 },
        { id: "google-y8s0", value: process.env.GOOGLE_API_KEY_Y8S0 }
      ]
    },
    {
      name: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4.6",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "gateway-d4j7", value: process.env.AI_GATEWAY_API_KEY_D4J7 },
        { id: "gateway-f8a2", value: process.env.AI_GATEWAY_API_KEY_F8A2 },
        { id: "gateway-n6c3", value: process.env.AI_GATEWAY_API_KEY_N6C3 },
        { id: "gateway-r1v9", value: process.env.AI_GATEWAY_API_KEY_R1V9 },
        { id: "gateway-w5q4", value: process.env.AI_GATEWAY_API_KEY_W5Q4 }
      ]
    }
  ],
  state: new FileStateAdapter(".llm-key-state.json")
});

const lease = await scheduler.acquire({
  provider: "openrouter",
  model: "google/gemma-4-26b-a4b-it:free"
});

try {
  const result = await callProvider(lease.key.secret.value());
  await lease.success();
  return result;
} catch (error) {
  if (isRateLimitError(error)) {
    await lease.rateLimited({ retryAfter: getRetryAfter(error) });
  } else {
    await lease.release();
  }

  throw error;
}
```

## What You Input

```ts
const scheduler = new KeyScheduler({
  providers: [
    {
      name: "openrouter",
      model: "openai/gpt-4o-mini",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "openrouter-a7f3", value: process.env.OPENROUTER_API_KEY_A7F3 },
        { id: "openrouter-k2m9", value: process.env.OPENROUTER_API_KEY_K2M9 },
        { id: "openrouter-q4x8", value: process.env.OPENROUTER_API_KEY_Q4X8 },
        { id: "openrouter-v6n1", value: process.env.OPENROUTER_API_KEY_V6N1 },
        { id: "openrouter-z9p5", value: process.env.OPENROUTER_API_KEY_Z9P5 },
        { id: "openrouter-l0e4", value: process.env.OPENROUTER_API_KEY_L0E4 }
      ]
    },
    {
      name: "google",
      model: "gemini-2.5-flash",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "google-b1r8", value: process.env.GOOGLE_API_KEY_B1R8 },
        { id: "google-c5t2", value: process.env.GOOGLE_API_KEY_C5T2 },
        { id: "google-h7w4", value: process.env.GOOGLE_API_KEY_H7W4 },
        { id: "google-m3d6", value: process.env.GOOGLE_API_KEY_M3D6 },
        { id: "google-y8s0", value: process.env.GOOGLE_API_KEY_Y8S0 },
        { id: "google-p9k1", value: process.env.GOOGLE_API_KEY_P9K1 },
        { id: "google-x2n5", value: process.env.GOOGLE_API_KEY_X2N5 }
      ]
    },
    {
      name: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4.6",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "gateway-d4j7", value: process.env.AI_GATEWAY_API_KEY_D4J7 },
        { id: "gateway-f8a2", value: process.env.AI_GATEWAY_API_KEY_F8A2 },
        { id: "gateway-n6c3", value: process.env.AI_GATEWAY_API_KEY_N6C3 },
        { id: "gateway-r1v9", value: process.env.AI_GATEWAY_API_KEY_R1V9 },
        { id: "gateway-w5q4", value: process.env.AI_GATEWAY_API_KEY_W5Q4 },
        { id: "gateway-t7b0", value: process.env.AI_GATEWAY_API_KEY_T7B0 }
      ]
    }
  ],
  state: new FileStateAdapter(".llm-key-state.json")
});
```

Each key needs:

- `id`: stable public identifier used for persisted scheduling state.
- `value`: secret API key value used only at runtime. The scheduler converts this to `SecretString`.
- `metadata`: optional non-secret data you want persisted with the key.

The IDs above are intentionally random-looking but non-secret. Keep real key values in environment variables or a secret manager.

## What `acquire()` Returns

```ts
const lease = await scheduler.acquire({
  provider: "openrouter",
  model: "openai/gpt-4o-mini"
});
```

Returns:

```ts
{
  key: {
    id: "openrouter-k2m9",
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    secret: "[REDACTED]",
    exhausted: false
  },
  provider: "openrouter",
  model: "openai/gpt-4o-mini",
  success: async () => {},
  release: async () => {},
  rateLimited: async ({ retryAfter }) => {}
}
```

Call exactly one lease method after the provider request:

- `success()`: request worked; update LRU state.
- `rateLimited({ retryAfter })`: provider returned 429; cool this key down.
- `release()`: request failed for another reason; make the key available again.

If all keys are cooling down, `acquire()` throws `NoAvailableKeyError` and includes `nextResetAt`.
If no matching group exists, it throws `SchedulerConfigurationError`.

Raw key access is intentionally explicit:

```ts
const rawKey = lease.key.secret.value();
```

Do not log `secret.value()`.

## Security Model

AI Key Manager is local-first. It does not send API keys, prompts, responses, metadata, analytics, or telemetry to any external server. Scheduler operations make zero outbound network calls.

Enforced by the package:

- Secrets are wrapped in `SecretString`.
- `String(secret)`, `secret.toString()`, `secret.toJSON()`, `JSON.stringify(secret)`, `util.inspect(secret)`, and `console.log(secret)` return `[REDACTED]`.
- Scheduler errors use safe fields like key ID, provider, model, and reset timestamps.
- Default state is in memory. `FileStateAdapter` persists only non-secret scheduler state.
- `sanitizeForLog()` recursively redacts API keys, tokens, authorization headers, prompts, responses, request bodies, and metadata.

Developer responsibility:

- Load keys from environment variables or your own secret manager.
- Do not hardcode API keys in source code.
- Do not log `lease.key.secret.value()`.
- Only pass raw keys to the AI provider SDK call that needs them.

See [SECURITY.md](./SECURITY.md) for the full security policy.

## How It Works

The scheduler stores keys in `Map`s for O(1) lookup by `provider`, `model`, and key ID. Keys are grouped by `provider + model`, so rate limits for one model never block another model unless you configure them in the same group.

Available keys are chosen with greedy LRU selection using `lastUsedAt`. Rate-limited keys move into a min heap sorted by `resetAt`. Before every `acquire()`, expired cooldowns are released back into the available pool.

Inside one Node.js process, acquire and lease settlement calls are serialized so two concurrent requests do not receive the same key.

## LangChain JS Example

Install:

```sh
npm install @langchain/openai @langchain/core ai-key-manager
```

```ts
import { ChatOpenAI } from "@langchain/openai";
import {
  FileStateAdapter,
  KeyScheduler,
  isRateLimitError
} from "ai-key-manager";

const model = "openai/gpt-4o-mini";

const scheduler = new KeyScheduler({
  providers: [
    {
      name: "openrouter",
      model,
      defaultCooldownMs: 60_000,
      keys: [
        { id: "openrouter-a7f3", value: process.env.OPENROUTER_API_KEY_A7F3 },
        { id: "openrouter-k2m9", value: process.env.OPENROUTER_API_KEY_K2M9 },
        { id: "openrouter-q4x8", value: process.env.OPENROUTER_API_KEY_Q4X8 },
        { id: "openrouter-v6n1", value: process.env.OPENROUTER_API_KEY_V6N1 },
        { id: "openrouter-z9p5", value: process.env.OPENROUTER_API_KEY_Z9P5 }
      ]
    }
  ],
  state: new FileStateAdapter(".llm-key-state.json")
});

export async function askWithLangChain(prompt: string) {
  const lease = await scheduler.acquire({ provider: "openrouter", model });

  const llm = new ChatOpenAI({
    model,
    apiKey: lease.key.secret.value(),
    configuration: {
      baseURL: "https://openrouter.ai/api/v1"
    }
  });

  try {
    const response = await llm.invoke(prompt);
    await lease.success();
    return response;
  } catch (error) {
    if (isRateLimitError(error)) {
      await lease.rateLimited({ retryAfter: readRetryAfter(error) });
    } else {
      await lease.release();
    }

    throw error;
  }
}

function readRetryAfter(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const headers = (error as { headers?: Headers | Record<string, string> }).headers;
  if (!headers) return undefined;
  return headers instanceof Headers ? headers.get("retry-after") ?? undefined : headers["retry-after"];
}
```

## Vercel AI SDK Example

Install:

```sh
npm install ai @ai-sdk/openai-compatible ai-key-manager
```

```ts
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  FileStateAdapter,
  KeyScheduler,
  isRateLimitError
} from "ai-key-manager";

const model = "anthropic/claude-sonnet-4.6";

const scheduler = new KeyScheduler({
  providers: [
    {
      name: "vercel-ai-gateway",
      model,
      defaultCooldownMs: 60_000,
      keys: [
        { id: "gateway-d4j7", value: process.env.AI_GATEWAY_API_KEY_D4J7 },
        { id: "gateway-f8a2", value: process.env.AI_GATEWAY_API_KEY_F8A2 },
        { id: "gateway-n6c3", value: process.env.AI_GATEWAY_API_KEY_N6C3 },
        { id: "gateway-r1v9", value: process.env.AI_GATEWAY_API_KEY_R1V9 },
        { id: "gateway-w5q4", value: process.env.AI_GATEWAY_API_KEY_W5Q4 }
      ]
    }
  ],
  state: new FileStateAdapter(".llm-key-state.json")
});

export async function askWithVercelAISDK(prompt: string) {
  const lease = await scheduler.acquire({
    provider: "vercel-ai-gateway",
    model
  });

  const gateway = createOpenAICompatible({
    name: "vercel-ai-gateway",
    apiKey: lease.key.secret.value(),
    baseURL: "https://ai-gateway.vercel.sh/v1"
  });

  try {
    const result = await generateText({
      model: gateway(model),
      prompt
    });

    await lease.success();
    return result.text;
  } catch (error) {
    if (isRateLimitError(error)) {
      await lease.rateLimited({ retryAfter: readRetryAfter(error) });
    } else {
      await lease.release();
    }

    throw error;
  }
}

function readRetryAfter(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const headers = (error as { responseHeaders?: Headers | Record<string, string> }).responseHeaders;
  if (!headers) return undefined;
  return headers instanceof Headers ? headers.get("retry-after") ?? undefined : headers["retry-after"];
}
```

## State Adapters

```ts
import { FileStateAdapter, MemoryStateAdapter } from "ai-key-manager";
```

Use `MemoryStateAdapter` for tests and short-lived processes.

Use `FileStateAdapter` for local persistence. It writes atomically with a temporary file and rename.

Custom state adapters can implement:

```ts
interface StateAdapter {
  load(): Promise<PersistedSchedulerState | undefined>;
  save(state: PersistedSchedulerState): Promise<void>;
}
```

## Helpers

```ts
import {
  RateLimitError,
  isRateLimitError,
  parseRetryAfter
} from "ai-key-manager";
```

`parseRetryAfter()` supports seconds, HTTP date strings, and `Date` values. Numeric values are interpreted as seconds, matching the HTTP `Retry-After` header.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

Build output includes ESM, CJS, and TypeScript declarations under `dist/`.
