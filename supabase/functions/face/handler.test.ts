// deno-lint-ignore-file require-await
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../_shared/audit.ts";
import {
  FACE_LIMITS,
  FACE_WORKER_AUDIENCE,
  type FaceClaimInput,
  type FaceFrameMeasure,
  type FaceResultRequest,
  WORKER_HEADERS,
} from "../_shared/contract.ts";
import { makeRequest, readJson } from "../_shared/test-helpers.ts";
import { newKey, signedHeaders, type TestKey } from "../worker/test-support.ts";
import {
  type ClaimedFaceJob,
  createFaceHandler,
  type FaceImageLookup,
  type FaceImageStorage,
  type FaceJobContext,
  type FaceNonceResult,
  type FaceRecordResult,
  type FaceRepo,
  type FaceResultRecord,
} from "./handler.ts";
import { parseClaim, parseJobContext } from "./repo.ts";
import { validateImageRequest, validateResultRequest } from "./validation.ts";

// ---------------------------------------------------------------------------
// In-memory fakes, following the M6/M7 migration: face_use_nonce (scope "face"), face_claim,
// face_image_lookup (only an input of the attempt holding the lease), face_job_context and
// face_record_result (first result wins).
// ---------------------------------------------------------------------------
const VERIFICATION = "c0ffee00-0000-4000-8000-0000000000aa";
const CHALLENGE = "c0ffee00-0000-4000-8000-0000000000cc";
const DOCUMENT = "c0ffee00-0000-4000-8000-0000000000d0";
const frameId = (i: number) => `c0ffee00-0000-4000-8000-0000000000${(0xf0 + i).toString(16)}`;

function inputs(kind: "liveness" | "face_match"): FaceClaimInput[] {
  const frames: FaceClaimInput[] = Array.from({ length: 13 }, (_, i) => ({
    captureId: frameId(i),
    role: "frame",
    index: i,
    step: i === 0 ? 0 : Math.floor((i - 1) / 4) + 1,
    atMs: 900 + i * 600,
    sha256: "a".repeat(64),
    byteSize: 30_000,
    width: 360,
    height: 480,
  }));
  if (kind === "liveness") return frames;
  return [...frames, { captureId: DOCUMENT, role: "document", index: null, step: null, atMs: null, sha256: "b".repeat(64), byteSize: 300_000, width: 1280, height: 900 }];
}

interface Job extends FaceJobContext {
  testSession: boolean;
}

class MemoryFaceRepo implements FaceRepo {
  keys = new Map<string, { publicKey: string; revoked: boolean; scope: "documents" | "face" }>();
  nonces = new Set<string>();
  jobs: Job[] = [];
  erased = new Set<string>();
  recorded: FaceResultRecord[] = [];
  audits: AuditEntry[] = [];
  auditFails = false;

  async getKey(kid: string) {
    const key = this.keys.get(kid);
    return key && key.scope === "face" ? { publicKey: key.publicKey, revoked: key.revoked } : null;
  }
  async useNonce(kid: string, nonce: string): Promise<FaceNonceResult> {
    const key = this.keys.get(kid);
    if (!key || key.revoked || key.scope !== "face") return "revoked";
    if (this.nonces.has(nonce)) return "replayed";
    this.nonces.add(nonce);
    return "ok";
  }
  async claim(): Promise<ClaimedFaceJob | null> {
    const job = this.jobs.find((j) => j.status === "pending");
    if (!job) return null;
    job.status = "claimed";
    job.attempts += 1;
    const all = inputs(job.kind);
    job.inputs = all.map((i) => ({ captureId: i.captureId, role: i.role, index: i.index, step: i.step }));
    return { jobId: job.jobId, attempt: job.attempts, kind: job.kind, testSession: job.testSession, declaredDocument: "passport", actions: job.actions, inputs: all };
  }
  async lookupImage(jobId: string, attempt: number, captureId: string): Promise<FaceImageLookup> {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (!job || !job.inputs.some((i) => i.captureId === captureId)) return { result: "not_found" };
    if (job.status === "superseded" || this.erased.has(captureId)) return { result: "gone" };
    if (job.status !== "claimed" || job.attempts !== attempt) return { result: "not_found" };
    return { result: "ok", verificationId: VERIFICATION, storagePath: `${VERIFICATION}/${captureId}.jpg`, byteSize: 4 };
  }
  async jobContext(jobId: string): Promise<FaceJobContext | null> {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (!job) return null;
    return { ...job, live: job.inputs.length > 0 && job.inputs.every((i) => !this.erased.has(i.captureId)) };
  }
  async recordResult(record: FaceResultRecord): Promise<FaceRecordResult> {
    const job = this.jobs.find((j) => j.jobId === record.jobId);
    if (!job || record.attempt > job.attempts) return "not_found";
    if (job.status === "done") return "already_done";
    if (job.status === "superseded") return "gone";
    job.status = "done";
    this.recorded.push(record);
    return "recorded";
  }
  async audit(entry: AuditEntry) {
    if (this.auditFails) throw new Error("audit down");
    this.audits.push(entry);
  }
}

class MemoryImages implements FaceImageStorage {
  async download(path: string) {
    return path.includes("missing") ? null : new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]);
  }
}

const NOW = new Date("2026-10-20T09:00:00Z");
const NOW_S = NOW.getTime() / 1000;
const URL_BASE = "https://ref.supabase.co/functions/v1/face";

async function setup() {
  const repo = new MemoryFaceRepo();
  const images = new MemoryImages();
  const log = { error: vi.fn() };
  const key = await newKey("f1");
  repo.keys.set(key.kid, { publicKey: key.publicKey, revoked: false, scope: "face" });
  const handler = createFaceHandler({ repo, images, now: () => NOW, log });

  function addJob(kind: "liveness" | "face_match", overrides: Partial<Job> = {}): Job {
    const job: Job = {
      jobId: crypto.randomUUID(),
      kind,
      verificationId: VERIFICATION,
      status: "pending",
      attempts: 0,
      live: true,
      challengeId: CHALLENGE,
      actions: ["turn_left", "blink", "smile"],
      inputs: [],
      testSession: true,
      ...overrides,
    };
    repo.jobs.push(job);
    return job;
  }

  async function send(path: string, body: unknown, options: { signer?: TestKey; audience?: string; timestamp?: string; nonce?: string; origin?: string } = {}) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const signed = await signedHeaders(options.signer ?? key, {
      path,
      body: raw,
      timestamp: options.timestamp ?? String(NOW_S),
      nonce: options.nonce,
      audience: options.audience ?? FACE_WORKER_AUDIENCE,
    });
    return handler(makeRequest(`${URL_BASE}${path}`, {
      origin: options.origin ?? null,
      rawBody: raw,
      headers: { "content-type": "application/json", apikey: "sb_publishable_x", ...signed },
    }));
  }

  return { repo, log, key, send, addJob };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await readJson(res)).toEqual({ error: { code, message: expect.any(String) } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function measure(index: number, overrides: Partial<FaceFrameMeasure> = {}): FaceFrameMeasure {
  return {
    index, faces: 1, yaw: 0, pitch: 0, roll: 0, blink: 0.05, eyeOpenness: 0.3, smile: 0.05, mouthWidth: 0.57, faceSize: 0.2,
    centerX: 0.5, centerY: 0.45, planarResidual: index === 0 ? 0 : 0.01, shapeDistance: 0.01, moire: 0.4, glare: 0, detail: 0.02,
    ...overrides,
  };
}

function livenessResult(jobId: string, attempt = 1): FaceResultRequest {
  const frames = Array.from({ length: 13 }, (_, i) => {
    const step = i === 0 ? 0 : Math.floor((i - 1) / 4) + 1;
    if (step === 1) return measure(i, { yaw: 24, planarResidual: 0.06 });
    if (step === 2) return measure(i, { blink: 0.9, eyeOpenness: 0.08 });
    if (step === 3) return measure(i, { smile: 0.85, mouthWidth: 0.7 });
    return measure(i);
  });
  return { jobId, attempt, kind: "liveness", engine: "face-1/test", liveness: { referenceIndex: 0, frames }, faceMatch: null, timing: { ms: 800, cold: true } };
}

function faceMatchResult(jobId: string, similarity: number | null = 0.62): FaceResultRequest {
  return {
    jobId,
    attempt: 1,
    kind: "face_match",
    engine: "face-1/test",
    liveness: null,
    faceMatch: {
      portrait: { found: true, faces: 2, box: [0.08, 0.22, 0.2, 0.3], faceSize: 58.5, method: "mesh", detectionScore: 0.97 },
      selfie: { captureId: frameId(0), frameIndex: 0, found: true, box: [0.3, 0.2, 0.4, 0.35], faceSize: 82, yaw: 1.5, pitch: -2 },
      similarity,
    },
    timing: { ms: 2100, cold: true },
  };
}

describe("signatures (the AI worker's scheme, for the face function's own audience and keys)", () => {
  it("accepts the face worker's signed claim", async () => {
    const { send } = await setup();
    expect((await send("/claim", {})).status).toBe(204);
  });

  it("refuses a signature made for the AI worker's function (another audience)", async () => {
    const { send } = await setup();
    await expectError(await send("/claim", {}, { audience: "confiance-verify/worker" }), 401, "invalid_signature");
  });

  it("refuses the AI worker's key (scope documents), however well it signs", async () => {
    const { send, repo } = await setup();
    const documentsKey = await newKey("w1");
    repo.keys.set("w1", { publicKey: documentsKey.publicKey, revoked: false, scope: "documents" });
    await expectError(await send("/claim", {}, { signer: documentsKey }), 401, "invalid_signature");
  });

  it("refuses a revoked key, a stale timestamp and a replayed nonce", async () => {
    const { send, repo, key } = await setup();
    await expectError(await send("/claim", {}, { timestamp: String(NOW_S - 120) }), 401, "invalid_signature");
    expect((await send("/claim", {}, { nonce: "0".repeat(32) })).status).toBe(204);
    await expectError(await send("/claim", {}, { nonce: "0".repeat(32) }), 401, "replayed_request");
    repo.keys.get(key.kid)!.revoked = true;
    await expectError(await send("/claim", {}), 401, "invalid_signature");
  });

  it("refuses any browser origin and a body over the limit", async () => {
    const { send } = await setup();
    await expectError(await send("/claim", {}, { origin: "https://evil.example" }), 403, "forbidden");
    await expectError(await send("/result", "x".repeat(FACE_LIMITS.maxBodyBytes + 1)), 413, "bad_request");
  });

  it("refuses unsigned requests", async () => {
    const { send } = await setup();
    const res = await send("/claim", {});
    expect(res.status).toBe(204);
    const handler = createFaceHandler({ repo: new MemoryFaceRepo(), images: new MemoryImages(), now: () => NOW, log: { error: vi.fn() } });
    await expectError(await handler(makeRequest(`${URL_BASE}/claim`, { origin: null, rawBody: "{}" })), 401, "invalid_signature");
    expect(WORKER_HEADERS.signature).toBe("x-worker-signature");
  });
});

describe("POST /claim", () => {
  it("204 with nothing to do; the job with its inputs otherwise", async () => {
    const { send, addJob } = await setup();
    expect((await send("/claim", {})).status).toBe(204);
    const job = addJob("face_match");
    const res = await send("/claim", {});
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { inputs: FaceClaimInput[] };
    expect(body).toMatchObject({ jobId: job.jobId, attempt: 1, kind: "face_match", testSession: true, actions: job.actions });
    expect(body.inputs).toHaveLength(14);
    expect(body.inputs.at(-1)).toMatchObject({ captureId: DOCUMENT, role: "document" });
  });

  it("refuses a claim body with anything in it", async () => {
    const { send } = await setup();
    await expectError(await send("/claim", { kind: "face_match" }), 400, "bad_request");
  });
});

describe("POST /image", () => {
  it("relays one input of the job holding the lease, after auditing it", async () => {
    const { send, addJob, repo } = await setup();
    const job = addJob("liveness");
    await send("/claim", {});
    const res = await send("/image", { jobId: job.jobId, attempt: 1, captureId: frameId(3) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(repo.audits).toEqual([{
      actorType: "system",
      actorId: "f1",
      action: "face.image",
      targetType: "capture",
      targetId: frameId(3),
      details: { jobId: job.jobId, attempt: 1, verificationId: VERIFICATION, byteSize: 4 },
    }]);
  });

  it("no bytes without the audit entry", async () => {
    const { send, addJob, repo } = await setup();
    const job = addJob("liveness");
    await send("/claim", {});
    repo.auditFails = true;
    await expectError(await send("/image", { jobId: job.jobId, attempt: 1, captureId: frameId(0) }), 500, "audit_failed");
  });

  it("404 for a photo that is not the job's (another case's document), or another attempt; 410 once erased", async () => {
    const { send, addJob, repo } = await setup();
    const job = addJob("liveness");
    await send("/claim", {});
    await expectError(await send("/image", { jobId: job.jobId, attempt: 1, captureId: DOCUMENT }), 404, "not_found");
    await expectError(await send("/image", { jobId: job.jobId, attempt: 2, captureId: frameId(0) }), 404, "not_found");
    repo.erased.add(frameId(0));
    await expectError(await send("/image", { jobId: job.jobId, attempt: 1, captureId: frameId(0) }), 410, "image_gone");
  });
});

describe("POST /result", () => {
  it("liveness: decided here from the measures and recorded as the case's liveness check", async () => {
    const { send, addJob, repo } = await setup();
    const job = addJob("liveness");
    await send("/claim", {});
    const res = await send("/result", livenessResult(job.jobId));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ status: "recorded" });
    const record = repo.recorded[0];
    expect(record).toMatchObject({ kid: "f1", checkName: "liveness", version: "liveness-eval-v2", outcome: "pass", score: 1 });
    expect(record.details).toMatchObject({ evaluated: true, provisional: true, challengeId: CHALLENGE, flatPlane: "depth", problems: [] });
    // The measures stay with the job (never readable by staff).
    expect(record.evidence).toMatchObject({ referenceIndex: 0 });
  });

  it("keeps the timings (fetch, wall, and since the job was created) with the check, and logs them", async () => {
    const { send, addJob, repo } = await setup();
    const job = addJob("liveness", { createdAt: new Date(NOW.getTime() - 4_200).toISOString() });
    await send("/claim", {});
    const body = { ...livenessResult(job.jobId), timing: { ms: 350, cold: false, fetchMs: 900, wallMs: 1_500 } };
    expect(await readJson(await send("/result", body))).toEqual({ status: "recorded" });
    expect(repo.recorded[0].details.timing).toEqual({ ms: 350, cold: false, fetchMs: 900, wallMs: 1_500, sinceJobMs: 4_200 });
    // Per-frame metrics for tuning, numbers only.
    expect(repo.recorded[0].details.metrics).toMatchObject({ windows: [[1, 2, 3, 4, 5, 6], [5, 6, 7, 8, 9, 10], [9, 10, 11, 12]] });
  });

  it("refuses a timing with any other key", async () => {
    const { send, addJob } = await setup();
    const job = addJob("liveness");
    await send("/claim", {});
    const body = { ...livenessResult(job.jobId), timing: { ms: 350, cold: false, photo: 1 } };
    await expectError(await send("/result", body), 400, "bad_request");
  });

  it("face_match: recorded as the case's face_match check, review-only and uncalibrated", async () => {
    const { send, addJob, repo } = await setup();
    const job = addJob("face_match");
    await send("/claim", {});
    expect((await send("/result", faceMatchResult(job.jobId))).status).toBe(200);
    const record = repo.recorded[0];
    expect(record).toMatchObject({ checkName: "face_match", version: "face-match-v1", outcome: "pass", score: 0.62 });
    expect(record.details).toMatchObject({
      similarity: 0.62,
      calibrated: false,
      reviewOnly: true,
      portrait: { captureId: DOCUMENT, box: [0.08, 0.22, 0.2, 0.3] },
      selfie: { captureId: frameId(0), box: [0.3, 0.2, 0.4, 0.35] },
    });
  });

  it("the first result wins; a superseded job or an erased input is gone; an unknown attempt is not found", async () => {
    const { send, addJob, repo } = await setup();
    const job = addJob("liveness");
    await send("/claim", {});
    expect((await send("/result", livenessResult(job.jobId))).status).toBe(200);
    expect(await readJson(await send("/result", livenessResult(job.jobId)))).toEqual({ status: "already_done" });

    const other = addJob("liveness");
    await send("/claim", {});
    await expectError(await send("/result", livenessResult(other.jobId, 2)), 404, "not_found");
    repo.erased.add(frameId(5));
    await expectError(await send("/result", livenessResult(other.jobId)), 410, "image_gone");
    other.status = "superseded";
    await expectError(await send("/result", livenessResult(other.jobId)), 410, "image_gone");
  });

  it("refuses a result of the wrong kind, a frame the job does not have, and a selfie that is not one of its frames", async () => {
    const { send, addJob } = await setup();
    const job = addJob("liveness");
    await send("/claim", {});
    await expectError(await send("/result", faceMatchResult(job.jobId)), 400, "bad_request");
    const result = livenessResult(job.jobId);
    result.liveness!.frames[12] = measure(14);
    await expectError(await send("/result", result), 400, "bad_request");

    const match = addJob("face_match");
    await send("/claim", {});
    const stranger = faceMatchResult(match.jobId);
    stranger.faceMatch!.selfie.captureId = "c0ffee00-0000-4000-8000-000000000999";
    await expectError(await send("/result", stranger), 400, "bad_request");
  });
});

describe("validation", () => {
  it("image requests: exactly jobId, attempt and captureId", () => {
    expect(validateImageRequest({ jobId: crypto.randomUUID(), attempt: 1, captureId: crypto.randomUUID() }).ok).toBe(true);
    expect(validateImageRequest({ jobId: crypto.randomUUID(), attempt: 1 }).ok).toBe(false);
    expect(validateImageRequest({ jobId: crypto.randomUUID(), attempt: 4, captureId: crypto.randomUUID() }).ok).toBe(false);
    expect(validateImageRequest({ jobId: crypto.randomUUID(), attempt: 1, captureId: crypto.randomUUID(), path: "x" }).ok).toBe(false);
  });

  const valid = () => JSON.parse(JSON.stringify(livenessResult(crypto.randomUUID()))) as Record<string, unknown> & FaceResultRequest;

  it.each([
    ["an unknown top-level key", (r: Record<string, unknown>) => (r.landmarks = [[1, 2]])],
    ["an unknown frame key (a landmark list)", (r: FaceResultRequest) => ((r.liveness!.frames[0] as unknown as Record<string, unknown>).points = [1])],
    ["a measure out of range", (r: FaceResultRequest) => (r.liveness!.frames[1].yaw = 400)],
    ["a measure without a face", (r: FaceResultRequest) => (r.liveness!.frames[1] = { ...r.liveness!.frames[1], faces: 0 })],
    ["a repeated frame", (r: FaceResultRequest) => (r.liveness!.frames[1].index = 0)],
    ["a reference that is not a frame", (r: FaceResultRequest) => (r.liveness!.referenceIndex = 14)],
    ["a face match on a liveness result", (r: FaceResultRequest) => (r.faceMatch = faceMatchResult(r.jobId).faceMatch)],
    ["a long engine label", (r: FaceResultRequest) => (r.engine = "x".repeat(61))],
    ["an engine label with spaces", (r: FaceResultRequest) => (r.engine = "face 1")],
    ["a timing over 300 s", (r: FaceResultRequest) => (r.timing.ms = 300_001)],
  ])("refuses %s", (_name, mutate) => {
    const result = valid();
    mutate(result as never);
    expect(validateResultRequest(result).ok).toBe(false);
  });

  it.each([
    ["a similarity without both faces", (r: FaceResultRequest) => (r.faceMatch!.selfie = { captureId: null, frameIndex: null, found: false, box: null, faceSize: null, yaw: null, pitch: null })],
    ["a box outside the photo", (r: FaceResultRequest) => (r.faceMatch!.portrait.box = [0.9, 0.1, 0.3, 0.2])],
    ["an embedding", (r: FaceResultRequest) => ((r.faceMatch as unknown as Record<string, unknown>).embedding = [0.1])],
    ["a similarity over 1", (r: FaceResultRequest) => (r.faceMatch!.similarity = 1.2)],
    ["leftovers of a portrait not found", (r: FaceResultRequest) => (r.faceMatch!.portrait = { ...r.faceMatch!.portrait, found: false })],
  ])("refuses a face match with %s", (_name, mutate) => {
    const result = JSON.parse(JSON.stringify(faceMatchResult(crypto.randomUUID()))) as FaceResultRequest;
    mutate(result);
    expect(validateResultRequest(result as unknown as Record<string, unknown>).ok).toBe(false);
  });

  it("accepts a face match where nothing was found", () => {
    const result = faceMatchResult(crypto.randomUUID(), null);
    result.faceMatch!.portrait = { found: false, faces: 0, box: null, faceSize: null, method: null, detectionScore: null };
    expect(validateResultRequest(result as unknown as Record<string, unknown>).ok).toBe(true);
  });
});

describe("repo parsers", () => {
  it("parse face_claim's answer field by field", () => {
    const claim = { jobId: crypto.randomUUID(), attempt: 1, kind: "liveness", testSession: true, declaredDocument: "passport", actions: ["blink", "smile", "look_up"], inputs: inputs("liveness") };
    expect(parseClaim(claim)?.inputs).toHaveLength(13);
    expect(parseClaim(null)).toBeNull();
    expect(() => parseClaim({ ...claim, kind: "ocr" })).toThrow();
    expect(() => parseClaim({ ...claim, inputs: [{ ...inputs("liveness")[0], index: null }] })).toThrow();
    expect(() => parseClaim({ ...claim, actions: ["dance"] })).toThrow();
  });

  it("parse face_job_context's answer field by field", () => {
    const context = {
      jobId: crypto.randomUUID(), kind: "face_match", verificationId: VERIFICATION, status: "claimed", attempts: 1, live: true,
      challengeId: CHALLENGE, actions: ["turn_left", "blink", "smile"], inputs: [{ captureId: DOCUMENT, role: "document", index: null, step: null }],
    };
    expect(parseJobContext(context)?.inputs[0].role).toBe("document");
    expect(() => parseJobContext({ ...context, status: "running" })).toThrow();
    expect(() => parseJobContext({ ...context, inputs: [{ captureId: "x", role: "frame", index: 0, step: 0 }] })).toThrow();
    // createdAt since the real-test fixes (a database before them sends none).
    expect(parseJobContext(context)?.createdAt).toBeNull();
    expect(parseJobContext({ ...context, createdAt: "2026-10-20T13:34:09.988058+00:00" })?.createdAt).toBe("2026-10-20T13:34:09.988058+00:00");
    expect(() => parseJobContext({ ...context, createdAt: "yesterday" })).toThrow();
  });
});
