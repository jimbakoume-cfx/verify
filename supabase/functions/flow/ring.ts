// Rings the AI worker's doorbell (M3): an empty POST to its Vercel URL. A ring carries no authority:
// the worker then claims whatever is due through the signed worker API. The ring runs after the
// response is sent (EdgeRuntime.waitUntil when the runtime has it, otherwise fire-and-forget), so the
// rider never waits for it.
import { InternalError, type Logger } from "../_shared/log.ts";

/**
 * Why a worker is rung: the rider chose a document (warm-up) or a photo was accepted (the AI worker);
 * a face check started (face_warm_up: the face worker loads its models while the rider follows the
 * prompts, fixes after the PM's first real test) or was recorded (the face worker, M6/M7).
 */
export type RingReason = "warm_up" | "capture" | "face_warm_up" | "face_check";

/**
 * Rings in the background. `onFailure` runs when the ring could not reach the worker (so the photo is
 * reported unchecked at once instead of keeping the rider waiting).
 */
export type WorkerRing = (reason: RingReason, onFailure?: () => Promise<void>) => void;

/** The worker answers when its run ends (up to about 50 s); the ring stops listening before that. */
export const RING_TIMEOUT_MS = 30_000;

/**
 * A ring refused by the firewall's rate limit (429) never reached the worker, and nothing says one is
 * running: a run stops as soon as no job is left, while the firewall keeps counting. It is tried once
 * more after this pause, or after the firewall's Retry-After when that is at most
 * RING_RETRY_MAX_PAUSE_MS (the rider waits CHECKS_WAIT_MS, 20 s, for the result).
 */
export const RING_RETRY_PAUSE_MS = 5_000;
export const RING_RETRY_MAX_PAUSE_MS = 10_000;

export interface RingOptions {
  /** Null: no ring (the sweep still rings every minute). */
  url: string | null;
  fetch?: typeof fetch;
  /** EdgeRuntime.waitUntil when available: keeps the function alive until the ring settles. */
  waitUntil?: (task: Promise<unknown>) => void;
  timeoutMs?: number;
  /** The pause before a rate-limited ring is tried again (tests replace it). */
  sleep?: (ms: number) => Promise<void>;
  log: Logger;
}

export const noRing: WorkerRing = () => {};

/**
 * The pause before retrying a ring refused with 429: the firewall's Retry-After (whole seconds) when it
 * is short enough, RING_RETRY_PAUSE_MS when it gives none (or a date); null when it asks for longer than
 * the rider would wait, so the photo is reported unchecked at once.
 */
export function retryPause(retryAfter: string | null): number | null {
  const seconds = retryAfter?.trim() ?? "";
  if (!/^\d+$/.test(seconds)) return RING_RETRY_PAUSE_MS;
  const ms = Number(seconds) * 1000;
  return ms <= RING_RETRY_MAX_PAUSE_MS ? ms : null;
}

export function createWorkerRing(options: RingOptions): WorkerRing {
  const { url, log } = options;
  if (!url) return noRing;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? RING_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** One POST: reached, failed (logged), or refused by the rate limit with the pause before a retry. */
  async function post(reason: RingReason): Promise<"reached" | "failed" | { limited: number | null }> {
    try {
      const res = await fetchImpl(url!, { method: "POST", body: "", signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return "reached";
      if (res.status === 429) return { limited: retryPause(res.headers.get("retry-after")) };
      log.error(`flow.ring_failed.${reason}`, new InternalError("worker ring refused", { status: res.status }));
      return "failed";
    } catch (err) {
      // Still running when the ring stopped listening: the worker was reached.
      if (err instanceof Error && err.name === "TimeoutError") return "reached";
      log.error(`flow.ring_failed.${reason}`, err);
      return "failed";
    }
  }

  /** True when the worker was not reached. */
  async function ring(reason: RingReason): Promise<boolean> {
    let attempt = await post(reason);
    if (typeof attempt === "object" && attempt.limited !== null) {
      await sleep(attempt.limited);
      attempt = await post(reason);
    }
    if (typeof attempt === "object") {
      log.error(`flow.ring_failed.${reason}`, new InternalError("worker ring rate-limited", { status: 429 }));
      return true;
    }
    return attempt === "failed";
  }

  return (reason, onFailure) => {
    const task = ring(reason)
      .then((failed) => (failed && onFailure ? onFailure() : undefined))
      .catch((err) => log.error("flow.ring_failure_not_recorded", err));
    options.waitUntil?.(task);
  };
}
