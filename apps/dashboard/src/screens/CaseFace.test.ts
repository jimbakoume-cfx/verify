// The "Server face checks" section (M6/M7), rendered to HTML on the server side, and the parsers behind
// it: only the contract's codes and scores get through, the face match always shows "Uncalibrated"
// and "Review only", admins get no photos, and the crop is CSS over the audited photo.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import type { FaceMatchDetails, LivenessDetails } from "@verify/shared";
import { type DashboardServices, ServicesContext } from "../api/services";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import { cropStyle, faceJobStates, type FaceChecks, toBox, toFaceChecks, toFaceMatchDetails, toLivenessEvalDetails } from "../lib/faceChecks";
import { type CaptureRecord, type StaffProfile, toCapture } from "../lib/records";
import { toRiskAssessment } from "../lib/risk";
import { FaceChecksSection } from "./CaseFace";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: "en",
  fallbackLng: "fr",
  interpolation: { escapeValue: false },
});

function render(element: ReactElement, lng: "en" | "fr" = "en"): string {
  void i18n.changeLanguage(lng);
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(ServicesContext.Provider, { value: {} as DashboardServices }, element)),
  );
}

const CHALLENGE = "0d9f6a8e-1b7c-4c11-9b0e-6f2b8a2f4f10";
const FRONT = "a1111111-1111-4111-8111-111111111111";
const FRAME = "f6666666-6666-4666-8666-000000000000";

const LIVENESS: LivenessDetails = {
  evaluated: true,
  provisional: true,
  challengeId: CHALLENGE,
  engine: "face-1/mediapipe-fl-v1/auraface-v1",
  actions: [
    { action: "turn_left", result: "pass", framesWithFace: 4, peak: 22.4 },
    { action: "blink", result: "fail", framesWithFace: 4, peak: 0.2 },
    { action: "smile", result: "unclear", framesWithFace: 0, peak: null },
  ],
  frames: 13,
  framesWithFace: 9,
  flatPlane: "flat",
  flatPlaneScore: 0.004,
  problems: ["action_not_done", "action_unclear", "flat_plane"],
  timing: { ms: 420, cold: false },
};

const MATCH: FaceMatchDetails = {
  model: "auraface-v1/glintr100",
  engine: "face-1/mediapipe-fl-v1/auraface-v1",
  similarity: 0.512,
  threshold: 0.35,
  lowThreshold: 0.15,
  calibrated: false,
  reviewOnly: true,
  problems: ["portrait_small"],
  portrait: { captureId: FRONT, box: [0.07, 0.24, 0.17, 0.33] },
  selfie: { captureId: FRAME, box: [0.25, 0.2, 0.5, 0.42] },
  timing: { ms: 1180, cold: true },
};

function row(name: string, details: unknown, outcome = "pass") {
  return { id: `${name}-id`, capture_id: null, check_name: name, check_version: `${name}-v1`, outcome, details, created_at: "2026-10-20T09:00:00Z" };
}

const CAPTURES: CaptureRecord[] = [
  toCapture({ id: FRONT, kind: "document_front", byte_size: 240000, width: 1600, height: 1126, created_at: "2026-10-20T08:55:00Z", sha256: "a".repeat(64), deleted_at: null, superseded_by: null, quality: {}, liveness_challenge_id: null })!,
  toCapture({ id: FRAME, kind: "liveness_frame", byte_size: 31000, width: 360, height: 480, created_at: "2026-10-20T08:57:00Z", sha256: "b".repeat(64), deleted_at: null, superseded_by: null, quality: { liveness: { index: 0, step: 0, atMs: 900 } }, liveness_challenge_id: CHALLENGE })!,
];

const supervisor: StaffProfile = { userId: "s", role: "supervisor", fullName: "Sup", active: true };
const admin: StaffProfile = { userId: "a", role: "admin", fullName: "Adm", active: true };

function section(checks: FaceChecks, profile = supervisor, lng: "en" | "fr" = "en") {
  return render(createElement(FaceChecksSection, { checks, captures: CAPTURES, error: null, loading: false, profile, onReload: () => {} }), lng);
}

describe("parsers", () => {
  it("read the face worker's two checks and nothing else", () => {
    const checks = toFaceChecks(
      [row("liveness", LIVENESS, "fail"), row("face_match", MATCH), row("liveness_capture", {}), { ...row("liveness", LIVENESS), capture_id: FRONT }],
      [],
    );
    expect(checks.liveness?.details).toEqual(LIVENESS);
    expect(checks.liveness?.outcome).toBe("fail");
    expect(checks.faceMatch?.details).toEqual(MATCH);
  });

  it("refuse details with an unknown key, code or a missing field", () => {
    expect(toLivenessEvalDetails({ ...LIVENESS, actions: [{ ...LIVENESS.actions[0], yaw: 22 }] })).toBeNull();
    expect(toLivenessEvalDetails({ ...LIVENESS, problems: ["looks_fake"] })).toBeNull();
    expect(toLivenessEvalDetails({ ...LIVENESS, evaluated: false })).toBeNull();
    expect(toFaceMatchDetails({ ...MATCH, calibrated: true })).toBeNull();
    expect(toFaceMatchDetails({ ...MATCH, reviewOnly: false })).toBeNull();
    expect(toFaceMatchDetails({ ...MATCH, portrait: { ...MATCH.portrait, name: "X" } })).toBeNull();
    const { threshold: _threshold, ...noThreshold } = MATCH;
    expect(toFaceMatchDetails(noThreshold)).toBeNull();
  });

  it("boxes are 4 fractions or nothing", () => {
    expect(toBox([0.1, 0.2, 0.3, 0.4])).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(toBox([0.1, 0.2, 1.3, 0.4])).toBeNull();
    expect(toBox("0.1,0.2")).toBeNull();
  });

  it("job states: waiting beats given up beats done; superseded jobs are ignored", () => {
    expect(faceJobStates([])).toEqual({ liveness: "none", face_match: "none" });
    expect(faceJobStates([{ kind: "liveness", status: "done" }, { kind: "liveness", status: "pending" }]).liveness).toBe("waiting");
    expect(faceJobStates([{ kind: "face_match", status: "failed" }, { kind: "face_match", status: "done" }]).face_match).toBe("not_checked");
    expect(faceJobStates([{ kind: "face_match", status: "superseded" }]).face_match).toBe("none");
    expect(faceJobStates([{ kind: "selfie", status: "pending" }])).toEqual({ liveness: "none", face_match: "none" });
  });

  it("a stored assessment gains reviewOnly; an older one without it has none", () => {
    const base = {
      recommendation: "review", band: "approve", score: 0, firmScore: 0, reasons: ["score_low", "review_only_check"], contributions: [],
      hardFlags: [], missing: [], unknownSignals: [], rejectReasonCode: null, approveMax: 0.15, rejectMin: 0.9,
    };
    expect(toRiskAssessment({ ...base, reviewOnly: ["face_match"] })?.reviewOnly).toEqual(["face_match"]);
    expect(toRiskAssessment({ ...base, reviewOnly: ["face_match"] })?.reasons).toContain("review_only_check");
    expect(toRiskAssessment(base)?.reviewOnly).toEqual([]);
  });
});

describe("cropStyle", () => {
  it("shows the box with a margin, keeping its aspect ratio", () => {
    const style = cropStyle([0.25, 0.25, 0.5, 0.5], 400, 400, 0);
    expect(style.container.aspectRatio).toBe("200 / 200");
    expect(style.image).toEqual({ width: "200%", height: "200%", left: "-50%", top: "-50%" });
  });

  it("never reaches outside the photo", () => {
    const style = cropStyle([0, 0, 0.2, 0.2], 1000, 500, 0.5);
    expect(style.image.left).toBe("0%");
    expect(style.image.top).toBe("0%");
  });
});

describe("the section", () => {
  const checks = toFaceChecks([row("liveness", LIVENESS, "fail"), row("face_match", MATCH)], []);

  it("lists each action asked, in order, with what was seen", () => {
    const html = section(checks);
    expect(html).toContain("Liveness (actions re-checked on the server)");
    expect(html).toMatch(/1\. Turn the head left.*Done.*22°/s);
    expect(html).toMatch(/2\. Blink.*Not done/s);
    expect(html).toMatch(/3\. Smile.*Cannot tell/s);
    expect(html).toContain("Moved like a flat picture");
  });

  it("marks the provisional parts", () => {
    const html = section(checks);
    expect(html).toContain("Provisional");
    expect(html).toMatch(/Flat face\..*Provisional/s);
  });

  it("always shows the face match as uncalibrated and review only, with its threshold", () => {
    const html = section(checks);
    expect(html).toContain("Uncalibrated");
    expect(html).toContain("Review only");
    expect(html).toContain("0.512");
    expect(html).toContain("0.35");
    expect(html).toContain("never approves a case");
    expect(section(checks, supervisor, "fr")).toContain("Non calibré");
  });

  it("offers both faces side by side to staff with photo access, never to admins", () => {
    expect(section(checks)).toContain("Show the portrait and the frame (2 views)");
    const adminHtml = section(checks, admin);
    expect(adminHtml).not.toContain("Show the portrait and the frame");
    expect(adminHtml).toContain("Administrators have no routine access");
  });

  it("says what the face worker is doing when a check is missing", () => {
    expect(section({ liveness: null, faceMatch: null, jobs: { liveness: "waiting", face_match: "not_checked" } })).toMatch(
      /Waiting for the face worker.*test sessions only/s,
    );
    expect(section({ liveness: null, faceMatch: null, jobs: { liveness: "none", face_match: "none" } })).toContain("Not evaluated yet");
  });

  it("says when stored details cannot be read", () => {
    const html = section(toFaceChecks([row("face_match", { ...MATCH, calibrated: true })], []));
    expect(html).toContain("cannot be read by this version");
  });
});
