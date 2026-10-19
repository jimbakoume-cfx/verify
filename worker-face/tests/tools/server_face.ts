// The real face Edge Function (supabase/functions/face/handler.ts: signature checks for the face
// audience, scope-face keys, nonces, strict validation, the liveness and face match decisions) served
// on 127.0.0.1, with in-memory stand-ins for the database and the bucket. Used by
// tests/test_edge_function.py to run the face worker's own client, ring and (with the models) pipeline
// against it, so both sides are checked by the code that runs in production.
//
//   deno run --allow-net=127.0.0.1 --allow-read server_face.ts <config.json>
//
// config.json: { kid, publicKey (base64url), otherKeys: [{kid, publicKey, scope}], jobs: [{ jobId, kind,
// verificationId, challengeId, actions, testSession, inputs: [FaceClaimInput & { file }] }] }. The jobs
// are claimable in order. Prints one JSON line per event: {event:"listening", port} first, then each
// audit entry and each recorded result (decided details only; drawn faces, nothing personal).
import type { AuditEntry } from "../../../supabase/functions/_shared/audit.ts";
import type { FaceClaimInput, FaceJobKind, LivenessAction } from "../../../supabase/functions/_shared/contract.ts";
import {
  type ClaimedFaceJob,
  createFaceHandler,
  type FaceImageLookup,
  type FaceJobContext,
  type FaceKey,
  type FaceNonceResult,
  type FaceRecordResult,
  type FaceRepo,
  type FaceResultRecord,
} from "../../../supabase/functions/face/handler.ts";

interface Input extends FaceClaimInput {
  file: string;
}

interface JobConfig {
  jobId: string;
  kind: FaceJobKind;
  verificationId: string;
  challengeId: string;
  actions: LivenessAction[];
  testSession: boolean;
  inputs: Input[];
}

interface Config {
  kid: string;
  publicKey: string;
  otherKeys: { kid: string; publicKey: string; scope: "documents" | "face" }[];
  jobs: JobConfig[];
}

interface Job extends JobConfig {
  status: FaceJobContext["status"];
  attempts: number;
}

const config = JSON.parse(await Deno.readTextFile(Deno.args[0])) as Config;
const jobs: Job[] = config.jobs.map((job) => ({ ...job, status: "pending", attempts: 0 }));
const keys = new Map<string, { publicKey: string; scope: string }>([
  [config.kid, { publicKey: config.publicKey, scope: "face" }],
  ...config.otherKeys.map((k) => [k.kid, { publicKey: k.publicKey, scope: k.scope }] as const),
]);
const nonces = new Set<string>();

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

const repo: FaceRepo = {
  getKey(kid: string): Promise<FaceKey | null> {
    const key = keys.get(kid);
    return Promise.resolve(key && key.scope === "face" ? { publicKey: key.publicKey, revoked: false } : null);
  },
  useNonce(kid: string, nonce: string): Promise<FaceNonceResult> {
    if (keys.get(kid)?.scope !== "face") return Promise.resolve("revoked");
    if (nonces.has(nonce)) return Promise.resolve("replayed");
    nonces.add(nonce);
    return Promise.resolve("ok");
  },
  claim(): Promise<ClaimedFaceJob | null> {
    const job = jobs.find((j) => j.status === "pending");
    if (!job) return Promise.resolve(null);
    job.status = "claimed";
    job.attempts += 1;
    emit({ event: "claim", jobId: job.jobId, attempt: job.attempts });
    return Promise.resolve({
      jobId: job.jobId,
      attempt: job.attempts,
      kind: job.kind,
      testSession: job.testSession,
      declaredDocument: "passport",
      actions: job.actions,
      inputs: job.inputs.map(({ file: _file, ...input }) => input),
    });
  },
  lookupImage(jobId: string, attempt: number, captureId: string): Promise<FaceImageLookup> {
    const job = jobs.find((j) => j.jobId === jobId);
    const input = job?.inputs.find((i) => i.captureId === captureId);
    if (!job || !input || job.status !== "claimed" || job.attempts !== attempt) return Promise.resolve({ result: "not_found" });
    return Promise.resolve({ result: "ok", verificationId: job.verificationId, storagePath: input.file, byteSize: input.byteSize });
  },
  jobContext(jobId: string): Promise<FaceJobContext | null> {
    const job = jobs.find((j) => j.jobId === jobId);
    if (!job) return Promise.resolve(null);
    return Promise.resolve({
      jobId: job.jobId,
      kind: job.kind,
      verificationId: job.verificationId,
      status: job.status,
      attempts: job.attempts,
      live: true,
      challengeId: job.challengeId,
      actions: job.actions,
      inputs: job.attempts === 0 ? [] : job.inputs.map((i) => ({ captureId: i.captureId, role: i.role, index: i.index, step: i.step })),
    });
  },
  recordResult(record: FaceResultRecord): Promise<FaceRecordResult> {
    const job = jobs.find((j) => j.jobId === record.jobId);
    if (!job || record.attempt > job.attempts) return Promise.resolve("not_found");
    if (job.status === "done") return Promise.resolve("already_done");
    job.status = "done";
    emit({
      event: "result",
      jobId: record.jobId,
      kid: record.kid,
      checkName: record.checkName,
      version: record.version,
      outcome: record.outcome,
      score: record.score,
      details: record.details,
    });
    return Promise.resolve("recorded");
  },
  audit(entry: AuditEntry): Promise<void> {
    emit({ event: "audit", action: entry.action, actorId: entry.actorId, targetId: entry.targetId, details: entry.details ?? {} });
    return Promise.resolve();
  },
};

const handler = createFaceHandler({
  repo,
  images: {
    async download(path: string): Promise<Blob | null> {
      try {
        return new Blob([await Deno.readFile(path)], { type: "image/jpeg" });
      } catch {
        return null;
      }
    },
  },
  log: { error: () => {} },
});

Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: ({ port }) => emit({ event: "listening", port }) },
  handler,
);
