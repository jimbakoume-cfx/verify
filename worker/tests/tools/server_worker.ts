// The real worker Edge Function (supabase/functions/worker/handler.ts: signature checks, nonce, strict
// validation, decisions with the shared MRZ corrector and parser) served on 127.0.0.1, with in-memory
// stand-ins for the database and the storage bucket. Used by tests/test_edge_function.py to run the
// Python worker's own client and ring against it, so both sides of the signature and of the result
// format are checked by the code that runs in production, not by a re-implementation.
//
//   deno run --allow-net=127.0.0.1 --allow-read server_worker.ts <config.json>
//
// config.json: { kid, publicKey (base64url), jobs: [{ jobId, captureId, verificationId, kind,
// declaredDocument, image (path), sha256, byteSize, width, height }] }. The jobs are claimable in
// order. Prints one JSON line per event on stdout: {event:"listening", port} first, then each audit
// entry and each recorded result (the specimens are fictitious, so their lines may be printed).
import type { AuditEntry } from "../../../supabase/functions/_shared/audit.ts";
import type { CaptureSide, DeclaredDocument } from "../../../supabase/functions/_shared/contract.ts";
import type { CaseSnapshot, JobStatus } from "../../../supabase/functions/worker/case.ts";
import type { SideDocumentData } from "../../../supabase/functions/worker/consistency.ts";
import type { CaptureEvidence } from "../../../supabase/functions/worker/decide.ts";
import {
  type ClaimedJob,
  createWorkerHandler,
  type ImageLookup,
  type NonceResult,
  type RecordResult,
  type ResultRecord,
  type WorkerKey,
  type WorkerRepo,
} from "../../../supabase/functions/worker/handler.ts";

interface JobConfig {
  jobId: string;
  captureId: string;
  verificationId: string;
  kind: CaptureSide;
  declaredDocument: DeclaredDocument;
  image: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
}

interface Config {
  kid: string;
  publicKey: string;
  jobs: JobConfig[];
}

interface Job extends JobConfig {
  status: JobStatus;
  attempts: number;
  evidence: CaptureEvidence | null;
  /** What the database would decrypt for the snapshot (M4): code lines and fields, no sub-type. */
  data: SideDocumentData | null;
}

const config = JSON.parse(await Deno.readTextFile(Deno.args[0])) as Config;
const jobs: Job[] = config.jobs.map((job) => ({ ...job, status: "pending", attempts: 0, evidence: null, data: null }));
const nonces = new Set<string>();
// Bumped by every recorded result: the snapshot's fingerprint, as the database's changes when a case does.
let version = 0;

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

const repo: WorkerRepo = {
  getKey(kid: string): Promise<WorkerKey | null> {
    return Promise.resolve(kid === config.kid ? { publicKey: config.publicKey, revoked: false } : null);
  },
  useNonce(kid: string, nonce: string): Promise<NonceResult> {
    const key = `${kid}|${nonce}`;
    if (nonces.has(key)) return Promise.resolve("replayed");
    nonces.add(key);
    return Promise.resolve("ok");
  },
  claim(): Promise<ClaimedJob | null> {
    const job = jobs.find((j) => j.status === "pending");
    if (!job) return Promise.resolve(null);
    job.status = "claimed";
    job.attempts += 1;
    emit({ event: "claim", jobId: job.jobId, attempt: job.attempts });
    return Promise.resolve({
      jobId: job.jobId,
      attempt: job.attempts,
      captureId: job.captureId,
      kind: job.kind,
      declaredDocument: job.declaredDocument,
      sha256: job.sha256,
      byteSize: job.byteSize,
      width: job.width,
      height: job.height,
    });
  },
  lookupImage(jobId: string, attempt: number): Promise<ImageLookup> {
    const job = jobs.find((j) => j.jobId === jobId);
    if (!job || job.status !== "claimed" || job.attempts !== attempt) return Promise.resolve({ result: "not_found" });
    return Promise.resolve({
      result: "ok",
      captureId: job.captureId,
      verificationId: job.verificationId,
      storagePath: job.image,
      byteSize: job.byteSize,
    });
  },
  jobSnapshot(jobId: string): Promise<CaseSnapshot | null> {
    const job = jobs.find((j) => j.jobId === jobId);
    if (!job) return Promise.resolve(null);
    const ofCase = jobs.filter((j) => j.verificationId === job.verificationId);
    return Promise.resolve({
      verificationId: job.verificationId,
      declaredDocument: job.declaredDocument,
      sides: ofCase.map((j) => ({ kind: j.kind, captureId: j.captureId, evidence: j.evidence })),
      documentData: ofCase.flatMap((j) => (j.data ? [j.data] : [])),
      fingerprint: `v${version}`,
      job: {
        id: job.jobId,
        status: job.status,
        attempts: job.attempts,
        captureId: job.captureId,
        kind: job.kind,
        captureLive: true,
      },
    });
  },
  recordResult(record: ResultRecord): Promise<RecordResult> {
    const job = jobs.find((j) => j.jobId === record.jobId);
    if (!job) return Promise.resolve("not_found");
    if (job.status === "done") return Promise.resolve("already_done");
    if (record.fingerprint !== `v${version}`) return Promise.resolve("stale");
    job.status = "done";
    job.evidence = record.evidence;
    if (record.mrzLines !== null || record.fields !== null) {
      const { subtype: _subtype, ...fields } = record.fields === null ? {} : JSON.parse(record.fields);
      job.data = {
        kind: job.kind,
        captureId: job.captureId,
        mrzLines: record.mrzLines === null ? null : record.mrzLines.split("\n"),
        fields: record.fields === null ? null : fields,
      };
    }
    version += 1;
    emit({
      event: "result",
      jobId: record.jobId,
      attempt: record.attempt,
      kid: record.kid,
      checks: record.checks,
      caseChecks: record.caseChecks,
      mrzLines: record.mrzLines,
      mrzFormat: record.mrzFormat,
      fields: record.fields === null ? null : JSON.parse(record.fields),
    });
    return Promise.resolve("recorded");
  },
  audit(entry: AuditEntry): Promise<void> {
    emit({ event: "audit", action: entry.action, actorId: entry.actorId, details: entry.details ?? {} });
    return Promise.resolve();
  },
};

const handler = createWorkerHandler({
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
  // Errors are expected in the refusal tests; the handler's own log lines are not needed.
  log: { error: () => {} },
});

Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: ({ port }) => emit({ event: "listening", port }) },
  handler,
);
