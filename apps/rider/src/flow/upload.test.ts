import { describe, expect, it, vi } from "vitest";
import type { CaptureSide, FlowSession, UploadUrlResponse } from "@verify/shared";
import { FlowError } from "./errors";
import type { Shot, UploadProgress } from "./machine";
import { classifyStorageError } from "./storage";
import { type UploadDeps, Uploader } from "./upload";

const VID = "11111111-2222-4333-8444-555555555555";

function shot(side: CaptureSide): Shot {
  return {
    side,
    blob: new Blob([new Uint8Array(10)], { type: "image/jpeg" }),
    quality: {
      source: "auto",
      sharpness: 800,
      glareRatio: 0,
      meanLuma: 140,
      framing: 0.85,
      videoWidth: 1080,
      videoHeight: 1920,
      elapsedMs: 3000,
    },
    hints: [],
    lowResolution: false,
    info: { width: 1000, height: 640, bytes: 10, jpegQuality: 0.88, scale: 1, attempts: 1 },
  };
}

const submitted: FlowSession = {
  verificationId: VID,
  status: "submitted",
  locale: "fr",
  consentGiven: true,
  declaredDocument: "cni",
  requiredSides: ["document_front", "document_back"],
  captures: [],
  expiresAt: "2026-10-13T12:30:00Z",
  isTest: true,
};

/** In-memory fake of the flow API and storage, recording every call. */
function fakeBackend() {
  const calls: string[] = [];
  let n = 0;
  const failures: Partial<Record<string, FlowError[]>> = {};
  const failNext = (op: string, ...errors: FlowError[]) => {
    failures[op] = [...(failures[op] ?? []), ...errors];
  };
  const maybeFail = (op: string) => {
    const next = failures[op]?.shift();
    if (next) throw next;
  };
  const api: UploadDeps["api"] = {
    uploadUrl: vi.fn(async ({ kind }) => {
      calls.push(`upload-url:${kind}`);
      maybeFail("uploadUrl");
      n++;
      return { path: `${VID}/${kind}-${n}.jpg`, token: `tok${n}`, bucket: "id-captures" } satisfies UploadUrlResponse;
    }),
    completeCapture: vi.fn(async ({ path }) => {
      calls.push(`captures:${path}`);
      maybeFail("completeCapture");
      return { captureId: "c", byteSize: 10, width: 1000, height: 640, sha256: "x" };
    }),
    submit: vi.fn(async () => {
      calls.push("submit");
      maybeFail("submit");
      return submitted;
    }),
    getSession: vi.fn(async () => {
      calls.push("session");
      return submitted;
    }),
  };
  const putObject = vi.fn(async (target: UploadUrlResponse) => {
    calls.push(`put:${target.path}:${target.token}`);
    maybeFail("put");
  });
  return { api, putObject, calls, failNext };
}

function uploaderFor(backend: ReturnType<typeof fakeBackend>) {
  const waits: number[] = [];
  const uploader = new Uploader({
    api: backend.api,
    putObject: backend.putObject,
    sleep: async (ms) => void waits.push(ms),
    random: () => 0.5,
  });
  return { uploader, waits };
}

function listener() {
  const progress: UploadProgress[] = [];
  const done: CaptureSide[] = [];
  return { progress, done, l: { progress: (p: UploadProgress) => progress.push(p), sideDone: (s: CaptureSide) => done.push(s) } };
}

describe("Uploader", () => {
  it("uploads each side then submits", async () => {
    const backend = fakeBackend();
    const { uploader } = uploaderFor(backend);
    const { l, done, progress } = listener();
    const outcome = await uploader.run([shot("document_front"), shot("document_back")], l);
    expect(outcome).toEqual({ ok: true, session: submitted });
    expect(backend.calls).toEqual([
      "upload-url:document_front",
      `put:${VID}/document_front-1.jpg:tok1`,
      `captures:${VID}/document_front-1.jpg`,
      "upload-url:document_back",
      `put:${VID}/document_back-2.jpg:tok2`,
      `captures:${VID}/document_back-2.jpg`,
      "submit",
    ]);
    expect(done).toEqual(["document_front", "document_back"]);
    expect(progress.map((p) => [p.phase, p.done, p.photo])).toEqual([
      ["link", 0, 1],
      ["send", 1, 1],
      ["check", 2, 1],
      ["link", 3, 2],
      ["send", 4, 2],
      ["check", 5, 2],
      ["submit", 6, 0],
    ]);
    expect(progress.every((p) => p.total === 7 && p.attempt === 1)).toBe(true);
    expect(backend.api.completeCapture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "document_front", quality: shot("document_front").quality }),
    );
  });

  it("retries a failed upload with the same link instead of asking for a new one", async () => {
    const backend = fakeBackend();
    backend.failNext("put", new FlowError("network"));
    const { uploader, waits } = uploaderFor(backend);
    const { l, progress } = listener();
    const outcome = await uploader.run([shot("document_front")], l);
    expect(outcome.ok).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("upload-url"))).toHaveLength(1);
    expect(backend.calls.filter((c) => c.startsWith("put"))).toEqual([
      `put:${VID}/document_front-1.jpg:tok1`,
      `put:${VID}/document_front-1.jpg:tok1`,
    ]);
    expect(waits).toEqual([1500]);
    expect(progress.some((p) => p.phase === "send" && p.attempt === 2)).toBe(true);
  });

  it("re-uploads when the server cannot find the object", async () => {
    const backend = fakeBackend();
    backend.failNext("completeCapture", new FlowError("upload_missing", 404));
    const { uploader } = uploaderFor(backend);
    expect((await uploader.run([shot("document_front")], listener().l)).ok).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("put"))).toHaveLength(2);
    expect(backend.calls.filter((c) => c.startsWith("upload-url"))).toHaveLength(1);
  });

  it("asks for a fresh link when storage refuses the token", async () => {
    const backend = fakeBackend();
    backend.failNext("put", new FlowError("storage_failed", 400));
    const { uploader } = uploaderFor(backend);
    expect((await uploader.run([shot("document_front")], listener().l)).ok).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("upload-url"))).toHaveLength(2);
  });

  it("gives up after three tries and resumes on a manual retry", async () => {
    const backend = fakeBackend();
    backend.failNext("completeCapture", new FlowError("network"), new FlowError("network"), new FlowError("timeout"));
    const { uploader, waits } = uploaderFor(backend);
    const front = shot("document_front");
    const first = await uploader.run([front], listener().l);
    expect(first).toEqual({ ok: false, error: "timeout", side: "document_front" });
    expect(waits).toEqual([1500, 3000]);

    const second = await uploader.run([front], listener().l);
    expect(second.ok).toBe(true);
    // The photo was stored once; only the confirmation was repeated.
    expect(backend.calls.filter((c) => c.startsWith("put"))).toHaveLength(1);
    expect(backend.calls.filter((c) => c.startsWith("upload-url"))).toHaveLength(1);
  });

  it("does not retry a permanent error", async () => {
    const backend = fakeBackend();
    backend.failNext("uploadUrl", new FlowError("too_many_uploads", 429));
    const { uploader, waits } = uploaderFor(backend);
    expect(await uploader.run([shot("document_front")], listener().l)).toEqual({
      ok: false,
      error: "too_many_uploads",
      side: "document_front",
    });
    expect(waits).toEqual([]);
  });

  it("reports an image rejection for its side and forgets the deleted upload", async () => {
    const backend = fakeBackend();
    backend.failNext("completeCapture", new FlowError("image_too_small", 422));
    const { uploader } = uploaderFor(backend);
    const back = shot("document_back");
    expect(await uploader.run([back], listener().l)).toEqual({ ok: false, error: "image_too_small", side: "document_back" });
    await uploader.run([back], listener().l);
    expect(backend.calls.filter((c) => c.startsWith("upload-url"))).toHaveLength(2);
  });

  it("treats already_submitted on a retried submit as success when the session is submitted", async () => {
    const backend = fakeBackend();
    backend.failNext("submit", new FlowError("network"), new FlowError("already_submitted", 409));
    const { uploader } = uploaderFor(backend);
    expect(await uploader.run([], listener().l)).toEqual({ ok: true, session: submitted });
    expect(backend.calls).toEqual(["submit", "submit", "session"]);
  });

  it("treats already_submitted after the rider's retry as success when an earlier run had submitted", async () => {
    const backend = fakeBackend();
    // Every automatic try loses its answer; the server did record the first one.
    backend.failNext("submit", new FlowError("network"), new FlowError("network"), new FlowError("network"));
    const { uploader } = uploaderFor(backend);
    expect(await uploader.run([], listener().l)).toEqual({ ok: false, error: "network", side: null });
    backend.failNext("submit", new FlowError("already_submitted", 409));
    expect(await uploader.run([], listener().l)).toEqual({ ok: true, session: submitted });
    expect(backend.calls.slice(-2)).toEqual(["submit", "session"]);
  });

  it("reports already_submitted on a first submit", async () => {
    const backend = fakeBackend();
    backend.failNext("submit", new FlowError("already_submitted", 409));
    const { uploader } = uploaderFor(backend);
    expect(await uploader.run([], listener().l)).toEqual({ ok: false, error: "already_submitted", side: null });
  });
});

describe("classifyStorageError", () => {
  it("treats an existing object as stored", () => {
    expect(classifyStorageError({ status: 400, statusCode: "409", message: "The resource already exists" })).toBe(
      "already_stored",
    );
  });

  it("maps network, server and other failures", () => {
    expect(classifyStorageError({ message: "Failed to fetch" })).toMatchObject({ code: "network" });
    expect(classifyStorageError({ status: 503, statusCode: "503" })).toMatchObject({ code: "server_error", status: 503 });
    expect(classifyStorageError({ status: 400, statusCode: "403", message: "invalid signature" })).toMatchObject({
      code: "storage_failed",
      status: 400,
    });
  });
});
