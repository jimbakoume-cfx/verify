// Waits for the server's check of the photos just sent (GET /flow/checks, M3): asks at once, then
// every CHECKS_POLL_MS, for at most CHECKS_WAIT_MS. The server never holds the rider up: when it is
// slow, down, or answers with an error, the wait ends and the photos are submitted as they are
// (staff then review the case), with nothing shown to the rider.
import { CHECKS_POLL_MS, CHECKS_WAIT_MS, FLOW_CHECK_STATES, type FlowChecks } from "@verify/shared";
import { isTransient, toFlowError } from "./errors";

export interface ChecksTiming {
  /** The longest the rider waits, from the first request. */
  waitMs: number;
  /** Pause between two answers. */
  pollMs: number;
}

export const CHECKS_TIMING: ChecksTiming = { waitMs: CHECKS_WAIT_MS, pollMs: CHECKS_POLL_MS };

/** Bounds of the debug overrides below: never hammer the server, never wait for minutes. */
const TIMING_BOUNDS: Record<keyof ChecksTiming, { min: number; max: number }> = {
  waitMs: { min: 0, max: 120_000 },
  pollMs: { min: 250, max: 30_000 },
};

/**
 * Debug mode only (like the quality thresholds): the wait and the pause can be set from the URL, e.g.
 * /?debug=1&checksWaitMs=3000#s=<token>, to try the time-out on a phone or in end-to-end tests.
 * Unknown names, invalid and out-of-range numbers are ignored.
 */
export function parseChecksTiming(search: string): Partial<ChecksTiming> {
  const params = new URLSearchParams(search);
  const timing: Partial<ChecksTiming> = {};
  for (const [key, param] of [
    ["waitMs", "checksWaitMs"],
    ["pollMs", "checksPollMs"],
  ] as const) {
    const raw = params.get(param);
    if (raw === null || raw.trim() === "") continue;
    const value = Number(raw);
    const { min, max } = TIMING_BOUNDS[key];
    if (Number.isInteger(value) && value >= min && value <= max) timing[key] = value;
  }
  return timing;
}

export interface ChecksWaitOptions<T> {
  /** GET /flow/checks. Its signal aborts the request when the time is up or the wait is stopped. */
  getChecks: (signal: AbortSignal) => Promise<FlowChecks>;
  /** What an answer means: a value ends the wait with it; null asks again. */
  decide: (checks: FlowChecks) => T | null;
  timing?: Partial<ChecksTiming>;
  /** Stops the wait (the screen went away): it then resolves null. */
  signal?: AbortSignal;
}

/** How the wait ended: decided from an answer, or not in time ("timeout", also after an error). */
export type ChecksWait<T> = { type: "decided"; decision: T } | { type: "timeout" };

/**
 * An answer shaped like FlowChecks. Anything else counts as an error (the wait ends). `expired` (M4)
 * may be missing, from a server not yet updated: it then counts as false.
 */
export function isFlowChecks(value: unknown): value is FlowChecks {
  if (value === null || typeof value !== "object") return false;
  const { done, sides, expired } = value as Partial<FlowChecks>;
  return (
    typeof done === "boolean" &&
    (expired === undefined || typeof expired === "boolean") &&
    Array.isArray(sides) &&
    sides.every(
      (side: unknown) =>
        side !== null &&
        typeof side === "object" &&
        typeof (side as { kind?: unknown }).kind === "string" &&
        (FLOW_CHECK_STATES as readonly unknown[]).includes((side as { state?: unknown }).state),
    )
  );
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/**
 * Asks for the checks until `decide` settles them or the time runs out. A network or server error
 * (the server busy for a moment) is asked again while there is time; any other error, or an answer
 * that makes no sense, ends the wait at once. A request still running when the time is up is
 * abandoned. Never rejects; resolves null when stopped through `signal`.
 */
export async function waitForChecks<T>(options: ChecksWaitOptions<T>): Promise<ChecksWait<T> | null> {
  const waitMs = options.timing?.waitMs ?? CHECKS_TIMING.waitMs;
  const pollMs = options.timing?.pollMs ?? CHECKS_TIMING.pollMs;
  const stopped = options.signal ?? new AbortController().signal;
  const deadline = Date.now() + waitMs;
  const timeout: ChecksWait<T> = { type: "timeout" };

  for (;;) {
    if (stopped.aborted) return null;
    const left = deadline - Date.now();
    if (left <= 0) return timeout;

    const request = new AbortController();
    const abandon = () => request.abort();
    const timer = setTimeout(abandon, left);
    stopped.addEventListener("abort", abandon);
    let answer: unknown = null;
    try {
      answer = await options.getChecks(request.signal);
    } catch (err) {
      if (!stopped.aborted && !isTransient(toFlowError(err))) return timeout;
    } finally {
      clearTimeout(timer);
      stopped.removeEventListener("abort", abandon);
    }
    if (stopped.aborted) return null;

    if (answer !== null) {
      if (!isFlowChecks(answer)) return timeout;
      const decision = options.decide(answer);
      if (decision !== null) return { type: "decided", decision };
    }

    const rest = deadline - Date.now();
    if (rest <= 0) return timeout;
    await pause(Math.min(pollMs, rest), stopped);
  }
}
