import { describe, expect, it } from "vitest";
import {
  type CaptureRecord,
  countCaptures,
  MRZ_CHECK_COLUMNS,
  sessionOpen,
  sortCaptures,
  toCapture,
  toCaptureQuality,
  toMrzCheck,
  toMrzCheckDetails,
  toStaffProfile,
  toVerification,
  type VerificationSummary,
} from "./records";

const VID = "7d0c1a52-3f0e-4c8e-9a51-2b6f4f1d9e10";

describe("toStaffProfile", () => {
  it("reads a valid row and rejects unknown roles", () => {
    expect(toStaffProfile({ user_id: "u1", role: "supervisor", full_name: "Jean", active: true })).toEqual({
      userId: "u1",
      role: "supervisor",
      fullName: "Jean",
      active: true,
    });
    expect(toStaffProfile({ user_id: "u1", role: "owner", full_name: "x", active: true })).toBeNull();
    expect(toStaffProfile(null)).toBeNull();
  });

  it("treats anything but active = true as inactive", () => {
    expect(toStaffProfile({ user_id: "u1", role: "reviewer", full_name: "A" })?.active).toBe(false);
  });
});

describe("toVerification", () => {
  const row = {
    id: VID,
    status: "submitted",
    declared_document: "passport",
    is_test: true,
    created_at: "2026-10-13T08:00:00+00:00",
    submitted_at: "2026-10-13T08:05:00+00:00",
    session_expires_at: "2026-10-13T08:30:00+00:00",
  };

  it("maps the columns", () => {
    expect(toVerification(row)).toEqual({
      id: VID,
      status: "submitted",
      declaredDocument: "passport",
      isTest: true,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      sessionExpiresAt: row.session_expires_at,
    });
  });

  it("tolerates missing M1 columns and rejects unknown statuses", () => {
    const { declared_document: _d, is_test: _t, ...m0Row } = row;
    expect(toVerification(m0Row)).toMatchObject({ declaredDocument: null, isTest: false });
    expect(toVerification({ ...row, declared_document: "library_card" })?.declaredDocument).toBeNull();
    expect(toVerification({ ...row, status: "lost" })).toBeNull();
    expect(toVerification({ ...row, id: 5 })).toBeNull();
  });
});

describe("toCaptureQuality", () => {
  it("reads client metrics and the server's reuse flag", () => {
    expect(
      toCaptureQuality({
        source: "auto",
        sharpness: 120.5,
        glareRatio: 0.01,
        meanLuma: 140,
        framing: 0.9,
        videoWidth: 1920,
        videoHeight: 1080,
        elapsedMs: 4000,
        server: { validated: true, reusedElsewhere: true },
      }),
    ).toEqual({
      source: "auto",
      sharpness: 120.5,
      glareRatio: 0.01,
      meanLuma: 140,
      framing: 0.9,
      videoWidth: 1920,
      videoHeight: 1080,
      elapsedMs: 4000,
      reusedElsewhere: true,
    });
  });

  it("turns anything unexpected into null", () => {
    expect(toCaptureQuality({ source: "robot", sharpness: "high", glareRatio: Number.NaN, server: "yes" })).toEqual({
      source: null,
      sharpness: null,
      glareRatio: null,
      meanLuma: null,
      framing: null,
      videoWidth: null,
      videoHeight: null,
      elapsedMs: null,
      reusedElsewhere: null,
    });
    expect(toCaptureQuality(null).source).toBeNull();
    expect(toCaptureQuality([1, 2]).sharpness).toBeNull();
  });
});

describe("toCapture", () => {
  const row = {
    id: "c1",
    verification_id: VID,
    kind: "document_front",
    byte_size: 240_000,
    width: 1600,
    height: 1009,
    quality: { source: "manual" },
    created_at: "2026-10-13T08:03:00+00:00",
    sha256: "ab".repeat(32),
    deleted_at: null,
  };

  it("maps the metadata", () => {
    expect(toCapture(row)).toMatchObject({
      id: "c1",
      kind: "document_front",
      byteSize: 240_000,
      width: 1600,
      height: 1009,
      deleted: false,
      quality: { source: "manual" },
    });
  });

  it("flags erased captures and rejects incomplete rows", () => {
    expect(toCapture({ ...row, deleted_at: "2026-11-01T00:00:00Z" })?.deleted).toBe(true);
    expect(toCapture({ ...row, byte_size: null })).toBeNull();
    expect(toCapture({ ...row, id: undefined })).toBeNull();
  });
});

describe("countCaptures", () => {
  it("counts live captures per verification", () => {
    const counts = countCaptures([
      { verification_id: "a", deleted_at: null },
      { verification_id: "a", deleted_at: null },
      { verification_id: "a", deleted_at: "2026-11-01T00:00:00Z" },
      { verification_id: "b", deleted_at: null },
      { nonsense: true },
      null,
    ]);
    expect(Object.fromEntries(counts)).toEqual({ a: 2, b: 1 });
  });
});

describe("sortCaptures", () => {
  const capture = (id: string, kind: string, createdAt: string) => ({ id, kind, createdAt }) as CaptureRecord;

  it("puts front before back, newest first within a kind", () => {
    const sorted = sortCaptures([
      capture("back", "document_back", "2026-10-13T08:04:00Z"),
      capture("front-old", "document_front", "2026-10-13T08:01:00Z"),
      capture("other", "mystery", "2026-10-13T08:09:00Z"),
      capture("front-new", "document_front", "2026-10-13T08:02:00Z"),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["front-new", "front-old", "back", "other"]);
  });
});

describe("sessionOpen", () => {
  const base: VerificationSummary = {
    id: VID,
    status: "created",
    declaredDocument: null,
    isTest: true,
    createdAt: "2026-10-13T08:00:00Z",
    submittedAt: null,
    sessionExpiresAt: "2026-10-13T08:30:00Z",
  };
  const at = (iso: string) => Date.parse(iso);

  it("is open before expiry while created or in progress", () => {
    expect(sessionOpen(base, at("2026-10-13T08:29:59Z"))).toBe(true);
    expect(sessionOpen({ ...base, status: "in_progress" }, at("2026-10-13T08:10:00Z"))).toBe(true);
  });

  it("is closed after expiry, after submission, or without an expiry", () => {
    expect(sessionOpen(base, at("2026-10-13T08:30:00Z"))).toBe(false);
    expect(sessionOpen({ ...base, status: "submitted" }, at("2026-10-13T08:10:00Z"))).toBe(false);
    expect(sessionOpen({ ...base, sessionExpiresAt: null }, at("2026-10-13T08:10:00Z"))).toBe(false);
  });
});

describe("toMrzCheck", () => {
  // As written by the flow function (assessMrzReport): outcomes and counts, no data from the document.
  const details = {
    source: "mrz_phone",
    parserVersion: "mrz-v1",
    captureId: "c2",
    result: "read",
    reason: null,
    expectedFormat: "TD3",
    format: "TD3",
    checks: { documentNumber: true, birthDate: true, expiryDate: false, personalNumber: true, composite: false },
    documentCodeFits: true,
    datesValid: true,
    attempts: 2,
    corrections: 3,
    engine: "tesseract.js-7.0.0/mrz-1",
    ms: 812,
  };
  const row = {
    id: "r1",
    capture_id: "c2",
    check_name: "mrz",
    check_version: "mrz-v1",
    outcome: "flag",
    details,
    created_at: "2026-10-14T08:10:00+00:00",
  };

  it("asks for the columns it reads", () => {
    expect(MRZ_CHECK_COLUMNS.split(", ").sort()).toEqual(
      ["capture_id", "check_name", "check_version", "created_at", "details", "id", "outcome"].sort(),
    );
  });

  it("maps a result and its details", () => {
    expect(toMrzCheck(row)).toEqual({
      id: "r1",
      captureId: "c2",
      checkVersion: "mrz-v1",
      outcome: "flag",
      details,
      createdAt: row.created_at,
    });
  });

  it("reads an unreadable MRZ, which carries no checks", () => {
    const unreadable = {
      ...details,
      result: "unreadable",
      reason: "reader_unavailable",
      format: null,
      checks: null,
      documentCodeFits: null,
      datesValid: null,
      corrections: null,
      ms: null,
    };
    expect(toMrzCheck({ ...row, details: unreadable })?.details).toEqual(unreadable);
  });

  it("takes the photo from the details when the column is empty", () => {
    expect(toMrzCheck({ ...row, capture_id: null })?.captureId).toBe("c2");
  });

  it("rejects rows of another check or with an unknown outcome", () => {
    expect(toMrzCheck({ ...row, check_name: "ocr" })).toBeNull();
    expect(toMrzCheck({ ...row, outcome: "maybe" })).toBeNull();
    expect(toMrzCheck({ ...row, id: 3 })).toBeNull();
    expect(toMrzCheck(null)).toBeNull();
  });

  it("keeps the outcome but drops details of an unknown shape", () => {
    const check = toMrzCheck({ ...row, details: { source: "mrz_server", result: "read" } });
    expect(check).toMatchObject({ outcome: "flag", details: null });
  });
});

describe("toMrzCheckDetails", () => {
  const base = {
    source: "mrz_phone",
    parserVersion: "mrz-v1",
    captureId: "c2",
    result: "read",
    expectedFormat: "TD1",
    attempts: 1,
    engine: "e",
  };

  it("turns optional fields of the wrong type into null", () => {
    expect(
      toMrzCheckDetails({
        ...base,
        reason: "tired",
        format: "TD2",
        checks: { documentNumber: true, birthDate: "yes", expiryDate: true, composite: true },
        documentCodeFits: "true",
        datesValid: 1,
        corrections: "3",
        ms: Number.NaN,
      }),
    ).toEqual({
      ...base,
      reason: null,
      format: null,
      checks: null,
      documentCodeFits: null,
      datesValid: null,
      corrections: null,
      ms: null,
    });
  });

  it("leaves out a personal number check that is not there (TD1)", () => {
    const checks = toMrzCheckDetails({
      ...base,
      checks: { documentNumber: true, birthDate: true, expiryDate: true, composite: true },
    })?.checks;
    expect(checks).toEqual({ documentNumber: true, birthDate: true, expiryDate: true, composite: true });
    expect(checks && "personalNumber" in checks).toBe(false);
  });

  it("needs the fields every result carries", () => {
    for (const key of Object.keys(base)) {
      const { [key]: _removed, ...rest } = base as Record<string, unknown>;
      expect(toMrzCheckDetails(rest), key).toBeNull();
    }
    expect(toMrzCheckDetails({ ...base, expectedFormat: "TD2" })).toBeNull();
    expect(toMrzCheckDetails({ ...base, result: "partly" })).toBeNull();
    expect(toMrzCheckDetails([base])).toBeNull();
  });
});
