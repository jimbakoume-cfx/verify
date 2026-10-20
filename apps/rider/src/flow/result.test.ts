import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAST_POLL_FOR_MS, FAST_POLL_MS, type FlowResult, RESULT_POLL_MS, RESULT_WAIT_MS } from "@verify/shared";
import type { ChecksWait } from "./checks";
import { FlowError } from "./errors";
import { isFlowResult, parseResultTiming, safeReturnUrl, type SettledResult, waitForResult } from "./result";

const pending: FlowResult = { state: "pending", returnUrl: null };
const verified: FlowResult = { state: "verified", returnUrl: "https://ride.example/verified" };
const review: FlowResult = { state: "review", returnUrl: null };

/** A fake GET /flow/result giving `answers` in turn (the last one again), recording when it is called. */
function server(...answers: (FlowResult | FlowError | "hang" | unknown)[]) {
  const times: number[] = [];
  const start = Date.now();
  const getResult = vi.fn((signal: AbortSignal) => {
    times.push(Date.now() - start);
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === "hang") {
      return new Promise<FlowResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new FlowError("timeout")));
      });
    }
    return answer instanceof FlowError ? Promise.reject(answer) : Promise.resolve(answer as FlowResult);
  });
  return { getResult, times };
}

async function finish(promise: Promise<ChecksWait<SettledResult> | null>) {
  const start = Date.now();
  let result: ChecksWait<SettledResult> | null | undefined;
  void promise.then((r) => (result = r));
  for (let i = 0; i < 2000 && result === undefined; i++) await vi.advanceTimersByTimeAsync(100);
  return { result, ms: Date.now() - start };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("waitForResult", () => {
  it("asks at once, then every FAST_POLL_MS for FAST_POLL_FOR_MS, then every RESULT_POLL_MS, until verified", async () => {
    // Fixes after the PM's first real test: the result within 10 s of the end of the face check.
    const answers = [...Array.from({ length: 16 }, () => pending), verified];
    const { getResult, times } = server(...answers);
    const { result } = await finish(waitForResult({ getResult }));
    expect(result).toEqual({ type: "decided", decision: { state: "verified", returnUrl: "https://ride.example/verified" } });
    const fast = Array.from({ length: FAST_POLL_FOR_MS / FAST_POLL_MS + 1 }, (_, i) => i * FAST_POLL_MS);
    expect(times).toEqual([...fast, FAST_POLL_FOR_MS + RESULT_POLL_MS]);
  });

  it("settles on review at once", async () => {
    const { getResult, times } = server(review);
    expect((await finish(waitForResult({ getResult }))).result).toEqual({ type: "decided", decision: { state: "review", returnUrl: null } });
    expect(times).toEqual([0]);
  });

  it("gives up after RESULT_WAIT_MS (between 60 and 90 seconds) of pending answers", async () => {
    expect(RESULT_WAIT_MS).toBeGreaterThanOrEqual(60_000);
    expect(RESULT_WAIT_MS).toBeLessThanOrEqual(90_000);
    expect(RESULT_POLL_MS).toBeGreaterThanOrEqual(2_000);
    expect(RESULT_POLL_MS).toBeLessThanOrEqual(3_000);
    const { getResult } = server(pending);
    const { result, ms } = await finish(waitForResult({ getResult }));
    expect(result).toEqual({ type: "timeout" });
    expect(ms).toBeGreaterThanOrEqual(RESULT_WAIT_MS);
    expect(ms).toBeLessThan(RESULT_WAIT_MS + 1_000);
  });

  it("keeps asking through network errors and a busy server (slow networks), then settles", async () => {
    const { getResult, times } = server(new FlowError("network"), new FlowError("server_error", 503), verified);
    expect((await finish(waitForResult({ getResult }))).result).toMatchObject({ type: "decided", decision: { state: "verified" } });
    expect(times).toHaveLength(3);
  });

  it("abandons a request that hangs when the time is up", async () => {
    const { getResult } = server("hang");
    const { result, ms } = await finish(waitForResult({ getResult, timing: { waitMs: 5_000 } }));
    expect(result).toEqual({ type: "timeout" });
    expect(ms).toBeLessThan(6_000);
  });

  it("ends at once on an error that will not go away (an expired link) or an answer that makes no sense", async () => {
    for (const answer of [new FlowError("session_expired", 410), { state: "approved" }, { state: "verified", returnUrl: 3 }]) {
      const { getResult } = server(answer);
      const { result, ms } = await finish(waitForResult({ getResult }));
      expect(result).toEqual({ type: "timeout" });
      expect(ms).toBeLessThan(RESULT_POLL_MS + 200);
    }
  });

  it("never passes on a return address that is not https", async () => {
    const { getResult } = server({ state: "verified", returnUrl: "javascript:alert(1)" });
    expect((await finish(waitForResult({ getResult }))).result).toEqual({ type: "decided", decision: { state: "verified", returnUrl: null } });
  });

  it("stops when asked (the screen went away)", async () => {
    const { getResult } = server(pending);
    const controller = new AbortController();
    const promise = waitForResult({ getResult, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(RESULT_POLL_MS + 10);
    controller.abort();
    expect((await finish(promise)).result).toBeNull();
  });
});

describe("isFlowResult, safeReturnUrl and parseResultTiming", () => {
  it("accept the contract's shape only", () => {
    expect(isFlowResult(pending)).toBe(true);
    expect(isFlowResult(verified)).toBe(true);
    for (const bad of [null, "verified", {}, { state: "rejected", returnUrl: null }, { state: "review" }]) expect(isFlowResult(bad)).toBe(false);
  });

  it("keep https addresses only", () => {
    expect(safeReturnUrl("https://ride.example/x?y=1")).toBe("https://ride.example/x?y=1");
    for (const bad of ["http://ride.example/", "javascript:alert(1)", "not a url", null]) expect(safeReturnUrl(bad)).toBeNull();
  });

  it("read the debug overrides within bounds", () => {
    expect(parseResultTiming("?debug=1&resultWaitMs=3000&resultPollMs=500")).toEqual({ waitMs: 3000, pollMs: 500 });
    expect(parseResultTiming("?resultWaitMs=-1&resultPollMs=10")).toEqual({});
    expect(parseResultTiming("?resultWaitMs=999999")).toEqual({});
  });
});
