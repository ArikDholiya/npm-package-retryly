export interface RetryContext {
  /** Current attempt number, starting at 1. */
  attempt: number;
  /** Aborted when the attempt times out or the outer signal is aborted. Pass it to fetch() etc. */
  signal: AbortSignal;
}

export interface RetryOptions {
  /** Number of retries after the first attempt. Default: 3 (so up to 4 attempts total). */
  retries?: number;
  /** Delay before the first retry, in ms. Default: 100. */
  minDelay?: number;
  /** Upper bound for any single delay, in ms. Default: 30_000. */
  maxDelay?: number;
  /** Multiplier applied to the delay after each failure. Default: 2. */
  factor?: number;
  /**
   * Randomization strategy.
   * - "full" (default): delay is random between 0 and the computed backoff.
   * - "equal": delay is between half and all of the computed backoff.
   * - "none": exact exponential delays.
   */
  jitter?: "full" | "equal" | "none";
  /** Per-attempt timeout in ms. The attempt's signal is aborted and a TimeoutError is thrown. */
  timeout?: number;
  /** Cancels the whole operation, including any pending delay. */
  signal?: AbortSignal;
  /** Return false to stop retrying and rethrow the error. Default: always retry. */
  shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
  /** Called before waiting for the next attempt. */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
}

/** Throw this from your function to stop retrying immediately. The original error is in `cause`. */
export class StopRetryError extends Error {
  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : "Retrying stopped", { cause });
    this.name = "StopRetryError";
  }
}

/** Thrown when a single attempt exceeds `timeout`. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Attempt timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Computes the delay before retry number `retry` (1-based). Exported for testing and custom use. */
export function computeDelay(
  retry: number,
  { minDelay = 100, maxDelay = 30_000, factor = 2, jitter = "full" }: RetryOptions = {},
  random: () => number = Math.random,
): number {
  const base = Math.min(maxDelay, minDelay * factor ** (retry - 1));
  if (jitter === "full") return Math.round(random() * base);
  if (jitter === "equal") return Math.round(base / 2 + random() * (base / 2));
  return base;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runAttempt<T>(
  fn: (ctx: RetryContext) => T | Promise<T>,
  attempt: number,
  { timeout, signal }: RetryOptions,
): Promise<T> {
  if (timeout === undefined) {
    return fn({ attempt, signal: signal ?? new AbortController().signal });
  }

  const controller = new AbortController();
  const attemptSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(timeout);
      controller.abort(error);
      reject(error);
    }, timeout);
  });

  try {
    return await Promise.race([fn({ attempt, signal: attemptSignal }), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls `fn` until it succeeds, waiting with exponential backoff and jitter between attempts.
 * Rejects with the last error once retries are exhausted.
 */
export async function retry<T>(
  fn: (ctx: RetryContext) => T | Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { retries = 3, signal, shouldRetry, onRetry } = options;

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortReason(signal);

    try {
      return await runAttempt(fn, attempt, options);
    } catch (error) {
      if (error instanceof StopRetryError) throw error.cause ?? error;
      if (signal?.aborted) throw abortReason(signal);
      if (attempt > retries) throw error;
      if (shouldRetry && !(await shouldRetry(error, attempt))) throw error;

      const delay = computeDelay(attempt, options);
      onRetry?.(error, attempt, delay);
      await sleep(delay, signal);
    }
  }
}

export default retry;
