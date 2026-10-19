import { describe, expect, it } from "vitest";
import { type MrzCheckDetails, type MrzServerDetails, parseMrz } from "@verify/shared";
import {
  formatMrzFormat,
  mrzCheckLines,
  mrzFields,
  mrzOverview,
  phoneComparisonLine,
  phoneLinesRead,
  serverMrzCheckLines,
} from "./mrz";
import type { CaptureRecord, MrzCheckRecord } from "./records";

// ICAO 9303 specimens (Utopia): no real person.
const TD1 = ["I<UTOD231458907<<<<<<<<<<<<<<<", "7408122F1204159UTO<<<<<<<<<<<6", "ERIKSSON<<ANNA<MARIA<<<<<<<<<<"];
const TD3 = ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10"];

function capture(id: string, kind: string, createdAt: string, deleted = false): CaptureRecord {
  return {
    id,
    kind,
    byteSize: 200_000,
    width: 1600,
    height: 1009,
    createdAt,
    sha256: "",
    deleted,
    supersededBy: null,
    livenessChallengeId: null,
    liveness: null,
    quality: {
      source: "auto",
      sharpness: null,
      glareRatio: null,
      meanLuma: null,
      framing: null,
      videoWidth: null,
      videoHeight: null,
      elapsedMs: null,
      reusedElsewhere: null,
    },
  };
}

const ALL_PASS = { documentNumber: true, birthDate: true, expiryDate: true, composite: true };

function details(overrides: Partial<MrzCheckDetails> = {}): MrzCheckDetails {
  return {
    source: "mrz_phone",
    parserVersion: "mrz-v1",
    captureId: "back-1",
    result: "read",
    reason: null,
    expectedFormat: "TD1",
    format: "TD1",
    checks: ALL_PASS,
    documentCodeFits: true,
    datesValid: true,
    attempts: 1,
    corrections: 0,
    engine: "tesseract.js-7.0.0/mrz-1",
    ms: 640,
    ...overrides,
  };
}

function check(id: string, captureId: string | null, d: MrzCheckDetails | null = details(), createdAt = "2026-10-14T08:10:00Z"): MrzCheckRecord {
  return { id, captureId, checkVersion: "mrz-v1", outcome: "pass", details: d, createdAt };
}

const FRONT = capture("front-1", "document_front", "2026-10-14T08:00:00Z");
const BACK = capture("back-1", "document_back", "2026-10-14T08:01:00Z");

describe("mrzOverview", () => {
  it("shows each result on the side of its photo, with nothing missing", () => {
    const overview = mrzOverview("cni_biometric", [FRONT, BACK], [check("c1", BACK.id)]);
    expect(overview.expectation).toEqual({ side: "document_back", format: "TD1", required: true });
    expect(overview.entries).toEqual([
      { type: "check", check: check("c1", BACK.id), kind: "document_back", capturedAt: BACK.createdAt, superseded: false },
    ]);
    expect(overview.hasData).toBe(true);
  });

  it("says not received when the photo carrying the MRZ has no result", () => {
    const overview = mrzOverview("cni_biometric", [FRONT, BACK], []);
    expect(overview.entries).toEqual([
      { type: "missing", side: "document_back", captureId: BACK.id, capturedAt: BACK.createdAt },
    ]);
    expect(overview.hasData).toBe(false);
  });

  it("says not received, without a photo, when that side has not been uploaded yet", () => {
    expect(mrzOverview("passport", [], []).entries).toEqual([
      { type: "missing", side: "document_front", captureId: null, capturedAt: null },
    ]);
  });

  it("puts not received first when only an earlier photo of the side has a result", () => {
    const retaken = capture("back-2", "document_back", "2026-10-14T08:05:00Z");
    const overview = mrzOverview("cni_biometric", [FRONT, BACK, retaken], [check("c1", BACK.id)]);
    expect(overview.entries.map((e) => e.type)).toEqual(["missing", "check"]);
    expect(overview.entries[0]).toMatchObject({ captureId: "back-2" });
    expect(overview.entries[1]).toMatchObject({ superseded: true });
  });

  it("does not count an erased photo as the latest one", () => {
    const erased = capture("back-2", "document_back", "2026-10-14T08:05:00Z", true);
    const overview = mrzOverview("cni_biometric", [FRONT, BACK, erased], [check("c1", BACK.id)]);
    expect(overview.entries).toHaveLength(1);
    expect(overview.entries[0]).toMatchObject({ type: "check", superseded: false });
  });

  it("still shows a result whose photo is not in the list, without counting it for the side", () => {
    const overview = mrzOverview("passport", [], [check("c1", "front-9", details({ expectedFormat: "TD3" }))]);
    expect(overview.entries).toEqual([
      { type: "missing", side: "document_front", captureId: null, capturedAt: null },
      expect.objectContaining({ type: "check", kind: null, capturedAt: null, superseded: false }),
    ]);
  });

  it("expects nothing for a document without an MRZ or not chosen yet, but still shows results", () => {
    expect(mrzOverview("cni_legacy", [FRONT, BACK], [])).toEqual({ expectation: null, entries: [], hasData: false });
    expect(mrzOverview("driving_licence", [FRONT, BACK], [])).toEqual({ expectation: null, entries: [], hasData: false });
    expect(mrzOverview(null, [], [])).toEqual({ expectation: null, entries: [], hasData: false });
    expect(mrzOverview("voter_card", [FRONT, BACK], [check("c1", BACK.id)]).entries).toHaveLength(1);
  });

  it("marks the residence permit's MRZ as optional", () => {
    expect(mrzOverview("residence_permit", [], []).expectation).toEqual({
      side: "document_back",
      format: "TD1",
      required: false,
    });
  });

  it("offers the data only when some lines were read", () => {
    const unreadable = details({ result: "unreadable", reason: "not_found", format: null, checks: null });
    expect(mrzOverview("cni_biometric", [BACK], [check("c1", BACK.id, unreadable)]).hasData).toBe(false);
    expect(mrzOverview("cni_biometric", [BACK], [check("c1", BACK.id, unreadable), check("c0", BACK.id)]).hasData).toBe(
      true,
    );
    // Details this dashboard cannot read may still come with lines: let the server decide.
    expect(mrzOverview("cni_biometric", [BACK], [check("c1", BACK.id, null)]).hasData).toBe(true);
  });
});

describe("mrzCheckLines", () => {
  const ok = (lines: ReturnType<typeof mrzCheckLines>) => Object.fromEntries(lines.map((l) => [l.key, l.ok]));

  it("lists every TD1 check, without a personal number", () => {
    expect(ok(mrzCheckLines(details()))).toEqual({
      "mrz.checks.format": true,
      "mrz.checks.documentNumber": true,
      "mrz.checks.birthDate": true,
      "mrz.checks.expiryDate": true,
      "mrz.checks.composite": true,
      "mrz.checks.documentCode": true,
      "mrz.checks.dates": true,
    });
  });

  it("adds the personal number on a passport, in reading order", () => {
    const lines = mrzCheckLines(
      details({
        expectedFormat: "TD3",
        format: "TD3",
        checks: { ...ALL_PASS, personalNumber: false, composite: false },
      }),
    );
    expect(lines.map((l) => l.key)).toEqual([
      "mrz.checks.format",
      "mrz.checks.documentNumber",
      "mrz.checks.birthDate",
      "mrz.checks.expiryDate",
      "mrz.checks.personalNumber",
      "mrz.checks.composite",
      "mrz.checks.documentCode",
      "mrz.checks.dates",
    ]);
    expect(ok(lines)).toMatchObject({ "mrz.checks.personalNumber": false, "mrz.checks.composite": false });
  });

  it("flags lines of the wrong format and failed document code or dates", () => {
    const lines = ok(
      mrzCheckLines(details({ expectedFormat: "TD3", format: "TD1", documentCodeFits: false, datesValid: false })),
    );
    expect(lines).toMatchObject({
      "mrz.checks.format": false,
      "mrz.checks.documentCode": false,
      "mrz.checks.dates": false,
    });
    expect(lines["mrz.checks.personalNumber"]).toBeUndefined();
  });

  it("shows unknown rather than a verdict when the result does not say", () => {
    const lines = ok(
      mrzCheckLines(details({ expectedFormat: "TD3", format: null, checks: null, documentCodeFits: null, datesValid: null })),
    );
    expect(Object.values(lines).every((v) => v === null)).toBe(true);
  });

  it("has nothing to check when the MRZ was not readable", () => {
    expect(mrzCheckLines(details({ result: "unreadable", reason: "reader_unavailable", checks: null }))).toEqual([]);
  });
});

describe("formatMrzFormat", () => {
  it("names the format and its shape", () => {
    expect(formatMrzFormat("TD1")).toBe("TD1 (3 × 30)");
    expect(formatMrzFormat("TD3")).toBe("TD3 (2 × 44)");
    expect(formatMrzFormat(null)).toBe("—");
  });
});

describe("mrzFields", () => {
  it("lists the passport's fields in the order staff compare them with the photo", () => {
    const parsed = parseMrz(TD3, new Date("2026-10-14T00:00:00Z"))!;
    expect(mrzFields(parsed)).toEqual([
      { key: "surname", value: { type: "text", text: "ERIKSSON" } },
      { key: "givenNames", value: { type: "text", text: "ANNA MARIA" } },
      { key: "documentNumber", value: { type: "text", text: "L898902C3" } },
      { key: "nationality", value: { type: "text", text: "UTO" } },
      { key: "birthDate", value: { type: "date", date: { raw: "740812", iso: "1974-08-12" } } },
      { key: "sex", value: { type: "sex", sex: "F" } },
      { key: "expiryDate", value: { type: "date", date: { raw: "120415", iso: "2012-04-15" } } },
      { key: "issuingState", value: { type: "text", text: "UTO" } },
      { key: "documentCode", value: { type: "text", text: "P" } },
      { key: "optionalData", value: { type: "text", text: "ZE184226B" } },
    ]);
  });

  it("keeps empty fields empty, for the page to show a dash", () => {
    const parsed = parseMrz(TD1, new Date("2026-10-14T00:00:00Z"))!;
    const fields = Object.fromEntries(mrzFields(parsed).map((f) => [f.key, f.value]));
    expect(fields.documentCode).toEqual({ type: "text", text: "I" });
    expect(fields.optionalData).toEqual({ type: "text", text: "" });
  });
});

describe("phoneLinesRead", () => {
  it("is true when some report holds lines, or details this page cannot read", () => {
    const unreadable = details({ result: "unreadable", reason: "not_found", format: null, checks: null });
    expect(phoneLinesRead([])).toBe(false);
    expect(phoneLinesRead([check("c1", BACK.id, unreadable)])).toBe(false);
    expect(phoneLinesRead([check("c1", BACK.id, unreadable), check("c0", BACK.id)])).toBe(true);
    expect(phoneLinesRead([check("c1", BACK.id, null)])).toBe(true);
  });
});

describe("serverMrzCheckLines", () => {
  function server(overrides: Partial<MrzServerDetails> = {}): MrzServerDetails {
    return {
      parserVersion: "mrz-v1",
      found: true,
      format: "TD1",
      checks: ALL_PASS,
      documentCodeFits: true,
      datesValid: true,
      corrections: 0,
      phone: "agrees",
      ...overrides,
    };
  }
  const ok = (lines: ReturnType<typeof serverMrzCheckLines>) => Object.fromEntries(lines.map((l) => [l.key, l.ok]));

  it("says the lines were found, then every check, then the comparison with the phone", () => {
    expect(serverMrzCheckLines(server(), "TD1").map((l) => l.key)).toEqual([
      "serverChecks.mrz.found",
      "mrz.checks.format",
      "mrz.checks.documentNumber",
      "mrz.checks.birthDate",
      "mrz.checks.expiryDate",
      "mrz.checks.composite",
      "mrz.checks.documentCode",
      "mrz.checks.dates",
      "serverChecks.mrz.phone.agrees",
    ]);
    expect(Object.values(ok(serverMrzCheckLines(server(), "TD1"))).every((v) => v === true)).toBe(true);
  });

  it("adds the personal number on a passport and shows each failed check", () => {
    const lines = ok(
      serverMrzCheckLines(
        server({ format: "TD3", checks: { ...ALL_PASS, personalNumber: false, composite: false }, datesValid: false }),
        "TD3",
      ),
    );
    expect(lines).toMatchObject({
      "mrz.checks.personalNumber": false,
      "mrz.checks.composite": false,
      "mrz.checks.dates": false,
      "mrz.checks.documentNumber": true,
    });
  });

  it("shows lines of the other format as found but not as expected", () => {
    const lines = ok(serverMrzCheckLines(server({ found: false, format: "TD1", phone: "differs" }), "TD3"));
    expect(lines).toMatchObject({ "serverChecks.mrz.found": false, "mrz.checks.format": false });
    // Without the expected format (no declared document), "found" decides.
    expect(ok(serverMrzCheckLines(server({ found: false }), null))["mrz.checks.format"]).toBe(false);
  });

  it("has only found and the comparison when nothing was read", () => {
    const nothing = server({ found: false, format: null, checks: null, documentCodeFits: null, datesValid: null, phone: "unreadable" });
    expect(serverMrzCheckLines(nothing, "TD1")).toEqual([
      { key: "serverChecks.mrz.found", ok: false },
      { key: "serverChecks.mrz.phone.unreadable", ok: null },
    ]);
  });
});

describe("phoneComparisonLine", () => {
  it("ticks the same lines and crosses other lines", () => {
    expect(phoneComparisonLine({ found: true, phone: "agrees" })).toEqual({ key: "serverChecks.mrz.phone.agrees", ok: true });
    expect(phoneComparisonLine({ found: true, phone: "differs" })).toEqual({ key: "serverChecks.mrz.phone.differs", ok: false });
  });

  it("has no verdict when there is nothing to compare", () => {
    expect(phoneComparisonLine({ found: true, phone: "missing" })).toEqual({ key: "serverChecks.mrz.phone.missing", ok: null });
    expect(phoneComparisonLine({ found: true, phone: "unreadable" })).toEqual({
      key: "serverChecks.mrz.phone.unreadable",
      ok: null,
    });
    // The database says "differs" when only the phone read lines: the server's own line already says it found none.
    expect(phoneComparisonLine({ found: false, phone: "differs" })).toEqual({ key: "serverChecks.mrz.phone.phoneOnly", ok: null });
  });
});
