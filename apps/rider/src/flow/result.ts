// The result screen (automatic approval, PM 2026-10-20): after the submit, the app asks GET /flow/result
// at once, then every RESULT_POLL_MS, for at most RESULT_WAIT_MS. "verified": the ID is verified.
// "review": a person checks the case. "pending": ask again. When the time is up, the server is slow or
// down, or anything goes wrong, the rider is told what a review says ("we're checking a few details,
// we'll let you know"): never an error, never a refusal.
import { FLOW_RESULT_STATES, type FlowResult, RESULT_POLL_MS, RESULT_WAIT_MS } from "@verify/shared";
import { type ChecksWait, pollUntil } from "./checks";

export interface ResultTiming {
  /** The longest the rider waits, from the first request. */
  waitMs: number;
  /** Pause between two answers. */
  pollMs: number;
}

export const RESULT_TIMING: ResultTiming = { waitMs: RESULT_WAIT_MS, pollMs: RESULT_POLL_MS };

/** Bounds of the debug overrides below. */
const TIMING_BOUNDS: Record<keyof ResultTiming, { min: number; max: number }> = {
  waitMs: { min: 0, max: 180_000 },
  pollMs: { min: 250, max: 30_000 },
};

/**
 * Debug mode only (like the checks' wait): /?debug=1&resultWaitMs=3000#s=<token> shortens the wait, to
 * try the time-out on a phone or in end-to-end tests. Invalid and out-of-range numbers are ignored.
 */
export function parseResultTiming(search: string): Partial<ResultTiming> {
  const params = new URLSearchParams(search);
  const timing: Partial<ResultTiming> = {};
  for (const [key, param] of [
    ["waitMs", "resultWaitMs"],
    ["pollMs", "resultPollMs"],
  ] as const) {
    const raw = params.get(param);
    if (raw === null || raw.trim() === "") continue;
    const value = Number(raw);
    const { min, max } = TIMING_BOUNDS[key];
    if (Number.isInteger(value) && value >= min && value <= max) timing[key] = value;
  }
  return timing;
}

/** An answer shaped like FlowResult; anything else ends the wait (shown as a review). */
export function isFlowResult(value: unknown): value is FlowResult {
  if (value === null || typeof value !== "object") return false;
  const { state, returnUrl } = value as Partial<FlowResult>;
  return (FLOW_RESULT_STATES as readonly unknown[]).includes(state) && (returnUrl === null || typeof returnUrl === "string");
}

/**
 * Where "Continue" may take a verified rider: an https address only (the server sends nothing else; a
 * page that was tampered with must not send the rider to a javascript: or http: address).
 */
export function safeReturnUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** How the wait settled: verified (with where to go next) or review. */
export interface SettledResult {
  state: "verified" | "review";
  returnUrl: string | null;
}

export interface ResultWaitOptions {
  getResult: (signal: AbortSignal) => Promise<FlowResult>;
  timing?: Partial<ResultTiming>;
  signal?: AbortSignal;
}

/** Asks until the result is verified or review; null when stopped through `signal`. */
export function waitForResult(options: ResultWaitOptions): Promise<ChecksWait<SettledResult> | null> {
  return pollUntil({
    get: options.getResult,
    isAnswer: isFlowResult,
    decide: (answer): SettledResult | null =>
      answer.state === "pending"
        ? null
        : { state: answer.state, returnUrl: answer.state === "verified" ? safeReturnUrl(answer.returnUrl) : null },
    waitMs: options.timing?.waitMs ?? RESULT_TIMING.waitMs,
    pollMs: options.timing?.pollMs ?? RESULT_TIMING.pollMs,
    signal: options.signal,
  });
}
