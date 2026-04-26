# Security

AI Key Manager is a local-first library for API key scheduling. Users bring their own API keys inside their own backend or application runtime. The package only chooses which key should be used next.

## Local-First Guarantee

AI Key Manager does not send API keys, prompts, responses, metadata, analytics, or telemetry to any external server. The scheduler has no request function and makes zero outbound network calls during key selection, success reporting, release, cooldown handling, or state persistence.

There is no background telemetry worker, no analytics endpoint, and no timer that uploads data.

## Secret Handling

Secrets are wrapped in `SecretString`.

```ts
const secret = new SecretString("sk-real-key");

console.log(secret);      // [REDACTED]
String(secret);           // [REDACTED]
JSON.stringify(secret);   // "[REDACTED]"
secret.value();           // "sk-real-key"
```

The raw key is available only through the explicit `secret.value()` method. This is intended for the exact provider SDK call that requires the API key.

Do not log `secret.value()`.

## Storage

By default, scheduler state is memory-only.

`FileStateAdapter` is optional and stores only non-secret scheduling state:

- key ID
- provider
- model
- `lastUsedAt`
- `resetAt`
- optional non-secret metadata

It never persists raw API keys.

## Logging

Use `sanitizeForLog()` before logging unknown objects. It recursively redacts:

- `apiKey`
- `key`
- `secret`
- `token`
- `authorization`
- `password`
- `bearer`
- `accessToken`
- `refreshToken`
- `prompt`
- `response`
- request `body`
- `metadata`

Safe logs may include key ID, provider, model, exhausted status, reset time, and cooldown duration.

## Errors

Custom errors include only safe fields such as key ID, provider, model, and reset timestamps. Error messages must not include raw secrets, prompts, responses, authorization headers, or request bodies.

## User Responsibilities

- Load keys from environment variables or your own secret manager.
- Do not hardcode API keys in source code.
- Do not log `secret.value()`.
- Treat key IDs as non-secret but stable operational identifiers.
- Keep metadata non-secret if you use a persistent state adapter.

If a proxy/request mode is added in the future, it must be self-hosted or explicitly enabled by the user. It must not become default telemetry.
