import { describe, expect, it } from "vitest";
import { CLASSIFICATION_DETAIL_KEYS } from "@verify/shared";
import {
  CAPTURE_COLUMNS,
  type CaptureRecord,
  CHECK_COLUMNS,
  countCaptures,
  JOB_COLUMNS,
  newestLiveCaptures,
  PRINTED_FIELDS,
  SERVER_CHECK_NAME_LIST,
  sessionOpen,
  sortCaptures,
  toCapture,
  toCaptureQuality,
  toClassificationDetails,
  toConsistencyDetails,
  toDocumentPolicyDetails,
  toMrzCheck,
  toMrzCheckDetails,
  toMrzServerDetails,
  toOcrFieldsDetails,
  toQualityServerDetails,
  toServerChecks,
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
    expect(CHECK_COLUMNS.split(", ").sort()).toEqual(
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

describe("captures replaced by a newer photo (M3)", () => {
  it("asks for the column and maps it", () => {
    expect(CAPTURE_COLUMNS.split(", ")).toContain("superseded_by");
    const row = { id: "c1", kind: "document_back", byte_size: 1, created_at: "2026-10-14T08:00:00Z", deleted_at: "2026-10-14T08:05:00Z" };
    expect(toCapture({ ...row, superseded_by: "c2" })?.supersededBy).toBe("c2");
    expect(toCapture(row)?.supersededBy).toBeNull();
  });
});

describe("newestLiveCaptures", () => {
  const capture = (id: string, kind: string, createdAt: string, deleted = false) =>
    ({ id, kind, createdAt, deleted }) as CaptureRecord;

  it("keeps the newest photo of each kind still holding an image", () => {
    const newest = newestLiveCaptures([
      capture("back-1", "document_back", "2026-10-14T08:01:00Z"),
      capture("back-3", "document_back", "2026-10-14T08:09:00Z", true),
      capture("back-2", "document_back", "2026-10-14T08:05:00Z"),
      capture("front-1", "document_front", "2026-10-14T08:00:00Z"),
    ]);
    expect(Object.fromEntries([...newest].map(([kind, c]) => [kind, c.id]))).toEqual({
      document_back: "back-2",
      document_front: "front-1",
    });
  });

  it("breaks a tie on the time by the id, as the database does", () => {
    const at = "2026-10-14T08:01:00Z";
    const ids = (list: CaptureRecord[]) => newestLiveCaptures(list).get("document_back")?.id;
    expect(ids([capture("b", "document_back", at), capture("a", "document_back", at)])).toBe("b");
    expect(ids([capture("a", "document_back", at), capture("b", "document_back", at)])).toBe("b");
  });

  it("has nothing for a kind whose photos are all erased", () => {
    expect(newestLiveCaptures([capture("x", "document_front", "2026-10-14T08:00:00Z", true)]).size).toBe(0);
  });
});

// As written by the worker Edge Function (supabase/functions/worker/decide.ts) and the database
// (worker_refresh_policy): outcomes, generic codes and metrics only.
const QUALITY = {
  verdict: "poor",
  quality: {
    sharpness: 4.2,
    glareRatio: 0.031,
    meanLuma: 140.5,
    documentFound: true,
    documentConfidence: 0.88,
    longSide: 1600,
    textLines: 14,
  },
  provisional: true,
  engine: "worker-1/rapidocr-3.10.0/ppocrv6",
  timing: { ms: 2310, cold: true },
};
const MRZ_SERVER = {
  parserVersion: "mrz-v1",
  found: true,
  format: "TD3",
  checks: { documentNumber: true, birthDate: true, expiryDate: true, personalNumber: true, composite: false },
  documentCodeFits: true,
  datesValid: true,
  corrections: 2,
  phone: "differs",
};
const FIELDS = { found: ["surname", "givenNames", "issueDate"], provisional: true };
const CLASSIFICATION = {
  detected: "passport",
  basis: "mrz",
  provisional: false,
  matchesDeclared: true,
  confidence: 1,
  qrPresent: false,
};
const POLICY = { reasons: ["mrz_disagreement", "manual_review_document"] };

function checkRow(name: string, captureId: string | null, details: unknown, createdAt = "2026-10-14T09:00:00+00:00") {
  return {
    id: `${name}-${captureId ?? "case"}-${createdAt}`,
    capture_id: captureId,
    check_name: name,
    check_version: "server-checks-v1",
    outcome: "flag",
    details,
    created_at: createdAt,
  };
}

describe("toServerChecks", () => {
  it("queries every server check by name", () => {
    expect([...SERVER_CHECK_NAME_LIST].sort()).toEqual(
      ["classification", "consistency", "document_policy", "mrz_server", "ocr_fields", "quality_server"].sort(),
    );
  });

  it("sorts each row into its check, per photo or per case, with its details", () => {
    const checks = toServerChecks([
      checkRow("quality_server", "front", QUALITY),
      checkRow("mrz_server", "front", MRZ_SERVER),
      checkRow("ocr_fields", "front", FIELDS),
      checkRow("classification", null, CLASSIFICATION),
      checkRow("document_policy", null, POLICY),
    ]);
    expect(checks.quality).toEqual([
      {
        id: "quality_server-front-2026-10-14T09:00:00+00:00",
        captureId: "front",
        checkVersion: "server-checks-v1",
        outcome: "flag",
        details: QUALITY,
        createdAt: "2026-10-14T09:00:00+00:00",
      },
    ]);
    expect(checks.mrz[0].details).toEqual(MRZ_SERVER);
    expect(checks.fields[0].details).toEqual(FIELDS);
    expect(checks.classification?.details).toEqual(CLASSIFICATION);
    expect(checks.policy?.details).toEqual({ reasons: ["manual_review_document", "mrz_disagreement"] });
  });

  it("puts the latest first and keeps the newest check of the case", () => {
    const checks = toServerChecks([
      checkRow("quality_server", "a", QUALITY, "2026-10-14T09:00:00Z"),
      checkRow("quality_server", "b", QUALITY, "2026-10-14T09:05:00Z"),
      checkRow("document_policy", null, { reasons: [] }, "2026-10-14T09:06:00Z"),
      checkRow("document_policy", null, POLICY, "2026-10-14T09:01:00Z"),
    ]);
    expect(checks.quality.map((c) => c.captureId)).toEqual(["b", "a"]);
    expect(checks.policy?.details).toEqual({ reasons: [] });
  });

  it("leaves out rows in the wrong place, of other checks, or incomplete", () => {
    const checks = toServerChecks([
      checkRow("quality_server", null, QUALITY),
      checkRow("classification", "front", CLASSIFICATION),
      checkRow("mrz", "front", { source: "mrz_phone" }),
      checkRow("face_match", "front", {}),
      { ...checkRow("ocr_fields", "front", FIELDS), outcome: "maybe" },
      { ...checkRow("ocr_fields", "front", FIELDS), id: null },
      null,
    ]);
    expect(checks).toEqual({ quality: [], mrz: [], fields: [], classification: null, policy: null, consistency: null, jobs: new Map() });
  });

  it("reads each photo's job state, and nothing else of the job", () => {
    const checks = toServerChecks([], [
      { capture_id: "a", status: "pending" },
      { capture_id: "b", status: "claimed" },
      { capture_id: "c", status: "done", evidence: { mrz: "ERIKSSON" } },
      { capture_id: "d", status: "failed", error_code: "budget" },
      { capture_id: "e", status: "superseded" },
      { capture_id: "f", status: "lost" },
      { capture_id: null, status: "done" },
      null,
    ]);
    expect(checks.jobs).toEqual(
      new Map([
        ["a", "waiting"],
        ["b", "waiting"],
        ["c", "done"],
        ["d", "failed"],
      ]),
    );
    expect(JOB_COLUMNS).toBe("capture_id, status");
  });

  it("keeps the outcome when the details have a shape this dashboard does not know", () => {
    const checks = toServerChecks([checkRow("quality_server", "front", { verdict: "great" })]);
    expect(checks.quality[0]).toMatchObject({ outcome: "flag", details: null });
  });
});

describe("server check details", () => {
  it("copy only the known fields, so nothing else stored there can reach the page", () => {
    const extra = { surname: "ERIKSSON", documentNumber: "L898902C3" };
    const parsed = [
      toQualityServerDetails({ ...QUALITY, ...extra, quality: { ...QUALITY.quality, ...extra } }),
      toMrzServerDetails({ ...MRZ_SERVER, ...extra, checks: { ...MRZ_SERVER.checks, ...extra } }),
      toOcrFieldsDetails({ ...FIELDS, ...extra }),
      toClassificationDetails({ ...CLASSIFICATION, ...extra, keywordHits: { passport: 2, ERIKSSON: 1 } }),
      toDocumentPolicyDetails({ ...POLICY, ...extra, reasons: [...POLICY.reasons, "ERIKSSON"] }),
    ];
    expect(JSON.stringify(parsed)).not.toMatch(/ERIKSSON|L898902C3/);
    expect(parsed.every((p) => p !== null)).toBe(true);
  });

  it("need the fields every photo check carries", () => {
    expect(toQualityServerDetails(QUALITY)).toEqual(QUALITY);
    expect(toQualityServerDetails({ ...QUALITY, verdict: "great" })).toBeNull();
    expect(toQualityServerDetails({ ...QUALITY, provisional: false })).toBeNull();
    expect(toQualityServerDetails({ ...QUALITY, engine: 3 })).toBeNull();
    expect(toQualityServerDetails({ ...QUALITY, timing: { ms: 10 } })).toBeNull();
    expect(toQualityServerDetails({ ...QUALITY, quality: { ...QUALITY.quality, textLines: "14" } })).toBeNull();
    for (const verdict of ["ok", "no_document", "unreadable"]) {
      expect(toQualityServerDetails({ ...QUALITY, verdict })?.verdict).toBe(verdict);
    }
  });

  it("read the server's code lines, optional fields falling back to null", () => {
    expect(toMrzServerDetails(MRZ_SERVER)).toEqual(MRZ_SERVER);
    expect(
      toMrzServerDetails({ ...MRZ_SERVER, found: false, format: "TD2", checks: { documentNumber: true }, datesValid: "yes" }),
    ).toEqual({ ...MRZ_SERVER, found: false, format: null, checks: null, datesValid: null });
    for (const phone of ["agrees", "missing", "unreadable"]) expect(toMrzServerDetails({ ...MRZ_SERVER, phone })?.phone).toBe(phone);
    expect(toMrzServerDetails({ ...MRZ_SERVER, phone: "maybe" })).toBeNull();
    expect(toMrzServerDetails({ ...MRZ_SERVER, found: undefined })).toBeNull();
    expect(toMrzServerDetails({ ...MRZ_SERVER, corrections: null })).toBeNull();
  });

  it("list the printed fields found by name, in page order, never the card sub-type", () => {
    expect(toOcrFieldsDetails({ found: ["issueDate", "subtype", "surname", "address"], provisional: true })).toEqual({
      found: ["surname", "issueDate"],
      provisional: true,
    });
    expect(toOcrFieldsDetails({ found: "surname", provisional: true })).toBeNull();
    expect(toOcrFieldsDetails({ found: [] })).toBeNull();
  });

  it("read the classification, never keyword counts (they would tell a Cameroonian passport from a foreign one)", () => {
    expect(toClassificationDetails(CLASSIFICATION)).toEqual(CLASSIFICATION);
    expect(
      toClassificationDetails({
        ...CLASSIFICATION,
        matchesDeclared: "yes",
        qrPresent: null,
        keywordHits: { passport: 2, republic: 2, field_labels: 11 },
      }),
    ).toEqual({ ...CLASSIFICATION, matchesDeclared: null, qrPresent: null });
    expect(Object.keys(toClassificationDetails({ ...CLASSIFICATION, keywordHits: { republic: 2 } })!).sort())
      .toEqual([...CLASSIFICATION_DETAIL_KEYS].sort());
    expect(toClassificationDetails({ ...CLASSIFICATION, detected: "library_card" })).toBeNull();
    expect(toClassificationDetails({ ...CLASSIFICATION, basis: "guess" })).toBeNull();
    expect(toClassificationDetails({ ...CLASSIFICATION, confidence: "high" })).toBeNull();
  });

  it("keep the known reasons once each, in the contract's order", () => {
    expect(
      toDocumentPolicyDetails({ reasons: ["server_unchecked", "type_mismatch", "server_unchecked", "new_reason"] }),
    ).toEqual({ reasons: ["type_mismatch", "server_unchecked"] });
    expect(toDocumentPolicyDetails({ reasons: "type_mismatch" })).toBeNull();
    expect(toDocumentPolicyDetails(null)).toBeNull();
  });
});

describe("the consistency check (M4)", () => {
  const DETAILS = { flags: ["document_expired", "mrz_print_mismatch"], provisional: ["number_format"], basis: "mrz", mismatches: ["name"] };

  it("is read per case only, its codes kept in the contract's order", () => {
    const checks = toServerChecks([
      checkRow("consistency", null, { ...DETAILS, flags: ["mrz_print_mismatch", "document_expired"] }),
      checkRow("consistency", "front", DETAILS),
    ]);
    expect(checks.consistency?.details).toEqual(DETAILS);
    expect(checks.consistency?.captureId).toBeNull();
  });

  it("never lets a value through, nor an unknown code", () => {
    const read = toConsistencyDetails({
      ...DETAILS,
      surname: "ERIKSSON",
      flags: [...DETAILS.flags, "ERIKSSON", "looks_fake"],
      mismatches: ["name", "D23145890"],
      provisional: ["1974-08-12"],
    });
    expect(read).toEqual({ flags: ["document_expired", "mrz_print_mismatch"], provisional: [], basis: "mrz", mismatches: ["name"] });
    expect(JSON.stringify(read)).not.toMatch(/ERIKSSON|D23145890|1974/);
  });

  it("is unreadable when a list or the basis is missing or wrong", () => {
    expect(toConsistencyDetails({ ...DETAILS, basis: "guess" })).toBeNull();
    expect(toConsistencyDetails({ ...DETAILS, flags: "document_expired" })).toBeNull();
    expect(toConsistencyDetails({ flags: [], provisional: [], basis: "mrz" })).toBeNull();
    expect(toConsistencyDetails(null)).toBeNull();
  });
});

describe("PRINTED_FIELDS", () => {
  it("names every printed field the worker reads, in the order staff compare them", () => {
    expect(PRINTED_FIELDS).toEqual(["surname", "givenNames", "documentNumber", "birthDate", "expiryDate", "issueDate", "subtype"]);
  });
});
