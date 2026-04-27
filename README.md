# AI Key Manager

Rate-limit aware API key scheduling for TypeScript and Node.js.

Use it when your app has multiple API keys across AI providers and models, and you want each request to get a healthy key without writing rotation logic.

> **Security Note**
>
> AI Key Manager is local-first by design. It does not phone home, collect analytics, send telemetry, proxy requests, or transmit your API keys, prompts, responses, headers, or metadata anywhere. Scheduler operations only run inside your Node.js process.
>
> Raw API keys are wrapped in `SecretString`, which redacts itself in `console.log`, `String()`, `JSON.stringify()`, and `util.inspect`. The only way to read the real key is the explicit `secret.value()` call.
>
> By default, state is memory-only. Optional file persistence stores only non-secret scheduling metadata such as key IDs, provider/model names, `lastUsedAt`, and `resetAt`. Never log `secret.value()`, and load real keys from environment variables or your own secret manager.

## Prompt For AI Assistants

Copy this into ChatGPT, Cursor, Claude, Copilot, or any coding agent when you want it to add AI Key Manager to your app:

```text
Use the npm package `ai-key-manager` to add rate-limit aware API key scheduling to this Node.js/TypeScript app.

Package:
- npm: ai-key-manager
- install: npm install ai-key-manager
- GitHub: https://github.com/Amon20044/AI-Key-Scheduler

Core concept:
The developer NEVER manually acquires or releases keys. The `scheduler.withRetry()` wrapper does everything:
- Acquires a key from the scheduler.
- Injects `{ provider, model, apiKey }` into the `execute` callback.
- On rate-limit errors (429/quota/exhausted): marks the key as rate-limited, picks the next key, retries.
- On route errors (UPSTREAM_ERROR/NOT_FOUND/403/blacklisted): falls back to another configured provider/model group entirely.
- On success: marks the key healthy and returns the result.
- On non-retryable errors: releases the key and rethrows.

The developer writes ONLY the generation logic inside `execute`. The wrapper manages provider, model, apiKey, retries, cooldowns, and failover automatically.

Setup pattern:

import { KeyScheduler, FileStateAdapter } from "ai-key-manager";

const scheduler = new KeyScheduler({
  providers: [
    {
      name: "openrouter",
      model: "google/gemma-4-26b-a4b-it:free",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "or-a7f3", value: process.env.OPENROUTER_KEY_A7F3 },
        { id: "or-k2m9", value: process.env.OPENROUTER_KEY_K2M9 },
        { id: "or-q4x8", value: process.env.OPENROUTER_KEY_Q4X8 }
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
    }
  ],
  state: new FileStateAdapter(".llm-key-state.json")
});

Simplest usage (auto-pick — no provider/model needed):

const result = await scheduler.withRetry({
  execute: async ({ apiKey, provider, model, signal }) => {
    // provider, model, apiKey are injected by the scheduler.
    // The scheduler picks the best available provider/model group automatically.
    return callYourSDK({ apiKey, provider, model, prompt, signal });
  }
});

Targeted usage (when you want a specific provider/model):

const result = await scheduler.withRetry({
  provider: "openrouter",
  model: "google/gemma-4-26b-a4b-it:free",
  execute: async ({ apiKey, provider, model, signal }) => {
    // If the target route fails, the wrapper can fall back to other groups.
    // Always use the injected provider/model — fallback may change them.
    return callYourSDK({ apiKey, provider, model, prompt, signal });
  }
});

What the wrapper handles automatically:
1. Key selection: picks the least-recently-used healthy key.
2. Rate-limit retry: detects 429, "rate limit", "quota", "exhausted" and rotates to the next key.
3. Route fallback: detects UPSTREAM_ERROR, NOT_FOUND, 404, 403/blacklisted and tries another provider/model group.
4. Route affinity: remembers the last successful fallback route and prefers it on future calls.
5. Cooldown wait: if all keys are cooling and the soonest reset is within the timeout, waits and retries.
6. Health tracking: degrades health on rate limits, recovers on success, uses health as tie-breaker.
7. State persistence: persists only non-secret state (key IDs, lastUsedAt, resetAt, health scores).
8. Abort support: respects AbortSignal before acquire, during execute, and while waiting for cooldown.
9. Secret safety: raw API keys never appear in logs, errors, persisted state, or JSON output.
10. Auto-pick: when provider/model are omitted, the scheduler tries all configured groups in order.

Key rules:
- The `execute` callback MUST use the `provider`, `model`, and `apiKey` passed in its argument — not outer-scope variables.
- Never log `apiKey`. It is the raw secret.
- Load key values from environment variables or a secret manager. Never hardcode.
```

## Install

```sh
npm install ai-key-manager
```

## The Core Abstraction

The entire point of this package is one function: **`scheduler.withRetry()`**. It wraps your AI call and manages everything:

```
┌──────────────────────────────────────────────────────────────┐
│  scheduler.withRetry({ execute })                            │
│                                                              │
│  1. Pick best provider/model group (auto or targeted)        │
│  2. Acquire LRU healthy key from that group                  │
│  3. Inject { provider, model, apiKey } into execute()        │
│  4. On success → mark key healthy, return result             │
│  5. On 429/rate-limit → cooldown key, pick next, retry       │
│  6. On route error → fall back to another provider/model     │
│  7. On timeout/exhaust → throw safe KeyExhaustedError        │
│  8. On abort → throw safe RetryAbortedError                  │
└──────────────────────────────────────────────────────────────┘
```

**You never call `acquire()`, `success()`, `rateLimited()`, or `release()` manually.** The wrapper does it all.

### Auto-Pick Mode (Simplest)

When you have one or more providers configured, you don't even need to specify which one. The scheduler picks the best available group automatically:

```ts
import { KeyScheduler, FileStateAdapter } from "ai-key-manager";

const scheduler = new KeyScheduler({
  providers: [
    {
      name: "openrouter",
      model: "google/gemma-4-26b-a4b-it:free",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "or-a7f3", value: process.env.OPENROUTER_API_KEY_A7F3 },
        { id: "or-k2m9", value: process.env.OPENROUTER_API_KEY_K2M9 }
      ]
    },
    {
      name: "google",
      model: "gemini-2.5-flash",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "g-b1r8", value: process.env.GOOGLE_API_KEY_B1R8 },
        { id: "g-c5t2", value: process.env.GOOGLE_API_KEY_C5T2 }
      ]
    }
  ],
  state: new FileStateAdapter(".llm-key-state.json")
});

// This is ALL you write — no provider/model needed:
const text = await scheduler.withRetry({
  execute: async ({ apiKey, provider, model, signal }) => {
    // provider, model, apiKey are injected by the scheduler.
    // It picks the best available group and cascades on failure.
    return generateContent({ apiKey, provider, model, prompt: "Hello world", signal });
  }
});
```

### Targeted Mode (Prefer a Specific Provider)

When you want to start with a specific provider/model but still allow fallback:

```ts
const text = await scheduler.withRetry({
  provider: "openrouter",
  model: "google/gemma-4-26b-a4b-it:free",
  execute: async ({ apiKey, provider, model, signal }) => {
    // If openrouter route-fails, the wrapper falls back to google automatically.
    // Always use the injected values — they change on fallback.
    return generateContent({ apiKey, provider, model, prompt: "Hello world", signal });
  }
});
```

### Why `execute` Receives `provider` and `model`

When fallback kicks in, the wrapper switches to a different `provider + model` group. If your `execute` function hardcodes the provider/model from the outer scope, it would call the wrong route. Always use the injected values:

```ts
// ✅ Correct — uses injected provider/model
execute: async ({ apiKey, provider, model }) => {
  return callSDK({ apiKey, provider, model, prompt });
}

// ❌ Wrong — ignores fallback route changes
execute: async ({ apiKey }) => {
  return callSDK({ apiKey, provider: "google", model: "gemini-2.5-flash", prompt });
}
```

## Wrap Any Provider Function

AI Key Manager does not care which AI SDK you use. If your function accepts an API key, wrap it:

```ts
const result = await scheduler.withRetry({
  execute: async ({ apiKey, provider, model, signal }) => {
    return generateWithAnySDK({ apiKey, provider, model, prompt: "Summarize this.", signal });
  }
});
```

For streaming/SSE startup, use the stream alias:

```ts
const stream = await scheduler.withStreamRetry({
  execute: async ({ apiKey, provider, model, signal }) => {
    return startProviderStream({ apiKey, provider, model, prompt, signal });
  }
});
```

`withStreamRetry()` retries only failures that happen before the stream is returned. Once a stream exists, AI Key Manager marks the key as successful and does not retry mid-stream.

## Retry Intelligence

- **Auto-pick:** when `provider`/`model` are omitted, tries all configured groups in order.
- **Key budget:** defaults to the total key count for the selected `provider + model`.
- **Deadline:** defaults to `60_000ms`; override with `timeoutMs`.
- **Cooldown wait:** if every key is cooling and the soonest reset is inside the deadline, the wrapper waits and retries.
- **Route fallback:** if a provider/model route is broken, the wrapper can try another configured provider/model group.
- **Route memory:** after a fallback success, later calls prefer the last successful route in this process.
- **Blacklist-safe:** provider blacklisted/blocked route failures trigger fallback to the next route.
- **Safe failures:** throws `KeyExhaustedError` with safe fields only (no secrets).
- **Abort:** pass `signal` to abort before acquire, before execute, or while waiting for cooldown.
- **Custom classification:** use `classifyError(error)` to force `"retry"` or `"fail"`.

## Provider/Model Fallback

Some AI gateways fail before generation starts because the requested provider/model route is invalid or unsupported. A common SSE error looks like this:

```txt
event: error
data: {"success":false,"message":"Stream failed","error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent., Status: NOT_FOUND"}}
```

`withRetry()` treats route failures as fallback-safe and tries the next configured provider/model group. It detects: `UPSTREAM_ERROR`, `NOT_FOUND`, HTTP `404`, `model_not_found`, `models/... is not found`, `unsupported model`, `not supported for generateContent`, `403` + `FORBIDDEN`/blacklist patterns.

When fallback succeeds, the wrapper remembers the route and prefers it on future calls:

```ts
// Automatic fallback (default)
const response = await scheduler.withRetry({
  provider: "google",
  model: "gemini-3.0-flash",
  execute: async ({ apiKey, provider, model, signal }) => {
    return generateWithRoute({ apiKey, provider, model, prompt, signal });
  }
});

// Explicit fallback list
await scheduler.withRetry({
  provider: "google",
  model: "gemini-3.0-flash",
  fallbacks: [
    { provider: "openrouter", model: "google/gemini-flash-1.5" },
    { provider: "vercel-ai-gateway", model: "anthropic/claude-sonnet-4.6" }
  ],
  execute: async ({ apiKey, provider, model }) => {
    return generateWithRoute({ apiKey, provider, model, prompt });
  }
});

// Disable fallback
await scheduler.withRetry({
  provider: "google",
  model: "gemini-3.0-flash",
  fallbacks: false,
  execute
});
```

## Wrapper Examples

### LangChain JS

```ts
import { ChatOpenAI } from "@langchain/openai";
import { KeyScheduler } from "ai-key-manager";

export async function askWithLangChain(scheduler: KeyScheduler, prompt: string) {
  return scheduler.withRetry({
    execute: async ({ apiKey, provider, model }) => {
      const llm = new ChatOpenAI({
        model,
        apiKey,
        configuration: { baseURL: "https://openrouter.ai/api/v1" }
      });
      return llm.invoke(prompt);
    }
  });
}
```

### Vercel AI SDK

```ts
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { KeyScheduler } from "ai-key-manager";

export async function askWithVercelAI(scheduler: KeyScheduler, prompt: string) {
  return scheduler.withRetry({
    execute: async ({ apiKey, provider, model }) => {
      const gateway = createOpenAICompatible({
        name: provider,
        apiKey,
        baseURL: "https://ai-gateway.vercel.sh/v1"
      });
      const result = await generateText({ model: gateway(model), prompt });
      return result.text;
    }
  });
}
```

### Any Env-Based Function

```ts
const result = await scheduler.withRetry({
  execute: async ({ apiKey, provider, model }) => {
    return generateWithYourSDK({ apiKey, provider, model, prompt: "Summarize this document." });
  }
});
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
        { id: "openrouter-q4x8", value: process.env.OPENROUTER_API_KEY_Q4X8 }
      ]
    },
    {
      name: "google",
      model: "gemini-2.5-flash",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "google-b1r8", value: process.env.GOOGLE_API_KEY_B1R8 },
        { id: "google-c5t2", value: process.env.GOOGLE_API_KEY_C5T2 }
      ]
    },
    {
      name: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4.6",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "gateway-d4j7", value: process.env.AI_GATEWAY_API_KEY_D4J7 },
        { id: "gateway-f8a2", value: process.env.AI_GATEWAY_API_KEY_F8A2 }
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

## What `acquire()` Returns

> You typically don't need `acquire()` directly. Use `withRetry()` instead.

```ts
const lease = await scheduler.acquire({ provider: "openrouter", model: "openai/gpt-4o-mini" });
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

## Edge-Case Checklist

- **Auto-pick:** omit `provider`/`model` from `withRetry()` and the scheduler tries all configured groups in order with cascade.
- **Route memory:** stores the last successful fallback route per requested route and prefers it on future calls.
- **Key exhaustion cascade:** when all keys in one route are rate-limited, the wrapper automatically moves to the next route.
- **Blacklist/blocked:** 403-forbidden and blacklist patterns trigger route-level fallback, not key-level retry.
- **Access denied:** when all routes fail with 404/403/not-found patterns, returns `"Model access denied or not found (404)"` via `ProviderRouteError`.
- **Cooldown heap:** `rateLimited()` pushes keys into a min-heap by `resetAt`; `acquire()` releases expired cooldowns before selection.
- **State continuity:** `FileStateAdapter` persists non-secret `lastUsedAt`, `resetAt`, and health counters; expired cooldowns are released on first acquire after restart.
- **Concurrent safety:** acquire and lease settlement calls are serialized within one Node.js process.

## Key Identity Safety

If users accidentally swap environment variables after a restart, enable HMAC identity checks:

```ts
const scheduler = new KeyScheduler({
  providers,
  keyIdentity: {
    hmacSecret: process.env.AI_KEY_MANAGER_HMAC_SECRET!,
    onMismatch: "reset" // or "throw"
  }
});
```

AI Key Manager stores only an HMAC fingerprint, never the raw API key or HMAC secret.

## Security Model

AI Key Manager is local-first. It does not send API keys, prompts, responses, metadata, analytics, or telemetry to any external server.

Enforced by the package:

- Secrets wrapped in `SecretString` — redacted in `console.log`, `JSON.stringify`, `String()`, `util.inspect`.
- Scheduler errors use only safe fields (key ID, provider, model, reset timestamps).
- `FileStateAdapter` persists only non-secret state.
- `sanitizeForLog()` recursively redacts API keys, tokens, authorization headers.

Developer responsibility:

- Load keys from environment variables or a secret manager.
- Do not hardcode API keys in source code.
- Do not log `lease.key.secret.value()`.

See [SECURITY.md](./SECURITY.md) for the full security policy.

## How It Works

Keys are stored in `Map`s for O(1) lookup by `provider`, `model`, and key ID. Keys are grouped by `provider + model`, so rate limits for one model never block another.

Available keys are chosen with greedy LRU selection using `lastUsedAt`. Rate-limited keys move into a min-heap sorted by `resetAt`. Before every `acquire()`, expired cooldowns are released back into the available pool.

`withRetry()` keeps in-memory route affinity for each requested route so fallback wins are reused on later calls.

## State Adapters

```ts
import { FileStateAdapter, MemoryStateAdapter } from "ai-key-manager";
```

- `MemoryStateAdapter`: for tests and short-lived processes.
- `FileStateAdapter`: atomic write with temp file + rename.

Custom:

```ts
interface StateAdapter {
  load(): Promise<PersistedSchedulerState | undefined>;
  save(state: PersistedSchedulerState): Promise<void>;
}
```

## Helpers

```ts
import { RateLimitError, isRateLimitError, parseRetryAfter } from "ai-key-manager";
```

`parseRetryAfter()` supports seconds, HTTP date strings, and `Date` values.

## Release Log

### v0.1.0

- Core provider/model/key scheduler.
- Greedy LRU key selection.
- Cooldown min-heap for exhausted keys.
- ESM, CJS, and TypeScript declarations.
- Memory and file state adapters.

### v0.2.0

- `SecretString` redaction for logs, JSON, string coercion, and inspect output.
- Safe logging helpers and security-focused errors.
- No-telemetry guarantees and network-silence tests.
- `SECURITY.md` with local-first trust model.

### v0.2.1

- Smart `withRetry()` / `withKeyRetry()` wrappers for LangChain, Vercel AI SDK, and any provider function.
- 60s default retry deadline, total-key attempt budget, and cooldown-aware waiting.
- SSE/start-stream startup retry via `withStreamRetry()` / `withStreamKeyRetry()`.
- AbortSignal support for acquire/execute/cooldown waits.
- Simple per-key health score for smarter tie-breaking.
- Optional HMAC key identity checks to detect swapped environment keys after restart.

### v0.2.2

- Route affinity memory: remembers and prefers the last successful fallback route per requested provider/model.
- Blacklisted/blocked provider route detection added to default fallback-safe route handling.

### v0.3.0

- 35 comprehensive battle tests covering multi-provider cascade, cooldown timing, state persistence across restarts, concurrent acquire serialization, health score degradation/recovery, abort scenarios, route affinity memory, blacklist detection, custom error classification, and callback safety.
- README restructured around the core abstraction.

### v0.3.1

- **Auto-pick mode:** `provider` and `model` are now optional in `withRetry()` and `withStreamRetry()`. When omitted, the scheduler tries all configured provider/model groups in order, cascading on failure. Developers no longer need to specify which provider to use — the scheduler picks the best available group automatically.
- 4 new auto-pick battle tests: basic auto-pick, route-fail cascade, rate-limit cascade, and single-provider auto-pick.
- AI prompt updated to feature auto-pick as the simplest usage pattern.

## v0.3.1 Build Logs

```
> ai-key-manager@0.3.1 typecheck
> tsc -p tsconfig.json --noEmit
```

```
> ai-key-manager@0.3.1 test
> vitest run

 RUN  v4.1.5

 ✓ tests/security.test.ts   (11 tests)  38ms
 ✓ tests/scheduler.test.ts  (19 tests)  62ms
 ✓ tests/wrapper.test.ts    (28 tests)  83ms
 ✓ tests/battle.test.ts     (35 tests)  82ms

 Test Files  4 passed (4)
      Tests  93 passed (93)
   Duration  594ms
```

```
> ai-key-manager@0.3.1 build
> npm run clean && tsc -p tsconfig.esm.json && tsc -p tsconfig.cjs.json && tsc -p tsconfig.types.json && node scripts/fix-cjs-extensions.cjs
```

Build output: ESM, CJS, and TypeScript declarations under `dist/`.

## Development

```sh
npm install
npm run lint
npm run test:security
npm test
npm run typecheck
npm run build
```

Track build/test logs in PowerShell:

```powershell
New-Item -ItemType Directory -Path logs -Force | Out-Null
npm run lint 2>&1 | Tee-Object logs/lint.log
npm run test:security 2>&1 | Tee-Object logs/test-security.log
npm test 2>&1 | Tee-Object logs/test.log
npm run typecheck 2>&1 | Tee-Object logs/typecheck.log
npm run build 2>&1 | Tee-Object logs/build.log
```
