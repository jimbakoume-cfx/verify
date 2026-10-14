import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKS_POLL_MS, CHECKS_WAIT_MS, type FlowCheckSide, type FlowChecks } from "@verify/shared";
import { FlowError } from "./errors";
import { type ChecksWait, isFlowChecks, parseChecksTiming, waitForChecks } from "./checks";

function side(kind: FlowCheckSide["kind"], state: FlowCheckSide["state"]): FlowCheckSide {
  return { kind, captureId: `capture-${kind}`, state, reason: state === "retake" ? "unreadable" : null };
}

const pending: FlowChecks = { done: false, sides: [side("document_front", "pending")] };
const ok: FlowChecks = { done: true, sides: [side("document_front", "ok")] };

/** decide() as the flow uses it: settled once nothing is pending. */
const decide = (checks: FlowChecks) => (checks.done ? "submit" : null);

/** A fake GET /flow/checks giving `answers` in turn (the last one again), recording when it is called. */
function server(...answers: (FlowChecks | FlowError | "hang" | unknown)[]) {
  const times: number[] = [];
  const start = Date.now();
  const getChecks = vi.fn((signal: AbortSignal) => {
    times.push(Date.now() - start);
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === "hang") {
      return new Promise<FlowChecks>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new FlowError("timeout")));
      });
    }
    return answer instanceof FlowError ? Promise.reject(answer) : Promise.resolve(answer as FlowChecks);
  });
  return { getChecks, times };
}

/** Runs the wait to its end with fake timers; returns how it ended and after how long. */
async function finish<T>(promise: Promise<ChecksWait<T> | null>) {
  const start = Date.now();
  let result: ChecksWait<T> | null | undefined;
  void promise.then((r) => (result = r));
  for (let i = 0; i < 1000 && result === undefined; i++) await vi.advanceTimersByTimeAsync(100);
  return { result, ms: Date.now() - start };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("waitForChecks", () => {
  it("asks at once, then every CHECKS_POLL_MS until the checks are settled", async () => {
    const { getChecks, times } = server(pending, pending, ok);
    const { result } = await finish(waitForChecks({ getChecks, decide }));
    expect(result).toEqual({ type: "decided", decision: "submit" });
    expect(times).toEqual([0, CHECKS_POLL_MS, 2 * CHECKS_POLL_MS]);
  });

  it("gives up after CHECKS_WAIT_MS of pending answers", async () => {
    const { getChecks, times } = server(pending);
    const { result, ms } = await finish(waitForChecks({ getChecks, decide }));
    expect(result).toEqual({ type: "timeout" });
    expect(ms).toBeLessThanOrEqual(CHECKS_WAIT_MS + 100);
    expect(ms).toBeGreaterThanOrEqual(CHECKS_WAIT_MS);
    expect(times.length).toBe(CHECKS_WAIT_MS / CHECKS_POLL_MS);
    expect(times.every((t) => t < CHECKS_WAIT_MS)).toBe(true);
  });

  it("takes its timing from the caller (tests, debug mode)", async () => {
    const { getChecks, times } = server(pending);
    const { result, ms } = await finish(waitForChecks({ getChecks, decide, timing: { waitMs: 3000, pollMs: 500 } }));
    expect(result).toEqual({ type: "timeout" });
    expect(ms).toBeLessThanOrEqual(3100);
    expect(times).toEqual([0, 500, 1000, 1500, 2000, 2500]);
  });

  it("abandons a request still running when the time is up", async () => {
    const { getChecks } = server(pending, "hang");
    const { result, ms } = await finish(waitForChecks({ getChecks, decide }));
    expect(result).toEqual({ type: "timeout" });
    expect(ms).toBeLessThanOrEqual(CHECKS_WAIT_MS + 100);
    expect(getChecks).toHaveBeenCalledTimes(2);
    expect(getChecks.mock.calls[1][0].aborted).toBe(true);
  });

  it("asks again after a network or server error, while there is time", async () => {
    const { getChecks } = server(new FlowError("network"), new FlowError("server_error", 503), ok);
    const { result } = await finish(waitForChecks({ getChecks, decide }));
    expect(result).toEqual({ type: "decided", decision: "submit" });
    expect(getChecks).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a refusal", new FlowError("missing_sides", 409)],
    ["an expired session", new FlowError("session_expired", 410)],
    ["an answer that makes no sense", { done: "yes" }],
  ])("stops at once on %s", async (_name, answer) => {
    const { getChecks } = server(answer);
    const { result, ms } = await finish(waitForChecks({ getChecks, decide }));
    expect(result).toEqual({ type: "timeout" });
    expect(ms).toBeLessThanOrEqual(100);
    expect(getChecks).toHaveBeenCalledTimes(1);
  });

  it("resolves null, and stops asking, once stopped", async () => {
    const { getChecks } = server(pending);
    const controller = new AbortController();
    const promise = waitForChecks({ getChecks, decide, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(CHECKS_POLL_MS + 10);
    controller.abort();
    const { result } = await finish(promise);
    expect(result).toBeNull();
    const calls = getChecks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECKS_WAIT_MS);
    expect(getChecks).toHaveBeenCalledTimes(calls);
  });

  it("abandons the request in flight when stopped", async () => {
    const { getChecks } = server("hang");
    const controller = new AbortController();
    const promise = waitForChecks({ getChecks, decide, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect((await finish(promise)).result).toBeNull();
    expect(getChecks.mock.calls[0][0].aborted).toBe(true);
  });
});

describe("isFlowChecks", () => {
  it("accepts the contract's shape only", () => {
    expect(isFlowChecks(ok)).toBe(true);
    expect(isFlowChecks({ done: true, sides: [] })).toBe(true);
    expect(isFlowChecks(null)).toBe(false);
    expect(isFlowChecks({ done: true })).toBe(false);
    expect(isFlowChecks({ done: true, sides: [{ kind: "document_front", state: "maybe" }] })).toBe(false);
    expect(isFlowChecks({ done: true, sides: [null] })).toBe(false);
  });
});

describe("parseChecksTiming", () => {
  it("reads the wait and the pause from the URL, within bounds", () => {
    expect(parseChecksTiming("?debug=1&checksWaitMs=3000&checksPollMs=500")).toEqual({ waitMs: 3000, pollMs: 500 });
    expect(parseChecksTiming("?checksWaitMs=0")).toEqual({ waitMs: 0 });
    expect(parseChecksTiming("?checksWaitMs=-1&checksPollMs=10")).toEqual({});
    expect(parseChecksTiming("?checksWaitMs=1e9&checksPollMs=abc")).toEqual({});
    expect(parseChecksTiming("?checksWaitMs=2.5&checksPollMs=")).toEqual({});
    expect(parseChecksTiming("")).toEqual({});
  });
});
