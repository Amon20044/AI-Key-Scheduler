# AI Key Manager

Rate-limit aware API key scheduling for TypeScript and Node.js.

Use it when your app has multiple API keys across AI providers and models, and you want each request to get a healthy key without hard-coding rotation logic into every SDK wrapper.

> **Security Note**
>
> AI Key Manager is local-first by design. It does not phone home, collect analytics, send telemetry, proxy requests, or transmit your API keys, prompts, responses, headers, or metadata anywhere. Scheduler operations only run inside your Node.js process.
>
> Raw API keys are wrapped in `SecretString`, which redacts itself in `console.log`, `String()`, `JSON.stringify()`, and `util.inspect`. The only way to read the real key is the explicit `secret.value()` call, intended for the exact provider SDK request that needs it.
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

The developer writes ONLY the generation logic inside `execute`. The wrapper manages provider, model, apiKey, retries, cooldowns, and failover.

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

Usage pattern (this is all the dev writes):

const result = await scheduler.withRetry({
  provider: "openrouter",
  model: "google/gemma-4-26b-a4b-it:free",
  signal: abortController.signal,
  execute: async ({ apiKey, provider, model, signal }) => {
    // apiKey, provider, model are injected by the scheduler.
    // Use them directly in your SDK call. Never hardcode these.
    return callYourSDK({ apiKey, provider, model, prompt, signal });
  }
});

What the wrapper handles automatically:
1. Key selection: picks the least-recently-used healthy key for the requested provider/model.
2. Rate-limit retry: detects 429, "rate limit", "quota", "exhausted" and rotates to the next key.
3. Route fallback: detects UPSTREAM_ERROR, NOT_FOUND, 404, 403/blacklisted and tries another provider/model group.
4. Route affinity: remembers the last successful fallback route and prefers it on future calls.
5. Cooldown wait: if all keys are cooling and the soonest reset is within the timeout, waits and retries.
6. Health tracking: degrades health on rate limits, recovers on success, uses health as tie-breaker.
7. State persistence: persists only non-secret state (key IDs, lastUsedAt, resetAt, health scores).
8. Abort support: respects AbortSignal before acquire, during execute, and while waiting for cooldown.
9. Secret safety: raw API keys never appear in logs, errors, persisted state, or JSON output.

For SSE/streaming startup retry:
await scheduler.withStreamRetry({ provider, model, execute, signal });

Key rules:
- The `execute` callback MUST use the `provider`, `model`, and `apiKey` passed in its argument — not outer-scope variables. This is critical because fallback can change the route.
- Never log `apiKey`. It is the raw secret.
- Load key values from environment variables or a secret manager. Never hardcode.
- The wrapper throws safe package errors (KeyExhaustedError, ProviderRouteError, RetryAbortedError) with only non-secret fields.

Optional advanced features:
- `classifyError(error)`: force "retry" or "fail" for custom errors.
- `getRetryAfter(error)`: extract Retry-After from custom error shapes.
- `onRetry(event)` / `onFallback(event)`: observe retry/fallback events (safe fields only).
- `fallbacks: false` or `fallbacks: [{ provider, model }, ...]`: control route fallback behavior.
- `keyIdentity: { hmacSecret, onMismatch }`: detect swapped env keys after restart.
```

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

## The Core Abstraction

The entire point of this package is one function: **`scheduler.withRetry()`**. It wraps your AI call and manages everything:

```
┌─────────────────────────────────────────────────────────────┐
│  scheduler.withRetry({ provider, model, execute })          │
│                                                             │
│  1. Acquire key (LRU, health-aware)                         │
│  2. Inject { provider, model, apiKey } into execute()       │
│  3. On success → mark key healthy, return result            │
│  4. On 429/rate-limit → cooldown key, pick next, retry      │
│  5. On route error → fall back to another provider/model    │
│  6. On timeout/exhaust → throw safe KeyExhaustedError       │
│  7. On abort → throw safe RetryAbortedError                 │
└─────────────────────────────────────────────────────────────┘
```

**You never call `acquire()`, `success()`, `rateLimited()`, or `release()` manually.** The wrapper does it all. You write only the generation logic:

```ts
import { KeyScheduler, FileStateAdapter } from "ai-key-manager";

const scheduler = new KeyScheduler({
  providers: [
    {
      name: "openrouter",
      model: "google/gemma-4-26b-a4b-it:free",
      defaultCooldownMs: 60_000,
      keys: [
        { id: "openrouter-a7f3", value: process.env.OPENROUTER_API_KEY_A7F3 },
        { id: "openrouter-k2m9", value: process.env.OPENROUTER_API_KEY_K2M9 },
        { id: "openrouter-q4x8", value: process.env.OPENROUTER_API_KEY_Q4X8 }
      ]
    }
  ],
  state: new FileStateAdapter(".llm-key-state.json")
});

// This is ALL you write:
const text = await scheduler.withRetry({
  provider: "openrouter",
  model: "google/gemma-4-26b-a4b-it:free",
  execute: async ({ apiKey, provider, model, signal }) => {
    // provider, model, apiKey are injected by the scheduler.
    // Use them directly — fallback may change the route.
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
  provider: "google",
  model: "gemini-2.5-flash",
  execute: async ({ apiKey, provider, model, signal }) => {
    return generateWithAnySDK({ apiKey, provider, model, prompt: "Summarize this.", signal });
  }
});
```

For streaming/SSE startup, use the stream alias:

```ts
const stream = await scheduler.withStreamRetry({
  provider: "openrouter",
  model,
  execute: async ({ apiKey, provider, model, signal }) => {
    return startProviderStream({ apiKey, provider, model, prompt, signal });
  }
});
```

`withStreamRetry()` retries only failures that happen before the stream is returned. Once a stream exists, AI Key Manager marks the key as successful and does not retry mid-stream.

## Retry Intelligence

- **Key budget:** defaults to the total key count for the selected `provider + model`.
- **Deadline:** defaults to `60_000ms`; override with `timeoutMs`.
- **Cooldown wait:** if every key is cooling and the soonest reset is inside the deadline, the wrapper waits and retries.
- **Route fallback:** if a provider/model route is broken, the wrapper can try another configured provider/model group.
- **Route memory:** after a fallback success, later calls for the same requested route prefer the last successful route in this process.
- **Blacklist-safe route handling:** provider blacklisted/blocked route failures are treated as fallback-safe and move to the next route.
- **Safe failures:** if attempts or timeout are exhausted, it throws `KeyExhaustedError` with safe fields only.
- **Abort:** pass `signal` to abort before acquire, before execute, or while waiting for cooldown.
- **Custom classification:** use `classifyError(error)` to force `"retry"` or `"fail"` for provider-specific SDK errors.

## Provider/Model Fallback

Some AI gateways fail before generation starts because the requested provider/model route is invalid or unsupported. A common SSE error looks like this:

```txt
event: error
data: {"success":false,"message":"Stream failed","error":{"code":"UPSTREAM_ERROR","details":"Error 404, Message: models/gemini-3.0-flash is not found for API version v1beta, or is not supported for generateContent., Status: NOT_FOUND"}}
```

By default, `withRetry()` and `withStreamRetry()` treat route failures as fallback-safe and try the next configured provider/model group. They detect common shapes including `UPSTREAM_ERROR`, `NOT_FOUND`, HTTP `404`, `model_not_found`, `models/... is not found`, `unsupported model`, and `not supported for generateContent`.

They also treat common provider-blacklist/blocked route failures as fallback-safe (for example messages containing blacklist/blocked/provider-disabled semantics, including `403` + `FORBIDDEN` patterns from gateways).

When fallback succeeds, the wrapper remembers that successful route for the requested `provider + model` and prefers it first on the next call in the same process.

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

If every route fails, the wrapper throws `ProviderRouteError` with only safe fields: `provider`, `model`, and `routesTried`.

## Edge-Case Checklist

- Last provider memory: `withRetry()` stores the last successful route per requested `provider + model` and prefers it on future calls (same process).
- All keys exhausted in one provider/model route: the wrapper automatically continues to the next allowed fallback route.
- Provider accidentally blacklisted/blocked: route-level blacklist/blocked/403-forbidden patterns are treated as fallback-safe and move to another route.
- All providers route-fail with access/not-found: returns a clear `Model access denied or not found (404)` message via `ProviderRouteError`.
- Cooldown heap lifecycle: `rateLimited()` pushes keys into the cooldown min-heap by `resetAt`, and `acquire()` releases expired cooldowns before selection.
- Key state continuity: with `FileStateAdapter`, non-secret `lastUsedAt`, `resetAt`, and health counters are restored on restart; expired cooldowns are released on first acquire.

## Key Identity Safety

If users accidentally swap environment variables after a restart, a stable key ID can point to a different real token. Enable HMAC identity checks to avoid carrying old cooldown/health state onto a different token:

```ts
const scheduler = new KeyScheduler({
  providers,
  keyIdentity: {
    hmacSecret: process.env.AI_KEY_MANAGER_HMAC_SECRET!,
    onMismatch: "reset"
  }
});
```

AI Key Manager stores only an HMAC fingerprint, never the raw API key or HMAC secret. With `onMismatch: "reset"`, old cooldown and health state for that key ID is ignored. With `onMismatch: "throw"`, the scheduler throws `KeyIdentityMismatchError`.

## Wrapper Examples

### LangChain JS

```ts
import { ChatOpenAI } from "@langchain/openai";
import { KeyScheduler } from "ai-key-manager";

const model = "openai/gpt-4o-mini";

export async function askWithLangChain(scheduler: KeyScheduler, prompt: string) {
  return scheduler.withRetry({
    provider: "openrouter",
    model,
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

const model = "anthropic/claude-sonnet-4.6";

export async function askWithVercelAI(scheduler: KeyScheduler, prompt: string) {
  return scheduler.withRetry({
    provider: "vercel-ai-gateway",
    model,
    execute: async ({ apiKey, provider, model }) => {
      const gateway = createOpenAICompatible({
        name: "vercel-ai-gateway",
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
  provider: "google",
  model: "gemini-2.5-flash",
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

The IDs above are intentionally random-looking but non-secret. Keep real key values in environment variables or a secret manager.

## What `acquire()` Returns

> Note: you typically don't need `acquire()` directly. Use `withRetry()` instead.

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

`withRetry()` additionally keeps in-memory route affinity for each requested route so fallback wins can be reused on later calls.

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

## Release Log

### v0.1.0

- Core provider/model/key scheduler.
- Greedy LRU key selection.
- Cooldown min heap for exhausted keys.
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
- Added retry-wrapper tests for provider with keys route-memory preference, blacklisted route fallback, and exhausted-route fallback progression.

### v0.3.0

- Updated AI prompt to emphasize the `withRetry()` abstraction — devs just pass `execute` and receive `{ provider, model, apiKey }` injected.
- 31 comprehensive battle tests covering multi-provider cascade, cooldown timing, state persistence across restarts, concurrent acquire serialization, health score degradation/recovery, abort scenarios, route affinity memory, blacklist detection, custom error classification, and callback safety.
- README restructured around the core abstraction: the wrapper manages everything, devs write only generation logic.

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

Build output includes ESM, CJS, and TypeScript declarations under `dist/`.
