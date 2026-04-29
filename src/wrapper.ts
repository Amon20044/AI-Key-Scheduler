import { isRateLimitError, KeyExhaustedError, NoAvailableKeyError, ProviderRouteError, RetryAbortedError } from "./errors.js";
import { MaxScoreHeap } from "./heap.js";
import type { KeyScheduler } from "./scheduler.js";
import type { AcquireRequest, KeyFallbackEvent, KeyRetryEvent, ProviderStrategyOptions, WithKeyRetryOptions } from "./types.js";

export const DEFAULT_RETRY_TIMEOUT_MS = 60_000;
export const DEFAULT_RETRY_POLL_INTERVAL_MS = 50;
const RETRYABLE_ERROR_PATTERN =
  /\b429\b|rate[\s_-]?limit|too many requests|quota|exhausted|resource[\s_-]?exhausted|key[\s_-]?exhausted|insufficient[\s_-]?quota|quota[\s_-]?exceeded/i;
const FALLBACK_ERROR_PATTERN =
  /upstream[\s_-]?error|not[\s_-]?found|model[\s\S]{0,80}not[\s_-]?found|not supported for generatecontent|unsupported model|model_not_found|not_supported|provider[\s_-]?(?:blacklist(?:ed)?|blocked|banned|disabled)|blacklist(?:ed)?|403[\s\S]{0,20}(?:forbidden|blacklist(?:ed)?|blocked)|404/i;
const MODEL_ACCESS_DENIED_OR_NOT_FOUND_PATTERN =
  /model[\s\S]{0,80}not[\s_-]?found|not[\s_-]?found|model_not_found|access[\s_-]?denied|forbidden|403|404|not supported for generatecontent|unsupported model|blacklist(?:ed)?|provider[\s_-]?(?:blocked|disabled|banned)/i;
const routeAffinityByScheduler = new WeakMap<KeyScheduler, Map<string, AcquireRequest>>();
const providerStateByScheduler = new WeakMap<KeyScheduler, Map<string, ProviderRuntimeState>>();
const roundRobinCursorByScheduler = new WeakMap<KeyScheduler, number>();

interface ProviderRuntimeState {
  name: string;
  successCount: number;
  failureCount: number;
  avgLatency: number;
  lastUsedAt: number;
  cooldownUntil?: number;
}

export async function withKeyRetry<T>(scheduler: KeyScheduler, options: WithKeyRetryOptions<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_RETRY_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const routes = buildRoutes(scheduler, options);
  const requestedRoute: AcquireRequest = options.provider && options.model
    ? { provider: options.provider, model: options.model }
    : routes[0] ?? { provider: "unknown", model: "unknown" };
  let lastExhaustedError: KeyExhaustedError | undefined;

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    const maxAttempts = options.maxAttempts ?? scheduler.getKeyCount(route);
    if (maxAttempts <= 0) {
      throw new NoAvailableKeyError(`No retry attempts available for provider "${route.provider}" and model "${route.model}".`, {
        provider: route.provider,
        model: route.model
      });
    }

    let lastRetryableKeyId: string | undefined;
    let attempts = 0;

    let movedToFallback = false;

    while (attempts < maxAttempts) {
      throwIfAborted({ ...options, ...route }, attempts, maxAttempts);

      if (isTimedOut(now(), deadline)) {
        throw exhaustedError(route, {
          keyId: lastRetryableKeyId,
          reason: "timeout",
          attempts,
          maxAttempts,
          timeoutMs
        });
      }

      let lease;
      try {
        throwIfAborted({ ...options, ...route }, attempts, maxAttempts);
        lease = await scheduler.acquire(route);
      } catch (error) {
        if (error instanceof NoAvailableKeyError) {
          await waitForAvailability({
            error,
            provider: route.provider,
            model: route.model,
            keyId: lastRetryableKeyId,
            attempts,
            maxAttempts,
            timeoutMs,
            pollIntervalMs,
            now,
            deadline,
            sleep,
            signal: options.signal
          });
          continue;
        }
        throw error;
      }

      attempts += 1;
      const attempt = attempts;
      const attemptStartedAt = now();

      try {
        if (options.signal?.aborted) {
          await lease.release();
          throw abortedError({ provider: route.provider, model: route.model, attempts: attempts - 1, maxAttempts });
        }
        const result = await options.execute({
          key: lease.key,
          apiKey: lease.key.secret.value(),
          lease,
          provider: route.provider,
          model: route.model,
          attempt,
          maxAttempts,
          remainingMs: Math.max(0, deadline - now()),
          signal: options.signal
        });
        const latencyMs = Math.max(0, now() - attemptStartedAt);
        await lease.success({ latencyMs });
        updateProviderState(scheduler, route, {
          now: now(),
          latencyMs,
          success: true
        });
        rememberRouteAffinity(scheduler, requestedRoute, route);
        return result;
      } catch (error) {
        if (options.signal?.aborted) {
          await lease.release();
          throw abortedError({ provider: route.provider, model: route.model, attempts, maxAttempts });
        }

        if (isFallbackRouteError(error, options)) {
          const latencyMs = Math.max(0, now() - attemptStartedAt);
          await lease.release();
          updateProviderState(scheduler, route, {
            now: now(),
            latencyMs,
            success: false,
            cooldownMs: 2_000
          });
          clearRouteAffinityIfFailed(scheduler, requestedRoute, route);
          if (routeIndex >= routes.length - 1) {
            const routeErrorMessage = isModelAccessDeniedOrNotFoundError(error)
              ? "Model access denied or not found (404) across all configured provider/model routes."
              : `Provider/model route failed for provider "${route.provider}" and model "${route.model}".`;

            throw new ProviderRouteError(routeErrorMessage, {
              provider: route.provider,
              model: route.model,
              routesTried: routes.length
            });
          }

          const nextRoute = routes[routeIndex + 1];
          rememberRouteAffinity(scheduler, requestedRoute, nextRoute);

          await options.onFallback?.({
            fromProvider: route.provider,
            fromModel: route.model,
            toProvider: nextRoute.provider,
            toModel: nextRoute.model,
            attempt,
            maxAttempts,
            remainingMs: Math.max(0, deadline - now()),
            ...safeErrorFields(error)
          });
          movedToFallback = true;
          break;
        }

        const classification = classifyKeyError(error, options);
        if (classification === "retry") {
          lastRetryableKeyId = lease.key.id;
          const retryAfter = options.getRetryAfter?.(error) ?? extractRetryAfter(error);
          const latencyMs = Math.max(0, now() - attemptStartedAt);
          await lease.rateLimited({ retryAfter, latencyMs });
          const parsedRetryAfterMs =
            typeof retryAfter === "number"
              ? retryAfter * 1000
              : typeof retryAfter === "string" && Number.isFinite(Number(retryAfter))
                ? Number(retryAfter) * 1000
                : undefined;
          updateProviderState(scheduler, route, {
            now: now(),
            latencyMs,
            success: false,
            cooldownMs: parsedRetryAfterMs
          });
          await options.onRetry?.({
            keyId: lease.key.id,
            provider: route.provider,
            model: route.model,
            attempt,
            maxAttempts,
            remainingMs: Math.max(0, deadline - now()),
            retryAfter,
            ...safeErrorFields(error)
          });
          continue;
        }

        await lease.release({ recordFailure: true, latencyMs: Math.max(0, now() - attemptStartedAt) });
        updateProviderState(scheduler, route, {
          now: now(),
          latencyMs: Math.max(0, now() - attemptStartedAt),
          success: false
        });
        throw error;
      }
    }

    if (movedToFallback) {
      continue;
    }

    lastExhaustedError = exhaustedError(route, {
      keyId: lastRetryableKeyId,
      reason: "max_attempts",
      attempts,
      maxAttempts,
      timeoutMs
    });
  }

  const fallbackRoute = routes[0] ?? { provider: options.provider ?? "unknown", model: options.model ?? "unknown" };
  throw lastExhaustedError ?? exhaustedError(fallbackRoute, { reason: "no_available_key", attempts: 0, maxAttempts: 0, timeoutMs });
}

export async function withStreamKeyRetry<T>(scheduler: KeyScheduler, options: WithKeyRetryOptions<T>): Promise<T> {
  return withKeyRetry(scheduler, options);
}

export function isRetryableKeyError(error: unknown, custom?: (error: unknown) => boolean): boolean {
  if (custom?.(error)) {
    return true;
  }

  if (isRateLimitError(error)) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return RETRYABLE_ERROR_PATTERN.test(String(error));
  }

  const maybeError = error as { status?: unknown; statusCode?: unknown };

  if (maybeError.status === 429 || maybeError.statusCode === 429) {
    return true;
  }

  return RETRYABLE_ERROR_PATTERN.test(collectErrorText(error));
}

export function isFallbackRouteError(error: unknown, options: Pick<WithKeyRetryOptions<unknown>, "isFallbackError"> = {}): boolean {
  if (options.isFallbackError?.(error)) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return FALLBACK_ERROR_PATTERN.test(String(error));
  }

  const maybeError = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = maybeError.status ?? maybeError.statusCode;
  const code = typeof maybeError.code === "string" ? maybeError.code.toUpperCase() : undefined;
  const text = collectErrorText(error);

  if (
    code === "UPSTREAM_ERROR" ||
    code === "NOT_FOUND" ||
    code === "MODEL_NOT_FOUND" ||
    code === "FORBIDDEN" ||
    code === "PROVIDER_BLACKLISTED" ||
    code === "BLACKLISTED_PROVIDER" ||
    code === "PROVIDER_BLOCKED"
  ) {
    return true;
  }

  return (status === 404 || status === 403 || code === undefined) && FALLBACK_ERROR_PATTERN.test(text);
}

function classifyKeyError<T>(error: unknown, options: WithKeyRetryOptions<T>): "retry" | "fail" {
  const customClassification = options.classifyError?.(error);
  if (customClassification === "retry" || customClassification === "fail") {
    return customClassification;
  }

  return isRetryableKeyError(error, options.isRetryableError) ? "retry" : "fail";
}

function isModelAccessDeniedOrNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return MODEL_ACCESS_DENIED_OR_NOT_FOUND_PATTERN.test(String(error));
  }

  const maybeError = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = maybeError.status ?? maybeError.statusCode;
  const code = typeof maybeError.code === "string" ? maybeError.code.toUpperCase() : undefined;
  const text = collectErrorText(error);

  if (
    status === 403 ||
    status === 404 ||
    code === "UPSTREAM_ERROR" ||
    code === "NOT_FOUND" ||
    code === "MODEL_NOT_FOUND" ||
    code === "FORBIDDEN" ||
    code === "PROVIDER_BLACKLISTED" ||
    code === "BLACKLISTED_PROVIDER" ||
    code === "PROVIDER_BLOCKED"
  ) {
    return MODEL_ACCESS_DENIED_OR_NOT_FOUND_PATTERN.test(text);
  }

  return MODEL_ACCESS_DENIED_OR_NOT_FOUND_PATTERN.test(text);
}

function buildRoutes<T>(scheduler: KeyScheduler, options: WithKeyRetryOptions<T>): AcquireRequest[] {
  const routes: AcquireRequest[] = [];

  const addRoute = (route: AcquireRequest) => {
    if (!routes.some((candidate) => candidate.provider === route.provider && candidate.model === route.model)) {
      routes.push({ provider: route.provider, model: route.model });
    }
  };

  // When provider/model are not specified, use all configured groups
  const hasRequestedRoute = options.provider !== undefined && options.model !== undefined;

  if (!hasRequestedRoute) {
    const selected = selectAutoRoutes(scheduler, options.providerStrategy);
    for (const group of selected) {
      addRoute(toAcquireRequest(group));
    }
    return routes;
  }

  const requestedRoute: AcquireRequest = { provider: options.provider!, model: options.model! };

  if (options.fallbacks === false) {
    addRoute(requestedRoute);
    return routes;
  }

  const fallbackRoutes: AcquireRequest[] =
    options.fallbacks === undefined || options.fallbacks === "all"
      ? scheduler.listGroups().map((route) => toAcquireRequest(route))
      : options.fallbacks;

  const preferredRoute = getPreferredRoute(scheduler, requestedRoute);
  if (preferredRoute && isAllowedRoute(preferredRoute, requestedRoute, fallbackRoutes)) {
    addRoute(preferredRoute);
  }

  addRoute(requestedRoute);

  for (const route of fallbackRoutes) {
    addRoute(route);
  }

  return routes;
}

function selectAutoRoutes(scheduler: KeyScheduler, strategy?: ProviderStrategyOptions): AcquireRequest[] {
  const groups = scheduler.listGroups().map((group) => toAcquireRequest(group));
  const activeStrategy = strategy?.type ?? "adaptive";
  if (groups.length <= 1) {
    return groups;
  }

  if (activeStrategy === "ordered") {
    return buildOrderedRoutes(groups, strategy?.order);
  }

  if (activeStrategy === "round-robin") {
    const cursor = roundRobinCursorByScheduler.get(scheduler) ?? 0;
    const next = cursor % groups.length;
    roundRobinCursorByScheduler.set(scheduler, next + 1);
    return [...groups.slice(next), ...groups.slice(0, next)];
  }

  if (activeStrategy === "weighted") {
    return buildWeightedRoutes(groups, strategy?.weights);
  }

  return buildAdaptiveRoutes(scheduler, groups, strategy?.explorationEpsilon ?? 0.05);
}

function buildOrderedRoutes(groups: AcquireRequest[], order: AcquireRequest[] | undefined): AcquireRequest[] {
  if (!order || order.length === 0) {
    return groups;
  }
  const ordered: AcquireRequest[] = [];
  for (const route of order) {
    const found = groups.find((candidate) => sameRoute(candidate, route));
    if (found && !ordered.some((candidate) => sameRoute(candidate, found))) {
      ordered.push(found);
    }
  }
  for (const group of groups) {
    if (!ordered.some((candidate) => sameRoute(candidate, group))) {
      ordered.push(group);
    }
  }
  return ordered;
}

function buildWeightedRoutes(groups: AcquireRequest[], weights: Record<string, number> | undefined): AcquireRequest[] {
  const remaining = [...groups];
  const ordered: AcquireRequest[] = [];
  while (remaining.length > 0) {
    const total = remaining.reduce((sum, route) => sum + getRouteWeight(route, weights), 0);
    let cursor = Math.random() * Math.max(total, 0.001);
    let selectedIndex = 0;
    for (let i = 0; i < remaining.length; i += 1) {
      cursor -= getRouteWeight(remaining[i], weights);
      if (cursor <= 0) {
        selectedIndex = i;
        break;
      }
    }
    ordered.push(remaining.splice(selectedIndex, 1)[0]);
  }
  return ordered;
}

function buildAdaptiveRoutes(scheduler: KeyScheduler, groups: AcquireRequest[], epsilon: number): AcquireRequest[] {
  const store = getProviderStore(scheduler);
  const heap = new MaxScoreHeap<{ id: string; score: number; route: AcquireRequest }>();
  const now = Date.now();

  for (const route of groups) {
    const state = getOrCreateProviderState(store, route);
    const score = getProviderScore(state, now, epsilon);
    heap.upsert({ id: routeKey(route), score, route });
  }

  const ordered: AcquireRequest[] = [];
  while (heap.size > 0) {
    ordered.push(heap.pop()!.route);
  }
  return ordered;
}

function getRouteWeight(route: AcquireRequest, weights: Record<string, number> | undefined): number {
  if (!weights) {
    return 1;
  }
  return Math.max(0.001, weights[routeKey(route)] ?? weights[route.provider] ?? 1);
}

function toAcquireRequest(input: { provider: string; model: string }): AcquireRequest {
  return {
    provider: input.provider,
    model: input.model
  };
}

function routeKey(route: AcquireRequest): string {
  return `${route.provider}\u0000${route.model}`;
}

function sameRoute(left: AcquireRequest, right: AcquireRequest): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function isAllowedRoute(route: AcquireRequest, requestedRoute: AcquireRequest, fallbackRoutes: AcquireRequest[]): boolean {
  return sameRoute(route, requestedRoute) || fallbackRoutes.some((candidate) => sameRoute(route, candidate));
}

function getAffinityStore(scheduler: KeyScheduler): Map<string, AcquireRequest> {
  const existing = routeAffinityByScheduler.get(scheduler);
  if (existing) {
    return existing;
  }

  const created = new Map<string, AcquireRequest>();
  routeAffinityByScheduler.set(scheduler, created);
  return created;
}

function getProviderStore(scheduler: KeyScheduler): Map<string, ProviderRuntimeState> {
  const existing = providerStateByScheduler.get(scheduler);
  if (existing) {
    return existing;
  }
  const created = new Map<string, ProviderRuntimeState>();
  providerStateByScheduler.set(scheduler, created);
  return created;
}

function getOrCreateProviderState(
  store: Map<string, ProviderRuntimeState>,
  route: AcquireRequest
): ProviderRuntimeState {
  const key = routeKey(route);
  const existing = store.get(key);
  if (existing) {
    return existing;
  }
  const created: ProviderRuntimeState = {
    name: route.provider,
    successCount: 0,
    failureCount: 0,
    avgLatency: 0,
    lastUsedAt: 0
  };
  store.set(key, created);
  return created;
}

function updateProviderState(
  scheduler: KeyScheduler,
  route: AcquireRequest,
  update: { now: number; latencyMs: number; success: boolean; cooldownMs?: number }
): void {
  const store = getProviderStore(scheduler);
  const state = getOrCreateProviderState(store, route);
  state.lastUsedAt = update.now;
  state.avgLatency = state.avgLatency > 0 ? state.avgLatency * 0.8 + update.latencyMs * 0.2 : update.latencyMs;
  if (update.success) {
    state.successCount += 1;
    state.cooldownUntil = undefined;
    return;
  }

  state.failureCount += 1;
  if (update.cooldownMs !== undefined && Number.isFinite(update.cooldownMs) && update.cooldownMs > 0) {
    state.cooldownUntil = update.now + update.cooldownMs;
  }
}

function getProviderScore(provider: ProviderRuntimeState, now: number, epsilon: number): number {
  const successRate = provider.successCount / (provider.successCount + provider.failureCount + 1);
  const latencyScore = 1 / (provider.avgLatency + 1);
  const recencyScore = 1 / (Math.max(0, now - provider.lastUsedAt) + 1);
  const cooldownPenalty = now < (provider.cooldownUntil ?? 0) ? -100 : 0;
  const totalAttempts = provider.successCount + provider.failureCount;
  const exploration = totalAttempts > 0 ? Math.random() * epsilon : 0;
  return 0.4 * successRate + 0.3 * latencyScore + 0.2 * recencyScore + cooldownPenalty + exploration;
}

function getPreferredRoute(scheduler: KeyScheduler, requestedRoute: AcquireRequest): AcquireRequest | undefined {
  const store = routeAffinityByScheduler.get(scheduler);
  if (!store) {
    return undefined;
  }

  const preferredRoute = store.get(routeKey(requestedRoute));
  if (!preferredRoute) {
    return undefined;
  }

  const configured = scheduler.listGroups().some((candidate) => sameRoute(candidate, preferredRoute));
  if (configured) {
    return preferredRoute;
  }

  store.delete(routeKey(requestedRoute));
  return undefined;
}

function rememberRouteAffinity(scheduler: KeyScheduler, requestedRoute: AcquireRequest, successfulRoute: AcquireRequest): void {
  getAffinityStore(scheduler).set(routeKey(requestedRoute), toAcquireRequest(successfulRoute));
}

function clearRouteAffinityIfFailed(scheduler: KeyScheduler, requestedRoute: AcquireRequest, failedRoute: AcquireRequest): void {
  const store = routeAffinityByScheduler.get(scheduler);
  if (!store) {
    return;
  }

  const key = routeKey(requestedRoute);
  const preferredRoute = store.get(key);
  if (preferredRoute && sameRoute(preferredRoute, failedRoute)) {
    store.delete(key);
  }
}

export function extractRetryAfter(error: unknown): string | number | Date | null | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const maybeError = error as {
    retryAfter?: string | number | Date | null;
    headers?: RetryAfterHeaders;
    response?: { headers?: RetryAfterHeaders };
    responseHeaders?: RetryAfterHeaders;
  };

  return (
    maybeError.retryAfter ??
    readRetryAfterHeader(maybeError.headers) ??
    readRetryAfterHeader(maybeError.response?.headers) ??
    readRetryAfterHeader(maybeError.responseHeaders)
  );
}

interface WaitForAvailabilityOptions {
  error: NoAvailableKeyError;
  provider: string;
  model: string;
  keyId?: string;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

async function waitForAvailability(options: WaitForAvailabilityOptions): Promise<void> {
  throwIfAborted(options, options.attempts, options.maxAttempts);
  const currentTime = options.now();
  const remainingMs = options.deadline - currentTime;
  if (remainingMs <= 0) {
    throw exhaustedError(options, {
      keyId: options.keyId,
      reason: "timeout",
      attempts: options.attempts,
      maxAttempts: options.maxAttempts,
      timeoutMs: options.timeoutMs,
      resetAt: options.error.nextResetAt
    });
  }

  const waitMs =
    options.error.nextResetAt !== undefined
      ? Math.max(0, options.error.nextResetAt - currentTime)
      : Math.max(1, options.pollIntervalMs);

  if (waitMs > remainingMs) {
    throw exhaustedError(options, {
      keyId: options.keyId,
      reason: "timeout",
      attempts: options.attempts,
      maxAttempts: options.maxAttempts,
      timeoutMs: options.timeoutMs,
      resetAt: options.error.nextResetAt
    });
  }

  await sleepWithAbort(waitMs, options.sleep, options.signal, options);
}

function exhaustedError(
  options: { provider: string; model: string },
  details: {
    keyId?: string;
    reason: "max_attempts" | "timeout" | "no_available_key";
    attempts: number;
    maxAttempts: number;
    timeoutMs: number;
    resetAt?: number;
  }
): KeyExhaustedError {
  const reasonText = details.reason === "timeout" ? "Retry timeout reached" : "Retry key budget exhausted";
  return new KeyExhaustedError(`${reasonText} for provider "${options.provider}" and model "${options.model}".`, {
    keyId: details.keyId ?? "unknown",
    provider: options.provider,
    model: options.model,
    resetAt: details.resetAt,
    reason: details.reason,
    attempts: details.attempts,
    maxAttempts: details.maxAttempts,
    timeoutMs: details.timeoutMs
  });
}

function isTimedOut(currentTime: number, deadline: number): boolean {
  return currentTime >= deadline;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function sleepWithAbort(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
  options: { provider: string; model: string; attempts: number; maxAttempts: number }
): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }

  throwIfAborted({ provider: options.provider, model: options.model, signal }, options.attempts, options.maxAttempts);
  let onAbort: (() => void) | undefined;
  try {
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(abortedError(options));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([sleep(ms), abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
  throwIfAborted({ provider: options.provider, model: options.model, signal }, options.attempts, options.maxAttempts);
}

function throwIfAborted(
  options: { provider: string; model: string; signal?: AbortSignal },
  attempts: number,
  maxAttempts: number
): void {
  if (options.signal?.aborted) {
    throw abortedError({ ...options, attempts, maxAttempts });
  }
}

function abortedError(options: { provider: string; model: string; attempts: number; maxAttempts: number }): RetryAbortedError {
  return new RetryAbortedError(`Retry aborted for provider "${options.provider}" and model "${options.model}".`, {
    provider: options.provider,
    model: options.model,
    attempts: options.attempts,
    maxAttempts: options.maxAttempts
  });
}

function safeErrorFields(error: unknown): Pick<KeyRetryEvent, "errorName" | "errorCode" | "errorStatus"> {
  if (!error || typeof error !== "object") {
    return {};
  }

  const maybeError = error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  const status = typeof maybeError.status === "number" ? maybeError.status : typeof maybeError.statusCode === "number" ? maybeError.statusCode : undefined;
  return {
    errorName: typeof maybeError.name === "string" ? maybeError.name : undefined,
    errorCode: typeof maybeError.code === "string" || typeof maybeError.code === "number" ? maybeError.code : undefined,
    errorStatus: status
  };
}

function collectErrorText(error: unknown, seen = new WeakSet<object>(), depth = 0): string {
  if (depth > 4 || error === null || error === undefined) {
    return "";
  }

  if (typeof error === "string" || typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }

  if (error instanceof Error) {
    const cause = "cause" in error ? collectErrorText((error as { cause?: unknown }).cause, seen, depth + 1) : "";
    return [error.name, error.message, cause].join(" ");
  }

  if (typeof error !== "object") {
    return "";
  }

  if (Array.isArray(error)) {
    return error.map((item) => collectErrorText(item, seen, depth + 1)).join(" ");
  }

  if (seen.has(error)) {
    return "";
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  const directFields = ["status", "statusCode", "code", "name", "type", "message", "error", "errors", "cause", "response", "data", "body"];
  return directFields.map((field) => collectErrorText(record[field], seen, depth + 1)).join(" ");
}

type RetryAfterHeaders =
  | Headers
  | {
      get?: (name: string) => string | null | undefined;
      [key: string]: string | string[] | ((name: string) => string | null | undefined) | undefined;
    };

function readRetryAfterHeader(headers: RetryAfterHeaders | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (typeof headers.get === "function") {
    return headers.get("retry-after") ?? headers.get("Retry-After") ?? undefined;
  }

  const headerRecord = headers as Record<string, string | string[] | ((name: string) => string | null | undefined) | undefined>;
  const value = headerRecord["retry-after"] ?? headerRecord["Retry-After"];
  return typeof value === "function" ? undefined : Array.isArray(value) ? value[0] : value;
}

export type { KeyRetryEvent, WithKeyRetryOptions } from "./types.js";
