import { describe, expect, it, vi } from "vitest";
import { MRZ_REPORT_LIMITS, type CaptureSide, type FlowSession, type UploadUrlResponse } from "@verify/shared";
import { OCR_ASSETS, type MrzReadResult, type MrzReadStatus } from "../mrz/types";
import { FlowError } from "./errors";
import type { Shot, UploadProgress } from "./machine";
import { classifyStorageError } from "./storage";
import {
  STEPS_PER_PHOTO,
  type SidesOutcome,
  type SubmitOutcome,
  type UploadDeps,
  type UploadListener,
  Uploader,
  mrzReport,
  uploadSteps,
} from "./upload";

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
  declaredDocument: "cni_legacy",
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
    completeCapture: vi.fn(async ({ path, kind }) => {
      calls.push(`captures:${path}`);
      maybeFail("completeCapture");
      return { captureId: `capture-${kind}`, byteSize: 10, width: 1000, height: 640, sha256: "x" };
    }),
    reportMrz: vi.fn(async (body) => {
      calls.push(`mrz:${body.captureId}:${body.result}`);
      maybeFail("reportMrz");
      return { recorded: true as const };
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
  const warnings: string[] = [];
  const uploader = new Uploader({
    api: backend.api,
    putObject: backend.putObject,
    sleep: async (ms) => void waits.push(ms),
    random: () => 0.5,
    warn: (message) => void warnings.push(message),
  });
  return { uploader, waits, warnings };
}

/** The ICAO 9303 TD3 specimen ("Utopia" passport): public example data. */
const TD3 = ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10"];

function read(status: MrzReadStatus, overrides: Partial<MrzReadResult> = {}): MrzReadResult {
  return {
    status,
    format: "TD3",
    lines: status === "valid" || status === "invalid" ? TD3 : null,
    parsed: null,
    corrections: 1,
    ms: 412.6,
    rawText: "P<UTOERIKSS0N",
    charHeight: 15,
    rotated: false,
    engine: "tesseract.js-7.0.0/mrz-1",
    ...overrides,
  };
}

/** A photo of the side that carries the MRZ, read on its `attempt`th try. */
function readShot(side: CaptureSide, status: MrzReadStatus = "valid", attempt = 1): Shot {
  return { ...shot(side), gray: null, mrz: read(status), mrzAttempt: attempt };
}

function listener() {
  const progress: UploadProgress[] = [];
  const done: CaptureSide[] = [];
  const l: UploadListener = { progress: (p) => progress.push(p), sideDone: (s) => done.push(s) };
  return { progress, done, l };
}

/**
 * The photos sent after the rider's "Use this photo", then, once the server's checks are over, the
 * submit (as useFlow runs them, without the checks in between).
 */
async function sendAndSubmit(
  uploader: Uploader,
  shots: readonly Shot[],
  l: UploadListener,
): Promise<SidesOutcome | SubmitOutcome> {
  const sides = await uploader.uploadSides(shots, l);
  if (!sides.ok) return sides;
  return uploader.submit(l, { total: uploadSteps(shots), photos: shots.length });
}

describe("Uploader", () => {
  it("uploads each side then submits", async () => {
    const backend = fakeBackend();
    const { uploader } = uploaderFor(backend);
    const { l, done, progress } = listener();
    const outcome = await sendAndSubmit(uploader, [shot("document_front"), shot("document_back")], l);
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
    const outcome = await sendAndSubmit(uploader, [shot("document_front")], l);
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
    expect((await sendAndSubmit(uploader, [shot("document_front")], listener().l)).ok).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("put"))).toHaveLength(2);
    expect(backend.calls.filter((c) => c.startsWith("upload-url"))).toHaveLength(1);
  });

  it("asks for a fresh link when storage refuses the token", async () => {
    const backend = fakeBackend();
    backend.failNext("put", new FlowError("storage_failed", 400));
    const { uploader } = uploaderFor(backend);
    expect((await sendAndSubmit(uploader, [shot("document_front")], listener().l)).ok).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("upload-url"))).toHaveLength(2);
  });

  it("gives up after three tries and resumes on a manual retry", async () => {
    const backend = fakeBackend();
    backend.failNext("completeCapture", new FlowError("network"), new FlowError("network"), new FlowError("timeout"));
    const { uploader, waits } = uploaderFor(backend);
    const front = shot("document_front");
    const first = await sendAndSubmit(uploader, [front], listener().l);
    expect(first).toEqual({ ok: false, error: "timeout", side: "document_front" });
    expect(waits).toEqual([1500, 3000]);

    const second = await sendAndSubmit(uploader, [front], listener().l);
    expect(second.ok).toBe(true);
    // The photo was stored once; only the confirmation was repeated.
    expect(backend.calls.filter((c) => c.startsWith("put"))).toHaveLength(1);
    expect(backend.calls.filter((c) => c.startsWith("upload-url"))).toHaveLength(1);
  });

  it("does not retry a permanent error", async () => {
    const backend = fakeBackend();
    backend.failNext("uploadUrl", new FlowError("too_many_uploads", 429));
    const { uploader, waits } = uploaderFor(backend);
    expect(await sendAndSubmit(uploader, [shot("document_front")], listener().l)).toEqual({
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
    expect(await sendAndSubmit(uploader, [back], listener().l)).toEqual({
      ok: false,
      error: "image_too_small",
      side: "document_back",
    });
    await sendAndSubmit(uploader, [back], listener().l);
    expect(backend.calls.filter((c) => c.startsWith("upload-url"))).toHaveLength(2);
  });

  it("treats already_submitted on a retried submit as success when the session is submitted", async () => {
    const backend = fakeBackend();
    backend.failNext("submit", new FlowError("network"), new FlowError("already_submitted", 409));
    const { uploader } = uploaderFor(backend);
    expect(await uploader.submit(listener().l)).toEqual({ ok: true, session: submitted });
    expect(backend.calls).toEqual(["submit", "submit", "session"]);
  });

  it("treats already_submitted after the rider's retry as success when an earlier call had submitted", async () => {
    const backend = fakeBackend();
    // Every automatic try loses its answer; the server did record the first one.
    backend.failNext("submit", new FlowError("network"), new FlowError("network"), new FlowError("network"));
    const { uploader } = uploaderFor(backend);
    expect(await uploader.submit(listener().l)).toEqual({ ok: false, error: "network", side: null });
    backend.failNext("submit", new FlowError("already_submitted", 409));
    expect(await uploader.submit(listener().l)).toEqual({ ok: true, session: submitted });
    expect(backend.calls.slice(-2)).toEqual(["submit", "session"]);
  });

  it("reports already_submitted on a first submit", async () => {
    const backend = fakeBackend();
    backend.failNext("submit", new FlowError("already_submitted", 409));
    const { uploader } = uploaderFor(backend);
    expect(await uploader.submit(listener().l)).toEqual({ ok: false, error: "already_submitted", side: null });
  });
});

describe("the MRZ report", () => {
  it("is sent once, right after its photo is confirmed, naming the capture", async () => {
    const backend = fakeBackend();
    const { uploader } = uploaderFor(backend);
    const { l, progress, done } = listener();
    const outcome = await sendAndSubmit(uploader, [shot("document_front"), readShot("document_back", "valid", 2)], l);
    expect(outcome).toEqual({ ok: true, session: submitted });
    expect(backend.calls).toEqual([
      "upload-url:document_front",
      `put:${VID}/document_front-1.jpg:tok1`,
      `captures:${VID}/document_front-1.jpg`,
      "upload-url:document_back",
      `put:${VID}/document_back-2.jpg:tok2`,
      `captures:${VID}/document_back-2.jpg`,
      "mrz:capture-document_back:read",
      "submit",
    ]);
    expect(done).toEqual(["document_front", "document_back"]);
    expect(backend.api.reportMrz).toHaveBeenCalledWith({
      captureId: "capture-document_back",
      result: "read",
      lines: TD3,
      corrections: 1,
      ms: 413,
      attempts: 2,
      engine: OCR_ASSETS.engine,
    });
    // Three steps per photo, one more for the report, and the submit.
    expect(progress.every((p) => p.total === 8)).toBe(true);
    expect(progress.map((p) => [p.phase, p.done, p.photo])).toEqual([
      ["link", 0, 1],
      ["send", 1, 1],
      ["check", 2, 1],
      ["link", 3, 2],
      ["send", 4, 2],
      ["check", 5, 2],
      ["check", 6, 2],
      ["submit", 7, 0],
    ]);
  });

  it("counts its step in the progress total", () => {
    expect(uploadSteps([])).toBe(1);
    expect(uploadSteps([shot("document_front"), shot("document_back")])).toBe(2 * STEPS_PER_PHOTO + 1);
    expect(uploadSteps([shot("document_front"), readShot("document_back")])).toBe(2 * STEPS_PER_PHOTO + 2);
  });

  it("is retried on a network error", async () => {
    const backend = fakeBackend();
    backend.failNext("reportMrz", new FlowError("network"));
    const { uploader, waits } = uploaderFor(backend);
    expect((await sendAndSubmit(uploader, [readShot("document_front")], listener().l)).ok).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("mrz"))).toHaveLength(2);
    expect(waits).toEqual([1500]);
  });

  it("never holds back the submit, and is sent again on the rider's next try with the same capture", async () => {
    const backend = fakeBackend();
    backend.failNext("reportMrz", new FlowError("server_error", 503), new FlowError("network"), new FlowError("timeout"));
    backend.failNext("submit", new FlowError("network"), new FlowError("network"), new FlowError("network"));
    const { uploader } = uploaderFor(backend);
    const front = readShot("document_front", "invalid", 3);
    const first = await sendAndSubmit(uploader, [front], listener().l);
    expect(first).toEqual({ ok: false, error: "network", side: null });
    expect(backend.calls.filter((c) => c.startsWith("mrz"))).toHaveLength(3);
    expect(backend.calls.filter((c) => c === "submit")).toHaveLength(3);

    // The rider's "Try again" (the checks are over): only the report and the submit remain.
    const before = backend.calls.length;
    const second = await uploader.submit(listener().l);
    expect(second).toEqual({ ok: true, session: submitted });
    expect(backend.calls.slice(before)).toEqual(["mrz:capture-document_front:read", "submit"]);
    expect(backend.api.reportMrz).toHaveBeenLastCalledWith(
      expect.objectContaining({ captureId: "capture-document_front", attempts: 3, result: "read" }),
    );
  });

  it("does not stop the upload when every try fails", async () => {
    const backend = fakeBackend();
    backend.failNext("reportMrz", new FlowError("network"), new FlowError("network"), new FlowError("network"));
    const { uploader } = uploaderFor(backend);
    const outcome = await sendAndSubmit(uploader, [readShot("document_front")], listener().l);
    expect(outcome).toEqual({ ok: true, session: submitted });
    expect(backend.calls.slice(-1)).toEqual(["submit"]);
  });

  it("is dropped, not retried, when the server refuses it for good", async () => {
    const backend = fakeBackend();
    backend.failNext("reportMrz", new FlowError("invalid_mrz", 422));
    backend.failNext("submit", new FlowError("network"), new FlowError("network"), new FlowError("network"));
    const { uploader, waits, warnings } = uploaderFor(backend);
    expect((await sendAndSubmit(uploader, [readShot("document_front")], listener().l)).ok).toBe(false);
    expect(backend.calls.filter((c) => c.startsWith("mrz"))).toHaveLength(1);
    // Only the submit's tries waited.
    expect(waits).toEqual([1500, 3000]);
    expect(warnings).toEqual(["MRZ report not recorded: invalid_mrz"]);
    expect(warnings.join()).not.toContain("UTO");

    expect((await uploader.submit(listener().l)).ok).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("mrz"))).toHaveLength(1);
  });

  it("is not sent again once recorded, even when a later step fails", async () => {
    const backend = fakeBackend();
    backend.failNext("submit", new FlowError("network"), new FlowError("network"), new FlowError("network"));
    const { uploader } = uploaderFor(backend);
    expect((await sendAndSubmit(uploader, [readShot("document_front")], listener().l)).ok).toBe(false);
    expect((await uploader.submit(listener().l)).ok).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("mrz"))).toEqual(["mrz:capture-document_front:read"]);
  });

  it("waits for the photo: no report when its confirmation failed", async () => {
    const backend = fakeBackend();
    backend.failNext("completeCapture", new FlowError("image_too_small", 422));
    const { uploader } = uploaderFor(backend);
    expect(await sendAndSubmit(uploader, [readShot("document_front")], listener().l)).toEqual({
      ok: false,
      error: "image_too_small",
      side: "document_front",
    });
    expect(backend.api.reportMrz).not.toHaveBeenCalled();
  });
});

describe("uploadSides and submit", () => {
  it("sends the photos without submitting: the server checks them first", async () => {
    const backend = fakeBackend();
    const { uploader } = uploaderFor(backend);
    const { l, done, progress } = listener();
    expect(await uploader.uploadSides([shot("document_front"), readShot("document_back")], l)).toEqual({ ok: true });
    expect(backend.calls).toEqual([
      "upload-url:document_front",
      `put:${VID}/document_front-1.jpg:tok1`,
      `captures:${VID}/document_front-1.jpg`,
      "upload-url:document_back",
      `put:${VID}/document_back-2.jpg:tok2`,
      `captures:${VID}/document_back-2.jpg`,
      "mrz:capture-document_back:read",
    ]);
    expect(done).toEqual(["document_front", "document_back"]);
    // The bar keeps its last step for the submit.
    expect(progress.at(-1)).toMatchObject({ done: 6, total: 8 });
    expect(progress.some((p) => p.phase === "submit")).toBe(false);
    expect(backend.api.submit).not.toHaveBeenCalled();
  });

  it("places the submit at the end of the photos' progress bar", async () => {
    const backend = fakeBackend();
    const { uploader } = uploaderFor(backend);
    const { l, progress } = listener();
    expect(await uploader.submit(l, { total: 7, photos: 2 })).toEqual({ ok: true, session: submitted });
    expect(progress).toEqual([{ done: 6, total: 7, phase: "submit", photo: 0, photos: 2, attempt: 1 }]);

    const alone = listener();
    await uploader.submit(alone.l);
    expect(alone.progress).toEqual([{ done: 0, total: 1, phase: "submit", photo: 0, photos: 0, attempt: 1 }]);
  });

  it("sends only the photo retaken for the server, then the submit", async () => {
    const backend = fakeBackend();
    const { uploader } = uploaderFor(backend);
    const front = shot("document_front");
    expect((await uploader.uploadSides([front, shot("document_back")], listener().l)).ok).toBe(true);
    // The server asked for the back again: the front stays on the server.
    const before = backend.calls.length;
    expect((await sendAndSubmit(uploader, [shot("document_back")], listener().l)).ok).toBe(true);
    expect(backend.calls.slice(before)).toEqual([
      "upload-url:document_back",
      `put:${VID}/document_back-3.jpg:tok3`,
      `captures:${VID}/document_back-3.jpg`,
      "submit",
    ]);
  });

  it("tries a missing report again before the submit when its photo stays, not when it was retaken", async () => {
    const backend = fakeBackend();
    const { uploader } = uploaderFor(backend);
    const back = readShot("document_back", "valid", 1);
    // The back's report fails on every try; the server then asks for the front again.
    backend.failNext("reportMrz", new FlowError("network"), new FlowError("network"), new FlowError("network"));
    expect((await uploader.uploadSides([shot("document_front"), back], listener().l)).ok).toBe(true);
    const before = backend.calls.length;
    expect((await sendAndSubmit(uploader, [shot("document_front")], listener().l)).ok).toBe(true);
    expect(backend.calls.slice(before)).toEqual([
      "upload-url:document_front",
      `put:${VID}/document_front-3.jpg:tok3`,
      `captures:${VID}/document_front-3.jpg`,
      "mrz:capture-document_back:read",
      "submit",
    ]);
    expect(backend.api.reportMrz).toHaveBeenLastCalledWith(expect.objectContaining({ attempts: 1 }));
  });

  it("drops the missing report of a photo the server asked for again: the new photo has its own", async () => {
    const backend = fakeBackend();
    const { uploader } = uploaderFor(backend);
    backend.failNext("reportMrz", new FlowError("network"), new FlowError("network"), new FlowError("network"));
    expect((await uploader.uploadSides([readShot("document_front", "valid", 1)], listener().l)).ok).toBe(true);
    // Read again on the phone (second read of the side), sent, then submitted.
    const before = backend.calls.length;
    expect((await sendAndSubmit(uploader, [readShot("document_front", "invalid", 2)], listener().l)).ok).toBe(true);
    expect(backend.calls.slice(before).filter((c) => c.startsWith("mrz"))).toHaveLength(1);
    expect(backend.api.reportMrz).toHaveBeenLastCalledWith(expect.objectContaining({ attempts: 2 }));
    expect(backend.calls.at(-1)).toBe("submit");
  });

  it("gives a failed report one round per action of the rider", async () => {
    const backend = fakeBackend();
    const { uploader } = uploaderFor(backend);
    backend.failNext("reportMrz", ...Array.from({ length: 6 }, () => new FlowError("network")));
    backend.failNext("submit", new FlowError("network"), new FlowError("network"), new FlowError("network"));
    // "Use this photo": three tries right after the photo, none more before the submit that follows.
    expect((await sendAndSubmit(uploader, [readShot("document_front")], listener().l)).ok).toBe(false);
    expect(backend.calls.filter((c) => c.startsWith("mrz"))).toHaveLength(3);
    // "Try again": three more, then the submit.
    expect((await uploader.submit(listener().l)).ok).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("mrz"))).toHaveLength(6);
    expect(backend.calls.at(-1)).toBe("submit");
  });
});

describe("mrzReport", () => {
  const ID = "c0ffee00-0000-4000-8000-000000000001";

  it("sends the lines whenever a complete MRZ was read, right or not", () => {
    expect(mrzReport(read("valid"), 1, ID)).toEqual({
      captureId: ID,
      result: "read",
      lines: TD3,
      corrections: 1,
      ms: 413,
      attempts: 1,
      engine: OCR_ASSETS.engine,
    });
    expect(mrzReport(read("invalid"), 3, ID)).toMatchObject({ result: "read", lines: TD3, attempts: 3 });
  });

  it("says why nothing was read, without lines", () => {
    expect(mrzReport(read("not_found"), 2, ID)).toEqual({
      captureId: ID,
      result: "unreadable",
      reason: "not_found",
      attempts: 2,
      engine: OCR_ASSETS.engine,
    });
    expect(mrzReport(read("unavailable"), 1, ID)).toMatchObject({ result: "unreadable", reason: "reader_unavailable" });
  });

  it("names the model that read (M4: our own on test sessions), so the server records it", () => {
    expect(mrzReport(read("valid", { engine: "tesseract.js-7.0.0/mrz-2" }), 1, ID).engine).toBe("tesseract.js-7.0.0/mrz-2");
    expect(mrzReport(read("not_found", { engine: "tesseract.js-7.0.0/mrz-2" }), 1, ID).engine).toBe("tesseract.js-7.0.0/mrz-2");
    // A result without one (never, as built) still sends the default model's label.
    expect(mrzReport(read("valid", { engine: "" }), 1, ID).engine).toBe(OCR_ASSETS.engine);
  });

  it("keeps every number within the server's limits", () => {
    const { maxAttempts, maxCorrections, maxMs } = MRZ_REPORT_LIMITS;
    const report = mrzReport(read("valid", { corrections: 500, ms: 10_000_000 }), 99, ID);
    expect(report).toMatchObject({ attempts: maxAttempts, corrections: maxCorrections, ms: maxMs });
    expect(mrzReport(read("valid", { corrections: -1, ms: Number.NaN }), 0, ID)).toMatchObject({
      attempts: 1,
      corrections: 0,
      ms: 0,
    });
  });

  it("never carries the raw OCR text", () => {
    expect(JSON.stringify(mrzReport(read("valid"), 1, ID))).not.toContain("ERIKSS0N");
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
