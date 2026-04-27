import type { KeyExecutionContext, KeyScheduler, WithKeyRetryOptions } from "@ai-key-scheduler/core";

type MaybePromise<T> = T | Promise<T>;
type ProviderRoute = Pick<WithKeyRetryOptions<unknown>, "provider" | "model" | "fallbacks">;
type RetryControls<TResult> = Omit<WithKeyRetryOptions<TResult>, "execute" | "provider" | "model" | "fallbacks">;

export type AISDKCall<TOptions extends Record<string, unknown>, TResult> = (options: TOptions) => Promise<TResult>;
export type AISDKOptionsFactory<TOptions extends Record<string, unknown>> = TOptions | ((context: KeyExecutionContext) => MaybePromise<TOptions>);

export interface AISDKAdapterOptions<TOptions extends Record<string, unknown>, TResult> extends ProviderRoute, RetryControls<TResult> {
  scheduler: KeyScheduler;
  call: AISDKCall<TOptions, TResult>;
  options: AISDKOptionsFactory<TOptions>;
  createModel: (context: KeyExecutionContext) => MaybePromise<unknown>;
}

export type GenerateTextWithKeyOptions<TOptions extends Record<string, unknown>, TResult> = AISDKAdapterOptions<TOptions, TResult>;
export type StreamTextWithKeyOptions<TOptions extends Record<string, unknown>, TResult> = AISDKAdapterOptions<TOptions, TResult>;

export async function callWithKey<TOptions extends Record<string, unknown>, TResult>(
  options: AISDKAdapterOptions<TOptions, TResult>
): Promise<TResult> {
  const { scheduler, provider, model, fallbacks, call, options: aiOptions, createModel, ...retryOptions } = options;

  return scheduler.withRetry({
    ...retryOptions,
    provider,
    model,
    fallbacks,
    execute: async (context) => {
      const [resolvedOptions, resolvedModel] = await Promise.all([resolveOptions(aiOptions, context), createModel(context)]);
      return call({
        ...resolvedOptions,
        model: resolvedModel,
        abortSignal: context.signal ?? resolvedOptions.abortSignal
      } as TOptions);
    }
  });
}

export function generateTextWithKey<TOptions extends Record<string, unknown>, TResult>(
  options: GenerateTextWithKeyOptions<TOptions, TResult>
): Promise<TResult> {
  return callWithKey(options);
}

export function streamTextWithKey<TOptions extends Record<string, unknown>, TResult>(
  options: StreamTextWithKeyOptions<TOptions, TResult>
): Promise<TResult> {
  return callWithKey(options);
}

async function resolveOptions<TOptions extends Record<string, unknown>>(
  options: AISDKOptionsFactory<TOptions>,
  context: KeyExecutionContext
): Promise<TOptions> {
  return typeof options === "function" ? (options as (context: KeyExecutionContext) => MaybePromise<TOptions>)(context) : options;
}
