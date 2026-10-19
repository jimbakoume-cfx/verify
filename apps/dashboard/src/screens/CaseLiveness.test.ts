// The "Face check" section (M5), rendered to HTML on the server side (react-dom/server), and the
// parsers behind it. No browser: the text the page shows, its role rules, and that nothing but codes,
// counts and timings comes out of check_result.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { LIVENESS_PROBLEMS, type LivenessCaptureDetails } from "@verify/shared";
import { type DashboardServices, ServicesContext } from "../api/services";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import { formatCode, isLivenessFrame, livenessOverview, toLivenessCheck, toLivenessDetails } from "../lib/liveness";
import { type CaptureRecord, type StaffProfile, toCapture } from "../lib/records";
import { LivenessSection } from "./CaseLiveness";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: "en",
  fallbackLng: "fr",
  interpolation: { escapeValue: false },
});

const SERVICES = {} as DashboardServices;

function render(element: ReactElement, lng: "en" | "fr" = "en"): string {
  void i18n.changeLanguage(lng);
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(ServicesContext.Provider, { value: SERVICES }, element)),
  );
}

const CHALLENGE = "0d9f6a8e-1b7c-4c11-9b0e-6f2b8a2f4f10";
const OLD = "1d9f6a8e-1b7c-4c11-9b0e-6f2b8a2f4f10";

const DETAILS: LivenessCaptureDetails = {
  evaluated: false,
  challengeId: CHALLENGE,
  actions: ["blink", "turn_left", "smile"],
  code: "482913",
  frames: 13,
  framesPerStep: [1, 4, 4, 4],
  durationMs: 9_900,
  serverElapsedMs: 21_000,
  maxGapMs: 1_200,
  startedWithWarning: false,
  problems: [],
};

function checkRow(details: unknown = DETAILS, outcome = "pass") {
  return {
    id: "c",
    capture_id: null,
    check_name: "liveness_capture",
    check_version: "liveness-capture-v1",
    outcome,
    details,
    created_at: "2026-10-19T09:00:00Z",
  };
}

function frameRow(index: number, challenge = CHALLENGE, deleted = false) {
  const step = index === 0 ? 0 : Math.ceil(index / 4);
  return {
    id: `f6666666-6666-4666-8666-${String(index).padStart(10, "0")}${challenge === OLD ? "01" : "00"}`,
    verification_id: "v",
    kind: "liveness_frame",
    byte_size: 30_000,
    width: 360,
    height: 480,
    created_at: "2026-10-19T09:00:00Z",
    sha256: "a".repeat(64),
    deleted_at: deleted ? "2026-10-19T09:01:00Z" : null,
    superseded_by: null,
    liveness_challenge_id: challenge,
    quality: { liveness: { index, step, atMs: 900 + index * 700 }, server: { validated: true } },
  };
}

const frames = (challenge = CHALLENGE, deleted = false): CaptureRecord[] =>
  Array.from({ length: 13 }, (_, i) => toCapture(frameRow(12 - i, challenge, deleted))!);

const SUPERVISOR: StaffProfile = { userId: "u", role: "supervisor", fullName: "S", active: true };
const ADMIN: StaffProfile = { ...SUPERVISOR, role: "admin" };

describe("toLivenessDetails and toLivenessCheck", () => {
  it("reads the stored check", () => {
    const check = toLivenessCheck(checkRow());
    expect(check).toMatchObject({ outcome: "pass", checkVersion: "liveness-capture-v1", captureId: null, details: DETAILS });
  });

  it("keeps problems in the contract's order and refuses unknown codes", () => {
    expect(toLivenessDetails({ ...DETAILS, problems: ["frames_reused", "too_fast"] })?.problems).toEqual(["too_fast", "frames_reused"]);
    expect(toLivenessDetails({ ...DETAILS, problems: ["spoof"] })).toBeNull();
    expect(LIVENESS_PROBLEMS).toContain("too_fast");
  });

  it.each([
    ["evaluated", { ...DETAILS, evaluated: true }],
    ["an unknown action", { ...DETAILS, actions: ["wink"] }],
    ["a missing code", { ...DETAILS, code: undefined }],
    ["a negative duration", { ...DETAILS, durationMs: -1 }],
    ["not an object", "x"],
  ])("cannot read details with %s", (_label, details) => {
    expect(toLivenessDetails(details)).toBeNull();
    expect(toLivenessCheck(checkRow(details))?.details).toBeNull();
  });

  it("ignores another check", () => {
    expect(toLivenessCheck({ ...checkRow(), check_name: "mrz" })).toBeNull();
  });
});

describe("livenessOverview", () => {
  it("keeps the recorded challenge's live frames in order, and counts the replaced ones", () => {
    const captures = [...frames(OLD, true), ...frames()];
    const overview = livenessOverview(captures, toLivenessCheck(checkRow()));
    expect(overview.frames.map((f) => f.liveness?.index)).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(overview.frames.every((f) => f.livenessChallengeId === CHALLENGE)).toBe(true);
    expect(overview.replaced).toBe(13);
    expect(captures.filter(isLivenessFrame)).toHaveLength(26);
  });

  it("shows the newest frames even before the check is read", () => {
    expect(livenessOverview(frames(), null).frames).toHaveLength(13);
  });

  it("formats the code as the rider saw it", () => {
    expect(formatCode("482913")).toBe("482 913");
  });
});

describe("LivenessSection", () => {
  const props = { error: null, loading: false, onReload: () => {} };

  it("shows the challenge in order, its code, the timings and every frame, not evaluated yet", () => {
    const html = render(createElement(LivenessSection, { ...props, captures: frames(), check: toLivenessCheck(checkRow()), profile: SUPERVISOR }));
    expect(html).toContain("Face check");
    expect(html).toContain("Not evaluated yet");
    expect(html).toMatch(/Look straight at the camera.*Blink.*Turn the head left.*Smile/s);
    expect(html).toContain("482 913");
    expect(html).toContain("9.9 s");
    expect(html).toContain("Frames complete, timings plausible.");
    expect(html.match(/View frame/g)).toHaveLength(13);
    expect(html).toContain("View all frames");
    expect(html).toContain("Frame 13");
  });

  it("explains each problem", () => {
    const check = toLivenessCheck(checkRow({ ...DETAILS, problems: ["too_fast", "frames_reused"] }, "flag"));
    const html = render(createElement(LivenessSection, { ...props, captures: frames(), check, profile: SUPERVISOR }));
    expect(html).toContain("Too fast.");
    expect(html).toContain("Frame seen before.");
    expect(html).not.toContain("timings plausible");
  });

  it("gives admins no frame to open, as for the document photos", () => {
    const html = render(createElement(LivenessSection, { ...props, captures: frames(), check: toLivenessCheck(checkRow()), profile: ADMIN }));
    expect(html).not.toContain("View frame");
    expect(html).not.toContain("View all frames");
    expect(html).toContain(en.errors.adminNoImageAccess);
  });

  it("says when there is no face check yet, in French too", () => {
    expect(render(createElement(LivenessSection, { ...props, captures: [], check: null, profile: SUPERVISOR }), "fr")).toContain(
      "Aucune vérification du visage enregistrée",
    );
  });
});
