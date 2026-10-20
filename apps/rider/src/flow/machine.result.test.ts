// The result screen (automatic approval, PM 2026-10-20) in the reducer: after the submit, verified,
// review, or the wait timing out (shown as review); "Continue" to the return address or the end screen.
import { describe, expect, it } from "vitest";
import type { FlowSession } from "@verify/shared";
import { type FlowAction, type FlowState, flowReducer, handlesBack, initialFlowState } from "./machine";

const SESSION: FlowSession = {
  verificationId: "11111111-2222-4333-8444-555555555555",
  status: "submitted",
  locale: "fr",
  consentGiven: true,
  declaredDocument: "passport",
  requiredSides: ["document_front"],
  captures: [],
  expiresAt: "2026-10-21T10:30:00Z",
  isTest: true,
};

const run = (state: FlowState, ...actions: FlowAction[]) => actions.reduce(flowReducer, state);

/** Just submitted: the result screen, waiting. */
function submitted(): FlowState {
  const start: FlowState = {
    ...initialFlowState({ hasToken: true, invalidLink: false }),
    load: "ready",
    session: { ...SESSION, status: "in_progress" },
    screen: { name: "upload" },
    upload: { status: "running", stage: "submit", progress: null },
  };
  return run(start, { type: "upload/submitted", session: SESSION });
}

describe("the result screen (automatic approval)", () => {
  it("waits after the submit", () => {
    const state = submitted();
    expect(state.screen).toEqual({ name: "result" });
    expect(state.result).toEqual({ state: "pending", returnUrl: null, leaving: false });
    // Back is the browser's: nothing to step back to.
    expect(handlesBack(state.screen)).toBe(false);
  });

  it("says verified, then Continue goes to the return address", () => {
    const verified = run(submitted(), { type: "result/answer", state: "verified", returnUrl: "https://ride.example/back" });
    expect(verified.result).toEqual({ state: "verified", returnUrl: "https://ride.example/back", leaving: false });
    const leaving = run(verified, { type: "result/continue" });
    expect(leaving.screen).toEqual({ name: "result" });
    expect(leaving.result.leaving).toBe(true);
    // Pressed twice: nothing more.
    expect(run(leaving, { type: "result/continue" })).toBe(leaving);
  });

  it("says verified, then Continue ends on the done screen when there is no return address", () => {
    const state = run(submitted(), { type: "result/answer", state: "verified", returnUrl: null }, { type: "result/continue" });
    expect(state.screen).toEqual({ name: "done" });
    expect(state.result.state).toBe("verified");
  });

  it("says review, and never keeps a return address with it", () => {
    const state = run(submitted(), { type: "result/answer", state: "review", returnUrl: "https://ride.example/back" });
    expect(state.result).toEqual({ state: "review", returnUrl: null, leaving: false });
    // Continue is not offered: nothing happens.
    expect(run(state, { type: "result/continue" })).toBe(state);
  });

  it("shows a time-out (or a failure) as review", () => {
    expect(run(submitted(), { type: "result/timeout" }).result).toEqual({ state: "review", returnUrl: null, leaving: false });
  });

  it("keeps the first settled answer: a late one changes nothing", () => {
    const review = run(submitted(), { type: "result/timeout" });
    expect(run(review, { type: "result/answer", state: "verified", returnUrl: null })).toBe(review);
    const verified = run(submitted(), { type: "result/answer", state: "verified", returnUrl: null });
    expect(run(verified, { type: "result/timeout" })).toBe(verified);
  });

  it("ignores result actions on any other screen", () => {
    const other: FlowState = { ...initialFlowState({ hasToken: true, invalidLink: false }), screen: { name: "upload" } };
    for (const action of [
      { type: "result/answer", state: "verified", returnUrl: null },
      { type: "result/timeout" },
      { type: "result/continue" },
    ] as FlowAction[]) {
      expect(run(other, action)).toBe(other);
    }
  });
});
