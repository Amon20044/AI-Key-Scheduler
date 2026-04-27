# AI Key Scheduler

Rate-limit aware API key scheduling for TypeScript and Node.js.

AI Key Scheduler is a local-first package family for apps that have multiple API keys across AI providers and models. It picks a healthy key, retries safely on rate limits, falls back across provider/model routes, and keeps raw secrets out of logs and persisted state.

## Packages

```txt
@ai-key-manager/core        scheduler, heap, LRU, cooldown, state, retry
@ai-key-manager/ai-sdk      Vercel AI SDK adapter
@ai-key-manager/langchain   LangChain adapter
```

Install only what your app needs:

```sh
npm install @ai-key-manager/core
npm install @ai-key-manager/core @ai-key-manager/ai-sdk ai @ai-sdk/openai
npm install @ai-key-manager/core @ai-key-manager/langchain @langchain/openai
```

The adapter packages keep AI SDK and LangChain packages as peer/user dependencies. They do not bundle provider SDKs into your app.

## Security Model

AI Key Scheduler is local-first:

- No telemetry, analytics, proxying, or phone-home behavior.
- No API keys, prompts, responses, headers, or metadata are sent anywhere by the scheduler.
- Raw key values are wrapped in `SecretString`, which redacts itself in `console.log`, `String()`, `JSON.stringify()`, and `util.inspect`.
- File persistence stores only non-secret scheduling state such as key IDs, provider/model names, `lastUsedAt`, `resetAt`, and health counters.
- The explicit `secret.value()` or injected `apiKey` value is the only raw key. Do not log it.

See [SECURITY.md](./SECURITY.md) for the full policy.

## Core Setup

```ts
import { FileStateAdapter, KeyScheduler } from "@ai-key-manager/core";

const scheduler = new KeyScheduler({
  providers: [
    {
      name: "openrouter",
      model: "google/gemma-4-26b-a4b-it:free",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "or-a7f3", value: process.env.OPENROUTER_KEY_A7F3 },
        { id: "or-k2m9", value: process.env.OPENROUTER_KEY_K2M9 }
      ]
    },
    {
      name: "google",
      model: "gemini-2.5-flash",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "g-b1r8", value: process.env.GOOGLE_KEY_B1R8 },
        { id: "g-c5t2", value: process.env.GOOGLE_KEY_C5T2 }
      ]
    },
    {
      name: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4.6",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "gateway-d4j7", value: process.env.AI_GATEWAY_KEY_D4J7 }
      ]
    }
        `@ai-key-manager/core`, `@ai-key-manager/ai-sdk`, and `@ai-key-manager/langchain`.
  state: new FileStateAdapter(".llm-key-state.json")
});
```

## Custom Usage

Use `scheduler.withRetry()` when you want to wrap any SDK, fetch call, or custom provider client. This is the most flexible path.

```ts
const result = await scheduler.withRetry({
  execute: async ({ apiKey, provider, model, signal }) => {
    return generateWithAnySDK({
      apiKey,
      provider,
      model,
      prompt: "Summarize this document.",
      signal
    });
  }
});
```

You can also start with a specific provider/model and still allow fallback:

```ts
const result = await scheduler.withRetry({
  provider: "openrouter",
  model: "google/gemma-4-26b-a4b-it:free",
  fallbacks: [
    { provider: "google", model: "gemini-2.5-flash" },
    { provider: "vercel-ai-gateway", model: "anthropic/claude-sonnet-4.6" }
  ],
  execute: async ({ apiKey, provider, model, signal }) => {
    return generateWithAnySDK({ apiKey, provider, model, prompt, signal });
  }
});
```

Important rule: always use the injected `provider`, `model`, and `apiKey` inside `execute`. They may change when route fallback kicks in.

For stream startup retry:

```ts
const stream = await scheduler.withStreamRetry({
  execute: async ({ apiKey, provider, model, signal }) => {
    return startProviderStream({ apiKey, provider, model, prompt, signal });
  }
});
```

`withStreamRetry()` retries failures that happen before the stream is returned. Once a stream exists, the key is marked successful and the scheduler does not retry mid-stream.

## Vercel AI SDK Adapter

Install:

```sh
npm install @ai-key-scheduler/core @ai-key-scheduler/ai-sdk ai @ai-sdk/openai
```

Use `generateTextWithKey()` or `streamTextWithKey()` when your app uses the Vercel AI SDK. The adapter schedules the key, builds the provider model with that key, and calls your AI SDK function.

```ts
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateTextWithKey } from "@ai-key-manager/ai-sdk";

const { text } = await generateTextWithKey({
  scheduler,
  provider: "vercel-ai-gateway",
  model: "anthropic/claude-sonnet-4.6",
  options: {
    prompt: "Write a crisp release note."
  },
  createModel: ({ apiKey, provider, model }) => {
    const gateway = createOpenAICompatible({
      name: provider,
      apiKey,
      baseURL: "https://ai-gateway.vercel.sh/v1"
    });

    return gateway(model);
  },
  call: generateText
});
```

Streaming follows the same shape:

```ts
import { streamText } from "ai";
import { streamTextWithKey } from "@ai-key-manager/ai-sdk";

const stream = await streamTextWithKey({
  scheduler,
  options: { prompt },
  createModel: ({ apiKey, provider, model }) => createProviderModel({ apiKey, provider, model }),
  call: streamText
});
```

The package does not import `ai` at runtime by itself. Your app supplies `generateText`, `streamText`, and provider packages.

## LangChain Adapter

Install:

```sh
npm install @ai-key-scheduler/core @ai-key-scheduler/langchain @langchain/openai
```

Use `invokeWithKey()` for normal LangChain calls:

```ts
import { ChatOpenAI } from "@langchain/openai";
import { invokeWithKey } from "@ai-key-manager/langchain";

const response = await invokeWithKey({
  scheduler,
  provider: "openrouter",
  model: "openai/gpt-4o-mini",
  input: "Explain cooldown heaps in one paragraph.",
  createModel: ({ apiKey, model }) =>
    new ChatOpenAI({
      model,
      apiKey,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1"
      }
    })
});
```

Use `streamWithKey()` when the model exposes `stream()`:

```ts
import { streamWithKey } from "@ai-key-manager/langchain";

const stream = await streamWithKey({
  scheduler,
  input: ({ model }) => `Use the selected model: ${model}`,
  createModel: ({ apiKey, model }) =>
    new ChatOpenAI({
      model,
      apiKey,
      configuration: { baseURL: "https://openrouter.ai/api/v1" }
    })
});
```

The package does not bundle LangChain. Your app owns the LangChain and provider package versions.

## Retry Intelligence

- Auto-pick: omit `provider` and `model` to try all configured groups in order.
- LRU selection: picks the least-recently-used healthy key in a provider/model group.
- Health score: rate limits lower key health, successes recover it, health breaks LRU ties.
- Cooldown heap: rate-limited keys are held by `resetAt`; expired cooldowns are released before acquire.
- Retry-After: seconds, HTTP dates, and `Date` values override default cooldowns.
- Route fallback: model/provider route failures can move to another configured group.
- Route affinity: the last successful fallback route is preferred on later calls in the same process.
- AbortSignal: abort before acquire, during execute, or while waiting for cooldown.
- Safe errors: scheduler errors expose key IDs, provider/model names, and reset times, not secrets.
- Custom classification: use `classifyError`, `isRetryableError`, `isFallbackError`, or `getRetryAfter`.

## State Adapters

```ts
import { FileStateAdapter, MemoryStateAdapter } from "@ai-key-manager/core";
```

- `MemoryStateAdapter`: in-memory state for tests or short-lived processes.
- `FileStateAdapter`: atomic file persistence using temp file plus rename.

Custom adapter:

```ts
import type { PersistedSchedulerState, StateAdapter } from "@ai-key-manager/core";

class RedisStateAdapter implements StateAdapter {
  async load(): Promise<PersistedSchedulerState | undefined> {
    return loadStateFromRedis();
  }

  async save(state: PersistedSchedulerState): Promise<void> {
    await saveStateToRedis(state);
  }
}
```

## Key Identity Safety

Enable HMAC identity checks if environment variables may be swapped after a restart:

```ts
const scheduler = new KeyScheduler({
  providers,
  keyIdentity: {
    hmacSecret: process.env.AI_KEY_SCHEDULER_HMAC_SECRET!,
    onMismatch: "reset" // or "throw"
  }
});
```

The scheduler stores only an HMAC fingerprint, never the raw key or HMAC secret.

## Release Log

### v0.3.2

- Split the project into npm workspaces:
  `@ai-key-manager/core`, `@ai-key-manager/ai-sdk`, and `@ai-key-manager/langchain`.
- Added Vercel AI SDK adapter helpers: `generateTextWithKey()`, `streamTextWithKey()`, and shared `callWithKey()`.
- Added LangChain adapter helpers: `invokeWithKey()` and `streamWithKey()`.
- Added adapter smoke tests proving Vercel-style, LangChain-style, streaming, and custom wrapper usage works without bundling peer SDKs.
- Updated docs and website copy for scoped package installs and `0.3.2`.

### v0.3.1

- Auto-pick mode: `provider` and `model` are optional in `withRetry()` and `withStreamRetry()`.
- Added auto-pick battle tests for basic selection, route-fail cascade, rate-limit cascade, and single-provider auto-pick.

### v0.3.0

- Added the core battle test suite covering multi-provider cascade, cooldown timing, state persistence, concurrent acquire serialization, health score recovery, abort behavior, route affinity, blacklist detection, custom error classification, and callback safety.

### v0.2.x

- Added `withRetry()`, `withStreamRetry()`, safe retry classification, AbortSignal support, per-key health scores, route affinity memory, blacklist/blocked route detection, and optional HMAC key identity checks.

### v0.1.x

- Added the core provider/model/key scheduler, greedy LRU selection, cooldown min-heap, ESM/CJS/type builds, and memory/file state adapters.

## v0.3.2 Verification Logs

```txt
> ai-key-scheduler-monorepo@0.3.2 typecheck
> npm run build --workspace @ai-key-scheduler/core
> npm run typecheck --workspace @ai-key-scheduler/core
> npm run typecheck --workspace @ai-key-scheduler/ai-sdk
> npm run typecheck --workspace @ai-key-scheduler/langchain

Result: passed
```

```txt
> ai-key-scheduler-monorepo@0.3.2 test
> npm run test --workspace @ai-key-scheduler/core
> npm run test --workspace @ai-key-scheduler/ai-sdk
> npm run test --workspace @ai-key-scheduler/langchain

Core:      4 files passed, 93 tests passed
AI SDK:   1 file passed, 2 tests passed
LangChain: 1 file passed, 2 tests passed
Total:     6 files passed, 97 tests passed
```

```txt
> ai-key-scheduler-monorepo@0.3.2 build
> npm run build --workspace @ai-key-scheduler/core
> npm run build --workspace @ai-key-scheduler/ai-sdk
> npm run build --workspace @ai-key-scheduler/langchain

Result: ESM, CJS, and TypeScript declarations emitted for all three packages.
```

## Development

```sh
npm install
npm run lint
npm run test:security
npm test
npm run typecheck
npm run build
```

Track logs in PowerShell:

```powershell
New-Item -ItemType Directory -Path logs -Force | Out-Null
npm run lint 2>&1 | Tee-Object logs/lint.log
npm run test:security 2>&1 | Tee-Object logs/test-security.log
npm test 2>&1 | Tee-Object logs/test.log
npm run typecheck 2>&1 | Tee-Object logs/typecheck.log
npm run build 2>&1 | Tee-Object logs/build.log
```
