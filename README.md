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

What it does:
- Manages multiple AI providers, models, and API keys.
- Groups keys by provider + model.
- Selects the least recently used available key.
- Moves rate-limited keys into cooldown.
- Uses Retry-After when available; otherwise uses the provider default cooldown.
- Provides `scheduler.withRetry()` / `withKeyRetry()` to wrap LangChain, Vercel AI SDK, or any custom generation function.
- Retries retryable AI errors across the total number of keys configured for that provider/model.
- Uses a 60 second default retry deadline and waits for cooling keys only when their reset is inside that deadline.
- Falls back to other configured provider/model groups for route failures like UPSTREAM_ERROR, NOT_FOUND, model-not-found, or unsupported generateContent errors.
- Remembers the last successful fallback route in-memory for each requested provider/model and prefers it on later calls.
- Treats blacklisted or blocked route errors (for example provider-level 403/FORBIDDEN with blacklist/blocked signals) as fallback-safe.
- Supports AbortSignal, SSE/start-stream startup retry, health-aware key tie-breaking, and optional HMAC key identity checks.
- Persists only non-secret scheduling state if FileStateAdapter is used.
- Keeps raw API keys local and wrapped in SecretString.
- Makes no telemetry or external network calls by itself.

How to use it:
1. Import `KeyScheduler`, `FileStateAdapter` or `MemoryStateAdapter`, and `isRateLimitError` from `ai-key-manager`.
2. Configure providers with stable key IDs and API key values from environment variables.
3. Prefer wrapping AI calls with:
   `await scheduler.withRetry({ provider, model, execute, signal })`
4. For SSE/start-stream calls, use:
   `await scheduler.withStreamRetry({ provider, model, execute, signal })`
5. Inside `execute`, pass the current route and key to the provider SDK using:
   `provider`, `model`, and `apiKey`
6. Keep fallback enabled for MVP-safe routing, or set `fallbacks: false` / an explicit fallback list for stricter production control.
7. The wrapper automatically calls `success()`, `rateLimited()`, or `release()`.
8. It treats 429, rate-limit, quota, and exhausted-key messages as retryable.
9. It throws safe package errors when attempts, timeout, abort, or route fallback exhaustion stop the retry loop.

Manual flow:
1. Before calling the AI SDK, call:
   `const lease = await scheduler.acquire({ provider, model })`
2. Pass the real key to the provider SDK using:
   `lease.key.secret.value()`
3. If the provider request succeeds, call:
   `await lease.success()`
4. If the provider returns a rate-limit error, call:
   `await lease.rateLimited({ retryAfter })`
5. For any other error, call:
   `await lease.release()`

Security rules:
- Never log `lease.key.secret.value()`.
- Never hardcode API keys in source code.
- Load keys from env vars or a secret manager.
- Do not persist raw API key values.
- Do not send keys, prompts, responses, headers, or metadata to any service except the provider SDK call the user explicitly requested.

Preferred wrapper pattern:

const result = await scheduler.withRetry({
  provider: "openrouter",
  model,
  signal: abortController.signal,
  execute: async ({ apiKey, provider, model, signal }) => {
    return callProvider({ apiKey, provider, model, prompt, signal });
  }
});

Manual pattern:

const lease = await scheduler.acquire({ provider: "openrouter", model });

try {
  const result = await callProvider({
    apiKey: lease.key.secret.value(),
    model,
    prompt
  });
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

## Preferred: Wrap Any AI Call With Retry

Use `scheduler.withRetry()` when you want the package to handle acquire/success/rate-limit/release for you.

```ts
import {
  FileStateAdapter,
  KeyScheduler
} from "ai-key-manager";

const model = "google/gemma-4-26b-a4b-it:free";

const scheduler = new KeyScheduler({
  providers: [
    {
      name: "openrouter",
      model,
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

const text = await scheduler.withRetry({
  provider: "openrouter",
  model,
  timeoutMs: 60_000,
  execute: async ({ apiKey, provider, model, key, attempt, maxAttempts, remainingMs, signal }) => {
    // `apiKey` is the raw key. Use it only for the provider SDK call.
    // `provider`, `model`, `key.id`, `attempt`, `maxAttempts`, and `remainingMs` are safe for logs.
    return generateContent({
      apiKey,
      provider,
      model,
      prompt: "Write a short hello world.",
      signal
    });
  }
});
```

`withRetry()` retries only retryable key/provider failures. By default it treats these as retryable:

- HTTP status `429`
- `rate_limit_exceeded`
- messages containing `429`
- messages containing `rate limit`
- messages containing `too many requests`
- messages containing `quota`
- messages containing `exhausted`

It retries up to the total number of keys configured for that exact `provider + model`. Non-rate-limit errors are released and rethrown immediately.

If the selected provider/model route itself is broken, such as a provider returning `UPSTREAM_ERROR`, `NOT_FOUND`, `model_not_found`, or "not supported for generateContent", the wrapper can move to another configured provider/model group. In that case, `provider` and `model` in `execute` are the current route, not necessarily the original input.

## Wrap Any Provider Function

AI Key Manager does not care which AI SDK you use. If your function accepts an API key, wrap it:

```ts
const result = await scheduler.withRetry({
  provider: "google",
  model: "gemini-2.5-flash",
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

Use the `provider` and `model` passed into `execute`. They represent the current route, so fallback can move from one configured group to another without your wrapper accidentally calling the old model.

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

`withStreamRetry()` retries only failures that happen before the stream is returned. Once a stream exists, AI Key Manager marks the key as successful and does not retry mid-stream, which avoids duplicated tokens or double-billed output.

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

When fallback succeeds, the wrapper remembers that successful route for the requested `provider + model` and prefers it first on the next call in the same process, which avoids repeatedly probing a known-bad route.

```ts
const response = await scheduler.withRetry({
  provider: "google",
  model: "gemini-3.0-flash",
  execute: async ({ apiKey, provider, model, signal }) => {
    return generateWithRoute({ apiKey, provider, model, prompt, signal });
  }
});
```

For stricter control, disable fallback or provide an ordered list:

```ts
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

await scheduler.withRetry({
  provider: "google",
  model: "gemini-3.0-flash",
  fallbacks: false,
  execute
});
```

If every route fails before generation starts, the wrapper throws `ProviderRouteError` with only safe fields: `provider`, `model`, and `routesTried`.

## Edge-Case Checklist

- Last provider memory: `withRetry()` stores the last successful route per requested `provider + model` and prefers it on future calls (same process).
- All keys exhausted in one provider/model route: the wrapper automatically continues to the next allowed fallback route.
- Provider accidentally blacklisted/blocked: route-level blacklist/blocked/403-forbidden patterns are treated as fallback-safe and move to another route.
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

## Manual Lease Flow

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
    execute: async ({ apiKey }) => {
      const llm = new ChatOpenAI({
        model,
        apiKey,
        configuration: {
          baseURL: "https://openrouter.ai/api/v1"
        }
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
    execute: async ({ apiKey }) => {
      const gateway = createOpenAICompatible({
        name: "vercel-ai-gateway",
        apiKey,
        baseURL: "https://ai-gateway.vercel.sh/v1"
      });

      const result = await generateText({
        model: gateway(model),
        prompt
      });

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
  execute: async ({ apiKey }) => {
    return generateWithYourSDK({
      apiKey,
      prompt: "Summarize this document."
    });
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

`withRetry()` additionally keeps in-memory route affinity for each requested route so fallback wins can be reused on later calls.

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
- Added retry-wrapper tests for route-memory preference, blacklisted route fallback, and exhausted-route fallback progression.

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
