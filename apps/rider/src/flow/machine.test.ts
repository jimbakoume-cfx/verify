import { describe, expect, it } from "vitest";
import type { CaptureSide, ClientQuality, DeclaredDocument, FlowSession, FlowStatus } from "@verify/shared";
import type { Hint } from "@verify/capture";
import {
  type FlowAction,
  type FlowState,
  type Shot,
  REFUSALS_BEFORE_OVERRIDE,
  canUseShot,
  closedReason,
  flowReducer,
  handlesBack,
  initialFlowState,
  pendingShots,
  refusalHints,
} from "./machine";

function session(overrides: Partial<FlowSession> = {}): FlowSession {
  return {
    verificationId: "11111111-2222-4333-8444-555555555555",
    status: "created",
    locale: "fr",
    consentGiven: false,
    declaredDocument: null,
    requiredSides: null,
    captures: [],
    expiresAt: "2026-10-13T12:30:00Z",
    isTest: true,
    ...overrides,
  };
}

function withDocument(doc: DeclaredDocument, sides: CaptureSide[]): FlowSession {
  return session({ status: "in_progress", consentGiven: true, declaredDocument: doc, requiredSides: sides });
}

function shot(side: CaptureSide, source: ClientQuality["source"] = "auto", hints: Hint[] = []): Shot {
  return {
    side,
    blob: new Blob([new Uint8Array(20_000)], { type: "image/jpeg" }),
    quality: {
      source,
      sharpness: 900,
      glareRatio: 0,
      meanLuma: 150,
      framing: 0.9,
      videoWidth: 1080,
      videoHeight: 1920,
      elapsedMs: 4000,
    },
    hints,
    lowResolution: false,
    info: { width: 1000, height: 640, bytes: 20_000, jpegQuality: 0.88, scale: 1, attempts: 1 },
  };
}

function run(state: FlowState, ...actions: FlowAction[]): FlowState {
  return actions.reduce(flowReducer, state);
}

const loading = initialFlowState({ hasToken: true, invalidLink: false });
const ready = run(loading, { type: "session/loaded", session: session() });
const cniChosen = run(
  ready,
  { type: "start" },
  { type: "consent/accepted", session: session({ status: "in_progress", consentGiven: true }) },
  { type: "document/chosen", session: withDocument("cni", ["document_front", "document_back"]) },
);

describe("initial state", () => {
  it("waits for the session when the link had a token", () => {
    expect(loading).toMatchObject({ load: "loading", screen: { name: "welcome" } });
  });

  it("explains how to start when opened without a link", () => {
    expect(initialFlowState({ hasToken: false, invalidLink: false })).toMatchObject({
      load: "none",
      screen: { name: "welcome" },
    });
  });

  it("reports a broken link at once", () => {
    expect(initialFlowState({ hasToken: false, invalidLink: true }).screen).toEqual({
      name: "sessionError",
      reason: "invalid",
    });
  });
});

describe("session loading", () => {
  it("enables Start once the session is loaded", () => {
    expect(ready).toMatchObject({ load: "ready", screen: { name: "welcome" } });
  });

  it("keeps the welcome screen with an error on a network failure", () => {
    const failed = run(loading, { type: "session/failed", error: "network" });
    expect(failed).toMatchObject({ load: "failed", error: "network", screen: { name: "welcome" } });
    expect(run(failed, { type: "session/loading" })).toMatchObject({ load: "loading", error: null });
  });

  it.each([
    ["invalid_session", "invalid"],
    ["session_expired", "expired"],
    ["already_submitted", "already_submitted"],
  ] as const)("shows the session error screen for %s", (code, reason) => {
    expect(run(loading, { type: "session/failed", error: code }).screen).toEqual({ name: "sessionError", reason });
  });

  it.each([
    ["created", null],
    ["in_progress", null],
    ["submitted", "already_submitted"],
    ["in_review", "already_submitted"],
    ["approved", "already_submitted"],
    ["expired", "expired"],
    ["cancelled", "invalid"],
  ] as const)("treats status %s as %s", (status: FlowStatus, reason) => {
    expect(closedReason(status)).toBe(reason);
    const state = run(loading, { type: "session/loaded", session: session({ status }) });
    expect(state.screen).toEqual(reason ? { name: "sessionError", reason } : { name: "welcome" });
  });
});

describe("start, consent and document", () => {
  it("ignores Start until the session is ready", () => {
    expect(run(loading, { type: "start" })).toBe(loading);
  });

  it("goes to consent, or straight to the document choice when consent was already given", () => {
    expect(run(ready, { type: "start" }).screen).toEqual({ name: "consent" });
    const consented = run(loading, {
      type: "session/loaded",
      session: session({ status: "in_progress", consentGiven: true }),
    });
    expect(run(consented, { type: "start" }).screen).toEqual({ name: "document" });
  });

  it("lets the rider decline and come back", () => {
    const declined = run(ready, { type: "start" }, { type: "consent/decline" });
    expect(declined.screen).toEqual({ name: "declined" });
    expect(run(declined, { type: "consent/review" }).screen).toEqual({ name: "consent" });
  });

  it("tracks the request in flight and its failure", () => {
    const sending = run(ready, { type: "start" }, { type: "request/start" });
    expect(sending.busy).toBe(true);
    const failed = run(sending, { type: "request/failed", error: "timeout" });
    expect(failed).toMatchObject({ busy: false, error: "timeout", screen: { name: "consent" } });
  });

  it("sends the rider back to a skipped step", () => {
    const onDocument = run(ready, { type: "start" }, { type: "consent/accepted", session: session({ consentGiven: true }) });
    expect(run(onDocument, { type: "request/failed", error: "consent_required" })).toMatchObject({
      screen: { name: "consent" },
      error: "consent_required",
    });
  });

  it("starts with the front once the document is chosen", () => {
    expect(cniChosen).toMatchObject({
      busy: false,
      document: "cni",
      sides: ["document_front", "document_back"],
      screen: { name: "capture", side: "document_front" },
    });
  });

  it("falls back to the contract's sides when the session omits them", () => {
    const state = run(ready, {
      type: "document/chosen",
      session: session({ consentGiven: true, declaredDocument: "passport", requiredSides: null }),
    });
    expect(state.sides).toEqual(["document_front"]);
  });
});

describe("capture and review", () => {
  it("captures front, turns the card over, then captures the back", () => {
    let state = run(cniChosen, { type: "capture/taken", shot: shot("document_front") });
    expect(state.screen).toEqual({ name: "review", side: "document_front" });
    state = run(state, { type: "review/accept" });
    expect(state.screen).toEqual({ name: "turnOver", side: "document_back" });
    state = run(state, { type: "turnOver/ready" });
    expect(state.screen).toEqual({ name: "capture", side: "document_back" });
    state = run(state, { type: "capture/taken", shot: shot("document_back") }, { type: "review/accept" });
    expect(state.screen).toEqual({ name: "upload" });
    expect(state.upload.status).toBe("queued");
    expect(pendingShots(state).map((s) => s.side)).toEqual(["document_front", "document_back"]);
  });

  it("needs only the photo page for a passport", () => {
    const passport = run(ready, {
      type: "document/chosen",
      session: withDocument("passport", ["document_front"]),
    });
    const state = run(passport, { type: "capture/taken", shot: shot("document_front") }, { type: "review/accept" });
    expect(state.screen).toEqual({ name: "upload" });
  });

  it("retakes a photo", () => {
    const state = run(cniChosen, { type: "capture/taken", shot: shot("document_front") }, { type: "review/retake" });
    expect(state.screen).toEqual({ name: "capture", side: "document_front" });
    expect(state.shots.document_front).toBeUndefined();
  });

  it("ignores a photo for a side that is not being captured", () => {
    expect(run(cniChosen, { type: "capture/taken", shot: shot("document_back") })).toBe(cniChosen);
  });

  it("refuses a blurry or glary manual photo, then allows it after repeated refusals", () => {
    const blurry = shot("document_front", "manual", ["blurry", "hold_still"]);
    expect(refusalHints(blurry)).toEqual(["blurry"]);
    let state = run(cniChosen, { type: "capture/taken", shot: blurry });
    expect(state.refusals.document_front).toBe(1);
    expect(canUseShot(state, blurry)).toBe(false);
    expect(run(state, { type: "review/accept" })).toBe(state);

    for (let i = 1; i < REFUSALS_BEFORE_OVERRIDE; i++) {
      state = run(state, { type: "review/retake" }, { type: "capture/taken", shot: blurry });
    }
    expect(state.refusals.document_front).toBe(REFUSALS_BEFORE_OVERRIDE);
    expect(canUseShot(state, blurry)).toBe(true);
    expect(run(state, { type: "review/accept" }).screen).toEqual({ name: "turnOver", side: "document_back" });
  });

  it("does not refuse an automatic photo with the same hints", () => {
    const auto = shot("document_front", "auto", ["glare"]);
    expect(refusalHints(auto)).toEqual([]);
    const state = run(cniChosen, { type: "capture/taken", shot: auto });
    expect(state.refusals.document_front).toBeUndefined();
    expect(run(state, { type: "review/accept" }).screen.name).toBe("turnOver");
  });

  it("never offers a photo under the server's minimum resolution, even after refusals", () => {
    const small = { ...shot("document_front", "manual", ["blurry"]), lowResolution: true };
    let state = run(cniChosen, { type: "capture/taken", shot: small });
    for (let i = 0; i < REFUSALS_BEFORE_OVERRIDE + 1; i++) {
      state = run(state, { type: "review/retake" }, { type: "capture/taken", shot: small });
    }
    expect(state.refusals.document_front).toBeGreaterThanOrEqual(REFUSALS_BEFORE_OVERRIDE);
    expect(canUseShot(state, small)).toBe(false);
    expect(run(state, { type: "review/accept" })).toBe(state);
    // An automatic photo too.
    const autoSmall = { ...shot("document_front"), lowResolution: true };
    const auto = run(cniChosen, { type: "capture/taken", shot: autoSmall });
    expect(canUseShot(auto, autoSmall)).toBe(false);
    expect(run(auto, { type: "review/accept" })).toBe(auto);
  });

  it("keeps the photos when the rider picks the same document again", () => {
    let state = run(cniChosen, { type: "capture/taken", shot: shot("document_front") }, { type: "review/accept" });
    state = run(state, { type: "turnOver/ready" }, { type: "document/change" });
    expect(state.screen).toEqual({ name: "document" });
    state = run(state, { type: "document/chosen", session: withDocument("cni", ["document_front", "document_back"]) });
    expect(state.shots.document_front).toBeDefined();
    expect(state.screen).toEqual({ name: "turnOver", side: "document_back" });
  });

  it("lets the rider change the document from the camera, restarting the photos", () => {
    let state = run(cniChosen, { type: "capture/taken", shot: shot("document_front") }, { type: "review/accept" });
    state = run(state, { type: "turnOver/ready" }, { type: "document/change" });
    expect(state.screen).toEqual({ name: "document" });
    state = run(state, { type: "document/chosen", session: withDocument("passport", ["document_front"]) });
    expect(state.shots).toEqual({});
    expect(state.screen).toEqual({ name: "capture", side: "document_front" });
  });
});

describe("upload", () => {
  const queued = run(
    cniChosen,
    { type: "capture/taken", shot: shot("document_front") },
    { type: "review/accept" },
    { type: "turnOver/ready" },
    { type: "capture/taken", shot: shot("document_back") },
    { type: "review/accept" },
  );
  const progress = { done: 0, total: 7, phase: "link" as const, photo: 1, photos: 2, attempt: 1 };
  const running = run(queued, { type: "upload/started", progress });

  it("runs once from the queue", () => {
    expect(running.upload).toEqual({ status: "running", progress });
    expect(run(running, { type: "upload/started", progress })).toBe(running);
  });

  it("finishes on the done screen", () => {
    const state = run(
      running,
      { type: "upload/sideDone", side: "document_front" },
      { type: "upload/sideDone", side: "document_back" },
      { type: "upload/submitted", session: withDocument("cni", ["document_front", "document_back"]) },
    );
    expect(state.screen).toEqual({ name: "done" });
    expect(state.upload.status).toBe("idle");
  });

  it("waits for a manual retry after the automatic retries failed, keeping finished sides", () => {
    const failed = run(
      running,
      { type: "upload/sideDone", side: "document_front" },
      { type: "upload/failed", error: "network", side: "document_back" },
    );
    expect(failed).toMatchObject({ error: "network", upload: { status: "failed" }, screen: { name: "upload" } });
    const retried = run(failed, { type: "upload/retry" });
    expect(retried.upload.status).toBe("queued");
    expect(pendingShots(retried).map((s) => s.side)).toEqual(["document_back"]);
  });

  it("sends a refused image back to the camera for that side only", () => {
    const state = run(
      running,
      { type: "upload/sideDone", side: "document_front" },
      { type: "upload/failed", error: "image_resolution_too_low", side: "document_back" },
    );
    expect(state).toMatchObject({
      error: "image_resolution_too_low",
      screen: { name: "capture", side: "document_back" },
      upload: { status: "idle" },
    });
    expect(state.shots.document_back).toBeUndefined();
    const again = run(state, { type: "capture/taken", shot: shot("document_back") }, { type: "review/accept" });
    expect(again.screen).toEqual({ name: "upload" });
    expect(pendingShots(again).map((s) => s.side)).toEqual(["document_back"]);
  });

  it("starts the photos over when the server is missing a side", () => {
    const state = run(running, { type: "upload/failed", error: "missing_sides", side: null });
    expect(state).toMatchObject({ shots: {}, uploaded: {}, screen: { name: "capture", side: "document_front" } });
  });

  it("ends the flow when the session expires mid-upload", () => {
    const state = run(running, { type: "upload/failed", error: "session_expired", side: "document_front" });
    expect(state.screen).toEqual({ name: "sessionError", reason: "expired" });
    expect(state.upload.status).toBe("idle");
  });

  it("does not auto-retry a permanent failure but shows it", () => {
    const state = run(running, { type: "upload/failed", error: "too_many_uploads", side: "document_front" });
    expect(state).toMatchObject({ error: "too_many_uploads", upload: { status: "failed" } });
  });

  it("ignores a retry when nothing failed", () => {
    expect(run(running, { type: "upload/retry" })).toBe(running);
  });
});

describe("the phone's Back button", () => {
  const back = { type: "nav/back" } as const;
  const frontReview = run(cniChosen, { type: "capture/taken", shot: shot("document_front") });
  const turnOver = run(frontReview, { type: "review/accept" });
  const backCamera = run(turnOver, { type: "turnOver/ready" });
  const backReview = run(backCamera, { type: "capture/taken", shot: shot("document_back") });

  it("goes from a review back to that side's camera", () => {
    const state = run(backReview, back);
    expect(state.screen).toEqual({ name: "capture", side: "document_back" });
    expect(state.shots.document_back).toBeUndefined();
    expect(state.shots.document_front).toBeDefined();
  });

  it("goes from the back's camera to the turn-over step, then to the front's review, keeping the front", () => {
    let state = run(backCamera, back);
    expect(state.screen).toEqual({ name: "turnOver", side: "document_back" });
    state = run(state, back);
    expect(state.screen).toEqual({ name: "review", side: "document_front" });
    expect(state.shots.document_front).toBe(frontReview.shots.document_front);
    // ...and forward again without retaking the front.
    expect(run(state, { type: "review/accept" }).screen).toEqual({ name: "turnOver", side: "document_back" });
  });

  it("goes from the first camera to the document list", () => {
    expect(run(cniChosen, back).screen).toEqual({ name: "document" });
  });

  it("does nothing during an upload", () => {
    const queued = run(backReview, { type: "review/accept" });
    expect(queued.screen.name).toBe("upload");
    expect(run(queued, back)).toBe(queued);
  });

  it("returns from the declined screen to the consent text", () => {
    const declined = run(ready, { type: "start" }, { type: "consent/decline" });
    expect(run(declined, back).screen).toEqual({ name: "consent" });
  });

  it("leaves the other screens unchanged (the browser may leave the page)", () => {
    for (const state of [ready, run(ready, { type: "start" }), run(cniChosen, { type: "document/change" })]) {
      expect(run(state, back)).toBe(state);
    }
  });

  it("is handled by the flow only on the camera, turn-over, review and upload screens", () => {
    expect(handlesBack({ name: "capture", side: "document_front" })).toBe(true);
    expect(handlesBack({ name: "turnOver", side: "document_back" })).toBe(true);
    expect(handlesBack({ name: "review", side: "document_back" })).toBe(true);
    expect(handlesBack({ name: "upload" })).toBe(true);
    for (const name of ["welcome", "consent", "declined", "document", "done"] as const) {
      expect(handlesBack({ name })).toBe(false);
    }
  });
});
