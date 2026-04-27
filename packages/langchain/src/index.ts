import type { KeyExecutionContext, KeyScheduler, WithKeyRetryOptions } from "@ai-key-manager/core";

type MaybePromise<T> = T | Promise<T>;
type ProviderRoute = Pick<WithKeyRetryOptions<unknown>, "provider" | "model" | "fallbacks">;
type RetryControls<TResult> = Omit<WithKeyRetryOptions<TResult>, "execute" | "provider" | "model" | "fallbacks">;

export interface LangChainRunnable<TResult = unknown, TInput = unknown, TCallOptions = unknown> {
  invoke(input: TInput, options?: TCallOptions): Promise<TResult>;
  stream?(input: TInput, options?: TCallOptions): Promise<TResult>;
}

export interface LangChainAdapterOptions<TModel extends LangChainRunnable<TResult, TInput, TCallOptions>, TInput, TCallOptions, TResult>
  extends ProviderRoute,
    RetryControls<TResult> {
  scheduler: KeyScheduler;
  input: TInput | ((context: KeyExecutionContext) => MaybePromise<TInput>);
  callOptions?: TCallOptions | ((context: KeyExecutionContext) => MaybePromise<TCallOptions>);
  createModel: (context: KeyExecutionContext) => MaybePromise<TModel>;
}

export async function invokeWithKey<TModel extends LangChainRunnable<TResult, TInput, TCallOptions>, TInput, TCallOptions, TResult>(
  options: LangChainAdapterOptions<TModel, TInput, TCallOptions, TResult>
): Promise<TResult> {
  return runWithKey(options, "invoke");
}

export async function streamWithKey<TModel extends LangChainRunnable<TResult, TInput, TCallOptions>, TInput, TCallOptions, TResult>(
  options: LangChainAdapterOptions<TModel, TInput, TCallOptions, TResult>
): Promise<TResult> {
  return runWithKey(options, "stream");
}

async function runWithKey<TModel extends LangChainRunnable<TResult, TInput, TCallOptions>, TInput, TCallOptions, TResult>(
  options: LangChainAdapterOptions<TModel, TInput, TCallOptions, TResult>,
  method: "invoke" | "stream"
): Promise<TResult> {
  const { scheduler, provider, model, fallbacks, input, callOptions, createModel, ...retryOptions } = options;

  return scheduler.withRetry({
    ...retryOptions,
    provider,
    model,
    fallbacks,
    execute: async (context) => {
      const [resolvedModel, resolvedInput, resolvedCallOptions] = await Promise.all([
        createModel(context),
        resolveValue(input, context),
        resolveValue(callOptions, context)
      ]);
      const call = method === "stream" ? resolvedModel.stream : resolvedModel.invoke;

      if (!call) {
        throw new TypeError("The LangChain model does not implement stream().");
      }

      return call.call(resolvedModel, resolvedInput as TInput, resolvedCallOptions as TCallOptions);
    }
  });
}

async function resolveValue<T>(value: T | ((context: KeyExecutionContext) => MaybePromise<T>) | undefined, context: KeyExecutionContext): Promise<T | undefined> {
  return typeof value === "function" ? (value as (context: KeyExecutionContext) => MaybePromise<T>)(context) : value;
}
