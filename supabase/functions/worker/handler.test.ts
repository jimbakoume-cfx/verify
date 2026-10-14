// deno-lint-ignore-file require-await
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../_shared/audit.ts";
import {
  type CaptureSide,
  type DeclaredDocument,
  WORKER_HEADERS,
  WORKER_LIMITS,
  type WorkerResultRequest,
} from "../_shared/contract.ts";
import { checkDigit } from "../_shared/mrz.ts";
import { makeRequest, readJson } from "../_shared/test-helpers.ts";
import type { CaseChecksPayload, CaseSnapshot, JobStatus } from "./case.ts";
import type { CaptureEvidence } from "./decide.ts";
import {
  type ClaimedJob,
  createWorkerHandler,
  type ImageLookup,
  type ImageStorage,
  NONCE_MARGIN_S,
  type NonceResult,
  type RecordResult,
  type ResultRecord,
  type WorkerRepo,
} from "./handler.ts";
import { newKey, signedHeaders, type TestKey } from "./test-support.ts";

// ---------------------------------------------------------------------------
// In-memory fakes. They mirror the M3 migration: worker_use_nonce, worker_claim, worker_image_lookup,
// worker_case_snapshot and worker_record_result (first result wins, the fingerprint guards the
// case-level checks).
// ---------------------------------------------------------------------------
interface JobRow {
  id: string;
  captureId: string;
  verificationId: string;
  kind: CaptureSide;
  status: JobStatus;
  attempts: number;
  evidence: CaptureEvidence | null;
}

interface CaptureRow {
  id: string;
  verificationId: string;
  kind: CaptureSide;
  storagePath: string;
  live: boolean;
}

class MemoryWorkerRepo implements WorkerRepo {
  keys = new Map<string, { publicKey: string; revoked: boolean }>();
  nonces = new Map<string, string>();
  jobs: JobRow[] = [];
  captures: CaptureRow[] = [];
  declared = new Map<string, DeclaredDocument | null>();
  recorded: ResultRecord[] = [];
  caseChecks = new Map<string, CaseChecksPayload | null>();
  audits: AuditEntry[] = [];
  calls: string[] = [];
  /** Runs before a result is checked against the case, to simulate a concurrent write. */
  beforeRecord: (() => void) | null = null;
  /** Revokes the key between its lookup and the nonce (the race worker_use_nonce closes). */
  revokeBeforeNonce = false;
  failAudit = false;
  /** Makes recordResult throw an error carrying document data: the logs must not repeat it. */
  failRecord = false;

  async getKey(kid: string) {
    this.calls.push("getKey");
    return this.keys.get(kid) ?? null;
  }

  async useNonce(kid: string, nonce: string, expiresAt: string): Promise<NonceResult> {
    this.calls.push("useNonce");
    if (this.revokeBeforeNonce || this.keys.get(kid)?.revoked !== false) return "revoked";
    if (this.nonces.has(nonce)) return "replayed";
    this.nonces.set(nonce, expiresAt);
    return "ok";
  }

  async claim(): Promise<ClaimedJob | null> {
    this.calls.push("claim");
    const job = this.jobs.find((j) => j.status === "pending");
    if (!job) return null;
    job.status = "claimed";
    job.attempts++;
    return {
      jobId: job.id,
      attempt: job.attempts,
      captureId: job.captureId,
      kind: job.kind,
      declaredDocument: this.declared.get(job.verificationId)!,
      sha256: "a".repeat(64),
      byteSize: 120_000,
      width: 1600,
      height: 1009,
    };
  }

  async lookupImage(jobId: string, attempt: number): Promise<ImageLookup> {
    this.calls.push("lookupImage");
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return { result: "not_found" };
    const capture = this.capture(job.captureId);
    if (job.status === "superseded" || !capture.live) return { result: "gone" };
    if (job.status !== "claimed" || job.attempts !== attempt) return { result: "not_found" };
    return {
      result: "ok",
      captureId: capture.id,
      verificationId: capture.verificationId,
      storagePath: capture.storagePath,
      byteSize: 120_000,
    };
  }

  private capture(id: string): CaptureRow {
    return this.captures.find((c) => c.id === id)!;
  }

  /** private.worker_case_inputs: the declared document and the newest live photo of each side. */
  private inputs(verificationId: string) {
    const sides = (["document_front", "document_back"] as const).flatMap((kind) => {
      const capture = this.captures.filter((c) => c.verificationId === verificationId && c.kind === kind && c.live).at(-1);
      if (!capture) return [];
      const job = this.jobs.find((j) => j.captureId === capture.id && j.status === "done");
      return [{ kind, captureId: capture.id, evidence: job?.evidence ?? null }];
    });
    return { declaredDocument: this.declared.get(verificationId) ?? null, sides };
  }

  private fingerprint(verificationId: string): string {
    return JSON.stringify(this.inputs(verificationId));
  }

  async jobSnapshot(jobId: string): Promise<CaseSnapshot | null> {
    this.calls.push("jobSnapshot");
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    return {
      verificationId: job.verificationId,
      ...structuredClone(this.inputs(job.verificationId)),
      fingerprint: this.fingerprint(job.verificationId),
      job: {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        captureId: job.captureId,
        kind: job.kind,
        captureLive: this.capture(job.captureId).live,
      },
    };
  }

  async recordResult(record: ResultRecord): Promise<RecordResult> {
    this.calls.push("recordResult");
    if (this.failRecord) throw new Error(`insert failed: ${record.mrzLines} ${record.fields}`);
    const job = this.jobs.find((j) => j.id === record.jobId);
    if (!job || record.attempt < 1 || record.attempt > job.attempts) return "not_found";
    if (job.status === "done") return "already_done";
    if (job.status === "superseded" || !this.capture(job.captureId).live) return "gone";
    const hook = this.beforeRecord;
    this.beforeRecord = null;
    hook?.();
    if (this.fingerprint(job.verificationId) !== record.fingerprint) return "stale";
    job.status = "done";
    job.evidence = structuredClone(record.evidence);
    this.recorded.push(structuredClone(record));
    this.caseChecks.set(job.verificationId, structuredClone(record.caseChecks));
    this.audits.push({
      actorType: "system",
      actorId: record.kid,
      action: "worker.result",
      targetType: "verification",
      targetId: job.verificationId,
      details: { jobId: job.id, captureId: job.captureId, attempt: record.attempt },
    });
    return "recorded";
  }

  async audit(entry: AuditEntry) {
    this.calls.push(`audit:${entry.action}`);
    if (this.failAudit) throw new Error("audit store down");
    this.audits.push(entry);
  }

  /** A verification with one photo (and job) per side. */
  addCase(declared: DeclaredDocument, sides: readonly CaptureSide[], status: JobStatus = "pending") {
    const verificationId = crypto.randomUUID();
    this.declared.set(verificationId, declared);
    const ids: Partial<Record<CaptureSide, { jobId: string; captureId: string }>> = {};
    for (const kind of sides) {
      const captureId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      this.captures.push({ id: captureId, verificationId, kind, storagePath: `${verificationId}/${kind}-${captureId}.jpg`, live: true });
      this.jobs.push({ id: jobId, captureId, verificationId, kind, status, attempts: status === "claimed" ? 1 : 0, evidence: null });
      ids[kind] = { jobId, captureId };
    }
    return { verificationId, ...ids };
  }
}

class MemoryImages implements ImageStorage {
  objects = new Map<string, Uint8Array<ArrayBuffer>>();
  async download(path: string) {
    const bytes = this.objects.get(path);
    return bytes ? new Blob([bytes], { type: "application/octet-stream" }) : null;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const NOW = new Date("2026-10-14T09:00:00Z");
const NOW_S = NOW.getTime() / 1000;
const URL_BASE = "https://ref.supabase.co/functions/v1/worker";

async function setup({ logToConsole = false } = {}) {
  const repo = new MemoryWorkerRepo();
  const images = new MemoryImages();
  const log = { error: vi.fn() };
  const key = await newKey("worker-2026-10");
  repo.keys.set(key.kid, { publicKey: key.publicKey, revoked: false });
  const handler = createWorkerHandler({ repo, images, now: () => NOW, ...(logToConsole ? {} : { log }) });

  async function send(
    path: string,
    body: unknown,
    options: {
      signer?: TestKey;
      timestamp?: string;
      nonce?: string;
      signedPath?: string;
      signedMethod?: string;
      signedBody?: string;
      tamper?: (canonical: string) => string;
      headers?: Record<string, string>;
      url?: string;
    } = {},
  ) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const signed = await signedHeaders(options.signer ?? key, {
      method: options.signedMethod,
      path: options.signedPath ?? path,
      body: options.signedBody ?? raw,
      timestamp: options.timestamp ?? String(NOW_S),
      nonce: options.nonce,
      tamper: options.tamper,
    });
    return handler(makeRequest(options.url ?? `${URL_BASE}${path}`, {
      origin: null,
      rawBody: raw,
      headers: { "content-type": "application/json", apikey: "sb_publishable_x", ...signed, ...options.headers },
    }));
  }

  return { repo, images, log, key, handler, send };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await readJson(res)).toEqual({ error: { code, message: expect.any(String) } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Fictitious documents with correct check digits.
function td1Cmr(nationality = "CMR"): string[] {
  const cd = (field: string) => String(checkDigit(field));
  const l1 = "IDCMR" + "AB1234567" + cd("AB1234567") + "<".repeat(15);
  const head = "900101" + cd("900101") + "F" + "350101" + cd("350101") + nationality + "<".repeat(11);
  return [l1, head + cd(l1.slice(5, 30) + head.slice(0, 7) + head.slice(8, 15) + head.slice(18, 29)), "SPECIMEN<<TESTA" + "<".repeat(15)];
}

function result(jobId: string, overrides: Partial<WorkerResultRequest> = {}): WorkerResultRequest {
  return {
    jobId,
    attempt: 1,
    engine: "worker-1/rapidocr-3.10.0/ppocrv6",
    quality: { sharpness: 40, glareRatio: 0.001, meanLuma: 140, documentFound: true, documentConfidence: 0.9, longSide: 1600, textLines: 12 },
    mrzCandidates: [],
    classification: { rotation: 0, keywordHits: {}, qrPresent: false, orientation: "portrait" },
    fields: {},
    timing: { ms: 2500, cold: true },
    ...overrides,
  };
}

const VALUES = ["SPECIMEN", "TESTA", "AB1234567", "900101", "350101", "XXB", "Doe", "Jane", "refugee", "2025-03-01"];

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------
describe("signed requests", () => {
  it("accepts a correctly signed request and records its nonce until the window has passed", async () => {
    const h = await setup();
    const res = await h.send("/claim", {}, { nonce: "0123456789abcdef0123456789abcdef" });
    expect(res.status).toBe(204);
    expect(h.repo.nonces.get("0123456789abcdef0123456789abcdef"))
      .toBe(new Date((NOW_S + 60 + NONCE_MARGIN_S) * 1000).toISOString());
  });

  it("refuses a request without signature headers, before reading anything", async () => {
    const h = await setup();
    const res = await h.handler(makeRequest(`${URL_BASE}/claim`, { origin: null, body: {} }));
    await expectError(res, 401, "invalid_signature");
    expect(h.repo.calls).toEqual([]);
  });

  it.each([
    ["61 s old", String(NOW_S - 61)],
    ["61 s in the future", String(NOW_S + 61)],
    ["an hour old", String(NOW_S - 3600)],
    ["in milliseconds", String(NOW.getTime())],
  ])("refuses a timestamp %s", async (_label, timestamp) => {
    const h = await setup();
    await expectError(await h.send("/claim", {}, { timestamp }), 401, "invalid_signature");
    expect(h.repo.calls).toEqual([]);
  });

  it("accepts timestamps at both edges of the window", async () => {
    const h = await setup();
    expect((await h.send("/claim", {}, { timestamp: String(NOW_S - 60) })).status).toBe(204);
    expect((await h.send("/claim", {}, { timestamp: String(NOW_S + 60) })).status).toBe(204);
  });

  it("refuses an unknown key and a revoked one, without recording the nonce", async () => {
    const h = await setup();
    const stranger = await newKey("stranger");
    await expectError(await h.send("/claim", {}, { signer: stranger }), 401, "invalid_signature");
    h.repo.keys.get(h.key.kid)!.revoked = true;
    await expectError(await h.send("/claim", {}, {}), 401, "invalid_signature");
    expect(h.repo.nonces.size).toBe(0);
    expect(h.repo.calls).not.toContain("claim");
  });

  it("refuses a signature by another key under a known key id", async () => {
    const h = await setup();
    const impostor = await newKey(h.key.kid);
    await expectError(await h.send("/claim", {}, { signer: impostor }), 401, "invalid_signature");
    expect(h.repo.nonces.size).toBe(0);
  });

  it("refuses a small-order key stored by mistake (it would accept a forged all-zero signature)", async () => {
    const h = await setup();
    h.repo.keys.set("placeholder", { publicKey: "A".repeat(43), revoked: false });
    const res = await h.handler(makeRequest(`${URL_BASE}/claim`, {
      origin: null,
      rawBody: "{}",
      headers: {
        [WORKER_HEADERS.keyId]: "placeholder",
        [WORKER_HEADERS.timestamp]: String(NOW_S),
        [WORKER_HEADERS.nonce]: "f".repeat(32),
        [WORKER_HEADERS.signature]: "A".repeat(86),
      },
    }));
    await expectError(res, 401, "invalid_signature");
    expect(h.repo.calls).not.toContain("claim");
  });

  it.each([
    ["another audience", { tamper: (c: string) => c.replace("confiance-verify/worker", "confiance-verify/flow") }],
    ["another signature version", { tamper: (c: string) => c.replace(/^v1/, "v2") }],
    ["another path", { signedPath: "/result" }],
    ["another method", { signedMethod: "GET" }],
    ["another body", { signedBody: '{"jobId":"x"}' }],
    ["an empty body when {} is sent", { signedBody: "" }],
  ])("refuses a signature made for %s", async (_label, options) => {
    const h = await setup();
    await expectError(await h.send("/claim", {}, options), 401, "invalid_signature");
    expect(h.repo.calls).not.toContain("claim");
    expect(h.repo.nonces.size).toBe(0);
  });

  it("refuses a replayed request, even with a fresh timestamp it did not sign", async () => {
    const h = await setup();
    const nonce = "00112233445566778899aabbccddeeff";
    expect((await h.send("/claim", {}, { nonce })).status).toBe(204);
    await expectError(await h.send("/claim", {}, { nonce }), 401, "replayed_request");
    expect(h.repo.calls.filter((c) => c === "claim")).toHaveLength(1);
  });

  it("refuses a key revoked between its lookup and the nonce", async () => {
    const h = await setup();
    h.repo.revokeBeforeNonce = true;
    await expectError(await h.send("/claim", {}, {}), 401, "invalid_signature");
    expect(h.repo.calls).not.toContain("claim");
  });

  it("refuses a body over the limit, announced or not", async () => {
    const h = await setup();
    const big = JSON.stringify({ pad: "x".repeat(WORKER_LIMITS.maxBodyBytes) });
    // Announced: refused from Content-Length by the router.
    await expectError(await h.send("/result", big, { headers: { "content-length": String(big.length) } }), 413, "bad_request");
    // Streamed without a length: refused while reading, before any lookup.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const signed = await signedHeaders(h.key, { path: "/result", body: big, timestamp: String(NOW_S) });
    const res = await h.handler(new Request(`${URL_BASE}/result`, {
      method: "POST",
      body: stream,
      headers: signed,
      // @ts-ignore: duplex is required by fetch for a streamed body (not yet in every lib.dom).
      duplex: "half",
    }));
    await expectError(res, 413, "bad_request");
    expect(h.repo.calls).toEqual([]);
  });

  it("accepts a body exactly at the limit", async () => {
    const h = await setup();
    const { document_back: back } = h.repo.addCase("cni_biometric", ["document_back"], "claimed");
    const base = JSON.stringify(result(back!.jobId));
    const padded = base.slice(0, -1) + " ".repeat(WORKER_LIMITS.maxBodyBytes - base.length) + "}";
    expect(padded.length).toBe(WORKER_LIMITS.maxBodyBytes);
    expect((await h.send("/result", padded)).status).toBe(200);
  });

  it("refuses any request from a browser (an Origin header)", async () => {
    const h = await setup();
    const signed = await signedHeaders(h.key, { path: "/claim", body: "{}", timestamp: String(NOW_S) });
    const res = await h.handler(makeRequest(`${URL_BASE}/claim`, { origin: "https://confiance-verify.vercel.app", rawBody: "{}", headers: signed }));
    await expectError(res, 403, "forbidden");
    expect(h.repo.calls).toEqual([]);
  });

  it("signs the route as the function sees it, with or without the /functions/v1/worker prefix", async () => {
    const h = await setup();
    expect((await h.send("/claim", {}, { url: "https://ref.supabase.co/claim" })).status).toBe(204);
    expect((await h.send("/claim", {}, { url: "https://ref.supabase.co/worker/claim/" })).status).toBe(204);
    await expectError(await h.send("/claim", {}, { signedPath: "/worker/claim" }), 401, "invalid_signature");
  });

  it("routes only POST to the three routes", async () => {
    const h = await setup();
    await expectError(await h.handler(makeRequest(`${URL_BASE}/claim`, { origin: null, method: "GET" })), 405, "bad_request");
    await expectError(await h.handler(makeRequest(`${URL_BASE}/jobs`, { origin: null, body: {} })), 404, "not_found");
  });
});

// ---------------------------------------------------------------------------
// POST /claim
// ---------------------------------------------------------------------------
describe("POST /claim", () => {
  it("answers 204 with no body when there is no job", async () => {
    const h = await setup();
    const res = await h.send("/claim", {});
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("hands out the job with what the worker needs, and the MRZ expectation of the declared document", async () => {
    const h = await setup();
    const { document_back: back } = h.repo.addCase("cni_biometric", ["document_back"]);
    const res = await h.send("/claim", "");
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      jobId: back!.jobId,
      attempt: 1,
      captureId: back!.captureId,
      side: "document_back",
      declaredDocument: "cni_biometric",
      mrzExpectation: { side: "document_back", format: "TD1", required: true },
      image: { sha256: "a".repeat(64), byteSize: 120_000, width: 1600, height: 1009 },
    });
  });

  it("refuses a body with content -> 400", async () => {
    const h = await setup();
    await expectError(await h.send("/claim", { kind: "document_front" }), 400, "bad_request");
    await expectError(await h.send("/claim", "[]"), 400, "bad_request");
    await expectError(await h.send("/claim", "not json"), 400, "bad_request");
    expect(h.repo.calls).not.toContain("claim");
  });
});

// ---------------------------------------------------------------------------
// POST /image
// ---------------------------------------------------------------------------
describe("POST /image", () => {
  const BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

  async function claimed() {
    const h = await setup();
    const { verificationId, document_front: front } = h.repo.addCase("passport", ["document_front"], "claimed");
    const path = h.repo.captures[0].storagePath;
    h.images.objects.set(path, BYTES);
    return { h, verificationId, front: front! };
  }

  it("relays the photo's bytes as JPEG, never cached, after auditing the access", async () => {
    const { h, verificationId, front } = await claimed();
    const res = await h.send("/image", { jobId: front.jobId, attempt: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(h.repo.audits).toEqual([{
      actorType: "system",
      actorId: h.key.kid,
      action: "worker.image",
      targetType: "capture",
      targetId: front.captureId,
      details: { jobId: front.jobId, attempt: 1, verificationId, byteSize: BYTES.byteLength },
    }]);
  });

  it("refuses an attempt that does not hold the lease -> 404", async () => {
    const { h, front } = await claimed();
    await expectError(await h.send("/image", { jobId: front.jobId, attempt: 2 }), 404, "not_found");
    await expectError(await h.send("/image", { jobId: crypto.randomUUID(), attempt: 1 }), 404, "not_found");
    h.repo.jobs[0].status = "done";
    await expectError(await h.send("/image", { jobId: front.jobId, attempt: 1 }), 404, "not_found");
    expect(h.repo.audits).toEqual([]);
  });

  it("answers 410 image_gone for a replaced or erased photo, or a missing object", async () => {
    const { h, front } = await claimed();
    h.images.objects.clear();
    await expectError(await h.send("/image", { jobId: front.jobId, attempt: 1 }), 410, "image_gone");
    h.repo.captures[0].live = false;
    await expectError(await h.send("/image", { jobId: front.jobId, attempt: 1 }), 410, "image_gone");
    h.repo.captures[0].live = true;
    h.repo.jobs[0].status = "superseded";
    await expectError(await h.send("/image", { jobId: front.jobId, attempt: 1 }), 410, "image_gone");
    expect(h.repo.audits).toEqual([]);
  });

  it("sends no bytes when the access cannot be audited -> 500 audit_failed", async () => {
    const { h, front } = await claimed();
    h.repo.failAudit = true;
    const res = await h.send("/image", { jobId: front.jobId, attempt: 1 });
    await expectError(res, 500, "audit_failed");
    expect(h.log.error).toHaveBeenCalledWith("worker.image_audit_failed", expect.any(Error));
  });

  it("validates the body strictly -> 400", async () => {
    const { h, front } = await claimed();
    for (const body of [{}, { jobId: front.jobId }, { jobId: front.jobId, attempt: 1, path: "../x" }, { jobId: "x", attempt: 1 }]) {
      await expectError(await h.send("/image", body), 400, "bad_request");
    }
    expect(h.repo.calls).not.toContain("lookupImage");
  });
});

// ---------------------------------------------------------------------------
// POST /result
// ---------------------------------------------------------------------------
describe("POST /result", () => {
  it("records the decisions: per-photo checks, encrypted values, evidence, case checks", async () => {
    const h = await setup();
    const { document_back: back } = h.repo.addCase("cni_biometric", ["document_back"], "claimed");
    const res = await h.send("/result", result(back!.jobId, {
      mrzCandidates: td1Cmr(),
      fields: { issueDate: "2025-03-01" },
      classification: { rotation: 0, keywordHits: { national_id: 1 }, qrPresent: true, orientation: "landscape" },
    }));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ status: "recorded" });
    const record = h.repo.recorded[0];
    expect(record.kid).toBe(h.key.kid);
    expect(record.checks.map((c) => [c.name, c.outcome])).toEqual([
      ["quality_server", "pass"],
      ["mrz_server", "pass"],
      ["ocr_fields", "pass"],
    ]);
    expect(record.mrzLines).toBe(td1Cmr().join("\n"));
    expect(record.mrzFormat).toBe("TD1");
    expect(record.fields).toBe('{"issueDate":"2025-03-01"}');
    expect(record.evidence).toMatchObject({ mrz: { family: "cni_biometric", valid: true }, expectedMrzFound: true, qrPresent: true });
    expect(record.caseChecks).toMatchObject({
      version: "server-checks-v1",
      classification: { outcome: "pass", details: { detected: "cni_biometric", basis: "mrz", matchesDeclared: true } },
      reasons: [],
    });
  });

  it("decides the case from both sides: the second result sees the first one's evidence", async () => {
    const h = await setup();
    const c = h.repo.addCase("cni_biometric", ["document_front", "document_back"], "claimed");
    await h.send("/result", result(c.document_front!.jobId, { classification: { rotation: 90, keywordHits: { national_id: 2 }, qrPresent: false, orientation: "portrait" } }));
    expect(h.repo.caseChecks.get(c.verificationId)?.classification?.details).toMatchObject({ basis: "keywords", detected: "cni_biometric" });
    await h.send("/result", result(c.document_back!.jobId, { mrzCandidates: td1Cmr(), classification: { rotation: 0, keywordHits: {}, qrPresent: true, orientation: null } }));
    expect(h.repo.caseChecks.get(c.verificationId)).toMatchObject({
      classification: { details: { basis: "mrz", detected: "cni_biometric", keywordHits: { national_id: 2 }, qrPresent: true } },
      reasons: [],
    });
  });

  it("decides again when the other side's result lands first (stale), and gives up after a few rounds", async () => {
    const h = await setup();
    const c = h.repo.addCase("cni_biometric", ["document_front", "document_back"], "claimed");
    // The back's result is recorded between the front's snapshot and its write.
    h.repo.beforeRecord = () => {
      const back = h.repo.jobs.find((j) => j.id === c.document_back!.jobId)!;
      back.status = "done";
      back.evidence = { mrz: { family: "cni_biometric", valid: true }, expectedMrzFound: true, keywordHits: {}, qrPresent: true, orientation: null };
    };
    const res = await h.send("/result", result(c.document_front!.jobId));
    expect(await readJson(res)).toEqual({ status: "recorded" });
    expect(h.repo.calls.filter((call) => call === "jobSnapshot")).toHaveLength(2);
    expect(h.repo.caseChecks.get(c.verificationId)?.classification?.details).toMatchObject({ basis: "mrz" });

    const other = h.repo.addCase("passport", ["document_front"], "claimed");
    vi.spyOn(h.repo, "recordResult").mockResolvedValue("stale");
    await expectError(await h.send("/result", result(other.document_front!.jobId)), 500, "server_error");
    expect(h.log.error).toHaveBeenCalledWith("worker.result_stale");
  });

  it("lets the first result win: a later one gets already_done and changes nothing", async () => {
    const h = await setup();
    const { document_front: front } = h.repo.addCase("passport", ["document_front"], "claimed");
    expect(await readJson(await h.send("/result", result(front!.jobId)))).toEqual({ status: "recorded" });
    expect(await readJson(await h.send("/result", result(front!.jobId, { quality: { ...result("").quality, textLines: 0 } }))))
      .toEqual({ status: "already_done" });
    expect(h.repo.recorded).toHaveLength(1);
    // Decided in the database too (another instance's result committed between snapshot and write).
    const late = h.repo.addCase("passport", ["document_front"], "claimed");
    vi.spyOn(h.repo, "recordResult").mockResolvedValueOnce("already_done");
    expect(await readJson(await h.send("/result", result(late.document_front!.jobId)))).toEqual({ status: "already_done" });
  });

  it("accepts a late result from an earlier attempt, but not an attempt never handed out", async () => {
    const h = await setup();
    const { document_front: front } = h.repo.addCase("passport", ["document_front"], "claimed");
    h.repo.jobs[0].attempts = 2;
    await expectError(await h.send("/result", result(front!.jobId, { attempt: 3 })), 404, "not_found");
    expect(await readJson(await h.send("/result", result(front!.jobId, { attempt: 1 })))).toEqual({ status: "recorded" });
    await expectError(await h.send("/result", result(crypto.randomUUID())), 404, "not_found");
  });

  it("answers 410 image_gone for a photo replaced or erased meanwhile", async () => {
    const h = await setup();
    const { document_front: front } = h.repo.addCase("passport", ["document_front"], "claimed");
    h.repo.captures[0].live = false;
    await expectError(await h.send("/result", result(front!.jobId)), 410, "image_gone");
    h.repo.captures[0].live = true;
    h.repo.jobs[0].status = "superseded";
    await expectError(await h.send("/result", result(front!.jobId)), 410, "image_gone");
    expect(h.repo.recorded).toEqual([]);
  });

  it("refuses an invalid body before any lookup -> 400", async () => {
    const h = await setup();
    const { document_front: front } = h.repo.addCase("passport", ["document_front"], "claimed");
    await expectError(await h.send("/result", { ...result(front!.jobId), rawText: "SPECIMEN" }), 400, "bad_request");
    await expectError(await h.send("/result", result(front!.jobId, { mrzCandidates: ["p<cmr"] })), 400, "bad_request");
    expect(h.repo.calls).not.toContain("jobSnapshot");
  });

  it("keeps everything read from the document out of check details, the audit log and the logs", async () => {
    const h = await setup({ logToConsole: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { document_back: back } = h.repo.addCase("residence_permit", ["document_back"], "claimed");
    const body = result(back!.jobId, {
      mrzCandidates: td1Cmr("XXB"),
      fields: { surname: "Doe", givenNames: "Jane", issueDate: "2025-03-01", subtype: "refugee" },
      classification: { rotation: 0, keywordHits: { residence: 1 }, qrPresent: true, orientation: null },
    });
    expect((await h.send("/result", body)).status).toBe(200);
    const visible = JSON.stringify([h.repo.recorded[0].checks, h.repo.recorded[0].evidence, h.repo.recorded[0].caseChecks, h.repo.audits]);
    for (const value of VALUES) expect(visible).not.toContain(value);

    // A database error that carries the values: the logs must not repeat them.
    const again = h.repo.addCase("residence_permit", ["document_back"], "claimed");
    h.repo.failRecord = true;
    const res = await h.send("/result", { ...body, jobId: again.document_back!.jobId });
    const text = await res.clone().text();
    await expectError(res, 500, "server_error");
    const logged = spy.mock.calls.flat().join(" ") + text;
    expect(spy).toHaveBeenCalled();
    for (const value of [...VALUES, "insert failed"]) expect(logged).not.toContain(value);
  });
});
