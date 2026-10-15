import { describe, expect, it } from "vitest";
import type { MrzServerDetails, OcrFieldsDetails, QualityServerDetails } from "@verify/shared";
import type { CaptureRecord, CheckRecord, ServerChecks, ServerJobState } from "./records";
import { declaredMatch, mayHaveDocumentData, serverOverview, VERDICT_TONE } from "./serverChecks";

function capture(id: string, kind: string, createdAt: string, deleted = false): CaptureRecord {
  return { id, kind, createdAt, deleted, supersededBy: null } as CaptureRecord;
}

function check<D>(captureId: string | null, details: D, outcome: CheckRecord<D>["outcome"] = "pass"): CheckRecord<D> {
  return { id: `${captureId}`, captureId, checkVersion: "server-checks-v1", outcome, details, createdAt: "2026-10-14T09:00:00Z" };
}

const QUALITY: QualityServerDetails = {
  verdict: "ok",
  quality: {
    sharpness: 30,
    glareRatio: 0.01,
    meanLuma: 140,
    documentFound: true,
    documentConfidence: 0.9,
    longSide: 1600,
    textLines: 12,
  },
  provisional: true,
  engine: "worker-1",
  timing: { ms: 2000, cold: false },
};
const MRZ: MrzServerDetails = {
  parserVersion: "mrz-v1",
  found: true,
  format: "TD1",
  checks: { documentNumber: true, birthDate: true, expiryDate: true, composite: true },
  documentCodeFits: true,
  datesValid: true,
  corrections: 0,
  phone: "agrees",
};
const FIELDS: OcrFieldsDetails = { found: ["surname"], provisional: true };
const NONE: ServerChecks = { quality: [], mrz: [], fields: [], classification: null, policy: null, jobs: new Map() };
const withJobs = (checks: ServerChecks, ...entries: [string, ServerJobState][]): ServerChecks => ({ ...checks, jobs: new Map(entries) });

const FRONT = capture("front-1", "document_front", "2026-10-14T08:00:00Z");
const BACK = capture("back-2", "document_back", "2026-10-14T08:05:00Z");
const OLD_BACK = capture("back-1", "document_back", "2026-10-14T08:01:00Z", true);

describe("serverOverview", () => {
  it("shows each side's newest live photo with its own results, never an older photo's", () => {
    const checks: ServerChecks = {
      ...NONE,
      quality: [check(BACK.id, QUALITY), check(OLD_BACK.id, { ...QUALITY, verdict: "unreadable" }), check(FRONT.id, QUALITY)],
      mrz: [check(BACK.id, MRZ), check(OLD_BACK.id, { ...MRZ, found: false })],
      fields: [check(FRONT.id, FIELDS)],
    };
    const { sides, started } = serverOverview("cni_biometric", [FRONT, BACK, OLD_BACK], checks);
    expect(started).toBe(true);
    expect(sides.map((s) => [s.side, s.capture?.id, s.state])).toEqual([
      ["document_front", "front-1", "checked"],
      ["document_back", "back-2", "checked"],
    ]);
    expect(sides[1].quality?.details?.verdict).toBe("ok");
    expect(sides[1].mrz?.details?.found).toBe(true);
    expect(sides[1].fields).toBeNull();
    expect(sides[0].mrz).toBeNull();
  });

  it("names the format on the side that carries the declared document's code lines", () => {
    const sides = serverOverview("passport", [FRONT], NONE).sides;
    expect(sides.map((s) => [s.side, s.mrzFormat])).toEqual([["document_front", "TD3"]]);
    expect(serverOverview("cni_biometric", [], NONE).sides.map((s) => s.mrzFormat)).toEqual([null, "TD1"]);
    expect(serverOverview("driving_licence", [], NONE).sides.map((s) => s.mrzFormat)).toEqual([null, null]);
  });

  it("lists the required sides even without a photo, and other photographed sides too", () => {
    expect(serverOverview("cni_legacy", [], NONE).sides.map((s) => [s.side, s.state])).toEqual([
      ["document_front", "no_photo"],
      ["document_back", "no_photo"],
    ]);
    expect(serverOverview("passport", [BACK], NONE).sides.map((s) => s.side)).toEqual(["document_front", "document_back"]);
    expect(serverOverview(null, [BACK], NONE).sides.map((s) => s.side)).toEqual(["document_back"]);
    expect(serverOverview(null, [], NONE).sides).toEqual([]);
  });

  it("waits for the server, or says it could not check, when a photo has no result", () => {
    expect(serverOverview("passport", [FRONT], withJobs(NONE, [FRONT.id, "waiting"]))).toMatchObject({
      sides: [{ state: "pending" }],
      started: false,
      reasons: [],
      unknownFlag: false,
    });
    const gaveUp = withJobs(
      { ...NONE, policy: check(null, { reasons: ["server_unchecked" as const] }, "flag") },
      [FRONT.id, "failed"],
    );
    expect(serverOverview("passport", [FRONT], gaveUp)).toMatchObject({
      sides: [{ state: "unchecked" }],
      started: true,
      reasons: ["server_unchecked"],
    });
    // A photo with results stays checked, whatever happened to another one.
    const mixed = withJobs({ ...gaveUp, quality: [check(FRONT.id, QUALITY)] }, [FRONT.id, "done"], [BACK.id, "failed"]);
    expect(serverOverview("cni_legacy", [FRONT, BACK], mixed).sides.map((s) => s.state)).toEqual(["checked", "unchecked"]);
  });

  it("decides each side from its own photo's job, never from the case-wide reason", () => {
    // The back was given up on (budget); the front is still being read: it is not "not checked".
    const backGaveUp = withJobs(
      { ...NONE, policy: check(null, { reasons: ["server_unchecked" as const] }, "flag") },
      [FRONT.id, "waiting"],
      [BACK.id, "failed"],
    );
    expect(serverOverview("cni_legacy", [FRONT, BACK], backGaveUp).sides.map((s) => s.state)).toEqual([
      "pending",
      "unchecked",
    ]);
  });

  it("says a photo taken before the server checks existed was never sent, instead of waiting forever", () => {
    // M1/M2 photos have no job, and no case-level reason either.
    expect(serverOverview("cni_legacy", [FRONT, BACK], NONE).sides.map((s) => s.state)).toEqual(["not_sent", "not_sent"]);
    // Only the photo without a job: a newer photo of the other side has one.
    expect(
      serverOverview("cni_legacy", [FRONT, BACK], withJobs(NONE, [BACK.id, "waiting"])).sides.map((s) => s.state),
    ).toEqual(["not_sent", "pending"]);
  });

  it("counts details it cannot read as a result", () => {
    const checks = { ...NONE, fields: [check<OcrFieldsDetails>(FRONT.id, null as unknown as OcrFieldsDetails)] };
    expect(serverOverview("passport", [FRONT], checks).sides[0].state).toBe("checked");
  });

  it("notices a flag for reasons this dashboard does not know", () => {
    const flagged = { ...NONE, policy: check(null, { reasons: [] }, "flag") };
    expect(serverOverview("passport", [], flagged).unknownFlag).toBe(true);
    const passed = { ...NONE, policy: check(null, { reasons: [] }, "pass") };
    expect(serverOverview("passport", [], passed).unknownFlag).toBe(false);
    const unreadable = { ...NONE, policy: check(null, null as unknown as { reasons: [] }, "flag") };
    expect(serverOverview("passport", [], unreadable)).toMatchObject({ unknownFlag: false, reasons: [] });
  });
});

describe("declaredMatch", () => {
  it("is unknown when nothing was recognised", () => {
    expect(declaredMatch({ matchesDeclared: true })).toBe("yes");
    expect(declaredMatch({ matchesDeclared: false })).toBe("no");
    expect(declaredMatch({ matchesDeclared: null })).toBe("unknown");
  });
});

describe("VERDICT_TONE", () => {
  it("shows the retake reasons as the worst and a poor photo as flagged", () => {
    expect(VERDICT_TONE).toEqual({ ok: "ok", poor: "warn", no_document: "bad", unreadable: "bad" });
  });
});

describe("mayHaveDocumentData", () => {
  it("offers the data when the phone read lines or the server processed a photo", () => {
    expect(mayHaveDocumentData(true, undefined)).toBe(true);
    expect(mayHaveDocumentData(false, undefined)).toBe(false);
    expect(mayHaveDocumentData(false, NONE)).toBe(false);
    // Only a sub-type may have been read: check_result does not say, so the server is asked.
    expect(mayHaveDocumentData(false, { ...NONE, fields: [check(FRONT.id, { found: [], provisional: true })] })).toBe(true);
    expect(mayHaveDocumentData(false, { ...NONE, quality: [check(FRONT.id, QUALITY)] })).toBe(true);
    // A case-level reason alone (server_unchecked) means nothing was read.
    expect(mayHaveDocumentData(false, { ...NONE, policy: check(null, { reasons: ["server_unchecked" as const] }) })).toBe(
      false,
    );
  });
});
