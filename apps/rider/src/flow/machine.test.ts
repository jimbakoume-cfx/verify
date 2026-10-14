import { describe, expect, it } from "vitest";
import {
  MRZ_TRIES_BEFORE_OVERRIDE,
  REQUIRED_SIDES,
  type CaptureSide,
  type ClientQuality,
  type DeclaredDocument,
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
  canUseShot,
  closedReason,
  flowReducer,
  handlesBack,
  initialFlowState,
  mrzExpectationFor,
  mrzReview,
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
    expect(running.upload).toEqual({ status: "running", progress });
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

  it("is handled by the flow only on the camera, turn-over, reading, review and upload screens", () => {
    expect(handlesBack({ name: "capture", side: "document_front" })).toBe(true);
    expect(handlesBack({ name: "turnOver", side: "document_back" })).toBe(true);
    expect(handlesBack({ name: "reading", side: "document_back" })).toBe(true);
    expect(handlesBack({ name: "review", side: "document_back" })).toBe(true);
    expect(handlesBack({ name: "upload" })).toBe(true);
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
