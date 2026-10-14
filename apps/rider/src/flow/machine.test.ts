import { describe, expect, it } from "vitest";
import {
  MRZ_TRIES_BEFORE_OVERRIDE,
  REQUIRED_SIDES,
  SERVER_RETAKES_PER_SIDE,
  type CaptureSide,
  type ClientQuality,
  type DeclaredDocument,
  type FlowCheckSide,
  type FlowChecks,
  type FlowSession,
  type FlowStatus,
  type MrzFormat,
} from "@verify/shared";
import type { Hint } from "@verify/capture";
import type { MrzReadResult, MrzReadStatus } from "../mrz/types";
import {
  type FlowAction,
  type FlowState,
  type Shot,
  REFUSALS_BEFORE_OVERRIDE,
  acceptsServerRetake,
  canUseShot,
  checksDecision,
  closedReason,
  flowReducer,
  handlesBack,
  initialFlowState,
  mrzExpectationFor,
  mrzReview,
  pendingShots,
  refusalHints,
  sideShots,
  usedOverride,
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
  { type: "document/chosen", session: withDocument("cni_legacy", ["document_front", "document_back"]) },
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
      document: "cni_legacy",
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
    state = run(state, { type: "document/chosen", session: withDocument("cni_legacy", ["document_front", "document_back"]) });
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
    expect(running.upload).toEqual({ status: "running", stage: "sides", progress });
    expect(run(running, { type: "upload/started", progress })).toBe(running);
  });

  it("finishes on the done screen", () => {
    const state = run(
      running,
      { type: "upload/sideDone", side: "document_front" },
      { type: "upload/sideDone", side: "document_back" },
      { type: "upload/submitted", session: withDocument("cni_legacy", ["document_front", "document_back"]) },
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

  it("is handled by the flow only on the camera, turn-over, reading, review, upload and checking screens", () => {
    expect(handlesBack({ name: "capture", side: "document_front" })).toBe(true);
    expect(handlesBack({ name: "turnOver", side: "document_back" })).toBe(true);
    expect(handlesBack({ name: "reading", side: "document_back" })).toBe(true);
    expect(handlesBack({ name: "review", side: "document_back" })).toBe(true);
    expect(handlesBack({ name: "upload" })).toBe(true);
    expect(handlesBack({ name: "checking" })).toBe(true);
    for (const name of ["welcome", "consent", "declined", "document", "done"] as const) {
      expect(handlesBack({ name })).toBe(false);
    }
  });
});

describe("reading the code lines (MRZ)", () => {
  const gray = () => ({ width: 8, height: 4, data: new Uint8Array(32) });
  /** A photo of `side` with its full-resolution grayscale copy, as the camera hands it over. */
  const withGray = (side: CaptureSide, source: ClientQuality["source"] = "auto", hints: Hint[] = []): Shot => ({
    ...shot(side, source, hints),
    gray: gray(),
  });
  const LINES: Record<MrzFormat, string[]> = {
    TD1: ["I<UTOD231458907<<<<<<<<<<<<<<<", "7408122F1204159UTO<<<<<<<<<<<6", "ERIKSSON<<ANNA<MARIA<<<<<<<<<<"],
    TD3: ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10"],
  };
  function read(status: MrzReadStatus, format: MrzFormat = "TD1"): MrzReadResult {
    const lines = status === "valid" || status === "invalid" ? LINES[format] : null;
    return { status, format, lines, parsed: null, corrections: 0, ms: 300, rawText: "", charHeight: 18, rotated: false };
  }

  function chosen(document: DeclaredDocument): FlowState {
    return run(ready, { type: "document/chosen", session: withDocument(document, [...REQUIRED_SIDES[document]]) });
  }
  /** At the camera of the back of a two-sided document, the front accepted. */
  function atBack(document: DeclaredDocument): FlowState {
    return run(
      chosen(document),
      { type: "capture/taken", shot: shot("document_front") },
      { type: "review/accept" },
      { type: "turnOver/ready" },
    );
  }
  /** Takes a photo of `side` and finishes reading it with `result`. */
  function takeAndRead(state: FlowState, side: CaptureSide, result: MrzReadResult, photo = withGray(side)): FlowState {
    const reading = run(state, { type: "capture/taken", shot: photo });
    expect(reading.screen).toEqual({ name: "reading", side });
    return run(reading, { type: "mrz/read", shot: photo, result });
  }

  it("knows which side carries the MRZ", () => {
    expect(mrzExpectationFor("passport", "document_front")).toMatchObject({ format: "TD3", required: true });
    expect(mrzExpectationFor("cni_biometric", "document_back")).toMatchObject({ format: "TD1", required: true });
    expect(mrzExpectationFor("cni_biometric", "document_front")).toBeNull();
    expect(mrzExpectationFor("residence_permit", "document_back")).toMatchObject({ required: false });
    expect(mrzExpectationFor("cni_legacy", "document_back")).toBeNull();
    expect(mrzExpectationFor(null, "document_front")).toBeNull();
  });

  it("reads the new CNI's back, then shows its review with the result and without the grayscale copy", () => {
    let state = atBack("cni_biometric");
    // The front carries no MRZ: straight to its review (checked by atBack's accept).
    const photo = withGray("document_back");
    state = run(state, { type: "capture/taken", shot: photo });
    expect(state.screen).toEqual({ name: "reading", side: "document_back" });
    expect(state.shots.document_back).toBe(photo);

    state = run(state, { type: "mrz/read", shot: photo, result: read("valid") });
    expect(state.screen).toEqual({ name: "review", side: "document_back" });
    const kept = state.shots.document_back!;
    expect(kept.gray).toBeNull();
    expect(kept.mrz?.status).toBe("valid");
    expect(kept.mrzAttempt).toBe(1);
    expect(state.mrzReads).toEqual({ document_back: 1 });
    expect(state.mrzFailures).toEqual({});
    expect(mrzReview(state, kept)).toEqual({ status: "read" });
    expect(canUseShot(state, kept)).toBe(true);
    expect(run(state, { type: "review/accept" }).screen).toEqual({ name: "upload" });
  });

  it("reads the passport's photo page", () => {
    const state = takeAndRead(chosen("passport"), "document_front", read("valid", "TD3"));
    expect(state.screen).toEqual({ name: "review", side: "document_front" });
    expect(mrzReview(state, state.shots.document_front!)).toEqual({ status: "read" });
  });

  it("does not read the old CNI, and drops any grayscale copy", () => {
    const state = run(atBack("cni_legacy"), { type: "capture/taken", shot: withGray("document_back") });
    expect(state.screen).toEqual({ name: "review", side: "document_back" });
    expect(state.shots.document_back?.gray).toBeNull();
    expect(state.shots.document_back?.mrz).toBeUndefined();
    expect(state.mrzReads).toEqual({});
  });

  it("does not read a photo under the server's minimum resolution", () => {
    const small = { ...withGray("document_front"), lowResolution: true };
    const state = run(chosen("passport"), { type: "capture/taken", shot: small });
    expect(state.screen).toEqual({ name: "review", side: "document_front" });
    expect(state.shots.document_front?.gray).toBeNull();
    expect(state.mrzReads).toEqual({});
    expect(canUseShot(state, state.shots.document_front!)).toBe(false);
  });

  it("skips the reading screen when the phone could not keep a grayscale copy, which never blocks", () => {
    const state = run(chosen("passport"), { type: "capture/taken", shot: shot("document_front") });
    expect(state.screen).toEqual({ name: "review", side: "document_front" });
    const kept = state.shots.document_front!;
    expect(kept.mrz?.status).toBe("unavailable");
    expect(kept.mrzAttempt).toBe(1);
    expect(state.mrzFailures).toEqual({});
    expect(mrzReview(state, kept)).toBeNull();
    expect(canUseShot(state, kept)).toBe(true);
  });

  it("shows the first download's progress for the photo being read only", () => {
    const photo = withGray("document_front");
    const reading = run(chosen("passport"), { type: "capture/taken", shot: photo });
    expect(reading.readProgress).toBeNull();
    const half = run(reading, { type: "mrz/progress", shot: photo, progress: 0.4999 });
    expect(half.readProgress).toBe(0.5);
    // Same rounded value: same state (no re-render).
    expect(run(half, { type: "mrz/progress", shot: photo, progress: 0.501 })).toBe(half);
    expect(run(half, { type: "mrz/progress", shot: photo, progress: Number.NaN })).toBe(half);
    expect(run(half, { type: "mrz/progress", shot: withGray("document_front"), progress: 0.9 })).toBe(half);
    expect(run(half, { type: "mrz/read", shot: photo, result: read("valid", "TD3") }).readProgress).toBeNull();
  });

  it("goes back from the reading screen to the camera, and ignores the abandoned read", () => {
    const photo = withGray("document_front");
    const reading = run(chosen("passport"), { type: "capture/taken", shot: photo });
    const back = run(reading, { type: "nav/back" });
    expect(back.screen).toEqual({ name: "capture", side: "document_front" });
    expect(back.shots.document_front).toBeUndefined();
    expect(run(back, { type: "mrz/read", shot: photo, result: read("valid", "TD3") })).toBe(back);
    expect(run(back, { type: "mrz/progress", shot: photo, progress: 0.3 })).toBe(back);

    // The next photo is read normally; a late result for the first one still changes nothing.
    const again = withGray("document_front");
    const rereading = run(back, { type: "capture/taken", shot: again });
    expect(run(rereading, { type: "mrz/read", shot: photo, result: read("not_found", "TD3") })).toBe(rereading);
    const done = run(rereading, { type: "mrz/read", shot: again, result: read("valid", "TD3") });
    expect(done.shots.document_front?.mrz?.status).toBe("valid");
    // The abandoned read was never counted.
    expect(done.shots.document_front?.mrzAttempt).toBe(1);
  });

  it("ignores a result once the review is showing (a duplicate)", () => {
    const photo = withGray("document_front");
    const reviewed = takeAndRead(chosen("passport"), "document_front", read("valid", "TD3"), photo);
    expect(run(reviewed, { type: "mrz/read", shot: photo, result: read("not_found", "TD3") })).toBe(reviewed);
  });

  it(`asks for retakes, then offers "Continue anyway" after ${MRZ_TRIES_BEFORE_OVERRIDE} failed tries`, () => {
    let state = atBack("cni_biometric");
    const outcomes: MrzReadStatus[] = ["not_found", "invalid", "not_found"];
    for (const [index, status] of outcomes.entries()) {
      state = takeAndRead(state, "document_back", read(status));
      const kept = state.shots.document_back!;
      expect(kept.mrzAttempt).toBe(index + 1);
      expect(state.mrzFailures.document_back).toBe(index + 1);
      const last = index + 1 === MRZ_TRIES_BEFORE_OVERRIDE;
      expect(mrzReview(state, kept)).toEqual({ status: "unread", format: "TD1", canContinue: last });
      expect(canUseShot(state, kept)).toBe(last);
      if (!last) {
        expect(run(state, { type: "review/accept" })).toBe(state);
        state = run(state, { type: "review/retake" });
        expect(state.screen).toEqual({ name: "capture", side: "document_back" });
      }
    }
    expect(run(state, { type: "review/accept" }).screen).toEqual({ name: "upload" });
  });

  it("needs no override when a later try reads the lines", () => {
    let state = takeAndRead(chosen("passport"), "document_front", read("invalid", "TD3"));
    expect(canUseShot(state, state.shots.document_front!)).toBe(false);
    state = takeAndRead(run(state, { type: "review/retake" }), "document_front", read("valid", "TD3"));
    expect(state.shots.document_front?.mrzAttempt).toBe(2);
    expect(state.mrzFailures.document_front).toBe(1);
    expect(mrzReview(state, state.shots.document_front!)).toEqual({ status: "read" });
    expect(canUseShot(state, state.shots.document_front!)).toBe(true);
  });

  it("never blocks when the reader is unavailable, and does not count it as a failed try", () => {
    const state = takeAndRead(chosen("passport"), "document_front", read("unavailable", "TD3"));
    const kept = state.shots.document_front!;
    expect(state.mrzFailures).toEqual({});
    expect(state.mrzReads).toEqual({ document_front: 1 });
    expect(mrzReview(state, kept)).toBeNull();
    expect(canUseShot(state, kept)).toBe(true);
    expect(run(state, { type: "review/accept" }).screen).toEqual({ name: "upload" });
  });

  it("never blocks on an optional MRZ (residence permit), but says when it was read", () => {
    const unread = takeAndRead(atBack("residence_permit"), "document_back", read("not_found"));
    const kept = unread.shots.document_back!;
    expect(unread.mrzFailures).toEqual({});
    expect(unread.mrzReads).toEqual({ document_back: 1 });
    expect(mrzReview(unread, kept)).toBeNull();
    expect(canUseShot(unread, kept)).toBe(true);
    expect(run(unread, { type: "review/accept" }).screen).toEqual({ name: "upload" });

    const readOk = takeAndRead(run(unread, { type: "review/retake" }), "document_back", read("valid"));
    expect(mrzReview(readOk, readOk.shots.document_back!)).toEqual({ status: "read" });
  });

  it("needs both checks to allow a photo: blur and glare, and the code lines", () => {
    const blurry = () => withGray("document_front", "manual", ["blurry"]);
    let state = chosen("passport");
    // Enough refusals for the blur override, but too few MRZ tries.
    for (let i = 0; i < REFUSALS_BEFORE_OVERRIDE; i++) {
      state = takeAndRead(state, "document_front", read("not_found", "TD3"), blurry());
      if (i < REFUSALS_BEFORE_OVERRIDE - 1) state = run(state, { type: "review/retake" });
    }
    expect(state.refusals.document_front).toBe(REFUSALS_BEFORE_OVERRIDE);
    expect(canUseShot(state, state.shots.document_front!)).toBe(false);
    // The MRZ tries reach the override too: now both allow it.
    while ((state.mrzFailures.document_front ?? 0) < MRZ_TRIES_BEFORE_OVERRIDE) {
      state = takeAndRead(run(state, { type: "review/retake" }), "document_front", read("not_found", "TD3"), blurry());
    }
    expect(canUseShot(state, state.shots.document_front!)).toBe(true);

    // Lines read, but a fresh blurry refusal not yet overridable: still refused.
    const fresh = takeAndRead(chosen("passport"), "document_front", read("valid", "TD3"), blurry());
    expect(mrzReview(fresh, fresh.shots.document_front!)).toEqual({ status: "read" });
    expect(canUseShot(fresh, fresh.shots.document_front!)).toBe(false);
  });

  it("keeps the tries when the rider picks the same document again, and resets them for another", () => {
    let state = takeAndRead(chosen("passport"), "document_front", read("not_found", "TD3"));
    state = takeAndRead(run(state, { type: "review/retake" }), "document_front", read("invalid", "TD3"));
    expect(state.mrzFailures.document_front).toBe(2);
    state = run(state, { type: "document/change" });
    expect(state.screen).toEqual({ name: "document" });

    const same = run(state, { type: "document/chosen", session: withDocument("passport", ["document_front"]) });
    expect(same.mrzFailures).toEqual({ document_front: 2 });
    expect(same.mrzReads).toEqual({ document_front: 2 });

    const other = run(state, {
      type: "document/chosen",
      session: withDocument("cni_biometric", ["document_front", "document_back"]),
    });
    expect(other.mrzFailures).toEqual({});
    expect(other.mrzReads).toEqual({});
    expect(other.shots).toEqual({});
    expect(other.readProgress).toBeNull();
  });

  it("reads again after the server refused the photo", () => {
    let state = takeAndRead(chosen("passport"), "document_front", read("valid", "TD3"));
    state = run(
      state,
      { type: "review/accept" },
      { type: "upload/started", progress: { done: 0, total: 5, phase: "link", photo: 1, photos: 1, attempt: 1 } },
      { type: "upload/failed", error: "image_too_small", side: "document_front" },
    );
    expect(state.screen).toEqual({ name: "capture", side: "document_front" });
    state = takeAndRead(state, "document_front", read("valid", "TD3"));
    expect(state.shots.document_front?.mrzAttempt).toBe(2);
    expect(pendingShots(state).map((s) => s.side)).toEqual(["document_front"]);
  });
});

describe("the server's checks (M3)", () => {
  const progress = { done: 0, total: 7, phase: "link" as const, photo: 1, photos: 2, attempt: 1 };
  /** The ICAO 9303 TD1 specimen ("Utopia"): public example data. */
  const LINES_TD1 = [
    "I<UTOD231458907<<<<<<<<<<<<<<<",
    "7408122F1204159UTO<<<<<<<<<<<6",
    "ERIKSSON<<ANNA<MARIA<<<<<<<<<<",
  ];
  function read(status: MrzReadStatus): MrzReadResult {
    const lines = status === "valid" || status === "invalid" ? LINES_TD1 : null;
    const timing = { corrections: 0, ms: 300, rawText: "", charHeight: 18, rotated: false };
    return { status, format: "TD1", lines, parsed: null, ...timing };
  }

  /** Runs the queued upload of the photos still to send to its end: the checking screen. */
  function send(state: FlowState): FlowState {
    expect(state.upload).toMatchObject({ status: "queued", stage: "sides" });
    const sides = pendingShots(state).map((s) => s.side);
    return run(
      state,
      { type: "upload/started", progress },
      ...sides.map((side): FlowAction => ({ type: "upload/sideDone", side })),
      { type: "upload/sent" },
    );
  }

  /** Both sides of the old CNI taken (`front`, `back`), accepted and sent: the checking screen. */
  function checkingCni(front = shot("document_front"), back = shot("document_back")): FlowState {
    return send(
      run(
        cniChosen,
        { type: "capture/taken", shot: front },
        { type: "review/accept" },
        { type: "turnOver/ready" },
        { type: "capture/taken", shot: back },
        { type: "review/accept" },
      ),
    );
  }

  function checks(sides: Partial<Record<CaptureSide, FlowCheckSide["state"] | "no_document">>): FlowChecks {
    const list = Object.entries(sides).map(([kind, state]): FlowCheckSide => {
      const retake = state === "retake" || state === "no_document";
      return {
        kind: kind as CaptureSide,
        captureId: `capture-${kind}`,
        state: retake ? "retake" : (state as FlowCheckSide["state"]),
        reason: state === "no_document" ? "no_document" : retake ? "unreadable" : null,
      };
    });
    return { done: list.every((side) => side.state !== "pending"), sides: list };
  }

  const retakeFront = { type: "checks/retake", sides: [{ side: "document_front", reason: "no_document" }] } as const;
  const retakeBack = { type: "checks/retake", sides: [{ side: "document_back", reason: "unreadable" }] } as const;

  it("waits on the checking screen once every photo is sent, without submitting yet", () => {
    const state = checkingCni();
    expect(state.screen).toEqual({ name: "checking" });
    expect(state.upload).toEqual({ status: "idle", stage: "sides", progress: null });
    expect(state.uploaded).toEqual({ document_front: true, document_back: true });
    expect(sideShots(state).map((s) => s.side)).toEqual(["document_front", "document_back"]);
    // Only a running upload of the photos ends there.
    expect(run(state, { type: "upload/sent" })).toBe(state);
  });

  it("does nothing on Back while checking (the leave-page warning stays)", () => {
    const state = checkingCni();
    expect(handlesBack(state.screen)).toBe(true);
    expect(run(state, { type: "nav/back" })).toBe(state);
  });

  it("submits once the checks are over, then finishes", () => {
    const state = run(checkingCni(), { type: "checks/ok" });
    expect(state.screen).toEqual({ name: "upload" });
    expect(state.upload).toEqual({ status: "queued", stage: "submit", progress: null });
    // Nothing left to send: only the submit.
    expect(pendingShots(state)).toEqual([]);
    const submitting = run(state, {
      type: "upload/started",
      progress: { done: 6, total: 7, phase: "submit", photo: 0, photos: 2, attempt: 1 },
    });
    expect(submitting.upload).toMatchObject({ status: "running", stage: "submit" });
    const done = run(submitting, {
      type: "upload/submitted",
      session: withDocument("cni_legacy", ["document_front", "document_back"]),
    });
    expect(done.screen).toEqual({ name: "done" });
  });

  it("submits with no error shown when the checks time out or cannot be read", () => {
    const state = run(checkingCni(), { type: "checks/timeout" });
    expect(state).toMatchObject({ error: null, screen: { name: "upload" } });
    expect(state.upload).toMatchObject({ status: "queued", stage: "submit" });
  });

  it("ignores the checks' answers anywhere but on the checking screen", () => {
    const queued = run(cniChosen, { type: "capture/taken", shot: shot("document_front") });
    for (const action of [{ type: "checks/ok" }, { type: "checks/timeout" }, retakeFront] as const) {
      expect(run(queued, action)).toBe(queued);
    }
  });

  it("retries only the submit after it failed, without checking again", () => {
    let state = run(checkingCni(), { type: "checks/ok" }, { type: "upload/started", progress });
    state = run(state, { type: "upload/failed", error: "network", side: null });
    expect(state).toMatchObject({ error: "network", screen: { name: "upload" } });
    expect(state.upload).toMatchObject({ status: "failed", stage: "submit" });
    state = run(state, { type: "upload/retry" });
    expect(state.upload).toEqual({ status: "queued", stage: "submit", progress: null });
  });

  it("starts the photos over when the submit finds a side missing", () => {
    let state = run(checkingCni(), retakeFront);
    state = send(run(state, { type: "capture/taken", shot: shot("document_front") }, { type: "review/accept" }));
    state = run(state, { type: "checks/ok" }, { type: "upload/started", progress });
    state = run(state, { type: "upload/failed", error: "missing_sides", side: null });
    expect(state).toMatchObject({ shots: {}, uploaded: {}, retakeReasons: {} });
    expect(state.screen).toEqual({ name: "capture", side: "document_front" });
    expect(state.upload).toEqual({ status: "idle", stage: "sides", progress: null });
    // The server keeps its count of the retakes asked for: so does the phone.
    expect(state.serverRetakes).toEqual({ document_front: 1 });
  });

  it("sends the rider back to the front's camera, with the reason, when the server finds it unusable", () => {
    const checking = checkingCni();
    const state = run(checking, retakeFront);
    expect(state.screen).toEqual({ name: "capture", side: "document_front" });
    expect(state.error).toBeNull();
    expect(state.shots.document_front).toBeUndefined();
    expect(state.uploaded).toEqual({ document_back: true });
    expect(state.shots.document_back).toBe(checking.shots.document_back);
    expect(state.serverRetakes).toEqual({ document_front: 1 });
    expect(state.retakeReasons).toEqual({ document_front: "no_document" });

    // The new photo: the reason has been seen; the back is already on the server, so only the front goes.
    const taken = run(state, { type: "capture/taken", shot: shot("document_front") });
    expect(taken.retakeReasons).toEqual({});
    const queued = run(taken, { type: "review/accept" });
    expect(queued.upload).toEqual({ status: "queued", stage: "sides", progress: null });
    expect(pendingShots(queued).map((s) => s.side)).toEqual(["document_front"]);
    expect(send(queued).screen).toEqual({ name: "checking" });
  });

  it("goes through the turn-over step to retake the back", () => {
    let state = run(checkingCni(), retakeBack);
    expect(state.screen).toEqual({ name: "turnOver", side: "document_back" });
    expect(state.retakeReasons).toEqual({ document_back: "unreadable" });
    state = run(state, { type: "turnOver/ready" });
    expect(state.screen).toEqual({ name: "capture", side: "document_back" });
    // Back from there: the turn-over step, then the front's review (the front stays on the server).
    const back = run(state, { type: "nav/back" }, { type: "nav/back" });
    expect(back.screen).toEqual({ name: "review", side: "document_front" });
    expect(back.uploaded.document_front).toBe(true);
    state = run(state, { type: "capture/taken", shot: shot("document_back") }, { type: "review/accept" });
    expect(pendingShots(state).map((s) => s.side)).toEqual(["document_back"]);
  });

  it("retakes both sides, the front first, then the back through the turn-over step", () => {
    let state = run(checkingCni(), {
      type: "checks/retake",
      sides: [
        { side: "document_back", reason: "unreadable" },
        { side: "document_front", reason: "no_document" },
      ],
    });
    expect(state.screen).toEqual({ name: "capture", side: "document_front" });
    expect(state.shots).toEqual({});
    expect(state.uploaded).toEqual({});
    expect(state.retakeReasons).toEqual({ document_front: "no_document", document_back: "unreadable" });
    state = run(state, { type: "capture/taken", shot: shot("document_front") }, { type: "review/accept" });
    expect(state.screen).toEqual({ name: "turnOver", side: "document_back" });
    expect(state.retakeReasons).toEqual({ document_back: "unreadable" });
    state = run(
      state,
      { type: "turnOver/ready" },
      { type: "capture/taken", shot: shot("document_back") },
      { type: "review/accept" },
    );
    expect(pendingShots(state).map((s) => s.side)).toEqual(["document_front", "document_back"]);
  });

  it(`asks at most ${SERVER_RETAKES_PER_SIDE} time(s) per side, then submits the photo as it is`, () => {
    let state = checkingCni();
    for (let i = 0; i < SERVER_RETAKES_PER_SIDE; i++) {
      state = run(state, retakeFront);
      expect(state.screen).toEqual({ name: "capture", side: "document_front" });
      state = send(run(state, { type: "capture/taken", shot: shot("document_front") }, { type: "review/accept" }));
    }
    expect(acceptsServerRetake(state, "document_front")).toBe(false);
    const answer = checks({ document_front: "retake", document_back: "ok" });
    expect(checksDecision(state, answer)).toEqual({ type: "checks/ok" });
    const again = run(state, retakeFront);
    expect(again).toMatchObject({ screen: { name: "upload" }, upload: { status: "queued", stage: "submit" } });
    expect(again.serverRetakes).toEqual({ document_front: SERVER_RETAKES_PER_SIDE });
    // The other side still may be asked for.
    expect(acceptsServerRetake(state, "document_back")).toBe(true);
  });

  it("never asks again after the rider used a blurry or glary photo anyway", () => {
    const blurry = () => shot("document_front", "manual", ["blurry"]);
    let state = run(cniChosen, { type: "capture/taken", shot: blurry() });
    for (let i = 1; i < REFUSALS_BEFORE_OVERRIDE; i++) {
      state = run(state, { type: "review/retake" }, { type: "capture/taken", shot: blurry() });
    }
    state = run(state, { type: "review/accept" }, { type: "turnOver/ready" });
    state = send(run(state, { type: "capture/taken", shot: shot("document_back") }, { type: "review/accept" }));
    expect(usedOverride(state, state.shots.document_front!)).toBe(true);
    expect(acceptsServerRetake(state, "document_front")).toBe(false);
    expect(run(state, retakeFront)).toMatchObject({ screen: { name: "upload" }, serverRetakes: {} });
  });

  describe("on the side with the code lines", () => {
    const gray = () => ({ width: 8, height: 4, data: new Uint8Array(32) });
    /** The new CNI, its back read once per status in turn (retaken in between), accepted and sent. */
    function checkingBiometric(...statuses: MrzReadStatus[]): FlowState {
      const session = withDocument("cni_biometric", ["document_front", "document_back"]);
      let state = run(
        run(ready, { type: "document/chosen", session }),
        { type: "capture/taken", shot: shot("document_front") },
        { type: "review/accept" },
        { type: "turnOver/ready" },
      );
      for (const [index, status] of statuses.entries()) {
        if (index > 0) state = run(state, { type: "review/retake" });
        const photo = { ...shot("document_back"), gray: gray() };
        state = run(state, { type: "capture/taken", shot: photo });
        state = run(state, { type: "mrz/read", shot: photo, result: read(status) });
      }
      return send(run(state, { type: "review/accept" }));
    }

    it("never asks for a photo whose code lines the phone read with every check digit right", () => {
      const state = checkingBiometric("valid");
      expect(acceptsServerRetake(state, "document_back")).toBe(false);
      expect(checksDecision(state, checks({ document_front: "ok", document_back: "retake" }))).toEqual({
        type: "checks/ok",
      });
      expect(run(state, retakeBack).screen).toEqual({ name: "upload" });
    });

    it(`never asks again after "Continue anyway"`, () => {
      const state = checkingBiometric(...Array.from({ length: MRZ_TRIES_BEFORE_OVERRIDE }, () => "not_found" as const));
      expect(mrzReview(state, state.shots.document_back!)).toMatchObject({ status: "unread", canContinue: true });
      expect(usedOverride(state, state.shots.document_back!)).toBe(true);
      expect(run(state, retakeBack).screen).toEqual({ name: "upload" });
    });

    it("reads the code lines of the retaken photo again, for a new report", () => {
      // The reader could not run on the phone: the server may ask for the back again.
      let state = checkingBiometric("unavailable");
      expect(acceptsServerRetake(state, "document_back")).toBe(true);
      state = run(state, retakeBack, { type: "turnOver/ready" });
      const photo = { ...shot("document_back"), gray: gray() };
      state = run(state, { type: "capture/taken", shot: photo });
      expect(state.screen).toEqual({ name: "reading", side: "document_back" });
      state = run(state, { type: "mrz/read", shot: photo, result: read("valid") }, { type: "review/accept" });
      const [sent] = pendingShots(state);
      expect(sent.side).toBe("document_back");
      expect(sent.mrz?.status).toBe("valid");
      expect(sent.mrzAttempt).toBe(2);
    });
  });

  describe("checksDecision", () => {
    it("waits while a side is pending and none is to be retaken", () => {
      const state = checkingCni();
      expect(checksDecision(state, checks({ document_front: "ok", document_back: "pending" }))).toBeNull();
      expect(checksDecision(state, checks({ document_front: "pending", document_back: "pending" }))).toBeNull();
    });

    it("submits when every side is ok or could not be checked", () => {
      const state = checkingCni();
      expect(checksDecision(state, checks({ document_front: "ok", document_back: "ok" }))).toEqual({
        type: "checks/ok",
      });
      expect(checksDecision(state, checks({ document_front: "unchecked", document_back: "ok" }))).toEqual({
        type: "checks/ok",
      });
    });

    it("asks for a retake at once, even while the other side is pending", () => {
      const state = checkingCni();
      expect(checksDecision(state, checks({ document_front: "no_document", document_back: "pending" }))).toEqual({
        type: "checks/retake",
        sides: [{ side: "document_front", reason: "no_document" }],
      });
      expect(checksDecision(state, checks({ document_front: "retake", document_back: "retake" }))).toEqual({
        type: "checks/retake",
        sides: [
          { side: "document_front", reason: "unreadable" },
          { side: "document_back", reason: "unreadable" },
        ],
      });
    });

    it("keeps waiting for the other sides when a retake may not be asked", () => {
      const state = { ...checkingCni(), serverRetakes: { document_front: SERVER_RETAKES_PER_SIDE } };
      expect(checksDecision(state, checks({ document_front: "retake", document_back: "pending" }))).toBeNull();
    });

    it("treats an unknown reason, or a side it did not send, as nothing to retake", () => {
      const state = checkingCni();
      const odd: FlowChecks = {
        done: true,
        sides: [
          { kind: "document_front", captureId: "c", state: "retake", reason: "too_shiny" as never },
          { kind: "document_back", captureId: "d", state: "ok", reason: null },
        ],
      };
      expect(checksDecision(state, odd)).toEqual({ type: "checks/ok" });
      const unknown = { side: "document_front", reason: "too_shiny" as never } as const;
      expect(run(state, { type: "checks/retake", sides: [unknown] }).screen).toEqual({ name: "upload" });
      const passport = send(
        run(
          run(ready, { type: "document/chosen", session: withDocument("passport", ["document_front"]) }),
          { type: "capture/taken", shot: shot("document_front") },
          { type: "review/accept" },
        ),
      );
      const answer = checks({ document_front: "ok", document_back: "retake" });
      expect(checksDecision(passport, answer)).toEqual({ type: "checks/ok" });
    });
  });

  it("keeps the reasons when the rider picks the same document again, and drops them for another", () => {
    let state = run(checkingCni(), retakeFront, { type: "nav/back" });
    expect(state.screen).toEqual({ name: "document" });
    const cni = withDocument("cni_legacy", ["document_front", "document_back"]);
    const same = run(state, { type: "document/chosen", session: cni });
    expect(same.screen).toEqual({ name: "capture", side: "document_front" });
    expect(same.retakeReasons).toEqual({ document_front: "no_document" });
    state = run(state, { type: "document/chosen", session: withDocument("passport", ["document_front"]) });
    expect(state.retakeReasons).toEqual({});
    expect(state.serverRetakes).toEqual({ document_front: 1 });
  });
});
