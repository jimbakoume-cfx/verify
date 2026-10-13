// Automatic retry with exponential backoff, for uploads on unreliable mobile networks.

export interface RetryPolicy {
  /** Total attempts, including the first. */
  tries: number;
  /** Wait before the second attempt; doubles each time. */
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Spec: three tries, then the rider gets a manual "Try again" button. */
export const UPLOAD_RETRY: RetryPolicy = { tries: 3, baseDelayMs: 1500, maxDelayMs: 8000 };

/**
 * Wait after failed attempt number `attempt` (1-based): base x 2^(attempt-1), capped, with +/-25%
 * jitter so many phones recovering from the same outage do not retry in lockstep.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exact = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exact * (0.75 + 0.5 * random()));
}

export interface RetryOptions<E> {
  policy: RetryPolicy;
  /** Converts whatever was thrown into the error type the caller handles. */
  toError: (err: unknown) => E;
  shouldRetry: (error: E) => boolean;
  /** Called before waiting; `attempt` is the number of the attempt about to start. */
  onRetry?: (attempt: number, error: E, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `task` until it succeeds, fails with a non-retryable error, or the tries run out. */
export async function withRetry<T, E>(task: (attempt: number) => Promise<T>, options: RetryOptions<E>): Promise<T> {
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      const error = options.toError(err);
      if (attempt >= options.policy.tries || !options.shouldRetry(error)) throw error;
      const delay = backoffDelay(attempt, options.policy, options.random);
      options.onRetry?.(attempt + 1, error, delay);
      await wait(delay);
    }
  }
}
