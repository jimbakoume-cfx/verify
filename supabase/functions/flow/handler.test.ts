// deno-lint-ignore-file require-await
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../_shared/audit.ts";
import {
  CAPTURE_LIMITS,
  type CaptureSide,
  type ClientQuality,
  CONSENT_VERSION,
  type FlowSession,
  KEEP_FACE_IMAGES_VERSION,
  LIVENESS_ACTIONS,
  LIVENESS_LIMITS,
  type LivenessChallengeResponse,
  MRZ_REPORT_LIMITS,
  type MrzCheckDetails,
  REQUIRED_SIDES,
} from "../_shared/contract.ts";
import { randomToken, sha256Hex } from "../_shared/crypto.ts";
import { checkDigit, MRZ_PARSER_VERSION } from "../_shared/mrz.ts";
import { ALLOWED_ORIGIN, buildJpeg, type CallOptions, makeRequest, readJson } from "../_shared/test-helpers.ts";
import type { CaseChecksPayload, CaseSnapshot, CaseStore, JobStatus } from "../worker/case.ts";
import type { CheckStateRow } from "./checks.ts";
import {
  assessMrzReport,
  type CaptureFollowUp,
  type CaptureStorage,
  type ChallengeIssue,
  checkFrame,
  checkImage,
  createFlowHandler,
  type FlowDeps,
  type FlowRepo,
  type FlowVerification,
  type LivenessRecord,
  type LivenessRecordResult,
  type MrzRecord,
  type MrzRecordResult,
  type NewCapture,
  type RequiredKind,
  type StoredCapture,
  type StoredChallenge,
  type SubmitResult,
} from "./handler.ts";
import { livenessFramePath } from "./liveness.ts";
import type { RingReason } from "./ring.ts";

// ---------------------------------------------------------------------------
// In-memory fakes. submit() and claimUploadSlot() mirror the SQL functions in the M1 migration,
// recordMrz() mirrors flow_record_mrz in the M2 migration, insertCapture() mirrors the M3 trigger
// capture_worker_job (a newer photo of a side replaces the older one; one worker job per photo).
// ---------------------------------------------------------------------------
interface VerificationRecord extends FlowVerification {
  tokenHash: string;
  uploadUrlCount: number;
  submittedAt: string | null;
}

interface CaptureRecord extends NewCapture {
  id: string;
  createdAt: string;
  deletedAt: string | null;
  supersededBy: string | null;
  /** M5: set on the face check's frames (kind liveness_frame). */
  livenessChallengeId?: string;
}

interface JobRecord {
  status: JobStatus;
  errorCode: string | null;
  ringFailed: boolean;
}

class MemoryFlowRepo implements FlowRepo {
  verifications = new Map<string, VerificationRecord>();
  consents: {
    verificationId: string;
    consentVersion: string;
    language: string;
    userAgent: string | null;
    keepFaceImages?: boolean;
    keepFaceImagesVersion?: string;
  }[] = [];
  captures: CaptureRecord[] = [];
  audits: AuditEntry[] = [];
  reviewTasks: { verificationId: string; status: string }[] = [];
  mrzRecords: MrzRecord[] = [];
  /** Name of a method that throws, to exercise the 500 path. */
  failOn: keyof FlowRepo | null = null;
  submitOverride: SubmitResult | null = null;
  /** Simulates a capture erased between the handler's lookup and the RPC. */
  recordMrzOverride: MrzRecordResult | null = null;
  /** M3: worker jobs by capture id, the switch, the server's quality verdicts by capture id. */
  jobs = new Map<string, JobRecord>();
  workerEnabled = false;
  qualityVerdicts = new Map<string, string>();
  /** Captures whose read data the replacement deleted (extracted_document_data). */
  erasedData: string[] = [];
  private clock = Date.parse("2026-10-13T09:00:00Z");

  private maybeFail(method: keyof FlowRepo, detail: string) {
    if (this.failOn === method) throw new Error(`relation failed for ${detail}`);
  }

  private get(id: string): VerificationRecord {
    const v = this.verifications.get(id);
    if (!v) throw new Error("no such verification");
    return v;
  }

  async findVerificationByTokenHash(tokenHash: string) {
    this.maybeFail("findVerificationByTokenHash", tokenHash);
    for (const v of this.verifications.values()) if (v.tokenHash === tokenHash) return { ...v };
    return null;
  }

  async getVerification(id: string) {
    const v = this.verifications.get(id);
    return v ? { ...v } : null;
  }

  async hasConsent(verificationId: string) {
    return this.consents.some((c) => c.verificationId === verificationId);
  }

  async insertConsent(c: Parameters<FlowRepo["insertConsent"]>[0]) {
    this.maybeFail("insertConsent", c.verificationId);
    this.consents.push({ ...c });
  }

  async markInProgress(id: string) {
    const v = this.get(id);
    if (v.status === "created") v.status = "in_progress";
  }

  /** Set by a test to simulate a submit that lands between the session lookup and the update. */
  closeBeforeDeclare = false;

  async setDeclaredDocument(id: string, document: VerificationRecord["declaredDocument"]) {
    const v = this.get(id);
    if (this.closeBeforeDeclare) v.status = "submitted";
    if (v.status !== "created" && v.status !== "in_progress") return false;
    v.declaredDocument = document;
    return true;
  }

  async listActiveCaptures(verificationId: string) {
    return this.captures.filter((c) => c.verificationId === verificationId && c.deletedAt === null)
      .map((c) => ({ kind: c.kind as string, createdAt: c.createdAt }));
  }

  async claimUploadSlot(id: string, max: number) {
    const v = this.get(id);
    if (v.uploadUrlCount >= max) return false;
    v.uploadUrlCount++;
    return true;
  }

  async findCaptureByPath(verificationId: string, path: string): Promise<StoredCapture | null> {
    const c = this.captures.find((x) => x.verificationId === verificationId && x.storagePath === path && !x.deletedAt);
    if (!c) return null;
    const server = (c.quality.server ?? {}) as { reusedElsewhere?: boolean };
    return {
      id: c.id,
      byteSize: c.byteSize,
      width: c.width,
      height: c.height,
      sha256: c.sha256,
      reusedElsewhere: server.reusedElsewhere === true,
    };
  }

  async isShaUsedElsewhere(sha256: string, verificationId: string) {
    return this.captures.some((c) => c.sha256 === sha256 && c.verificationId !== verificationId);
  }

  async insertCapture(capture: NewCapture) {
    this.maybeFail("insertCapture", capture.storagePath);
    const id = crypto.randomUUID();
    this.clock += 1000;
    const createdAt = new Date(this.clock).toISOString();
    for (const older of this.captures) {
      if (older.verificationId === capture.verificationId && older.kind === capture.kind && older.deletedAt === null) {
        older.deletedAt = createdAt;
        older.supersededBy = id;
        this.erasedData.push(older.id);
        const job = this.jobs.get(older.id);
        if (job && (job.status === "pending" || job.status === "claimed")) job.status = "superseded";
      }
    }
    this.captures.push({ ...capture, id, createdAt, deletedAt: null, supersededBy: null });
    const eligible = this.get(capture.verificationId).isTest || this.workerEnabled;
    this.jobs.set(id, { status: eligible ? "pending" : "failed", errorCode: eligible ? null : "ineligible", ringFailed: false });
    return id;
  }

  async submit(id: string, requiredSides: readonly RequiredKind[]): Promise<SubmitResult> {
    if (this.submitOverride) return this.submitOverride;
    const v = this.get(id);
    if (v.status !== "created" && v.status !== "in_progress") return "already_submitted";
    const live = (kind: string) => this.captures.some((c) => c.verificationId === id && c.kind === kind && !c.deletedAt);
    if (requiredSides.length === 0 || !requiredSides.every(live)) return "missing_sides";
    v.status = "submitted";
    v.submittedAt = new Date().toISOString();
    this.reviewTasks.push({ verificationId: id, status: "open" });
    this.audits.push({
      actorType: "rider",
      actorId: id,
      action: "verification.submit",
      targetType: "verification",
      targetId: id,
    });
    return "ok";
  }

  async findActiveCapture(verificationId: string, captureId: string) {
    const c = this.captures.find((x) => x.id === captureId && x.verificationId === verificationId && !x.deletedAt);
    return c ? { kind: c.kind as string } : null;
  }

  async recordMrz(record: MrzRecord): Promise<MrzRecordResult> {
    // The detail carries the lines on purpose: the logs must not repeat them.
    this.maybeFail("recordMrz", record.lines ?? "no lines");
    if (this.recordMrzOverride) return this.recordMrzOverride;
    const live = this.captures.some((c) =>
      c.id === record.captureId && c.verificationId === record.verificationId && !c.deletedAt
    );
    if (!live) return "not_found";
    if (this.mrzRecords.some((r) => r.captureId === record.captureId)) return "exists";
    this.mrzRecords.push(structuredClone(record));
    this.audits.push({
      actorType: "rider",
      actorId: record.verificationId,
      action: "mrz.record",
      targetType: "verification",
      targetId: record.verificationId,
      details: { captureId: record.captureId, outcome: record.outcome, result: record.details.result },
    });
    return "ok";
  }

  async audit(entry: AuditEntry) {
    this.maybeFail("audit", entry.action);
    this.audits.push(entry);
  }

  async captureFollowUp(captureId: string): Promise<CaptureFollowUp> {
    this.maybeFail("captureFollowUp", captureId);
    return {
      supersededPaths: this.captures.filter((c) => c.supersededBy === captureId).map((c) => c.storagePath),
      jobPending: this.jobs.get(captureId)?.status === "pending",
    };
  }

  async markRingFailed(captureId: string) {
    const job = this.jobs.get(captureId);
    if (job?.status === "pending") job.ringFailed = true;
  }

  async checkState(verificationId: string): Promise<CheckStateRow[]> {
    return this.captures.filter((c) => c.verificationId === verificationId).map((c) => {
      const job = this.jobs.get(c.id);
      const phone = this.mrzRecords.find((r) => r.captureId === c.id);
      return {
        captureId: c.id,
        kind: c.kind,
        live: c.deletedAt === null,
        createdAt: c.createdAt,
        jobStatus: job?.status ?? null,
        jobError: job?.errorCode ?? null,
        ringFailed: job?.ringFailed ?? false,
        qualityVerdict: this.qualityVerdicts.get(c.id) ?? null,
        phoneMrzPass: phone ? phone.outcome === "pass" : null,
      };
    });
  }

  facePending = false;
  async faceJobsPending(_verificationId: string) {
    return this.facePending;
  }

  /** Automatic approval: flow_result's answer per case; by default from the status, as the SQL function. */
  results = new Map<string, unknown>();
  async flowResult(verificationId: string) {
    this.maybeFail("flowResult", verificationId);
    if (this.results.has(verificationId)) return this.results.get(verificationId);
    const v = this.verifications.get(verificationId);
    if (!v) return null;
    return { state: v.status === "approved" ? "verified" : "review", returnUrl: null };
  }

  async workerEnabledForRealSessions() {
    return this.workerEnabled;
  }

  faceEnabled = false;

  async faceEnabledForRealSessions() {
    return this.faceEnabled;
  }

  /** M4: the firm flags of each case's consistency check. */
  flags = new Map<string, string[]>();

  async consistencyFlags(verificationId: string) {
    return this.flags.get(verificationId) ?? [];
  }

  /** What the worker function does when the server has checked a photo. */
  finishJob(captureId: string, verdict: string) {
    this.jobs.get(captureId)!.status = "done";
    this.qualityVerdicts.set(captureId, verdict);
  }

  // M5: the face check, mirroring flow_issue_liveness_challenge and flow_record_liveness.
  challenges: (StoredChallenge & { verificationId: string })[] = [];
  livenessRecords: LivenessRecord[] = [];
  /** Simulates a change between the handler's checks and the RPC (a race). */
  recordLivenessOverride: LivenessRecordResult | null = null;

  async issueLivenessChallenge(issue: Parameters<FlowRepo["issueLivenessChallenge"]>[0]): Promise<ChallengeIssue> {
    this.maybeFail("issueLivenessChallenge", issue.code);
    const v = this.get(issue.verificationId);
    if (v.status !== "created" && v.status !== "in_progress") return { result: "closed" };
    const mine = this.challenges.filter((c) => c.verificationId === issue.verificationId);
    if (mine.length >= issue.max) return { result: "too_many" };
    this.clock += 1000;
    const createdAt = new Date(this.clock).toISOString();
    for (const c of mine) if (c.usedAt === null && c.supersededAt === null) c.supersededAt = createdAt;
    const id = crypto.randomUUID();
    const expiresAt = new Date(NOW.getTime() + issue.ttlSeconds * 1000).toISOString();
    this.challenges.push({
      id,
      verificationId: issue.verificationId,
      actions: [...issue.actions],
      code: issue.code,
      createdAt: NOW.toISOString(),
      expiresAt,
      supersededAt: null,
      usedAt: null,
    });
    this.audits.push({
      actorType: "rider",
      actorId: issue.verificationId,
      action: "liveness.challenge",
      targetType: "liveness_challenge",
      targetId: id,
      details: { challengeNo: mine.length + 1, actions: issue.actions },
    });
    return { result: "ok", challengeId: id, expiresAt };
  }

  async getLivenessChallenge(verificationId: string, challengeId: string): Promise<StoredChallenge | null> {
    const c = this.challenges.find((x) => x.id === challengeId && x.verificationId === verificationId);
    if (!c) return null;
    const { verificationId: _, ...stored } = c;
    return { ...stored, actions: [...stored.actions] };
  }

  async livenessFramePaths(challengeId: string) {
    return this.captures.filter((c) => c.livenessChallengeId === challengeId && !c.deletedAt).map((c) => c.storagePath);
  }

  async shasUsedElsewhere(sha256s: readonly string[], verificationId: string) {
    return this.captures.some((c) => sha256s.includes(c.sha256) && c.verificationId !== verificationId);
  }

  async recordLiveness(record: LivenessRecord): Promise<LivenessRecordResult> {
    // The detail carries the code on purpose: the logs must not repeat it.
    this.maybeFail("recordLiveness", record.code);
    if (this.recordLivenessOverride) return this.recordLivenessOverride;
    const v = this.get(record.verificationId);
    if (v.status !== "created" && v.status !== "in_progress") return { result: "closed" };
    const c = this.challenges.find((x) => x.id === record.challengeId && x.verificationId === record.verificationId);
    if (!c) return { result: "not_found" };
    if (c.usedAt) return { result: "used" };
    if (c.supersededAt || Date.parse(c.expiresAt) <= NOW.getTime()) return { result: "expired" };
    if (c.code !== record.code) return { result: "code_mismatch" };
    this.clock += 1000;
    const createdAt = new Date(this.clock).toISOString();
    const ids = record.frames.map((frame) => {
      const id = crypto.randomUUID();
      this.captures.push({
        id,
        verificationId: record.verificationId,
        kind: "liveness_frame" as CaptureSide,
        storagePath: frame.path,
        sha256: frame.sha256,
        byteSize: frame.byteSize,
        width: frame.width,
        height: frame.height,
        quality: { liveness: { index: frame.index, step: frame.step, atMs: frame.atMs }, server: { validated: true } },
        createdAt,
        deletedAt: null,
        supersededBy: null,
        livenessChallengeId: c.id,
      });
      return id;
    });
    const replaced = this.captures.filter((x) =>
      x.verificationId === record.verificationId && x.livenessChallengeId && x.livenessChallengeId !== c.id && !x.deletedAt
    );
    for (const older of replaced) {
      older.deletedAt = createdAt;
      older.supersededBy = ids[0];
    }
    c.usedAt = createdAt;
    this.livenessRecords.push(structuredClone(record));
    this.audits.push({
      actorType: "rider",
      actorId: record.verificationId,
      action: "liveness.capture",
      targetType: "liveness_challenge",
      targetId: c.id,
      details: { frames: record.frames.length, outcome: record.outcome, replaced: replaced.length, problems: record.details.problems },
    });
    return { result: "ok", supersededPaths: replaced.map((x) => x.storagePath) };
  }

  async hasLiveness(verificationId: string) {
    return this.captures.some((c) => c.verificationId === verificationId && c.livenessChallengeId && !c.deletedAt);
  }
}

/** Records rings instead of sending them; `fail` makes the ring report a failure. */
class MemoryRing {
  rings: RingReason[] = [];
  fail = false;
  pending: Promise<void>[] = [];

  readonly ring = (reason: RingReason, onFailure?: () => Promise<void>) => {
    this.rings.push(reason);
    if (this.fail && onFailure) this.pending.push(onFailure());
  };

  async settle() {
    await Promise.all(this.pending);
  }
}

/** Counts case refreshes; the decision itself is tested with the worker function. */
class MemoryCases implements CaseStore {
  writes: { verificationId: string; checks: CaseChecksPayload | null }[] = [];
  fail = false;

  async snapshot(verificationId: string): Promise<CaseSnapshot | null> {
    if (this.fail) throw new Error("snapshot failed");
    return { verificationId, declaredDocument: null, sides: [], documentData: [], fingerprint: "0".repeat(32), job: null };
  }

  async write(verificationId: string, _fingerprint: string, checks: CaseChecksPayload | null) {
    this.writes.push({ verificationId, checks });
    return "ok" as const;
  }
}

class MemoryStorage implements CaptureStorage {
  objects = new Map<string, Uint8Array<ArrayBuffer>>();
  signed: string[] = [];
  removed: string[] = [];
  failRemove = false;

  async createSignedUploadUrl(path: string) {
    this.signed.push(path);
    return { path, token: `signed-upload-token-${this.signed.length}` };
  }

  async download(path: string) {
    return this.objects.get(path) ?? null;
  }

  async remove(path: string) {
    if (this.failRemove) throw new Error(`storage refused ${path}`);
    this.removed.push(path);
    this.objects.delete(path);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const NOW = new Date("2026-10-13T10:00:00Z");
const IN_30_MIN = new Date(NOW.getTime() + 30 * 60_000).toISOString();
const PATH_RE = /^([0-9a-f-]{36})\/(document_front|document_back)-([0-9a-f-]{36})\.jpg$/;
const QUALITY: ClientQuality = {
  source: "auto",
  sharpness: 250,
  glareRatio: 0.002,
  meanLuma: 131,
  framing: 0.94,
  videoWidth: 1920,
  videoHeight: 1080,
  elapsedMs: 3500,
};
const GOOD_JPEG = buildJpeg({ width: 1600, height: 1009, padTo: 60_000 });

function setup(overrides: Partial<FlowDeps> = {}) {
  const repo = new MemoryFlowRepo();
  const storage = new MemoryStorage();
  const ring = new MemoryRing();
  const faceRing = new MemoryRing();
  const cases = new MemoryCases();
  const log = { error: vi.fn() };
  let clock = NOW;
  const handler = createFlowHandler({
    repo,
    storage,
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
    ring: ring.ring,
    faceRing: faceRing.ring,
    cases,
    now: () => clock,
    log,
    ...overrides,
  });

  async function seed(
    overrides: Partial<VerificationRecord> = {},
    { consent = false }: { consent?: boolean } = {},
  ) {
    const token = randomToken();
    const id = crypto.randomUUID();
    repo.verifications.set(id, {
      id,
      status: "created",
      locale: "fr",
      declaredDocument: null,
      expiresAt: IN_30_MIN,
      isTest: true,
      tokenHash: await sha256Hex(token),
      uploadUrlCount: 0,
      submittedAt: null,
      ...overrides,
    });
    if (consent) repo.consents.push({ verificationId: id, consentVersion: CONSENT_VERSION, language: "fr", userAgent: null });
    return { id, token };
  }

  /** A session with consent and a declared CNI, ready for uploads. */
  function ready(overrides: Partial<VerificationRecord> = {}) {
    return seed({ status: "in_progress", declaredDocument: "cni_legacy", ...overrides }, { consent: true });
  }

  function call(path: string, token: string | null, options: CallOptions = {}) {
    const headers: Record<string, string> = { ...options.headers };
    if (token !== null) headers["x-session-token"] = token;
    const method = options.method ?? (path === "/session" ? "GET" : "POST");
    return handler(makeRequest(`https://ref.supabase.co/flow${path}`, { ...options, method, headers }));
  }

  async function upload(token: string, kind: CaptureSide, image: Uint8Array<ArrayBuffer> = GOOD_JPEG) {
    const res = await call("/upload-url", token, { body: { kind } });
    expect(res.status).toBe(200);
    const { path } = await readJson(res) as { path: string };
    storage.objects.set(path, image);
    return path;
  }

  async function complete(token: string, kind: CaptureSide, image?: Uint8Array<ArrayBuffer>) {
    const path = await upload(token, kind, image);
    return call("/captures", token, { body: { path, kind, quality: QUALITY } });
  }

  /** M5: POST /liveness/challenge, expected to succeed. */
  async function challenge(token: string): Promise<LivenessChallengeResponse> {
    const res = await call("/liveness/challenge", token, { body: {} });
    expect(res.status).toBe(200);
    return await res.json() as LivenessChallengeResponse;
  }

  /**
   * M5: uploads `count` frames into the challenge's slots, as the app does (a distinct JPEG each), and
   * returns the POST /liveness/captures body for them, 20 s after the challenge was issued.
   */
  async function frames(c: LivenessChallengeResponse, count = 13, image = (i: number) => frameJpeg(i)) {
    const reports = [];
    for (let i = 0; i < count; i++) {
      const bytes = image(i);
      storage.objects.set(c.uploads[i].path, bytes);
      reports.push({ index: i, path: c.uploads[i].path, sha256: await sha256Hex(bytes), ...frameTiming(i) });
    }
    clock = new Date(NOW.getTime() + 20_000);
    return {
      challengeId: c.challengeId,
      code: c.code,
      frames: reports,
      stepStartsMs: [...STEP_STARTS],
      startedWithWarning: false,
      videoWidth: 480,
      videoHeight: 640,
    };
  }

  /** M5: a whole face check, recorded. */
  async function passLiveness(token: string) {
    const body = await frames(await challenge(token));
    const res = await call("/liveness/captures", token, { body });
    expect(res.status).toBe(200);
    return body;
  }

  return {
    repo,
    storage,
    ring,
    faceRing,
    cases,
    log,
    handler,
    seed,
    ready,
    call,
    upload,
    complete,
    challenge,
    frames,
    passLiveness,
    setClock: (d: Date) => (clock = d),
  };
}

/** M5: the app's schedule: 1 frame before the first action, then 4 during each 3-second action. */
const STEP_STARTS = [0, 1500, 4500, 7500];
function frameTiming(index: number): { atMs: number; step: number } {
  if (index === 0) return { atMs: 900, step: 0 };
  if (index > 12) return { atMs: 10_000 + (index - 12) * 100, step: 3 };
  const step = Math.floor((index - 1) / 4) + 1;
  return { atMs: STEP_STARTS[step] + (((index - 1) % 4) + 1) * 600, step };
}
/** A distinct frame per index: 360x480, about 30 KB. */
function frameJpeg(index: number): Uint8Array<ArrayBuffer> {
  return buildJpeg({ width: 360, height: 480, padTo: 30_000 + index });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = await readJson(res);
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------
describe("session lookup", () => {
  const routes: [string, CallOptions][] = [
    ["/session", {}],
    ["/consent", { body: { consentVersion: CONSENT_VERSION, language: "fr" } }],
    ["/document-type", { body: { declaredDocument: "cni_legacy" } }],
    ["/upload-url", { body: { kind: "document_front" } }],
    ["/captures", { body: {} }],
    ["/mrz", { body: {} }],
    ["/liveness/challenge", { body: {} }],
    ["/liveness/captures", { body: {} }],
    ["/submit", {}],
  ];

  it.each(routes)("%s: no token -> 401 invalid_session", async (path, options) => {
    const { call } = setup();
    await expectError(await call(path, null, options), 401, "invalid_session");
  });

  it("malformed and unknown tokens get the same 401 response", async () => {
    const { call, seed } = setup();
    await seed();
    const bodies = new Set<string>();
    for (const token of ["", "short", "x".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}+`, randomToken()]) {
      const res = await call("/session", token);
      expect(res.status).toBe(401);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("expired session -> 410 session_expired, from the exact expiry instant", async () => {
    const { call, seed, setClock } = setup();
    const { token } = await seed();
    setClock(new Date(IN_30_MIN));
    await expectError(await call("/session", token), 410, "session_expired");
    setClock(new Date(Date.parse(IN_30_MIN) - 1));
    expect((await call("/session", token)).status).toBe(200);
  });

  it("a session without an expiry is treated as expired", async () => {
    const { call, seed } = setup();
    const { token } = await seed({ expiresAt: null });
    await expectError(await call("/session", token), 410, "session_expired");
  });

  it("expiry is reported before the status", async () => {
    const { call, seed } = setup();
    const { token } = await seed({ status: "submitted", expiresAt: "2026-10-13T09:00:00Z" });
    await expectError(await call("/consent", token, { body: {} }), 410, "session_expired");
  });

  it.each(["submitted", "processing", "in_review", "approved", "rejected", "expired", "cancelled"] as const)(
    "status %s: every route but GET /session -> 409 already_submitted",
    async (status) => {
      const { call, seed } = setup();
      const { token } = await seed({ status, declaredDocument: "cni_legacy" }, { consent: true });
      expect((await call("/session", token)).status).toBe(200);
      for (const [path, options] of routes.slice(1)) {
        await expectError(await call(path, token, options), 409, "already_submitted");
      }
    },
  );

  it("never logs the token or its hash when the lookup fails", async () => {
    const { seed, repo } = setup();
    const { token } = await seed();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const quiet = createFlowHandler({ repo, storage: new MemoryStorage(), allowedOrigins: new Set([ALLOWED_ORIGIN]) });
    repo.failOn = "findVerificationByTokenHash";
    const res = await quiet(makeRequest("https://ref.supabase.co/flow/session", {
      method: "GET",
      headers: { "x-session-token": token },
    }));
    await expectError(res, 500, "server_error");
    const logged = spy.mock.calls.flat().join(" ");
    expect(spy).toHaveBeenCalled();
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(await sha256Hex(token));
    expect(logged).not.toContain("relation failed");
  });
});


// ---------------------------------------------------------------------------
// GET /session
// ---------------------------------------------------------------------------
describe("GET /session", () => {
  it("returns a fresh session", async () => {
    const { call, seed } = setup();
    const { id, token } = await seed({ locale: "en" });
    const res = await call("/session", token);
    expect(res.status).toBe(200);
    const session: FlowSession = await res.json();
    expect(session).toEqual({
      verificationId: id,
      status: "created",
      locale: "en",
      consentGiven: false,
      declaredDocument: null,
      requiredSides: null,
      captures: [],
      expiresAt: IN_30_MIN,
      isTest: true,
    });
  });

  it("lists the latest live capture per side, ignoring deleted rows and other kinds", async () => {
    const { call, ready, repo, complete } = setup();
    const { id, token } = await ready();
    expect((await complete(token, "document_front")).status).toBe(200);
    expect((await complete(token, "document_front", buildJpeg({ width: 1600, height: 1000, padTo: 30_000 }))).status)
      .toBe(200);
    expect((await complete(token, "document_back")).status).toBe(200);
    const fronts = repo.captures.filter((c) => c.kind === "document_front");
    repo.captures.find((c) => c.kind === "document_back")!.deletedAt = NOW.toISOString();
    repo.captures.push({ ...fronts[0], id: crypto.randomUUID(), kind: "selfie" as CaptureSide, storagePath: "x" });

    const session: FlowSession = await (await call("/session", token)).json();
    expect(session.verificationId).toBe(id);
    expect(session.consentGiven).toBe(true);
    expect(session.declaredDocument).toBe("cni_legacy");
    expect(session.requiredSides).toEqual(["document_front", "document_back"]);
    expect(session.captures).toEqual([{ kind: "document_front", createdAt: fronts[1].createdAt }]);
  });

  it("still answers once submitted", async () => {
    const { call, seed } = setup();
    const { token } = await seed({ status: "approved" });
    const session: FlowSession = await (await call("/session", token)).json();
    expect(session.status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// POST /consent
// ---------------------------------------------------------------------------
describe("POST /consent", () => {
  it.each([
    ["a wrong version", { consentVersion: "v999", language: "fr" }],
    ["a missing version", { language: "fr" }],
    ["a non-string version", { consentVersion: 1, language: "fr" }],
    ["an unknown language", { consentVersion: CONSENT_VERSION, language: "de" }],
    ["a missing language", { consentVersion: CONSENT_VERSION }],
  ])("%s -> 400 bad_request", async (_label, body) => {
    const { call, seed, repo } = setup();
    const { token } = await seed();
    await expectError(await call("/consent", token, { body }), 400, "bad_request");
    expect(repo.consents).toHaveLength(0);
  });

  it("requires a body", async () => {
    const { call, seed } = setup();
    const { token } = await seed();
    await expectError(await call("/consent", token), 400, "bad_request");
  });

  it("records consent with the user agent, starts the verification and audits", async () => {
    const { call, seed, repo } = setup();
    const { id, token } = await seed();
    const res = await call("/consent", token, {
      body: { consentVersion: CONSENT_VERSION, language: "en" },
      headers: { "user-agent": "Mozilla/5.0 " + "x".repeat(1000) },
    });
    expect(res.status).toBe(200);
    const session: FlowSession = await res.json();
    expect(session).toMatchObject({ status: "in_progress", consentGiven: true });
    expect(repo.consents).toHaveLength(1);
    expect(repo.consents[0]).toMatchObject({
      verificationId: id,
      consentVersion: CONSENT_VERSION,
      language: "en",
      // M5: the optional box is false when the app does not send it.
      keepFaceImages: false,
      keepFaceImagesVersion: KEEP_FACE_IMAGES_VERSION,
    });
    expect(repo.consents[0].userAgent).toHaveLength(512);
    expect(repo.audits).toEqual([{
      actorType: "rider",
      actorId: id,
      action: "consent.accept",
      targetType: "verification",
      targetId: id,
      details: { consentVersion: CONSENT_VERSION, language: "en", keepFaceImages: false, keepFaceImagesVersion: KEEP_FACE_IMAGES_VERSION },
    }]);
  });

  it("M5: records the optional 'keep my face images' answer with its wording's version", async () => {
    const { call, seed, repo } = setup();
    const { token } = await seed();
    const res = await call("/consent", token, { body: { consentVersion: CONSENT_VERSION, language: "fr", keepFaceImages: true } });
    expect(res.status).toBe(200);
    expect(repo.consents[0]).toMatchObject({ keepFaceImages: true, keepFaceImagesVersion: KEEP_FACE_IMAGES_VERSION });
    expect(repo.audits[0].details).toMatchObject({ keepFaceImages: true });
  });

  it.each([["a string", "yes"], ["a number", 1], ["null", null]])(
    "M5: refuses keepFaceImages as %s -> 400",
    async (_label, value) => {
      const { call, seed, repo } = setup();
      const { token } = await seed();
      const body = { consentVersion: CONSENT_VERSION, language: "fr", keepFaceImages: value };
      await expectError(await call("/consent", token, { body }), 400, "bad_request");
      expect(repo.consents).toHaveLength(0);
    },
  );

  it("stores a null user agent when the header is absent", async () => {
    const { call, seed, repo } = setup();
    const { token } = await seed();
    await call("/consent", token, { body: { consentVersion: CONSENT_VERSION, language: "fr" } });
    expect(repo.consents[0].userAgent).toBeNull();
  });

  it("is idempotent: no second row and no second audit", async () => {
    const { call, seed, repo } = setup();
    const { token } = await seed();
    const body = { consentVersion: CONSENT_VERSION, language: "fr" };
    expect((await call("/consent", token, { body })).status).toBe(200);
    const again = await call("/consent", token, { body });
    expect(again.status).toBe(200);
    expect((await again.json() as FlowSession).consentGiven).toBe(true);
    expect(repo.consents).toHaveLength(1);
    expect(repo.audits.filter((a) => a.action === "consent.accept")).toHaveLength(1);
  });

  it("finishes a half-done consent (row written, status still created)", async () => {
    const { call, seed, repo } = setup();
    const { id, token } = await seed({}, { consent: true });
    const res = await call("/consent", token, { body: { consentVersion: CONSENT_VERSION, language: "fr" } });
    expect(res.status).toBe(200);
    expect(repo.verifications.get(id)!.status).toBe("in_progress");
    expect(repo.consents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /document-type
// ---------------------------------------------------------------------------
describe("POST /document-type", () => {
  it("requires consent -> 403 consent_required", async () => {
    const { call, seed } = setup();
    const { token } = await seed();
    await expectError(await call("/document-type", token, { body: { declaredDocument: "cni_legacy" } }), 403, "consent_required");
  });

  it.each([
    ["unknown", { declaredDocument: "library_card" }],
    ["the M1 CNI", { declaredDocument: "cni" }],
    ["missing", {}],
    ["not a string", { declaredDocument: 3 }],
  ])(
    "%s document -> 400 bad_request",
    async (_label, body) => {
      const { call, seed } = setup();
      const { token } = await seed({ status: "in_progress" }, { consent: true });
      await expectError(await call("/document-type", token, { body }), 400, "bad_request");
    },
  );

  it.each(["cni_biometric", "cni_legacy"] as const)("accepts the CNI choice %s, with both sides", async (declaredDocument) => {
    const { call, seed } = setup();
    const { token } = await seed({ status: "in_progress" }, { consent: true });
    const session: FlowSession = await (await call("/document-type", token, { body: { declaredDocument } })).json();
    expect(session).toMatchObject({ declaredDocument, requiredSides: ["document_front", "document_back"] });
  });

  it("M4: decides the case's server checks again when the document changes, not when it stays", async () => {
    const { call, seed, cases } = setup();
    const { id, token } = await seed({ status: "in_progress" }, { consent: true });
    await call("/document-type", token, { body: { declaredDocument: "cni_biometric" } });
    expect(cases.writes).toEqual([]);
    await call("/document-type", token, { body: { declaredDocument: "cni_biometric" } });
    expect(cases.writes).toEqual([]);
    await call("/document-type", token, { body: { declaredDocument: "passport" } });
    expect(cases.writes).toEqual([{ verificationId: id, checks: null }]);
  });

  it("M4: a failed refresh after a new document is logged, never shown to the rider", async () => {
    const { call, seed, cases, log } = setup();
    const { token } = await seed({ status: "in_progress", declaredDocument: "cni_biometric" }, { consent: true });
    cases.fail = true;
    const res = await call("/document-type", token, { body: { declaredDocument: "passport" } });
    expect(res.status).toBe(200);
    expect(log.error).toHaveBeenCalledWith("flow.case_refresh_failed", expect.any(Error));
  });

  it("declares the document, audits, and may change it before submit", async () => {
    const { call, seed, repo } = setup();
    const { id, token } = await seed({ status: "in_progress" }, { consent: true });
    const first: FlowSession = await (await call("/document-type", token, { body: { declaredDocument: "cni_legacy" } })).json();
    expect(first).toMatchObject({ declaredDocument: "cni_legacy", requiredSides: ["document_front", "document_back"] });
    const second: FlowSession = await (await call("/document-type", token, { body: { declaredDocument: "passport" } }))
      .json();
    expect(second).toMatchObject({ declaredDocument: "passport", requiredSides: ["document_front"] });
    expect(repo.verifications.get(id)!.declaredDocument).toBe("passport");
    expect(repo.audits.map((a) => [a.action, a.details])).toEqual([
      ["document.declare", { declaredDocument: "cni_legacy" }],
      ["document.declare", { declaredDocument: "passport" }],
    ]);
    expect(repo.audits[0]).toMatchObject({ actorType: "rider", actorId: id, targetType: "verification", targetId: id });
  });

  it("a submit landing first wins: 409 already_submitted and no audit of a change that did not happen", async () => {
    const { call, seed, repo } = setup();
    const { id, token } = await seed({ status: "in_progress", declaredDocument: "cni_legacy" }, { consent: true });
    repo.closeBeforeDeclare = true;
    await expectError(
      await call("/document-type", token, { body: { declaredDocument: "passport" } }),
      409,
      "already_submitted",
    );
    expect(repo.verifications.get(id)!.declaredDocument).toBe("cni_legacy");
    expect(repo.audits.filter((a) => a.action === "document.declare")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /upload-url
// ---------------------------------------------------------------------------
describe("POST /upload-url", () => {
  it("requires consent -> 403 consent_required", async () => {
    const { call, seed } = setup();
    const { token } = await seed({ declaredDocument: "cni_legacy" });
    await expectError(await call("/upload-url", token, { body: { kind: "document_front" } }), 403, "consent_required");
  });

  it("requires a declared document -> 409 document_type_required", async () => {
    const { call, seed } = setup();
    const { token } = await seed({ status: "in_progress" }, { consent: true });
    await expectError(await call("/upload-url", token, { body: { kind: "document_front" } }), 409, "document_type_required");
  });

  it("requires a kind -> 400 bad_request", async () => {
    const { call, ready } = setup();
    const { token } = await ready();
    await expectError(await call("/upload-url", token, { body: {} }), 400, "bad_request");
    await expectError(await call("/upload-url", token, { body: { kind: ["document_front"] } }), 400, "bad_request");
  });

  it("rejects a side the document does not have -> 400 invalid_kind", async () => {
    const { call, ready, storage } = setup();
    const { token } = await ready({ declaredDocument: "passport" });
    await expectError(await call("/upload-url", token, { body: { kind: "document_back" } }), 400, "invalid_kind");
    await expectError(await call("/upload-url", token, { body: { kind: "selfie" } }), 400, "invalid_kind");
    expect(storage.signed).toHaveLength(0);
  });

  it("returns a signed upload for a fresh path inside the verification's folder", async () => {
    const { call, ready, storage, repo } = setup();
    const { id, token } = await ready();
    const res = await call("/upload-url", token, { body: { kind: "document_back" } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(Object.keys(body).sort()).toEqual(["bucket", "path", "token"]);
    expect(body.bucket).toBe("id-captures");
    expect(body.token).toBe("signed-upload-token-1");
    const match = PATH_RE.exec(body.path as string);
    expect(match?.[1]).toBe(id);
    expect(match?.[2]).toBe("document_back");
    expect(storage.signed).toEqual([body.path]);
    expect(repo.verifications.get(id)!.uploadUrlCount).toBe(1);
    const other = await readJson(await call("/upload-url", token, { body: { kind: "document_back" } }));
    expect(other.path).not.toBe(body.path);
  });

  it(`allows ${CAPTURE_LIMITS.maxUploadUrlsPerSession} links per session, then 429 too_many_uploads`, async () => {
    const { call, ready, storage } = setup();
    const { token } = await ready();
    for (let i = 0; i < CAPTURE_LIMITS.maxUploadUrlsPerSession; i++) {
      expect((await call("/upload-url", token, { body: { kind: "document_front" } })).status).toBe(200);
    }
    await expectError(await call("/upload-url", token, { body: { kind: "document_front" } }), 429, "too_many_uploads");
    expect(storage.signed).toHaveLength(CAPTURE_LIMITS.maxUploadUrlsPerSession);
  });
});

// ---------------------------------------------------------------------------
// POST /captures
// ---------------------------------------------------------------------------
describe("POST /captures", () => {
  it("records a valid image, sanitises the quality object and audits", async () => {
    const { call, ready, upload, repo } = setup();
    const { id, token } = await ready();
    const path = await upload(token, "document_front");
    // 1e999 is valid JSON that parses to Infinity.
    const json = JSON.stringify({
      path,
      kind: "document_front",
      quality: { ...QUALITY, sharpness: "INF", server: { validated: false } },
    }).replace('"INF"', "1e999");
    const res = await call("/captures", token, { rawBody: json });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const sha256 = await sha256Hex(GOOD_JPEG);
    expect(body).toEqual({
      captureId: expect.any(String),
      byteSize: GOOD_JPEG.byteLength,
      width: 1600,
      height: 1009,
      sha256,
    });
    expect(repo.captures).toHaveLength(1);
    expect(repo.captures[0]).toMatchObject({
      id: body.captureId,
      verificationId: id,
      kind: "document_front",
      storagePath: path,
      sha256,
      byteSize: GOOD_JPEG.byteLength,
      width: 1600,
      height: 1009,
    });
    expect(repo.captures[0].quality).toEqual({
      ...QUALITY,
      sharpness: 1e6,
      server: { validated: true, reusedElsewhere: false },
    });
    expect(repo.audits).toEqual([{
      actorType: "rider",
      actorId: id,
      action: "capture.create",
      targetType: "capture",
      targetId: body.captureId,
      details: { kind: "document_front", byteSize: GOOD_JPEG.byteLength, reusedElsewhere: false, replaced: 0 },
    }]);
  });

  it("flags an image already uploaded in another verification", async () => {
    const harness = setup();
    const first = await harness.ready();
    expect((await harness.complete(first.token, "document_front")).status).toBe(200);
    const second = await harness.ready();
    const res = await harness.complete(second.token, "document_front");
    // Recorded for staff, never told to the rider (it would let a fraudster probe for reuse).
    expect(await readJson(res)).not.toHaveProperty("reusedElsewhere");
    expect(harness.repo.captures[1].quality.server).toEqual({ validated: true, reusedElsewhere: true });
    // The first verification's next photo is the same image as the second verification's front.
    const again = await harness.complete(first.token, "document_back");
    expect(await readJson(again)).not.toHaveProperty("reusedElsewhere");
    expect(harness.repo.captures[2].quality.server).toEqual({ validated: true, reusedElsewhere: true });
  });

  it("answers a retried request with the capture already recorded", async () => {
    const { call, ready, upload, repo, storage } = setup();
    const { token } = await ready();
    const path = await upload(token, "document_front");
    const body = { path, kind: "document_front", quality: QUALITY };
    const first = await readJson(await call("/captures", token, { body }));
    storage.objects.delete(path); // a retry must not need the object again
    const second = await call("/captures", token, { body });
    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual(first);
    expect(repo.captures).toHaveLength(1);
    expect(repo.audits.filter((a) => a.action === "capture.create")).toHaveLength(1);
  });

  it("validates kind, path and quality -> 400 bad_request", async () => {
    const { call, ready, upload, seed, storage, repo } = setup();
    const { id, token } = await ready();
    const path = await upload(token, "document_front");
    const other = await seed();
    const foreign = `${other.id}/document_front-${crypto.randomUUID()}.jpg`;
    storage.objects.set(foreign, GOOD_JPEG);
    const cases: unknown[] = [
      { path, kind: "selfie", quality: QUALITY },
      { path, kind: "document_back", quality: QUALITY },
      { path: foreign, kind: "document_front", quality: QUALITY },
      { path: `${id}/../${foreign}`, kind: "document_front", quality: QUALITY },
      { path: path.replace(".jpg", ".png"), kind: "document_front", quality: QUALITY },
      { path: 12, kind: "document_front", quality: QUALITY },
      { kind: "document_front", quality: QUALITY },
      { path, kind: "document_front" },
      { path, kind: "document_front", quality: { ...QUALITY, source: "upload" } },
      { path, kind: "document_front", quality: { ...QUALITY, meanLuma: "dark" } },
    ];
    for (const body of cases) {
      await expectError(await call("/captures", token, { body }), 400, "bad_request");
    }
    expect(repo.captures).toHaveLength(0);
    expect(storage.removed).toHaveLength(0);
  });

  it("missing object -> 404 upload_missing", async () => {
    const { call, ready } = setup();
    const { id, token } = await ready();
    const path = `${id}/document_front-${crypto.randomUUID()}.jpg`;
    await expectError(await call("/captures", token, { body: { path, kind: "document_front", quality: QUALITY } }), 404, "upload_missing");
  });

  const tooSmall = buildJpeg({ width: 1600, height: 1000, padTo: CAPTURE_LIMITS.minBytes - 1 });
  const tooLarge = (() => {
    const big = new Uint8Array(CAPTURE_LIMITS.maxBytes + 1);
    big.set(buildJpeg({ width: 1600, height: 1000 }));
    return big;
  })();
  const png = (() => {
    const bytes = new Uint8Array(20_000);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return bytes;
  })();
  const noFrame = (() => {
    const bytes = new Uint8Array(20_000);
    bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    return bytes;
  })();
  const lowRes = buildJpeg({ width: CAPTURE_LIMITS.minLongSide - 1, height: 500, padTo: 20_000 });
  const overLongSide = buildJpeg({ width: 1200, height: CAPTURE_LIMITS.maxLongSide + 1, padTo: 20_000 });

  it.each([
    ["image_too_small", tooSmall],
    ["image_too_large", tooLarge],
    ["invalid_image", png],
    ["invalid_image", noFrame],
    ["image_resolution_too_low", lowRes],
    ["image_too_large", overLongSide],
  ])("rejects with 422 %s and deletes the object", async (code, image) => {
    const { call, ready, upload, storage, repo } = setup();
    const { token } = await ready();
    const path = await upload(token, "document_front", image);
    await expectError(await call("/captures", token, { body: { path, kind: "document_front", quality: QUALITY } }), 422, code);
    expect(storage.removed).toEqual([path]);
    expect(storage.objects.has(path)).toBe(false);
    expect(repo.captures).toHaveLength(0);
    expect(repo.audits).toHaveLength(0);
  });

  it("still answers 422 when the cleanup fails, and logs it", async () => {
    const { call, ready, upload, storage, log } = setup();
    const { token } = await ready();
    const path = await upload(token, "document_front", lowRes);
    storage.failRemove = true;
    await expectError(await call("/captures", token, { body: { path, kind: "document_front", quality: QUALITY } }), 422, "image_resolution_too_low");
    expect(log.error).toHaveBeenCalledWith("flow.capture_remove_failed", expect.any(Error));
  });

  it("accepts a portrait crop whose long side is exactly the minimum", async () => {
    const { complete, ready } = setup();
    const { token } = await ready();
    const res = await complete(token, "document_front", buildJpeg({ width: 600, height: CAPTURE_LIMITS.minLongSide, padTo: 20_000 }));
    expect(res.status).toBe(200);
  });

  it("returns 500 server_error when the database insert fails", async () => {
    const { call, ready, upload, repo } = setup();
    const { token } = await ready();
    const path = await upload(token, "document_front");
    repo.failOn = "insertCapture";
    await expectError(await call("/captures", token, { body: { path, kind: "document_front", quality: QUALITY } }), 500, "server_error");
  });
});

describe("checkImage", () => {
  it("checks size before format and format before resolution", () => {
    expect(checkImage(new Uint8Array(10))).toEqual({ ok: false, code: "image_too_small" });
    expect(checkImage(GOOD_JPEG)).toEqual({ ok: true, width: 1600, height: 1009 });
    expect(checkImage(buildJpeg({ width: 800, height: 10, padTo: CAPTURE_LIMITS.minBytes }))).toMatchObject({ ok: true });
  });

  it("refuses a long side over the app's maximum, which the AI worker would refuse", () => {
    const at = (width: number, height: number) => checkImage(buildJpeg({ width, height, padTo: CAPTURE_LIMITS.minBytes }));
    expect(at(CAPTURE_LIMITS.maxLongSide, 900)).toMatchObject({ ok: true });
    expect(at(900, CAPTURE_LIMITS.maxLongSide)).toMatchObject({ ok: true });
    expect(at(CAPTURE_LIMITS.maxLongSide + 1, 900)).toEqual({ ok: false, code: "image_too_large" });
    expect(at(2400, 1800)).toEqual({ ok: false, code: "image_too_large" });
  });
});

// ---------------------------------------------------------------------------
// POST /submit
// ---------------------------------------------------------------------------
describe("POST /submit", () => {
  it("requires a declared document -> 409 document_type_required", async () => {
    const { call, seed } = setup();
    const { token } = await seed({ status: "in_progress" }, { consent: true });
    await expectError(await call("/submit", token), 409, "document_type_required");
  });

  it("requires every side -> 409 missing_sides", async () => {
    const { call, ready, complete, repo, passLiveness } = setup();
    const { id, token } = await ready();
    await passLiveness(token);
    await expectError(await call("/submit", token), 409, "missing_sides");
    expect((await complete(token, "document_front")).status).toBe(200);
    await expectError(await call("/submit", token), 409, "missing_sides");
    expect(repo.verifications.get(id)!.status).toBe("in_progress");
    expect(repo.reviewTasks).toHaveLength(0);
  });

  it("M5: requires the face check -> 409 liveness_required", async () => {
    const { call, ready, complete, repo } = setup();
    const { id, token } = await ready();
    await complete(token, "document_front");
    await complete(token, "document_back");
    const submit = vi.spyOn(repo, "submit");
    await expectError(await call("/submit", token), 409, "liveness_required");
    expect(submit).not.toHaveBeenCalled();
    expect(repo.verifications.get(id)!.status).toBe("in_progress");
  });

  it("M5: erased frames do not count", async () => {
    const { call, ready, complete, repo, passLiveness } = setup();
    const { token } = await ready({ declaredDocument: "passport" });
    await complete(token, "document_front");
    await passLiveness(token);
    for (const c of repo.captures) if (c.livenessChallengeId) c.deletedAt = NOW.toISOString();
    await expectError(await call("/submit", token), 409, "liveness_required");
  });

  it("does not count a deleted capture", async () => {
    const { call, ready, complete, repo, passLiveness } = setup();
    const { token } = await ready({ declaredDocument: "passport" });
    await complete(token, "document_front");
    await passLiveness(token);
    repo.captures[0].deletedAt = NOW.toISOString();
    await expectError(await call("/submit", token), 409, "missing_sides");
  });

  it("submits, opens a review task, audits and returns the session", async () => {
    const { call, ready, complete, repo, passLiveness } = setup();
    const { id, token } = await ready();
    await complete(token, "document_front");
    await complete(token, "document_back");
    await passLiveness(token);
    const res = await call("/submit", token);
    expect(res.status).toBe(200);
    const session: FlowSession = await res.json();
    expect(session).toMatchObject({ verificationId: id, status: "submitted" });
    expect(session.captures.map((c) => c.kind)).toEqual(["document_front", "document_back"]);
    expect(repo.verifications.get(id)!.submittedAt).not.toBeNull();
    expect(repo.reviewTasks).toEqual([{ verificationId: id, status: "open" }]);
    expect(repo.audits.at(-1)).toMatchObject({ action: "verification.submit", actorType: "rider", actorId: id });
    await expectError(await call("/submit", token), 409, "already_submitted");
  });

  it("passes the document's required sides and, since M5, the face check's frames to the database", async () => {
    const { call, ready, complete, repo, passLiveness } = setup();
    const { token } = await ready({ declaredDocument: "passport" });
    await complete(token, "document_front");
    await passLiveness(token);
    const spy = vi.spyOn(repo, "submit");
    expect((await call("/submit", token)).status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.any(String), [...REQUIRED_SIDES.passport, "liveness_frame"]);
  });

  it("maps a concurrent submit reported by the database to 409 already_submitted", async () => {
    const { call, ready, repo, passLiveness } = setup();
    const { token } = await ready();
    await passLiveness(token);
    repo.submitOverride = "already_submitted";
    await expectError(await call("/submit", token), 409, "already_submitted");
  });
});

// ---------------------------------------------------------------------------
// POST /mrz
// ---------------------------------------------------------------------------
// ICAO Doc 9303 specimens (fictitious state "UTO"): every check digit right, real dates.
const TD1 = [
  "I<UTOD231458907<<<<<<<<<<<<<<<",
  "7408122F1204159UTO<<<<<<<<<<<6",
  "ERIKSSON<<ANNA<MARIA<<<<<<<<<<",
];
const TD3 = [
  "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
  "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
];
const ENGINE = "tesseract.js-7.0.0/mrz-1";
/** Values read from the specimens: none of them may reach a log, an audit entry or check_result. */
const READ_VALUES = ["ERIKSSON", "ANNA", "MARIA", "D23145890", "L898902C3", "ZE184226B", "740812", "120415", "UTO", "<<"];

/** Overwrites line `line` from `index` with `text`. */
function edit(lines: readonly string[], line: number, index: number, text: string): string[] {
  return lines.map((l, i) => (i === line ? l.slice(0, index) + text + l.slice(index + text.length) : l));
}

/** The TD1 specimen with another birth date, its check digit and the composite check digit made right. */
function td1WithBirthDate(birth: string): string[] {
  const lines = edit(TD1, 1, 0, birth + checkDigit(birth));
  const composite = checkDigit(lines[0].slice(5, 30) + lines[1].slice(0, 7) + lines[1].slice(8, 15) + lines[1].slice(18, 29));
  return edit(lines, 1, 29, String(composite));
}

/** The TD3 specimen with another birth date, its check digit and the composite check digit made right. */
function td3WithBirthDate(birth: string): string[] {
  const lines = edit(TD3, 1, 13, birth + checkDigit(birth));
  const composite = checkDigit(lines[1].slice(0, 10) + lines[1].slice(13, 20) + lines[1].slice(21, 43));
  return edit(lines, 1, 43, String(composite));
}

function readReport(captureId: string, lines: readonly string[], overrides: Record<string, unknown> = {}) {
  return { captureId, result: "read", lines, attempts: 1, corrections: 2, engine: ENGINE, ms: 850, ...overrides };
}

function unreadableReport(captureId: string, overrides: Record<string, unknown> = {}) {
  return { captureId, result: "unreadable", reason: "not_found", attempts: 3, engine: ENGINE, ...overrides };
}

describe("POST /mrz", () => {
  /** A session for `document` with every side photographed; returns the capture id of each side. */
  async function photographed(h: ReturnType<typeof setup>, declaredDocument: VerificationRecord["declaredDocument"]) {
    const session = await h.ready({ declaredDocument });
    const ids: Partial<Record<CaptureSide, string>> = {};
    for (const kind of REQUIRED_SIDES[declaredDocument!]) {
      const res = await h.complete(session.token, kind, buildJpeg({ width: 1600, height: 1009, padTo: 30_000 + h.repo.captures.length }));
      expect(res.status).toBe(200);
      ids[kind] = (await readJson(res)).captureId as string;
    }
    return { ...session, front: ids.document_front!, back: ids.document_back };
  }

  it("records a valid new-CNI read from the back as pass, with the details and an audit entry", async () => {
    const h = setup();
    const { id, token, back } = await photographed(h, "cni_biometric");
    const res = await h.call("/mrz", token, { body: readReport(back!, TD1) });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ recorded: true });
    expect(h.repo.mrzRecords).toHaveLength(1);
    const record = h.repo.mrzRecords[0];
    expect(record).toStrictEqual({
      verificationId: id,
      captureId: back,
      lines: TD1.join("\n"),
      format: "TD1",
      outcome: "pass",
      details: {
        source: "mrz_phone",
        parserVersion: MRZ_PARSER_VERSION,
        captureId: back!,
        result: "read",
        reason: null,
        expectedFormat: "TD1",
        format: "TD1",
        // TD1 has no personal number check digit: the key is absent, not false.
        checks: { documentNumber: true, birthDate: true, expiryDate: true, composite: true },
        documentCodeFits: true,
        datesValid: true,
        attempts: 1,
        corrections: 2,
        engine: ENGINE,
        ms: 850,
      } satisfies MrzCheckDetails,
    });
    expect(h.repo.audits.at(-1)).toEqual({
      actorType: "rider",
      actorId: id,
      action: "mrz.record",
      targetType: "verification",
      targetId: id,
      details: { captureId: back, outcome: "pass", result: "read" },
    });
  });

  it("records a valid passport read from the data page as pass, with the personal number check", async () => {
    const h = setup();
    const { token, front } = await photographed(h, "passport");
    expect((await h.call("/mrz", token, { body: readReport(front, TD3) })).status).toBe(200);
    expect(h.repo.mrzRecords[0]).toMatchObject({
      lines: TD3.join("\n"),
      format: "TD3",
      outcome: "pass",
      details: {
        expectedFormat: "TD3",
        format: "TD3",
        checks: { documentNumber: true, birthDate: true, expiryDate: true, personalNumber: true, composite: true },
        documentCodeFits: true,
        datesValid: true,
      },
    });
  });

  it("accepts the optional MRZ of a residence permit", async () => {
    const h = setup();
    const { token, back } = await photographed(h, "residence_permit");
    expect((await h.call("/mrz", token, { body: readReport(back!, TD1) })).status).toBe(200);
    expect(h.repo.mrzRecords[0]).toMatchObject({ format: "TD1", outcome: "pass" });
  });

  it.each([
    ["a wrong document number check digit", "cni_biometric", edit(TD1, 0, 14, "8"), {
      documentNumber: false,
      birthDate: true,
      expiryDate: true,
      composite: false,
    }, true, true],
    ["a wrong composite check digit only", "passport", edit(TD3, 1, 43, "1"), {
      documentNumber: true,
      birthDate: true,
      expiryDate: true,
      personalNumber: true,
      composite: false,
    }, true, true],
    ["a wrong birth date check digit", "cni_biometric", edit(TD1, 1, 6, "3"), {
      documentNumber: true,
      birthDate: false,
      expiryDate: true,
      composite: false,
    }, true, true],
    ["an impossible birth date with right check digits", "cni_biometric", td1WithBirthDate("741312"), {
      documentNumber: true,
      birthDate: true,
      expiryDate: true,
      composite: true,
    }, true, false],
    ["a passport document code on a CNI", "cni_biometric", edit(TD1, 0, 0, "P<"), {
      documentNumber: true,
      birthDate: true,
      expiryDate: true,
      composite: true,
    }, false, true],
    ["a card document code on a passport", "passport", edit(TD3, 0, 0, "I<"), {
      documentNumber: true,
      birthDate: true,
      expiryDate: true,
      personalNumber: true,
      composite: true,
    }, false, true],
  ] as const)("flags %s", async (_label, document, lines, checks, codeFits, datesValid) => {
    const h = setup();
    const session = await photographed(h, document);
    const captureId = document === "passport" ? session.front : session.back!;
    expect((await h.call("/mrz", session.token, { body: readReport(captureId, lines) })).status).toBe(200);
    const record = h.repo.mrzRecords[0];
    expect(record.outcome).toBe("flag");
    expect(record.lines).toBe(lines.join("\n"));
    expect(record.details.checks).toStrictEqual(checks);
    expect(record.details.documentCodeFits).toBe(codeFits);
    expect(record.details.datesValid).toBe(datesValid);
  });

  it("accepts the other TD1 document codes (ID, A, C)", async () => {
    for (const code of ["ID", "AC", "C<"]) {
      const h = setup();
      const { token, back } = await photographed(h, "cni_biometric");
      expect((await h.call("/mrz", token, { body: readReport(back!, edit(TD1, 0, 0, code)) })).status).toBe(200);
      expect(h.repo.mrzRecords[0].outcome, code).toBe("pass");
    }
  });

  it("never takes the phone's word: a verdict sent along with wrong lines is ignored", async () => {
    const h = setup();
    const { token, back } = await photographed(h, "cni_biometric");
    const body = readReport(back!, edit(TD1, 0, 14, "8"), {
      valid: true,
      outcome: "pass",
      checks: { documentNumber: true, birthDate: true, expiryDate: true, composite: true },
      parserVersion: "phone",
    });
    expect((await h.call("/mrz", token, { body })).status).toBe(200);
    const record = h.repo.mrzRecords[0];
    expect(record.outcome).toBe("flag");
    expect(record.details.checks?.documentNumber).toBe(false);
    expect(record.details.parserVersion).toBe(MRZ_PARSER_VERSION);
    expect(record.details).not.toHaveProperty("valid");
    expect(record.details).not.toHaveProperty("outcome");
  });

  it.each(["not_found", "reader_unavailable"] as const)("records an unreadable MRZ (%s) as flag, without lines", async (reason) => {
    const h = setup();
    const { id, token, back } = await photographed(h, "cni_biometric");
    // Lines sent with an unreadable report are not kept.
    const res = await h.call("/mrz", token, { body: unreadableReport(back!, { reason, lines: TD1 }) });
    expect(res.status).toBe(200);
    expect(h.repo.mrzRecords).toStrictEqual([{
      verificationId: id,
      captureId: back,
      lines: null,
      format: null,
      outcome: "flag",
      details: {
        source: "mrz_phone",
        parserVersion: MRZ_PARSER_VERSION,
        captureId: back!,
        result: "unreadable",
        reason,
        expectedFormat: "TD1",
        format: null,
        checks: null,
        documentCodeFits: null,
        datesValid: null,
        attempts: 3,
        corrections: null,
        engine: ENGINE,
        ms: null,
      } satisfies MrzCheckDetails,
    }]);
    expect(h.repo.audits.at(-1)?.details).toEqual({ captureId: back, outcome: "flag", result: "unreadable" });
  });

  it("is idempotent: a retried report answers 200 and records nothing new", async () => {
    const h = setup();
    const { token, back } = await photographed(h, "cni_biometric");
    expect((await h.call("/mrz", token, { body: readReport(back!, TD1) })).status).toBe(200);
    const again = await h.call("/mrz", token, { body: readReport(back!, edit(TD1, 0, 14, "8"), { attempts: 2 }) });
    expect(again.status).toBe(200);
    expect(await readJson(again)).toEqual({ recorded: true });
    expect(h.repo.mrzRecords).toHaveLength(1);
    expect(h.repo.mrzRecords[0].outcome).toBe("pass");
    expect(h.repo.audits.filter((a) => a.action === "mrz.record")).toHaveLength(1);
  });

  it("records a retaken photo separately", async () => {
    const h = setup();
    const { token, back } = await photographed(h, "cni_biometric");
    expect((await h.call("/mrz", token, { body: unreadableReport(back!) })).status).toBe(200);
    const retake = await readJson(await h.complete(token, "document_back", buildJpeg({ width: 1600, height: 1009, padTo: 50_000 })));
    const res = await h.call("/mrz", token, { body: readReport(retake.captureId as string, TD1, { attempts: 2 }) });
    expect(res.status).toBe(200);
    expect(h.repo.mrzRecords.map((r) => [r.captureId, r.outcome])).toEqual([[back, "flag"], [retake.captureId, "pass"]]);
  });

  it("accepts an upper-case capture id and stores it in lower case", async () => {
    const h = setup();
    const { token, back } = await photographed(h, "cni_biometric");
    expect((await h.call("/mrz", token, { body: readReport(back!.toUpperCase(), TD1) })).status).toBe(200);
    expect(h.repo.mrzRecords[0].captureId).toBe(back);
    expect(h.repo.mrzRecords[0].details.captureId).toBe(back);
  });

  it("accepts every limit exactly", async () => {
    const h = setup();
    const { token, back } = await photographed(h, "cni_biometric");
    const { maxAttempts, maxCorrections, maxMs, maxEngineLength } = MRZ_REPORT_LIMITS;
    const body = readReport(back!, TD1, {
      attempts: maxAttempts,
      corrections: maxCorrections,
      ms: maxMs,
      engine: "a/B.c_d-".repeat(5).slice(0, maxEngineLength),
    });
    expect((await h.call("/mrz", token, { body })).status).toBe(200);
    expect(h.repo.mrzRecords[0].details).toMatchObject({ attempts: 20, corrections: 90, ms: 600_000 });
    const zero = await photographed(h, "passport");
    expect((await h.call("/mrz", zero.token, { body: readReport(zero.front, TD3, { corrections: 0, ms: 0 }) })).status)
      .toBe(200);
  });

  it("judges the dates with the function's clock", async () => {
    const h = setup();
    const { token, front } = await photographed(h, "passport");
    // The session is still open on that day (it expires 30 minutes after NOW).
    h.setClock(new Date("1999-06-01T00:00:00Z"));
    expect((await h.call("/mrz", token, { body: readReport(front, td3WithBirthDate("000229")) })).status).toBe(200);
    expect(h.repo.mrzRecords[0]).toMatchObject({ outcome: "flag", details: { datesValid: false } });
  });

  it("requires a declared document -> 409 document_type_required", async () => {
    const { call, seed } = setup();
    const { token } = await seed({ status: "in_progress" }, { consent: true });
    await expectError(await call("/mrz", token, { body: readReport(crypto.randomUUID(), TD1) }), 409, "document_type_required");
  });

  it.each(["cni_legacy", "driving_licence", "voter_card"] as const)(
    "%s has no code lines -> 422 invalid_mrz",
    async (document) => {
      const h = setup();
      const { token, back } = await photographed(h, document);
      await expectError(await h.call("/mrz", token, { body: readReport(back!, TD1) }), 422, "invalid_mrz");
      await expectError(await h.call("/mrz", token, { body: unreadableReport(back!) }), 422, "invalid_mrz");
      expect(h.repo.mrzRecords).toHaveLength(0);
    },
  );

  it("refuses an expired session (410) and a submitted one (409)", async () => {
    const h = setup();
    const { id, token, back } = await photographed(h, "cni_biometric");
    h.repo.verifications.get(id)!.status = "submitted";
    await expectError(await h.call("/mrz", token, { body: readReport(back!, TD1) }), 409, "already_submitted");
    h.setClock(new Date(IN_30_MIN));
    await expectError(await h.call("/mrz", token, { body: readReport(back!, TD1) }), 410, "session_expired");
    expect(h.repo.mrzRecords).toHaveLength(0);
  });

  it("validates every field -> 400 bad_request, before the capture is looked up", async () => {
    const h = setup();
    const { token, back } = await photographed(h, "cni_biometric");
    const lookup = vi.spyOn(h.repo, "findActiveCapture");
    const read = readReport(back!, TD1);
    const unreadable = unreadableReport(back!);
    const without = (body: Record<string, unknown>, key: string) => {
      const copy = { ...body };
      delete copy[key];
      return copy;
    };
    const cases: unknown[] = [
      {},
      without(read, "captureId"),
      { ...read, captureId: "not-a-uuid" },
      { ...read, captureId: 42 },
      { ...read, captureId: `${back} ` },
      without(read, "result"),
      { ...read, result: "valid" },
      without(read, "attempts"),
      { ...read, attempts: 0 },
      { ...read, attempts: MRZ_REPORT_LIMITS.maxAttempts + 1 },
      { ...read, attempts: 1.5 },
      { ...read, attempts: "1" },
      without(read, "engine"),
      { ...read, engine: "" },
      { ...read, engine: "x".repeat(MRZ_REPORT_LIMITS.maxEngineLength + 1) },
      { ...read, engine: "tesseract js" },
      { ...read, engine: "<script>" },
      { ...read, engine: 7 },
      without(read, "corrections"),
      { ...read, corrections: -1 },
      { ...read, corrections: MRZ_REPORT_LIMITS.maxCorrections + 1 },
      { ...read, corrections: 0.5 },
      without(read, "ms"),
      { ...read, ms: -1 },
      { ...read, ms: MRZ_REPORT_LIMITS.maxMs + 1 },
      { ...read, ms: 12.5 },
      { ...read, ms: null },
      without(read, "lines"),
      { ...read, lines: TD1.join("\n") },
      { ...read, lines: [TD1[0], null, TD1[2]] },
      { ...read, lines: [1, 2, 3] },
      { ...read, lines: { 0: TD1[0], 1: TD1[1], 2: TD1[2], length: 3 } },
      without(unreadable, "reason"),
      { ...unreadable, reason: "blurry" },
      { ...unreadable, reason: null },
      // Malformed and of the wrong shape: the malformed field is reported first.
      { ...read, lines: TD3, corrections: -1 },
    ];
    for (const body of cases) {
      const res = await h.call("/mrz", token, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await readJson(res)).error).toMatchObject({ code: "bad_request" });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(h.repo.mrzRecords).toHaveLength(0);
  });

  it("refuses lines that are not an MRZ of the expected format -> 422 invalid_mrz", async () => {
    const h = setup();
    const cni = await photographed(h, "cni_biometric");
    const shapes: string[][] = [
      TD3,
      TD1.slice(0, 2),
      [...TD1, TD1[2]],
      [],
      [TD1[0].toLowerCase(), TD1[1], TD1[2]],
      [TD1[0].slice(1), TD1[1], TD1[2]],
      [TD1[0] + "<", TD1[1], TD1[2]],
      [TD1[0], TD1[1], TD1[2].replace("ANNA<", "ANNA ")],
      [TD1[0], TD1[1], `${TD1[2].slice(1)}\n`],
      [TD1[0].replace("I", "\uff29"), TD1[1], TD1[2]],
    ];
    for (const lines of shapes) {
      const res = await h.call("/mrz", cni.token, { body: readReport(cni.back!, lines) });
      expect(res.status, JSON.stringify(lines)).toBe(422);
      const body = await readJson(res) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_mrz");
      for (const line of lines) if (line) expect(body.error.message).not.toContain(line);
    }
    const passport = await photographed(h, "passport");
    await expectError(await h.call("/mrz", passport.token, { body: readReport(passport.front, TD1) }), 422, "invalid_mrz");
    expect(h.repo.mrzRecords).toHaveLength(0);
  });

  it("refuses a photo of the side without code lines -> 422 invalid_mrz", async () => {
    const h = setup();
    const { token, front } = await photographed(h, "cni_biometric");
    await expectError(await h.call("/mrz", token, { body: readReport(front, TD1) }), 422, "invalid_mrz");
    await expectError(await h.call("/mrz", token, { body: unreadableReport(front) }), 422, "invalid_mrz");
    expect(h.repo.mrzRecords).toHaveLength(0);
  });

  it("unknown, erased or another session's capture -> 404 not_found", async () => {
    const h = setup();
    const mine = await photographed(h, "cni_biometric");
    const other = await photographed(h, "cni_biometric");
    await expectError(await h.call("/mrz", mine.token, { body: readReport(crypto.randomUUID(), TD1) }), 404, "not_found");
    await expectError(await h.call("/mrz", mine.token, { body: readReport(other.back!, TD1) }), 404, "not_found");
    h.repo.captures.find((c) => c.id === mine.back)!.deletedAt = NOW.toISOString();
    await expectError(await h.call("/mrz", mine.token, { body: readReport(mine.back!, TD1) }), 404, "not_found");
    expect(h.repo.mrzRecords).toHaveLength(0);
  });

  it("a capture erased before the write -> 404 not_found", async () => {
    const h = setup();
    const { token, back } = await photographed(h, "cni_biometric");
    h.repo.recordMrzOverride = "not_found";
    await expectError(await h.call("/mrz", token, { body: readReport(back!, TD1) }), 404, "not_found");
  });

  it("keeps everything read from the document out of check details and the audit log", async () => {
    const h = setup();
    const cni = await photographed(h, "cni_biometric");
    const passport = await photographed(h, "passport");
    await h.call("/mrz", cni.token, { body: readReport(cni.back!, TD1) });
    await h.call("/mrz", passport.token, { body: readReport(passport.front, edit(TD3, 1, 43, "1")) });
    expect(h.repo.mrzRecords).toHaveLength(2);
    const stored = JSON.stringify([h.repo.mrzRecords.map((r) => r.details), h.repo.audits]);
    for (const value of READ_VALUES) expect(stored).not.toContain(value);
  });

  it("never logs the lines when the database fails -> 500 server_error", async () => {
    const h = setup();
    const { token, back } = await photographed(h, "cni_biometric");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const quiet = createFlowHandler({ repo: h.repo, storage: h.storage, allowedOrigins: new Set([ALLOWED_ORIGIN]), now: () => NOW });
    h.repo.failOn = "recordMrz";
    const res = await quiet(makeRequest("https://ref.supabase.co/flow/mrz", {
      headers: { "x-session-token": token },
      body: readReport(back!, TD1),
    }));
    await expectError(res, 500, "server_error");
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.flat().join(" ");
    for (const value of [...READ_VALUES, ...TD1]) expect(logged).not.toContain(value);
    expect(logged).not.toContain("relation failed");
  });
});

describe("assessMrzReport", () => {
  const captureId = "11111111-1111-4111-8111-111111111111";
  const base = { captureId, result: "read", attempts: 1, corrections: 0, engine: ENGINE, ms: 1 } as const;
  const passport = { side: "document_front", format: "TD3", required: true } as const;

  it("reads the dates relative to `today`: 29 Feb 00 is real in 2000, not in 1900", () => {
    const lines = td3WithBirthDate("000229");
    expect(assessMrzReport({ ...base, lines }, passport, NOW)).toMatchObject({ outcome: "pass", details: { datesValid: true } });
    // Before that day, the birth date can only be 1900, which had no 29 February.
    expect(assessMrzReport({ ...base, lines }, passport, new Date("1999-06-01T00:00:00Z")))
      .toMatchObject({ outcome: "flag", details: { datesValid: false, checks: { birthDate: true, composite: true } } });
  });

  it("flags lines whose format is not the expected one", () => {
    const cni = { side: "document_back", format: "TD1", required: true } as const;
    const result = assessMrzReport({ ...base, lines: TD3 }, cni, NOW);
    expect(result.outcome).toBe("flag");
    expect(result.details).toMatchObject({ expectedFormat: "TD1", format: "TD3", documentCodeFits: false });
  });
});

// ---------------------------------------------------------------------------
// M3: a newer photo of a side replaces the older one
// ---------------------------------------------------------------------------
describe("replaced photos (M3)", () => {
  const SECOND = buildJpeg({ width: 1600, height: 1009, padTo: 61_000 });

  it("erases the replaced photo from storage and counts it in the audit entry", async () => {
    const { complete, ready, repo, storage } = setup();
    const { token } = await ready();
    const first = await readJson(await complete(token, "document_front"));
    const firstPath = repo.captures[0].storagePath;
    expect(storage.objects.has(firstPath)).toBe(true);
    const second = await readJson(await complete(token, "document_front", SECOND));

    expect(repo.captures.find((c) => c.id === first.captureId)).toMatchObject({
      deletedAt: expect.any(String),
      supersededBy: second.captureId,
    });
    expect(repo.erasedData).toEqual([first.captureId]);
    expect(storage.removed).toEqual([firstPath]);
    expect(storage.objects.has(firstPath)).toBe(false);
    expect(repo.audits.filter((a) => a.action === "capture.create").map((a) => a.details?.replaced)).toEqual([0, 1]);
  });

  it("leaves the other side alone", async () => {
    const { complete, ready, repo, storage } = setup();
    const { token } = await ready();
    await complete(token, "document_front");
    await complete(token, "document_back", SECOND);
    expect(repo.captures.every((c) => c.deletedAt === null)).toBe(true);
    expect(storage.removed).toEqual([]);
  });

  it("still records the photo when the old object cannot be removed, and logs it", async () => {
    const { complete, ready, storage, log } = setup();
    const { token } = await ready();
    await complete(token, "document_front");
    storage.failRemove = true;
    expect((await complete(token, "document_front", SECOND)).status).toBe(200);
    expect(log.error).toHaveBeenCalledWith("flow.superseded_remove_failed", expect.any(Error));
  });

  it("decides the case's server checks again after a replacement, and only then", async () => {
    const { complete, ready, cases } = setup();
    const { id, token } = await ready();
    await complete(token, "document_front");
    await complete(token, "document_back", SECOND);
    expect(cases.writes).toEqual([]);
    await complete(token, "document_front", buildJpeg({ width: 1600, height: 1009, padTo: 62_000 }));
    // The fake snapshot has no photo with a result: the case-level checks are dropped (null).
    expect(cases.writes).toEqual([{ verificationId: id, checks: null }]);
  });

  it("logs a failed case refresh without failing the rider's request", async () => {
    const { complete, ready, cases, log } = setup();
    const { token } = await ready();
    await complete(token, "document_front");
    cases.fail = true;
    expect((await complete(token, "document_front", SECOND)).status).toBe(200);
    expect(log.error).toHaveBeenCalledWith("flow.case_refresh_failed", expect.any(Error));
  });

  it("finishes the follow-up on a retried request (the first may have stopped after the insert)", async () => {
    const { call, complete, ready, upload, repo, storage, ring } = setup();
    const { token } = await ready();
    await complete(token, "document_front");
    const firstPath = repo.captures[0].storagePath;
    storage.failRemove = true;
    const path = await upload(token, "document_front", SECOND);
    const body = { path, kind: "document_front", quality: QUALITY };
    expect((await call("/captures", token, { body })).status).toBe(200);
    expect(storage.objects.has(firstPath)).toBe(true);
    storage.failRemove = false;
    expect((await call("/captures", token, { body })).status).toBe(200);
    expect(storage.removed).toEqual([firstPath]);
    expect(ring.rings).toEqual(["capture", "capture", "capture"]);
    expect(repo.audits.filter((a) => a.action === "capture.create")).toHaveLength(2);
  });

  it("returns 500 when the follow-up cannot be read (the rider retries)", async () => {
    const { complete, ready, repo } = setup();
    const { token } = await ready();
    repo.failOn = "captureFollowUp";
    await expectError(await complete(token, "document_front"), 500, "server_error");
  });
});

// ---------------------------------------------------------------------------
// M3: ringing the AI worker
// ---------------------------------------------------------------------------
describe("ringing the worker (M3)", () => {
  it("rings after each accepted photo of a test session", async () => {
    const { complete, ready, ring } = setup();
    const { token } = await ready({ isTest: true });
    await complete(token, "document_front");
    await complete(token, "document_back", buildJpeg({ width: 1600, height: 1009, padTo: 61_000 }));
    expect(ring.rings).toEqual(["capture", "capture"]);
  });

  it("never rings for a refused photo", async () => {
    const { call, ready, upload, ring } = setup();
    const { token } = await ready();
    const path = await upload(token, "document_front", buildJpeg({ width: 700, height: 400, padTo: 20_000 }));
    await expectError(await call("/captures", token, { body: { path, kind: "document_front", quality: QUALITY } }), 422, "image_resolution_too_low");
    expect(ring.rings).toEqual([]);
  });

  it("does not ring for a real session while the switch is off; the photo is unchecked at once", async () => {
    const { call, complete, ready, ring, repo } = setup();
    const { token } = await ready({ isTest: false, declaredDocument: "passport" });
    const res = await readJson(await complete(token, "document_front"));
    expect(ring.rings).toEqual([]);
    expect(repo.jobs.get(res.captureId as string)).toMatchObject({ status: "failed", errorCode: "ineligible" });
    const checks = await readJson(await call("/checks", token, { method: "GET" }));
    expect(checks).toEqual({ done: true, sides: [{ kind: "document_front", captureId: res.captureId, state: "unchecked", reason: null }], expired: false });
  });

  it("rings for a real session once the switch is on", async () => {
    const { complete, ready, ring, repo } = setup();
    repo.workerEnabled = true;
    const { token } = await ready({ isTest: false });
    await complete(token, "document_front");
    expect(ring.rings).toEqual(["capture"]);
  });

  it("rings a warm-up when a test session declares its document", async () => {
    const { call, seed, ring } = setup();
    const { token } = await seed({ status: "in_progress", isTest: true }, { consent: true });
    expect((await call("/document-type", token, { body: { declaredDocument: "passport" } })).status).toBe(200);
    expect(ring.rings).toEqual(["warm_up"]);
  });

  it("rings no warm-up for a real session while the switch is off, one when it is on", async () => {
    const { call, seed, ring, repo } = setup();
    const { token } = await seed({ status: "in_progress", isTest: false }, { consent: true });
    await call("/document-type", token, { body: { declaredDocument: "passport" } });
    expect(ring.rings).toEqual([]);
    repo.workerEnabled = true;
    await call("/document-type", token, { body: { declaredDocument: "passport" } });
    expect(ring.rings).toEqual(["warm_up"]);
  });

  it("marks the photo when the ring fails, so the rider is not kept waiting", async () => {
    const { call, complete, ready, ring, repo } = setup();
    const { token } = await ready({ declaredDocument: "passport" });
    ring.fail = true;
    const res = await readJson(await complete(token, "document_front"));
    await ring.settle();
    expect(repo.jobs.get(res.captureId as string)).toMatchObject({ status: "pending", ringFailed: true });
    const checks = await readJson(await call("/checks", token, { method: "GET" }));
    expect(checks).toMatchObject({ done: true, sides: [{ state: "unchecked" }] });
  });

  it("works without a ring configured", async () => {
    const { complete, ready } = setup({ ring: undefined, cases: undefined });
    const { token } = await ready();
    expect((await complete(token, "document_front")).status).toBe(200);
    expect((await complete(token, "document_front", buildJpeg({ width: 1600, height: 1009, padTo: 61_000 }))).status)
      .toBe(200);
  });
});

// ---------------------------------------------------------------------------
// M3: GET /checks
// ---------------------------------------------------------------------------
describe("GET /checks", () => {
  const get = (h: ReturnType<typeof setup>, token: string) => h.call("/checks", token, { method: "GET" });

  async function cni(h: ReturnType<typeof setup>, overrides: Partial<VerificationRecord> = {}) {
    const session = await h.ready({ declaredDocument: "cni_biometric", ...overrides });
    const front = (await readJson(await h.complete(session.token, "document_front"))).captureId as string;
    const back = (await readJson(await h.complete(session.token, "document_back", buildJpeg({ width: 1600, height: 1009, padTo: 61_000 }))))
      .captureId as string;
    return { ...session, front, back };
  }

  it("needs a session, a declared document and every required side", async () => {
    const h = setup();
    await expectError(await h.call("/checks", null, { method: "GET" }), 401, "invalid_session");
    const bare = await h.seed({ status: "in_progress" }, { consent: true });
    await expectError(await get(h, bare.token), 409, "document_type_required");
    const half = await h.ready({ declaredDocument: "cni_biometric" });
    await h.complete(half.token, "document_front");
    await expectError(await get(h, half.token), 409, "missing_sides");
    const closed = await h.ready({ status: "submitted" });
    await expectError(await get(h, closed.token), 409, "already_submitted");
  });

  it("reports each side pending until the server has checked it, then ok", async () => {
    const h = setup();
    const { token, front, back } = await cni(h);
    const pending = await get(h, token);
    expect(pending.status).toBe(200);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(pending)).toEqual({
      done: false,
      sides: [
        { kind: "document_front", captureId: front, state: "pending", reason: null },
        { kind: "document_back", captureId: back, state: "pending", reason: null },
      ],
      expired: false,
    });
    h.repo.finishJob(front, "ok");
    h.repo.jobs.get(back)!.status = "claimed";
    expect(await readJson(await get(h, token))).toMatchObject({ done: false, sides: [{ state: "ok" }, { state: "pending" }] });
    h.repo.finishJob(back, "poor");
    expect(await readJson(await get(h, token))).toMatchObject({ done: true, sides: [{ state: "ok" }, { state: "ok" }] });
  });

  it("M4: says the document expired once the side with the code lines is checked", async () => {
    const h = setup();
    const { id, token, front, back } = await cni(h);
    h.repo.flags.set(id, ["document_expired", "mrz_print_mismatch"]);
    expect(await readJson(await get(h, token))).toMatchObject({ done: false, expired: false });
    h.repo.finishJob(back, "ok");
    expect(await readJson(await get(h, token))).toMatchObject({ done: false, expired: true });
    h.repo.finishJob(front, "ok");
    expect(await readJson(await get(h, token))).toMatchObject({ done: true, expired: true });
    // Other flags never reach the rider.
    h.repo.flags.set(id, ["under_18", "mrz_print_mismatch", "date_logic"]);
    expect(await readJson(await get(h, token))).toEqual({
      done: true,
      sides: [
        { kind: "document_front", captureId: front, state: "ok", reason: null },
        { kind: "document_back", captureId: back, state: "ok", reason: null },
      ],
      expired: false,
    });
  });

  it("M4: never says expired for a document without code lines", async () => {
    const h = setup();
    const { id, token } = await h.ready({ declaredDocument: "cni_legacy" });
    const front = (await readJson(await h.complete(token, "document_front"))).captureId as string;
    const back = (await readJson(await h.complete(token, "document_back", buildJpeg({ width: 1600, height: 1009, padTo: 61_000 }))))
      .captureId as string;
    h.repo.finishJob(front, "ok");
    h.repo.finishJob(back, "ok");
    h.repo.flags.set(id, ["document_expired"]);
    expect(await readJson(await get(h, token))).toMatchObject({ done: true, expired: false });
  });

  it("asks for one retake of an unusable photo, then follows the new photo", async () => {
    const h = setup();
    const { token, front } = await cni(h);
    h.repo.finishJob(front, "no_document");
    expect(await readJson(await get(h, token))).toMatchObject({
      done: false,
      sides: [{ kind: "document_front", captureId: front, state: "retake", reason: "no_document" }, { state: "pending" }],
    });
    const retake = (await readJson(await h.complete(token, "document_front", buildJpeg({ width: 1600, height: 1009, padTo: 62_000 }))))
      .captureId as string;
    expect(await readJson(await get(h, token))).toMatchObject({ sides: [{ captureId: retake, state: "pending" }, {}] });
    h.repo.finishJob(retake, "unreadable");
    // One server retake per side: the second unusable photo is flagged for staff, never refused.
    expect(await readJson(await get(h, token))).toMatchObject({ sides: [{ captureId: retake, state: "ok", reason: null }, {}] });
  });

  it("never asks for a retake of a photo whose code lines the phone read right", async () => {
    const h = setup();
    const { token, back } = await cni(h);
    h.repo.mrzRecords.push({
      verificationId: "",
      captureId: back,
      lines: null,
      format: null,
      outcome: "pass",
      details: {} as MrzCheckDetails,
    });
    h.repo.finishJob(back, "unreadable");
    expect(await readJson(await get(h, token))).toMatchObject({ sides: [{}, { captureId: back, state: "ok" }] });
  });

  it.each(["budget", "ineligible", "attempts", "expired"])("reports a job given up (%s) as unchecked at once", async (code) => {
    const h = setup();
    const { token, front } = await cni(h);
    Object.assign(h.repo.jobs.get(front)!, { status: "failed", errorCode: code });
    expect(await readJson(await get(h, token))).toMatchObject({ done: false, sides: [{ state: "unchecked" }, { state: "pending" }] });
  });

  it("returns nothing read from the document", async () => {
    const h = setup();
    const { token, front, back } = await cni(h);
    h.repo.finishJob(front, "ok");
    h.repo.finishJob(back, "unreadable");
    const body = await readJson(await get(h, token));
    expect(Object.keys(body).sort()).toEqual(["done", "expired", "sides"]);
    for (const side of body.sides as Record<string, unknown>[]) {
      expect(Object.keys(side).sort()).toEqual(["captureId", "kind", "reason", "state"]);
    }
  });
});

// ---------------------------------------------------------------------------
// The face check (M5)
// ---------------------------------------------------------------------------
describe("POST /liveness/challenge", () => {
  it("issues 3 different actions and a 6-digit code, with a signed upload per frame slot in the session's folder", async () => {
    const { ready, challenge, repo, storage } = setup();
    const { id, token } = await ready();
    const c = await challenge(token);
    expect(c.actions).toHaveLength(LIVENESS_LIMITS.actionsPerChallenge);
    expect(new Set(c.actions).size).toBe(3);
    for (const action of c.actions) expect(LIVENESS_ACTIONS).toContain(action);
    expect(c.code).toMatch(/^[0-9]{6}$/);
    expect(c.bucket).toBe("id-captures");
    expect(c.uploads).toHaveLength(LIVENESS_LIMITS.maxFrames);
    c.uploads.forEach((u, i) => {
      expect(u.path).toBe(livenessFramePath(id, c.challengeId, i));
      expect(u.path).toMatch(new RegExp(`^${id}/liveness-${c.challengeId}-\\d{2}\\.jpg$`));
    });
    expect(storage.signed).toEqual(c.uploads.map((u) => u.path));
    expect(Date.parse(c.expiresAt) - NOW.getTime()).toBe(LIVENESS_LIMITS.challengeTtlSeconds * 1000);
    const stored = repo.challenges[0];
    expect(stored).toMatchObject({ id: c.challengeId, verificationId: id, actions: c.actions, code: c.code });
    const audit = repo.audits.find((a) => a.action === "liveness.challenge")!;
    expect(JSON.stringify(audit)).not.toContain(c.code);
  });

  it("draws with the injected randomness (a new challenge each time)", async () => {
    const values = [4, 0, 2, 9, 8, 7, 6, 5, 4];
    let n = 0;
    const { ready, challenge } = setup({ randomInt: (max) => values[n++ % values.length] % max });
    const { token } = await ready();
    const c = await challenge(token);
    // Pool [turn_left, turn_right, look_up, blink, smile]: picks 0+4, 1+0, 2+2 of the pool as it is shuffled.
    expect(c.actions).toEqual(["smile", "turn_right", "turn_left"]);
    expect(c.code).toBe("987654");
  });

  it("each new challenge replaces the unused one before it, up to the session's limit", async () => {
    const { ready, challenge, call, repo } = setup();
    const { token } = await ready();
    const first = await challenge(token);
    const second = await challenge(token);
    expect(second.challengeId).not.toBe(first.challengeId);
    expect(repo.challenges[0].supersededAt).not.toBeNull();
    for (let i = 2; i < LIVENESS_LIMITS.maxChallengesPerSession; i++) await challenge(token);
    await expectError(await call("/liveness/challenge", token, { body: {} }), 429, "too_many_challenges");
  });

  it("requires consent and a declared document", async () => {
    const { call, seed } = setup();
    const { token } = await seed();
    await expectError(await call("/liveness/challenge", token, { body: {} }), 403, "consent_required");
    const { token: other } = await seed({ status: "in_progress" }, { consent: true });
    await expectError(await call("/liveness/challenge", other, { body: {} }), 409, "document_type_required");
  });

  it("accepts an empty body, and refuses a submitted session", async () => {
    const { call, ready, repo } = setup();
    const { id, token } = await ready();
    expect((await call("/liveness/challenge", token)).status).toBe(200);
    repo.verifications.get(id)!.status = "submitted";
    await expectError(await call("/liveness/challenge", token, { body: {} }), 409, "already_submitted");
  });
});

describe("POST /liveness/captures", () => {
  it("M6/M7: rings the face worker when the recorded face check left a face job waiting", async () => {
    const { ready, passLiveness, repo, faceRing, ring } = setup();
    const { token } = await ready();
    repo.facePending = true;
    await passLiveness(token);
    expect(faceRing.rings).toEqual(["face_warm_up", "face_check"]);
    // The AI worker's doorbell is not the face worker's.
    expect(ring.rings).not.toContain("face_check");
  });

  it("M6/M7: no face ring when no face job may run (a real session while the face switch is off)", async () => {
    const { ready, passLiveness, repo, faceRing } = setup();
    const { token } = await ready({ isTest: false });
    repo.facePending = false;
    await passLiveness(token);
    expect(faceRing.rings).toEqual([]);
  });

  it("warms the face worker up when a face check starts, for the sessions it may process only", async () => {
    // Fixes after the PM's first real test: the models load while the rider follows the prompts.
    const test = setup();
    const t = await test.ready();
    expect((await test.call("/liveness/challenge", t.token)).status).toBe(200);
    expect(test.faceRing.rings).toEqual(["face_warm_up"]);
    const real = setup();
    const r = await real.ready({ isTest: false });
    expect((await real.call("/liveness/challenge", r.token)).status).toBe(200);
    expect(real.faceRing.rings).toEqual([]);
    real.repo.faceEnabled = true;
    expect((await real.call("/liveness/challenge", r.token)).status).toBe(200);
    expect(real.faceRing.rings).toEqual(["face_warm_up"]);
    vi.spyOn(real.repo, "faceEnabledForRealSessions").mockRejectedValue(new Error("db down"));
    expect((await real.call("/liveness/challenge", r.token)).status).toBe(200);
    expect(real.log.error).toHaveBeenCalledWith("flow.face_warm_up_check_failed", expect.any(Error));
  });

  it("M6/M7: a failed check for face jobs is logged, never the rider's problem", async () => {
    const { ready, passLiveness, repo, faceRing, log } = setup();
    const { token } = await ready();
    vi.spyOn(repo, "faceJobsPending").mockRejectedValue(new Error("db down"));
    await passLiveness(token);
    expect(faceRing.rings).toEqual(["face_warm_up"]);
    expect(log.error).toHaveBeenCalledWith("flow.face_ring_check_failed", expect.any(Error));
  });

  it("records the frames, their check and the challenge as used; the response says nothing more", async () => {
    const { ready, challenge, frames, call, repo } = setup();
    const { id, token } = await ready();
    const c = await challenge(token);
    const body = await frames(c);
    const res = await call("/liveness/captures", token, { body });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ recorded: true });

    const record = repo.livenessRecords[0];
    expect(record).toMatchObject({ verificationId: id, challengeId: c.challengeId, code: c.code, outcome: "pass", version: "liveness-capture-v1" });
    expect(record.frames).toHaveLength(13);
    expect(record.frames[3]).toEqual({ ...body.frames[3], byteSize: 30_003, width: 360, height: 480 });
    expect(record.details).toEqual({
      evaluated: false,
      challengeId: c.challengeId,
      actions: c.actions,
      code: c.code,
      frames: 13,
      framesPerStep: [1, 4, 4, 4],
      durationMs: 9_900,
      serverElapsedMs: 20_000,
      maxGapMs: 1_200,
      startedWithWarning: false,
      problems: [],
    });
    expect(repo.challenges[0].usedAt).not.toBeNull();
    expect(repo.captures.filter((x) => x.kind === ("liveness_frame" as CaptureSide))).toHaveLength(13);
  });

  it("flags implausible timings and reused frames, never refusing them", async () => {
    const { ready, challenge, frames, call, repo, setClock } = setup();
    const { token } = await ready();
    // The same frame file was sent in another verification.
    repo.captures.push({
      id: crypto.randomUUID(),
      verificationId: crypto.randomUUID(),
      kind: "document_front",
      storagePath: "other.jpg",
      sha256: await sha256Hex(frameJpeg(5)),
      byteSize: 1,
      width: 1,
      height: 1,
      quality: {},
      createdAt: NOW.toISOString(),
      deletedAt: null,
      supersededBy: null,
    });
    const body = await frames(await challenge(token));
    setClock(new Date(NOW.getTime() + 3_000)); // the frames claim 9.9 s, but only 3 s have passed
    expect((await call("/liveness/captures", token, { body })).status).toBe(200);
    expect(repo.livenessRecords[0].outcome).toBe("flag");
    expect(repo.livenessRecords[0].details.problems).toEqual(["longer_than_challenge", "frames_reused"]);
  });

  it("a newer face check replaces the older frames, whose files are removed", async () => {
    const { ready, challenge, frames, call, repo, storage } = setup();
    const { token } = await ready();
    const first = await frames(await challenge(token));
    expect((await call("/liveness/captures", token, { body: first })).status).toBe(200);
    const second = await frames(await challenge(token), 9, (i) => frameJpeg(100 + i));
    second.frames = second.frames.map((f, i) => ({ ...f, step: i === 0 ? 0 : Math.min(3, Math.ceil(i / 3)), atMs: 900 + i * 1_000 }));
    second.stepStartsMs = [0, 1_500, 4_500, 7_500];
    expect((await call("/liveness/captures", token, { body: second })).status).toBe(200);
    expect(storage.removed).toEqual(first.frames.map((f) => f.path).sort());
    expect(repo.captures.filter((x) => x.livenessChallengeId && !x.deletedAt)).toHaveLength(9);
    expect(repo.audits.at(-1)).toMatchObject({ action: "liveness.capture", details: { frames: 9, replaced: 13 } });
  });

  it("a retried request after a lost answer is answered again; other frames for a used challenge are refused", async () => {
    const { ready, challenge, frames, call, repo } = setup();
    const { token } = await ready();
    const c = await challenge(token);
    const body = await frames(c);
    expect((await call("/liveness/captures", token, { body })).status).toBe(200);
    expect((await call("/liveness/captures", token, { body })).status).toBe(200);
    expect(repo.livenessRecords).toHaveLength(1);
    await expectError(await call("/liveness/captures", token, { body: { ...body, frames: body.frames.slice(0, 12) } }), 409, "challenge_used");
    // The same answer when the race is lost inside the database.
    const next = await frames(await challenge(token));
    repo.recordLivenessOverride = { result: "used" };
    await expectError(await call("/liveness/captures", token, { body: next }), 409, "challenge_used");
  });

  it("refuses a replaced or expired challenge (410), a wrong code (422) and another session's challenge (404)", async () => {
    const { ready, challenge, frames, call, setClock } = setup();
    const { token } = await ready();
    const first = await challenge(token);
    const body = await frames(first);
    await challenge(token);
    await expectError(await call("/liveness/captures", token, { body }), 410, "challenge_expired");

    const { token: late } = await ready();
    const lateBody = await frames(await challenge(late));
    setClock(new Date(NOW.getTime() + (LIVENESS_LIMITS.challengeTtlSeconds + 1) * 1000));
    await expectError(await call("/liveness/captures", late, { body: lateBody }), 410, "challenge_expired");

    setClock(NOW);
    const { token: wrong } = await ready();
    const wrongBody = await frames(await challenge(wrong));
    const code = wrongBody.code === "000000" ? "111111" : "000000";
    await expectError(await call("/liveness/captures", wrong, { body: { ...wrongBody, code } }), 422, "invalid_liveness");

    const { token: stranger } = await ready();
    await expectError(await call("/liveness/captures", stranger, { body: wrongBody }), 400, "bad_request"); // not its folder
  });

  it("refuses another session's challenge even with paths in its own folder", async () => {
    const { ready, challenge, frames, call, repo } = setup();
    const { token } = await ready();
    const theirs = await frames(await challenge(token));
    const { id, token: mine } = await ready();
    const body = {
      ...theirs,
      frames: theirs.frames.map((f) => ({ ...f, path: livenessFramePath(id, theirs.challengeId, f.index) })),
    };
    await expectError(await call("/liveness/captures", mine, { body }), 404, "not_found");
    expect(repo.livenessRecords).toHaveLength(0);
  });

  it("refuses a malformed body (400) before anything is read", async () => {
    const { ready, challenge, frames, call, repo } = setup();
    const { token } = await ready();
    const body = await frames(await challenge(token));
    const bad: [string, unknown][] = [
      ["an unknown field", { ...body, face: "x" }],
      ["a bad challenge id", { ...body, challengeId: "nope" }],
      ["a 5-digit code", { ...body, code: "12345" }],
      ["7 frames", { ...body, frames: body.frames.slice(0, 7) }],
      ["frames out of index order", { ...body, frames: [body.frames[1], body.frames[0], ...body.frames.slice(2)] }],
      ["a frame with an unknown field", { ...body, frames: [{ ...body.frames[0], blob: "x" }, ...body.frames.slice(1)] }],
      ["an upper-case hash", { ...body, frames: [{ ...body.frames[0], sha256: body.frames[0].sha256.toUpperCase() }, ...body.frames.slice(1)] }],
      ["a step beyond the actions", { ...body, frames: [...body.frames.slice(0, 12), { ...body.frames[12], step: 4 }] }],
      ["a negative time", { ...body, frames: [{ ...body.frames[0], atMs: -1 }, ...body.frames.slice(1)] }],
      ["three step starts", { ...body, stepStartsMs: [0, 1500, 4500] }],
      ["step starts not from 0", { ...body, stepStartsMs: [5, 1500, 4500, 7500] }],
      ["a missing flag", { ...body, startedWithWarning: undefined }],
      ["another frame's path", { ...body, frames: [{ ...body.frames[0], path: body.frames[1].path }, ...body.frames.slice(1)] }],
      ["a document photo's path", { ...body, frames: [{ ...body.frames[0], path: "x/document_front-y.jpg" }, ...body.frames.slice(1)] }],
    ];
    for (const [label, payload] of bad) {
      await expectError(await call("/liveness/captures", token, { body: payload }), 400, "bad_request").catch((err) => {
        throw new Error(`${label}: ${err}`);
      });
    }
    expect(repo.livenessRecords).toHaveLength(0);
  });

  it("checks every file: missing (404), and refused files (422) are all erased", async () => {
    const cases: [string, (i: number) => Uint8Array<ArrayBuffer>, string][] = [
      ["a tiny file", (i) => (i === 4 ? buildJpeg({ width: 360, height: 480, padTo: 500 }) : frameJpeg(i)), "image_too_small"],
      ["a file too large", (i) => (i === 4 ? buildJpeg({ width: 360, height: 480, padTo: 100_001 }) : frameJpeg(i)), "image_too_large"],
      ["not a JPEG", (i) => (i === 4 ? new Uint8Array(30_000) : frameJpeg(i)), "invalid_image"],
      ["a frame too small", (i) => (i === 4 ? buildJpeg({ width: 120, height: 160, padTo: 30_000 }) : frameJpeg(i)), "image_resolution_too_low"],
      ["a frame too big", (i) => (i === 4 ? buildJpeg({ width: 1280, height: 960, padTo: 30_000 }) : frameJpeg(i)), "image_too_large"],
      ["too many bytes together", (i) => buildJpeg({ width: 360, height: 480, padTo: 50_000 + i }), "image_too_large"],
    ];
    for (const [label, image, code] of cases) {
      const { ready, challenge, frames, call, storage, repo } = setup();
      const { token } = await ready();
      const body = await frames(await challenge(token), 13, image);
      await expectError(await call("/liveness/captures", token, { body }), 422, code).catch((err) => {
        throw new Error(`${label}: ${err}`);
      });
      expect(storage.removed.sort(), label).toEqual(body.frames.map((f) => f.path).sort());
      expect(repo.livenessRecords, label).toHaveLength(0);
      expect(repo.challenges[0].usedAt, label).toBeNull();
    }

    const { ready, challenge, frames, call, storage } = setup();
    const { token } = await ready();
    const body = await frames(await challenge(token));
    // The phone's hash of a frame does not match the file: refused and erased.
    const tampered = { ...body, frames: [{ ...body.frames[0], sha256: "0".repeat(64) }, ...body.frames.slice(1)] };
    await expectError(await call("/liveness/captures", token, { body: tampered }), 422, "invalid_liveness");
    expect(storage.removed).toHaveLength(13);

    const { ready: ready2, challenge: challenge2, frames: frames2, call: call2, storage: storage2 } = setup();
    const { token: token2 } = await ready2();
    const missing = await frames2(await challenge2(token2));
    storage2.objects.delete(missing.frames[7].path);
    await expectError(await call2("/liveness/captures", token2, { body: missing }), 404, "upload_missing");
    expect(storage2.removed).toEqual([]);
  });

  it("never logs the code, and an internal error is a plain 500", async () => {
    const { ready, challenge, frames, call, repo, log } = setup();
    const { token } = await ready();
    const body = await frames(await challenge(token));
    repo.failOn = "recordLiveness";
    await expectError(await call("/liveness/captures", token, { body }), 500, "server_error");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(body.code);
  });
});

describe("GET /result (automatic approval)", () => {
  const get = (h: ReturnType<typeof setup>, token: string | null) => h.call("/result", token, { method: "GET" });

  it("needs a session that was submitted", async () => {
    const h = setup();
    await expectError(await get(h, null), 401, "invalid_session");
    const open = await h.ready();
    await expectError(await get(h, open.token), 409, "not_submitted");
    const created = await h.seed();
    await expectError(await get(h, created.token), 409, "not_submitted");
  });

  it("answers after the submit, whatever the case's status, with no-store", async () => {
    const h = setup();
    const submitted = await h.ready({ status: "submitted" });
    const res = await get(h, submitted.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(res)).toEqual({ state: "review", returnUrl: null });
    const approved = await h.ready({ status: "approved" });
    expect(await readJson(await get(h, approved.token))).toEqual({ state: "verified", returnUrl: null });
  });

  it("passes on pending, verified with an https return address, and review", async () => {
    const h = setup();
    const { id, token } = await h.ready({ status: "submitted" });
    h.repo.results.set(id, { state: "pending", returnUrl: null });
    expect(await readJson(await get(h, token))).toEqual({ state: "pending", returnUrl: null });
    h.repo.results.set(id, { state: "verified", returnUrl: "https://ride.example/verified?ride=42" });
    expect(await readJson(await get(h, token))).toEqual({ state: "verified", returnUrl: "https://ride.example/verified?ride=42" });
    h.repo.results.set(id, { state: "verified", returnUrl: "http://ride.example/plain" });
    expect(await readJson(await get(h, token))).toEqual({ state: "verified", returnUrl: null });
  });

  it("never tells the rider more than the three states (a reject, a score, a reason)", async () => {
    const h = setup();
    const { id, token } = await h.ready({ status: "rejected" });
    h.repo.results.set(id, { state: "rejected", returnUrl: "https://ride.example/", reason: "DOC_INVALID", score: 1 });
    expect(await readJson(await get(h, token))).toEqual({ state: "review", returnUrl: null });
  });

  it("an expired link is still refused (410)", async () => {
    const h = setup();
    const { token } = await h.ready({ status: "approved" });
    h.setClock(new Date(IN_30_MIN));
    await expectError(await get(h, token), 410, "session_expired");
  });

  it("is a GET only, and fails closed when the database fails", async () => {
    const h = setup();
    const { token } = await h.ready({ status: "submitted" });
    expect((await h.call("/result", token, { method: "POST", body: {} })).status).toBe(405);
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.repo.failOn = "flowResult";
    await expectError(await get(h, token), 500, "server_error");
  });
});

describe("checkFrame", () => {
  it.each([
    [buildJpeg({ width: 360, height: 480, padTo: 30_000 }), { ok: true, width: 360, height: 480 }],
    [buildJpeg({ width: 640, height: 480, padTo: 2_000 }), { ok: true, width: 640, height: 480 }],
    [buildJpeg({ width: 180, height: 240, padTo: 30_000 }), { ok: true, width: 180, height: 240 }],
    [buildJpeg({ width: 170, height: 239, padTo: 30_000 }), { ok: false, code: "image_resolution_too_low" }],
    [buildJpeg({ width: 641, height: 480, padTo: 30_000 }), { ok: false, code: "image_too_large" }],
    [buildJpeg({ width: 360, height: 480, padTo: 1_999 }), { ok: false, code: "image_too_small" }],
    [buildJpeg({ width: 360, height: 480, padTo: 100_001 }), { ok: false, code: "image_too_large" }],
  ])("%#", (bytes, expected) => {
    expect(checkFrame(bytes)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// End to end through the handler
// ---------------------------------------------------------------------------
describe("rider flow", () => {
  it("goes from a new session to submitted", async () => {
    const { call, seed, upload, passLiveness } = setup();
    const { token } = await seed();
    expect((await call("/consent", token, { body: { consentVersion: CONSENT_VERSION, language: "fr" } })).status).toBe(200);
    expect((await call("/document-type", token, { body: { declaredDocument: "voter_card" } })).status).toBe(200);
    for (const kind of ["document_front", "document_back"] as const) {
      const path = await upload(token, kind, buildJpeg({ width: 1600, height: 1009, padTo: kind === "document_front" ? 40_000 : 41_000 }));
      expect((await call("/captures", token, { body: { path, kind, quality: QUALITY } })).status).toBe(200);
    }
    await passLiveness(token);
    const submitted: FlowSession = await (await call("/submit", token)).json();
    expect(submitted.status).toBe("submitted");
    const later: FlowSession = await (await call("/session", token)).json();
    expect(later).toMatchObject({ status: "submitted", declaredDocument: "voter_card", consentGiven: true });
  });

  it("accepts the path without the /flow prefix and refuses other origins", async () => {
    const { handler, seed } = setup();
    const { token } = await seed();
    const plain = await handler(makeRequest("https://ref.supabase.co/session", {
      method: "GET",
      headers: { "x-session-token": token },
    }));
    expect(plain.status).toBe(200);
    expect(plain.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    const evil = await handler(makeRequest("https://ref.supabase.co/flow/session", {
      method: "GET",
      origin: "https://evil.example",
      headers: { "x-session-token": token },
    }));
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers preflight requests for every route", async () => {
    const { handler } = setup();
    for (
      const path of [
        "/session",
        "/consent",
        "/document-type",
        "/upload-url",
        "/captures",
        "/mrz",
        "/checks",
        "/liveness/challenge",
        "/liveness/captures",
        "/submit",
      ]
    ) {
      const res = await handler(makeRequest(`https://ref.supabase.co/flow${path}`, { method: "OPTIONS" }));
      expect(res.status, path).toBe(204);
      expect(res.headers.get("access-control-allow-headers")).toContain("x-session-token");
    }
  });

  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    const { call, seed } = setup();
    const { token } = await seed();
    await expectError(await call("/admin", token), 404, "not_found");
    await expectError(await call("/session", token, { method: "POST" }), 405, "bad_request");
    await expectError(await call("/submit", token, { method: "GET" }), 405, "bad_request");
    await expectError(await call("/session", token, { method: "DELETE" }), 405, "bad_request");
  });
});
