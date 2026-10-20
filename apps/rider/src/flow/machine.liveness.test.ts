// The face check's place in the flow (M5). The step itself is in src/liveness.
import { describe, expect, it } from "vitest";
import type { FlowSession } from "@verify/shared";
import { type FlowAction, type FlowState, type Shot, flowReducer, handlesBack, initialFlowState } from "./machine";

function session(overrides: Partial<FlowSession> = {}): FlowSession {
  return {
    verificationId: "11111111-2222-4333-8444-555555555555",
    status: "in_progress",
    locale: "fr",
    consentGiven: true,
    declaredDocument: "cni_legacy",
    requiredSides: ["document_front", "document_back"],
    captures: [],
    expiresAt: "2026-10-13T12:30:00Z",
    isTest: true,
    ...overrides,
  };
}

function shot(side: Shot["side"]): Shot {
  return {
    side,
    blob: new Blob([new Uint8Array(20_000)], { type: "image/jpeg" }),
    quality: { source: "auto", sharpness: 900, glareRatio: 0, meanLuma: 150, framing: 0.9, videoWidth: 1080, videoHeight: 1920, elapsedMs: 4000 },
    hints: [],
    lowResolution: false,
    info: { width: 1000, height: 640, bytes: 20_000, jpegQuality: 0.88, scale: 1, attempts: 1 },
  };
}

function run(state: FlowState, ...actions: FlowAction[]): FlowState {
  return actions.reduce(flowReducer, state);
}

const LIVENESS_DONE: FlowAction = { type: "liveness/done" };

const chosen = run(
  initialFlowState({ hasToken: true, invalidLink: false }),
  { type: "session/loaded", session: session({ status: "created", consentGiven: false, declaredDocument: null, requiredSides: null }) },
  { type: "start" },
  { type: "consent/accepted", session: session({ declaredDocument: null, requiredSides: null }) },
  { type: "document/chosen", session: session() },
);

/** Both sides of the old CNI sent and checked: the face check comes next. */
function atLiveness(): FlowState {
  return run(
    chosen,
    { type: "capture/taken", shot: shot("document_front") },
    { type: "review/accept" },
    { type: "turnOver/ready" },
    { type: "capture/taken", shot: shot("document_back") },
    { type: "review/accept" },
    { type: "upload/started", progress: { done: 0, total: 7, phase: "link", photo: 1, photos: 2, attempt: 1 } },
    { type: "upload/sideDone", side: "document_front" },
    { type: "upload/sideDone", side: "document_back" },
    { type: "upload/sent" },
    { type: "checks/ok" },
  );
}

describe("the face check (M5)", () => {
  it("starts with nothing recorded", () => {
    expect(chosen.livenessDone).toBe(false);
  });

  it("comes after the server's checks, before the submit", () => {
    const state = atLiveness();
    expect(state.screen).toEqual({ name: "liveness" });
    expect(state.upload.status).toBe("idle");
    const submitting = run(state, LIVENESS_DONE);
    expect(submitting).toMatchObject({ livenessDone: true, screen: { name: "upload" } });
    expect(submitting.upload).toEqual({ status: "queued", stage: "submit", progress: null });
  });

  it("is done only from its screen", () => {
    expect(run(chosen, LIVENESS_DONE)).toBe(chosen);
  });

  it("holds the phone's Back button (the photos are already sent)", () => {
    const state = atLiveness();
    expect(handlesBack(state.screen)).toBe(true);
    expect(run(state, { type: "nav/back" })).toBe(state);
  });

  it("ends the flow on a session error, and keeps its own screen for anything else", () => {
    const state = atLiveness();
    expect(run(state, { type: "liveness/failed", error: "session_expired" }).screen).toEqual({
      name: "sessionError",
      reason: "expired",
    });
    expect(run(state, { type: "liveness/failed", error: "network" })).toBe(state);
    expect(run(state, { type: "liveness/failed", error: "too_many_challenges" })).toBe(state);
  });

  it("is asked for again when the submit finds no face check on the server", () => {
    let state = run(atLiveness(), LIVENESS_DONE, {
      type: "upload/started",
      progress: { done: 6, total: 7, phase: "submit", photo: 0, photos: 2, attempt: 1 },
    });
    state = run(state, { type: "upload/failed", error: "liveness_required", side: null });
    expect(state).toMatchObject({ screen: { name: "liveness" }, livenessDone: false, error: "liveness_required" });
    expect(state.upload.status).toBe("idle");
    // The photos stay sent.
    expect(state.uploaded).toEqual({ document_front: true, document_back: true });
  });

  it("is not asked again after another document is chosen (the face is the same)", () => {
    const done = run(atLiveness(), LIVENESS_DONE);
    const checking: FlowState = { ...done, screen: { name: "checking" }, upload: { status: "idle", stage: "sides", progress: null } };
    expect(run(checking, { type: "checks/expired" }, { type: "expired/another" }).livenessDone).toBe(true);
    expect(run(checking, { type: "checks/ok" }).screen).toEqual({ name: "upload" });
  });
});
