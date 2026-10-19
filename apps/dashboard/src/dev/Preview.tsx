// Dev-only (never in production builds): every screen with fake data, for screenshots and layout
// checks without a backend. Open /?screen=<name>, add &lang=en for English.
import { type ReactNode, useMemo } from "react";
import type {
  CaptureViewResponse,
  ClassificationDetails,
  ConsistencyDetails,
  DocumentDataItem,
  DocumentDataResponse,
  MrzCheckDetails,
  MrzServerDetails,
  PolicyReason,
  QualityServerDetails,
  TestSessionResponse,
  WorkerFields,
} from "@verify/shared";
import { StaffPages } from "../App";
import { type DashboardServices, ServicesContext } from "../api/services";
import type { OpenDocumentData } from "../components/DocumentDataViewer";
import type { OpenPhoto } from "../components/PhotoViewer";
import type { LivenessCheckRecord } from "../lib/liveness";
import type {
  CaptureRecord,
  CheckRecord,
  MrzCheckRecord,
  ServerChecks,
  ServerJobState,
  StaffProfile,
  VerificationListItem,
} from "../lib/records";
import { CaseView } from "../screens/CaseView";
import { EnrollScreen } from "../screens/Enroll";
import { LoadingScreen, NoAccessScreen, NotConfiguredScreen } from "../screens/Message";
import { SignInScreen } from "../screens/SignIn";

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const noop = () => undefined;
const never = () => new Promise<null>(noop);

const PROFILES: Record<StaffProfile["role"], StaffProfile> = {
  reviewer: { userId: "00000000-0000-4000-8000-000000000001", role: "reviewer", fullName: "Awa Reviewer", active: true },
  supervisor: { userId: "00000000-0000-4000-8000-000000000002", role: "supervisor", fullName: "Jean Supervisor", active: true },
  admin: { userId: "00000000-0000-4000-8000-000000000003", role: "admin", fullName: "Admin Example", active: true },
};

// One case per state of the "Code lines (MRZ)" section: read and passed (new CNI), read but flagged
// (passport), not readable on the phone, not received, and a document without code lines. Each also
// has the server's checks (M3): all fine; a poor photo whose code lines differ from the phone's; code
// lines the server could not read (after a retaken photo); a residence permit; a driving licence. Then
// three cases for the server alone: still waiting for it, not checked at all, another document found.
const CASE_ID = "7d0c1a52-3f0e-4c8e-9a51-2b6f4f1d9e10";
const PASSPORT_CASE_ID = "2b9f6a10-8c4d-4e1f-b7a3-5d2e9c0f1a22";
const UNREADABLE_CASE_ID = "5f3a9c21-7e4b-4d60-a8f2-1c9e7b3d5a55";
const NOT_RECEIVED_CASE_ID = "9e7d2b64-1a5c-4f83-b0d9-6c2a8e4f1b66";
const NO_MRZ_CASE_ID = "e5a2c9f0-6d1b-4a8e-8f37-9c4b2e7d1a44";
const PENDING_CASE_ID = "3c8e1f45-2b7a-4d90-9e16-8a5f0c3b7d77";
const UNCHECKED_CASE_ID = "6a1d9b38-4f2e-4c75-b8a0-3e7c5f9d2b88";
const MISMATCH_CASE_ID = "8f4b2e61-9c3d-4a17-a5e8-0d6b1f7c4e99";
// M4: an expired passport (a hard flag), and one whose print disagrees with its code lines.
const EXPIRED_CASE_ID = "4d2a7c90-5b1e-4f36-9a8c-2e6f0b9d3c11";
const PRINT_MISMATCH_CASE_ID = "1b6e3f82-7d4a-4c59-8e21-5a9c0d7f2e33";

const VERIFICATIONS: VerificationListItem[] = [
  {
    id: CASE_ID,
    status: "submitted",
    declaredDocument: "cni_biometric",
    isTest: true,
    createdAt: minutes(-12),
    submittedAt: minutes(-4),
    sessionExpiresAt: minutes(18),
    captureCount: 2,
  },
  {
    id: PASSPORT_CASE_ID,
    status: "submitted",
    declaredDocument: "passport",
    isTest: true,
    createdAt: minutes(-25),
    submittedAt: minutes(-19),
    sessionExpiresAt: minutes(5),
    captureCount: 1,
  },
  {
    id: UNREADABLE_CASE_ID,
    status: "submitted",
    declaredDocument: "cni_biometric",
    isTest: true,
    createdAt: minutes(-40),
    submittedAt: minutes(-33),
    sessionExpiresAt: minutes(-10),
    captureCount: 2,
  },
  {
    id: NOT_RECEIVED_CASE_ID,
    status: "submitted",
    declaredDocument: "residence_permit",
    isTest: true,
    createdAt: minutes(-50),
    submittedAt: minutes(-44),
    sessionExpiresAt: minutes(-20),
    captureCount: 2,
  },
  {
    id: "c41e8d77-0a3b-4f5c-9e26-7b1d3a8f6c33",
    status: "created",
    declaredDocument: null,
    isTest: true,
    createdAt: minutes(-95),
    submittedAt: null,
    sessionExpiresAt: minutes(-65),
    captureCount: 0,
  },
  {
    id: NO_MRZ_CASE_ID,
    status: "in_review",
    declaredDocument: "driving_licence",
    isTest: false,
    createdAt: minutes(-60 * 26),
    submittedAt: minutes(-60 * 26 + 6),
    sessionExpiresAt: minutes(-60 * 25),
    captureCount: 2,
  },
  {
    id: PENDING_CASE_ID,
    status: "in_progress",
    declaredDocument: "passport",
    isTest: true,
    createdAt: minutes(-3),
    submittedAt: null,
    sessionExpiresAt: minutes(27),
    captureCount: 1,
  },
  {
    id: UNCHECKED_CASE_ID,
    status: "submitted",
    declaredDocument: "cni_legacy",
    isTest: false,
    createdAt: minutes(-70),
    submittedAt: minutes(-64),
    sessionExpiresAt: minutes(-40),
    captureCount: 2,
  },
  {
    id: MISMATCH_CASE_ID,
    status: "submitted",
    declaredDocument: "cni_biometric",
    isTest: true,
    createdAt: minutes(-80),
    submittedAt: minutes(-73),
    sessionExpiresAt: minutes(-50),
    captureCount: 2,
  },
  {
    id: EXPIRED_CASE_ID,
    status: "submitted",
    declaredDocument: "passport",
    isTest: true,
    createdAt: minutes(-90),
    submittedAt: minutes(-86),
    sessionExpiresAt: minutes(-60),
    captureCount: 1,
  },
  {
    id: PRINT_MISMATCH_CASE_ID,
    status: "submitted",
    declaredDocument: "passport",
    isTest: true,
    createdAt: minutes(-100),
    submittedAt: minutes(-96),
    sessionExpiresAt: minutes(-70),
    captureCount: 1,
  },
];

const CAPTURES: CaptureRecord[] = [
  {
    id: "a1111111-1111-4111-8111-111111111111",
    kind: "document_front",
    byteSize: 241_337,
    width: 1600,
    height: 1009,
    createdAt: minutes(-6),
    sha256: "9f2c4e1a7b3d5f60812a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d",
    deleted: false,
    supersededBy: null,
    livenessChallengeId: null,
    liveness: null,
    quality: {
      source: "auto",
      sharpness: 412.6,
      glareRatio: 0.004,
      meanLuma: 138.2,
      framing: 0.93,
      videoWidth: 1920,
      videoHeight: 1080,
      elapsedMs: 3420,
      reusedElsewhere: false,
    },
  },
  {
    id: "b2222222-2222-4222-8222-222222222222",
    kind: "document_back",
    byteSize: 198_004,
    width: 1600,
    height: 1009,
    createdAt: minutes(-5),
    sha256: "1b3d5f7a9c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d",
    deleted: false,
    supersededBy: null,
    livenessChallengeId: null,
    liveness: null,
    quality: {
      source: "manual",
      sharpness: 168.9,
      glareRatio: 0.031,
      meanLuma: 171.4,
      framing: 0.81,
      videoWidth: 1920,
      videoHeight: 1080,
      elapsedMs: 9180,
      reusedElsewhere: true,
    },
  },
];

// M5: a face check of 13 frames (1 before the actions, then 4 per action), as the rider app sends it.
const CHALLENGE_ID = "f5555555-5555-4555-8555-555555555555";
const LIVENESS_FRAMES: CaptureRecord[] = Array.from({ length: 13 }, (_, i) => {
  const step = i === 0 ? 0 : Math.ceil(i / 4);
  const atMs = i === 0 ? 900 : 1500 + (step - 1) * 3000 + (((i - 1) % 4) + 1) * 600;
  return {
    ...CAPTURES[0],
    id: `f6666666-6666-4666-8666-${String(i).padStart(12, "0")}`,
    kind: "liveness_frame",
    byteSize: 31_000 + i * 211,
    width: 360,
    height: 480,
    createdAt: minutes(-3),
    sha256: `${String(i).padStart(2, "0")}${"ab".repeat(31)}`,
    livenessChallengeId: CHALLENGE_ID,
    liveness: { index: i, step, atMs },
  };
});

const LIVENESS_CHECK: LivenessCheckRecord = {
  id: "f7777777-7777-4777-8777-777777777777",
  captureId: null,
  checkVersion: "liveness-capture-v1",
  outcome: "pass",
  createdAt: minutes(-3),
  details: {
    evaluated: false,
    challengeId: CHALLENGE_ID,
    actions: ["blink", "turn_left", "smile"],
    code: "482913",
    frames: 13,
    framesPerStep: [1, 4, 4, 4],
    durationMs: 9_910,
    serverElapsedMs: 21_400,
    maxGapMs: 1_210,
    startedWithWarning: false,
    problems: [],
  },
};

const PASSPORT_CAPTURES: CaptureRecord[] = [
  {
    ...CAPTURES[0],
    id: "d3333333-3333-4333-8333-333333333333",
    width: 1600,
    height: 1126,
    createdAt: minutes(-21),
    sha256: "4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f",
  },
];

// The back first photographed on the case with unreadable code lines: replaced by a retake, so erased.
const RETAKEN_CAPTURES: CaptureRecord[] = [
  ...CAPTURES,
  {
    ...CAPTURES[1],
    id: "e4444444-4444-4444-8444-444444444444",
    createdAt: minutes(-7),
    sha256: "7c9e1b3d5f7a9c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e",
    deleted: true,
    supersededBy: CAPTURES[1].id,
  },
];

// ICAO 9303 specimens (Utopia, a country that does not exist): no real person. The phone's passport
// lines have their last digit changed so that the overall check digit fails, as a misread would; the
// server's reading of the same photo has it right.
const TD1_LINES = ["I<UTOD231458907<<<<<<<<<<<<<<<", "7408122F1204159UTO<<<<<<<<<<<6", "ERIKSSON<<ANNA<MARIA<<<<<<<<<<"];
const TD3_LINES = ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<14"];
const TD3_SERVER_LINES = ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10"];
const ENGINE = "tesseract.js-7.0.0/mrz-1";

function mrzCheck(
  id: string,
  outcome: MrzCheckRecord["outcome"],
  captureId: string,
  createdAt: string,
  details: Omit<MrzCheckDetails, "source" | "parserVersion" | "captureId" | "engine">,
): MrzCheckRecord {
  return {
    id,
    captureId,
    checkVersion: "mrz-v1",
    outcome,
    details: { source: "mrz_phone", parserVersion: "mrz-v1", captureId, engine: ENGINE, ...details },
    createdAt,
  };
}

const MRZ_CHECKS: Record<string, MrzCheckRecord[]> = {
  [CASE_ID]: [
    mrzCheck("f1111111-1111-4111-8111-111111111111", "pass", CAPTURES[1].id, minutes(-4), {
      result: "read",
      reason: null,
      expectedFormat: "TD1",
      format: "TD1",
      checks: { documentNumber: true, birthDate: true, expiryDate: true, composite: true },
      documentCodeFits: true,
      datesValid: true,
      attempts: 1,
      corrections: 2,
      ms: 640,
    }),
  ],
  [PASSPORT_CASE_ID]: [
    mrzCheck("f2222222-2222-4222-8222-222222222222", "flag", PASSPORT_CAPTURES[0].id, minutes(-19), {
      result: "read",
      reason: null,
      expectedFormat: "TD3",
      format: "TD3",
      checks: { documentNumber: true, birthDate: true, expiryDate: true, personalNumber: true, composite: false },
      documentCodeFits: true,
      datesValid: true,
      attempts: 3,
      corrections: 5,
      ms: 1830,
    }),
  ],
  [UNREADABLE_CASE_ID]: [
    mrzCheck("f3333333-3333-4333-8333-333333333333", "flag", CAPTURES[1].id, minutes(-33), {
      result: "unreadable",
      reason: "not_found",
      expectedFormat: "TD1",
      format: null,
      checks: null,
      documentCodeFits: null,
      datesValid: null,
      attempts: 3,
      corrections: null,
      ms: null,
    }),
  ],
};

// ---------------------------------------------------------------------------
// Server checks (M3), shaped as the worker Edge Function writes them (supabase/functions/worker/decide.ts)
// ---------------------------------------------------------------------------
const SERVER_ENGINE = "worker-1/rapidocr-3.10.0/ppocrv6";
const SERVER_VERSION = "server-checks-v1";
let serverCheckCount = 0;

function serverCheck<D>(
  captureId: string | null,
  outcome: CheckRecord<D>["outcome"],
  details: D,
  createdAt: string,
  checkVersion = SERVER_VERSION,
): CheckRecord<D> {
  serverCheckCount += 1;
  const n = String(serverCheckCount).padStart(12, "0");
  return { id: `a0000000-0000-4000-8000-${n}`, captureId, checkVersion, outcome, details, createdAt };
}

function quality(
  captureId: string,
  verdict: QualityServerDetails["verdict"],
  createdAt: string,
  metrics: Partial<QualityServerDetails["quality"]> = {},
  cold = false,
): CheckRecord<QualityServerDetails> {
  const details: QualityServerDetails = {
    verdict,
    quality: {
      sharpness: 38.4,
      glareRatio: 0.006,
      meanLuma: 142.7,
      documentFound: true,
      documentConfidence: 0.91,
      longSide: 1600,
      textLines: 17,
      ...metrics,
    },
    provisional: true,
    engine: SERVER_ENGINE,
    timing: { ms: cold ? 9840 : 2310, cold },
  };
  return serverCheck(captureId, verdict === "ok" ? "pass" : "flag", details, createdAt);
}

const ALL_DIGITS_RIGHT = { documentNumber: true, birthDate: true, expiryDate: true, composite: true };

function serverMrz(
  captureId: string,
  createdAt: string,
  details: Partial<MrzServerDetails> & Pick<MrzServerDetails, "phone">,
): CheckRecord<MrzServerDetails> {
  const full: MrzServerDetails = {
    parserVersion: "mrz-v1",
    found: true,
    format: "TD1",
    checks: ALL_DIGITS_RIGHT,
    documentCodeFits: true,
    datesValid: true,
    corrections: 1,
    ...details,
  };
  const pass = full.found && full.datesValid === true && full.documentCodeFits === true &&
    full.checks !== null && Object.values(full.checks).every(Boolean);
  return serverCheck(captureId, pass ? "pass" : "flag", full, createdAt, "mrz-v1");
}

function fieldsFound(captureId: string, createdAt: string, found: (keyof WorkerFields)[]) {
  return serverCheck(captureId, found.length > 0 ? "pass" : "flag", { found, provisional: true }, createdAt);
}

function classification(createdAt: string, details: ClassificationDetails): CheckRecord<ClassificationDetails> {
  const outcome = !details.provisional && details.matchesDeclared === true ? "pass" : "flag";
  return serverCheck(null, outcome, details, createdAt);
}

function policy(createdAt: string, reasons: PolicyReason[]) {
  return serverCheck(null, reasons.length === 0 ? "pass" : "flag", { reasons }, createdAt);
}

/** M4: the consistency check, as decideConsistency writes it. */
function consistency(createdAt: string, details: Partial<ConsistencyDetails> = {}): CheckRecord<ConsistencyDetails> {
  const full: ConsistencyDetails = { flags: [], provisional: [], basis: "mrz", mismatches: [], ...details };
  const outcome = full.flags.length > 0 ? "flag" : full.basis === "none" ? "skipped" : "pass";
  return serverCheck(null, outcome, full, createdAt);
}

const FRONT_ID = CAPTURES[0].id;
const BACK_ID = CAPTURES[1].id;
const PASSPORT_ID = PASSPORT_CAPTURES[0].id;
// Photos taken before the server checks existed have no job at all.
const NO_SERVER_CHECKS: ServerChecks = {
  quality: [],
  mrz: [],
  fields: [],
  classification: null,
  policy: null,
  consistency: null,
  jobs: new Map(),
};
const jobs = (state: ServerJobState, ...captureIds: string[]) => new Map(captureIds.map((id) => [id, state] as const));
const BOTH_DONE = jobs("done", FRONT_ID, BACK_ID);

const SERVER_CHECKS: Record<string, ServerChecks> = {
  [CASE_ID]: {
    quality: [quality(BACK_ID, "ok", minutes(-4.6)), quality(FRONT_ID, "ok", minutes(-5.5), {}, true)],
    mrz: [serverMrz(BACK_ID, minutes(-4.6), { phone: "agrees" })],
    fields: [fieldsFound(BACK_ID, minutes(-4.6), []), fieldsFound(FRONT_ID, minutes(-5.5), ["givenNames", "issueDate"])],
    classification: classification(minutes(-4.6), {
      detected: "cni_biometric",
      basis: "mrz",
      provisional: false,
      matchesDeclared: true,
      confidence: 1,
      qrPresent: true,
    }),
    policy: policy(minutes(-4.6), []),
    consistency: consistency(minutes(-4.6)),
    jobs: BOTH_DONE,
  },
  [PASSPORT_CASE_ID]: {
    quality: [quality(PASSPORT_ID, "poor", minutes(-20), { glareRatio: 0.034, meanLuma: 201.3 })],
    mrz: [serverMrz(PASSPORT_ID, minutes(-20), { format: "TD3", checks: { ...ALL_DIGITS_RIGHT, personalNumber: true }, phone: "differs" })],
    fields: [fieldsFound(PASSPORT_ID, minutes(-20), ["issueDate"])],
    classification: classification(minutes(-20), {
      detected: "passport",
      basis: "mrz",
      provisional: false,
      matchesDeclared: true,
      confidence: 1,
      qrPresent: false,
    }),
    policy: policy(minutes(-19), ["mrz_disagreement"]),
    consistency: consistency(minutes(-19), { provisional: ["date_logic"] }),
    jobs: jobs("done", PASSPORT_ID),
  },
  [UNREADABLE_CASE_ID]: {
    quality: [quality(BACK_ID, "unreadable", minutes(-34), { textLines: 1, sharpness: 3.1 }), quality(FRONT_ID, "ok", minutes(-36))],
    mrz: [
      serverMrz(BACK_ID, minutes(-34), {
        found: false,
        format: null,
        checks: null,
        documentCodeFits: null,
        datesValid: null,
        corrections: 0,
        phone: "unreadable",
      }),
    ],
    fields: [fieldsFound(BACK_ID, minutes(-34), []), fieldsFound(FRONT_ID, minutes(-36), ["surname", "givenNames"])],
    classification: classification(minutes(-34), {
      detected: "cni_biometric",
      basis: "keywords",
      provisional: true,
      matchesDeclared: true,
      confidence: 0.5,
      qrPresent: true,
    }),
    policy: policy(minutes(-33), ["mrz_unreadable_server", "provisional_classification"]),
    consistency: consistency(minutes(-33), { basis: "printed" }),
    jobs: BOTH_DONE,
  },
  [NOT_RECEIVED_CASE_ID]: {
    quality: [quality(BACK_ID, "ok", minutes(-45)), quality(FRONT_ID, "ok", minutes(-46))],
    mrz: [serverMrz(BACK_ID, minutes(-45), { corrections: 0, phone: "missing" })],
    fields: [fieldsFound(BACK_ID, minutes(-45), []), fieldsFound(FRONT_ID, minutes(-46), ["surname", "givenNames", "issueDate"])],
    classification: classification(minutes(-45), {
      detected: "residence_permit",
      basis: "mrz",
      provisional: false,
      matchesDeclared: true,
      confidence: 1,
      qrPresent: true,
    }),
    policy: policy(minutes(-44), ["manual_review_document", "phone_report_missing"]),
    consistency: consistency(minutes(-44)),
    jobs: BOTH_DONE,
  },
  [NO_MRZ_CASE_ID]: {
    quality: [quality(BACK_ID, "poor", minutes(-60 * 26 + 5), { sharpness: 4.2 }), quality(FRONT_ID, "ok", minutes(-60 * 26 + 4))],
    mrz: [],
    fields: [
      fieldsFound(BACK_ID, minutes(-60 * 26 + 5), []),
      fieldsFound(FRONT_ID, minutes(-60 * 26 + 4), ["surname", "givenNames", "documentNumber", "birthDate", "expiryDate", "issueDate"]),
    ],
    classification: classification(minutes(-60 * 26 + 5), {
      detected: "driving_licence",
      basis: "keywords",
      provisional: true,
      matchesDeclared: true,
      confidence: 0.417,
      qrPresent: false,
    }),
    policy: policy(minutes(-60 * 26 + 5), ["manual_review_document", "provisional_classification"]),
    consistency: consistency(minutes(-60 * 26 + 5), { basis: "printed", provisional: ["document_expired"] }),
    jobs: BOTH_DONE,
  },
  // The worker is on its way: nothing yet.
  [PENDING_CASE_ID]: { ...NO_SERVER_CHECKS, jobs: jobs("waiting", PASSPORT_ID) },
  // A real session while the worker processes test sessions only: the database marks it at once.
  [UNCHECKED_CASE_ID]: {
    ...NO_SERVER_CHECKS,
    policy: policy(minutes(-66), ["server_unchecked"]),
    jobs: jobs("failed", FRONT_ID, BACK_ID),
  },
  [MISMATCH_CASE_ID]: {
    quality: [quality(BACK_ID, "ok", minutes(-74)), quality(FRONT_ID, "ok", minutes(-75))],
    mrz: [serverMrz(BACK_ID, minutes(-74), { phone: "agrees" })],
    fields: [fieldsFound(BACK_ID, minutes(-74), []), fieldsFound(FRONT_ID, minutes(-75), ["issueDate"])],
    classification: classification(minutes(-74), {
      detected: "residence_permit",
      basis: "mrz",
      provisional: false,
      matchesDeclared: false,
      confidence: 1,
      qrPresent: true,
    }),
    policy: policy(minutes(-73), ["manual_review_document", "type_mismatch"]),
    consistency: consistency(minutes(-73)),
    jobs: BOTH_DONE,
  },
  [EXPIRED_CASE_ID]: {
    quality: [quality(PASSPORT_ID, "ok", minutes(-87))],
    mrz: [serverMrz(PASSPORT_ID, minutes(-87), { format: "TD3", checks: { ...ALL_DIGITS_RIGHT, personalNumber: true }, phone: "agrees" })],
    fields: [fieldsFound(PASSPORT_ID, minutes(-87), ["surname", "givenNames", "documentNumber", "birthDate", "expiryDate", "issueDate"])],
    classification: classification(minutes(-87), {
      detected: "passport",
      basis: "mrz",
      provisional: false,
      matchesDeclared: true,
      confidence: 1,
      qrPresent: false,
    }),
    policy: policy(minutes(-87), ["document_expired"]),
    consistency: consistency(minutes(-87), { flags: ["document_expired"] }),
    jobs: jobs("done", PASSPORT_ID),
  },
  [PRINT_MISMATCH_CASE_ID]: {
    quality: [quality(PASSPORT_ID, "ok", minutes(-97))],
    mrz: [serverMrz(PASSPORT_ID, minutes(-97), { format: "TD3", checks: { ...ALL_DIGITS_RIGHT, personalNumber: true }, phone: "agrees" })],
    fields: [fieldsFound(PASSPORT_ID, minutes(-97), ["surname", "givenNames", "documentNumber", "birthDate", "expiryDate", "issueDate"])],
    classification: classification(minutes(-97), {
      detected: "passport",
      basis: "mrz",
      provisional: false,
      matchesDeclared: true,
      confidence: 1,
      qrPresent: false,
    }),
    policy: policy(minutes(-97), ["mrz_print_mismatch", "under_18"]),
    consistency: consistency(minutes(-97), {
      flags: ["under_18", "mrz_print_mismatch"],
      provisional: ["number_format"],
      mismatches: ["name", "birth_date"],
    }),
    jobs: jobs("done", PASSPORT_ID),
  },
};

// Printed text as the worker reads it: fictitious, on the same Utopia specimen as the code lines. The
// licence's expiry shows a date the worker could not complete; the permit's carries the card sub-type.
const SPECIMEN_FIELDS: WorkerFields = { surname: "ERIKSSON", givenNames: "ANNA MARIA" };

const DOCUMENT_DATA: Record<string, DocumentDataItem[]> = {
  [CASE_ID]: [
    { captureId: FRONT_ID, source: "ocr_server", fields: { givenNames: "ANNA MARIA", issueDate: "2025-03-01" }, recordedAt: minutes(-5.5) },
    { captureId: BACK_ID, source: "mrz_server", format: "TD1", lines: TD1_LINES, recordedAt: minutes(-4.6) },
    { captureId: BACK_ID, source: "mrz_phone", format: "TD1", lines: TD1_LINES, recordedAt: minutes(-4) },
  ],
  [PASSPORT_CASE_ID]: [
    { captureId: PASSPORT_ID, source: "mrz_phone", format: "TD3", lines: TD3_LINES, recordedAt: minutes(-19) },
    { captureId: PASSPORT_ID, source: "ocr_server", fields: { issueDate: "2021-04-16" }, recordedAt: minutes(-20) },
    { captureId: PASSPORT_ID, source: "mrz_server", format: "TD3", lines: TD3_SERVER_LINES, recordedAt: minutes(-20) },
  ],
  [UNREADABLE_CASE_ID]: [
    { captureId: FRONT_ID, source: "ocr_server", fields: SPECIMEN_FIELDS, recordedAt: minutes(-36) },
  ],
  [NOT_RECEIVED_CASE_ID]: [
    { captureId: BACK_ID, source: "mrz_server", format: "TD1", lines: TD1_LINES, recordedAt: minutes(-45) },
    {
      captureId: FRONT_ID,
      source: "ocr_server",
      fields: { ...SPECIMEN_FIELDS, issueDate: "2025-06-02", subtype: "carte_de_sejour" },
      recordedAt: minutes(-46),
    },
  ],
  [NO_MRZ_CASE_ID]: [
    {
      captureId: FRONT_ID,
      source: "ocr_server",
      fields: {
        ...SPECIMEN_FIELDS,
        documentNumber: "D23145890",
        birthDate: "1974-08-12",
        expiryDate: "08/2031",
        issueDate: "2021-08-12",
      },
      recordedAt: minutes(-60 * 26 + 4),
    },
  ],
};

// A drawn specimen card standing in for a signed image link: no real document, no personal data.
const SPECIMEN_URL = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1009" viewBox="0 0 1600 1009">
    <rect width="1600" height="1009" rx="48" fill="#dfe7f5"/>
    <rect x="80" y="200" width="420" height="540" rx="24" fill="#b8c6e0"/>
    <g fill="#8a9cc0"><rect x="580" y="230" width="760" height="44" rx="10"/><rect x="580" y="330" width="600" height="44" rx="10"/>
    <rect x="580" y="430" width="680" height="44" rx="10"/><rect x="580" y="530" width="420" height="44" rx="10"/></g>
    <text x="800" y="900" font-family="sans-serif" font-size="96" font-weight="700" fill="#081a51" text-anchor="middle">SPECIMEN</text>
  </svg>`,
)}`;

const testSession = (): TestSessionResponse => ({
  verificationId: CASE_ID,
  riderUrl: "https://verify.example.org/#s=PREVIEW-not-a-real-token-0123456789abcdefghij",
  expiresAt: minutes(29.5),
});

function fakeServices(): DashboardServices {
  const view = (): CaptureViewResponse => ({ url: SPECIMEN_URL, expiresIn: 60 });
  const documentData = (id: string): DocumentDataResponse => ({ items: DOCUMENT_DATA[id] ?? [], expiresIn: 60 });
  return {
    recentVerifications: async () => VERIFICATIONS,
    verification: async (id) => VERIFICATIONS.find((v) => v.id === id) ?? null,
    captures: async (id) => {
      if ([PASSPORT_CASE_ID, PENDING_CASE_ID, EXPIRED_CASE_ID, PRINT_MISMATCH_CASE_ID].includes(id)) return PASSPORT_CAPTURES;
      if (id === CASE_ID) return [...CAPTURES, ...LIVENESS_FRAMES];
      return id === UNREADABLE_CASE_ID ? RETAKEN_CAPTURES : CAPTURES;
    },
    mrzChecks: async (id) => MRZ_CHECKS[id] ?? [],
    serverChecks: async (id) => SERVER_CHECKS[id] ?? NO_SERVER_CHECKS,
    livenessCheck: async (id) => (id === CASE_ID ? LIVENESS_CHECK : null),
    createTestSession: async () => testSession(),
    viewCapture: async () => view(),
    documentData: async (id) => documentData(id),
  };
}

const SCREENS = [
  "signin",
  "signin-error",
  "enroll",
  "enroll-filled",
  "enroll-error",
  "loading",
  "not-configured",
  "no-access",
  "home",
  "home-reviewer",
  "home-admin",
  "case",
  "case-data",
  "case-data-differs",
  "case-data-permit",
  "case-data-licence",
  "case-flag",
  "case-unreadable",
  "case-not-received",
  "case-no-mrz",
  "case-pending",
  "case-unchecked",
  "case-mismatch",
  "case-expired",
  "case-mismatch-print",
  "case-reviewer",
  "case-admin",
] as const;

export function Preview({ screen }: { screen: string }) {
  const services = useMemo(fakeServices, []);
  const openPhotos = useMemo<Record<string, OpenPhoto>>(
    () => ({ [CAPTURES[0].id]: { url: SPECIMEN_URL, deadlineMs: Date.now() + 42_000 } }),
    [],
  );
  const openData = (id: string): OpenDocumentData => ({ items: DOCUMENT_DATA[id] ?? [], deadlineMs: Date.now() + 42_000 });
  const supervisorCase = (id: string) => <CaseView id={id} profile={PROFILES.supervisor} />;
  const dataCase = (id: string) => (
    <CaseView id={id} profile={PROFILES.supervisor} initialDocumentData={openData(id)} />
  );
  const staff = (profile: StaffProfile, page?: ReactNode, withSession = false) => (
    <ServicesContext.Provider value={services}>
      <StaffPages profile={profile} onSignOut={noop} initialTestSession={withSession ? testSession() : null}>
        {page}
      </StaffPages>
    </ServicesContext.Provider>
  );

  switch (screen) {
    case "signin":
      return <SignInScreen onSignIn={never} onSetUp={noop} />;
    case "signin-error":
      return (
        <SignInScreen
          initialEmail="staff@example.org"
          initialError="signIn.errors.invalidCredentials"
          onSignIn={never}
          onSetUp={noop}
        />
      );
    case "enroll":
      return <EnrollScreen onEnroll={never} onBack={noop} />;
    case "enroll-filled":
      return (
        <EnrollScreen
          initial={{ email: "jean.dupont@example.org", code: "ABCD-2345-EFGH", password: "correct horse battery", confirmation: "correct horse" }}
          onEnroll={never}
          onBack={noop}
        />
      );
    case "enroll-error":
      return (
        <EnrollScreen
          initial={{ email: "jean.dupont@example.org", code: "ABCD-2345-EFGH", password: "correct horse battery", confirmation: "correct horse battery" }}
          initialError="errors.invalid_invite"
          onEnroll={never}
          onBack={noop}
        />
      );
    case "loading":
      return <LoadingScreen />;
    case "not-configured":
      return <NotConfiguredScreen />;
    case "no-access":
      return <NoAccessScreen email="new.staff@example.org" onSignOut={noop} />;
    case "home":
      return staff(PROFILES.supervisor, undefined, true);
    case "home-reviewer":
      return staff(PROFILES.reviewer);
    case "home-admin":
      return staff(PROFILES.admin);
    case "case":
      return staff(PROFILES.supervisor, <CaseView id={CASE_ID} profile={PROFILES.supervisor} initialPhotos={openPhotos} />);
    case "case-data":
      return staff(PROFILES.supervisor, dataCase(CASE_ID));
    case "case-data-differs":
      return staff(PROFILES.supervisor, dataCase(PASSPORT_CASE_ID));
    case "case-data-permit":
      return staff(PROFILES.supervisor, dataCase(NOT_RECEIVED_CASE_ID));
    case "case-data-licence":
      return staff(PROFILES.supervisor, dataCase(NO_MRZ_CASE_ID));
    case "case-flag":
      return staff(PROFILES.supervisor, supervisorCase(PASSPORT_CASE_ID));
    case "case-unreadable":
      return staff(PROFILES.supervisor, supervisorCase(UNREADABLE_CASE_ID));
    case "case-not-received":
      return staff(PROFILES.supervisor, supervisorCase(NOT_RECEIVED_CASE_ID));
    case "case-no-mrz":
      return staff(PROFILES.supervisor, supervisorCase(NO_MRZ_CASE_ID));
    case "case-pending":
      return staff(PROFILES.supervisor, supervisorCase(PENDING_CASE_ID));
    case "case-unchecked":
      return staff(PROFILES.supervisor, supervisorCase(UNCHECKED_CASE_ID));
    case "case-mismatch":
      return staff(PROFILES.supervisor, supervisorCase(MISMATCH_CASE_ID));
    case "case-expired":
      return staff(PROFILES.supervisor, supervisorCase(EXPIRED_CASE_ID));
    case "case-mismatch-print":
      return staff(PROFILES.supervisor, supervisorCase(PRINT_MISMATCH_CASE_ID));
    case "case-reviewer":
      return staff(PROFILES.reviewer, <CaseView id={PASSPORT_CASE_ID} profile={PROFILES.reviewer} />);
    case "case-admin":
      return staff(PROFILES.admin, <CaseView id={CASE_ID} profile={PROFILES.admin} />);
    default:
      return (
        <main className="page">
          <h1>Screen preview</h1>
          <ul>
            {SCREENS.map((name) => (
              <li key={name}>
                <a href={`/?screen=${name}`}>{name}</a>
              </li>
            ))}
          </ul>
        </main>
      );
  }
}
