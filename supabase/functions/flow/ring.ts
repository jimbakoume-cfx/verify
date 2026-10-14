// Rings the AI worker's doorbell (M3): an empty POST to its Vercel URL. A ring carries no authority:
// the worker then claims whatever is due through the signed worker API. The ring runs after the
// response is sent (EdgeRuntime.waitUntil when the runtime has it, otherwise fire-and-forget), so the
// rider never waits for it.
import { InternalError, type Logger } from "../_shared/log.ts";

/** Why the worker is rung: the rider chose a document (warm-up) or a photo was accepted. */
export type RingReason = "warm_up" | "capture";

/**
 * Rings in the background. `onFailure` runs when the ring could not reach the worker (so the photo is
 * reported unchecked at once instead of keeping the rider waiting).
 */
export type WorkerRing = (reason: RingReason, onFailure?: () => Promise<void>) => void;

/** The worker answers when its run ends (up to about 50 s); the ring stops listening before that. */
export const RING_TIMEOUT_MS = 30_000;

export interface RingOptions {
  /** Null: no ring (the sweep still rings every minute). */
  url: string | null;
  fetch?: typeof fetch;
  /** EdgeRuntime.waitUntil when available: keeps the function alive until the ring settles. */
  waitUntil?: (task: Promise<unknown>) => void;
  timeoutMs?: number;
  log: Logger;
}

export const noRing: WorkerRing = () => {};

export function createWorkerRing(options: RingOptions): WorkerRing {
  const { url, log } = options;
  if (!url) return noRing;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? RING_TIMEOUT_MS;

  /** True when the worker was not reached. */
  async function ring(reason: RingReason): Promise<boolean> {
    try {
      const res = await fetchImpl(url!, { method: "POST", body: "", signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel().catch(() => {});
      // 429: the firewall's rate limit, while a worker is already running and claiming. Not a failure.
      if (res.ok || res.status === 429) return false;
      log.error(`flow.ring_failed.${reason}`, new InternalError("worker ring refused", { status: res.status }));
      return true;
    } catch (err) {
      // Still running when the ring stopped listening: the worker was reached.
      if (err instanceof Error && err.name === "TimeoutError") return false;
      log.error(`flow.ring_failed.${reason}`, err);
      return true;
    }
  }

  return (reason, onFailure) => {
    const task = ring(reason)
      .then((failed) => (failed && onFailure ? onFailure() : undefined))
      .catch((err) => log.error("flow.ring_failure_not_recorded", err));
    options.waitUntil?.(task);
  };
}
