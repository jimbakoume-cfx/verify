import { type Mock, afterEach, describe, expect, it, vi } from "vitest";
import {
  LOAD_STAGES,
  MRZ_WHITELIST,
  OcrError,
  type TesseractLoggerMessage,
  type TesseractModule,
  type TesseractWorker,
  createOcrEngine,
} from "./ocrEngine";
import { OCR_ASSETS } from "./types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeWorker extends TesseractWorker {
  setParameters: Mock<TesseractWorker["setParameters"]>;
  recognize: Mock<TesseractWorker["recognize"]>;
  terminate: Mock<TesseractWorker["terminate"]>;
}

/**
 * A stand-in for tesseract.js. `start` decides how each createWorker call goes (default: start at
 * once); `read` answers each recognize call (default: "TEXT").
 */
function fakeTesseract(
  options: {
    start?: (call: number, opts: Record<string, unknown>) => Promise<void> | void;
    read?: (image: Uint8Array, call: number) => Promise<string>;
  } = {},
) {
  const workers: FakeWorker[] = [];
  const created: { langs: string; oem: number; options: Record<string, unknown>; config: Record<string, string> }[] = [];
  let reads = 0;
  const module: TesseractModule = {
    createWorker: vi.fn(async (langs: string, oem: number, opts: Record<string, unknown>, config: Record<string, string>) => {
      created.push({ langs, oem, options: opts, config });
      const log = opts.logger as (m: TesseractLoggerMessage) => void;
      for (const status of ["loading tesseract core", "initializing tesseract", "loading language traineddata", "initializing api"]) {
        log({ status, progress: 0 });
        log({ status, progress: 1 });
      }
      await options.start?.(created.length, opts);
      const worker: FakeWorker = {
        setParameters: vi.fn(async () => ({})),
        recognize: vi.fn(async (image: Uint8Array) => {
          log({ status: "recognizing text", progress: 0.5 });
          return { data: { text: await (options.read?.(image, ++reads) ?? Promise.resolve("TEXT")) } };
        }),
        terminate: vi.fn(async () => ({})),
      };
      workers.push(worker);
      return worker;
    }),
  };
  const loadModule = vi.fn(async () => module);
  return { module, loadModule, workers, created };
}

const image = new Uint8Array([1, 2, 3]);

afterEach(() => {
  vi.useRealTimers();
});

describe("createOcrEngine", () => {
  it("imports tesseract.js only when first needed", async () => {
    const fake = fakeTesseract();
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    expect(fake.loadModule).not.toHaveBeenCalled();
    engine.warmUp();
    engine.warmUp();
    await engine.ready();
    expect(fake.loadModule).toHaveBeenCalledTimes(1);
    expect(fake.module.createWorker).toHaveBeenCalledTimes(1);
  });

  it("starts tesseract.js with our own files, the LSTM engine, no dictionaries, and the MRZ alphabet", async () => {
    const fake = fakeTesseract();
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    await engine.ready();
    const [{ langs, oem, options, config }] = fake.created;
    expect(langs).toBe("mrz");
    expect(oem).toBe(1);
    expect(options).toMatchObject({
      workerPath: OCR_ASSETS.workerPath,
      corePath: OCR_ASSETS.corePath,
      langPath: OCR_ASSETS.langPath,
      cachePath: OCR_ASSETS.cachePath,
      gzip: true,
      workerBlobURL: false,
    });
    expect(options).not.toHaveProperty("cacheMethod");
    expect(typeof options.errorHandler).toBe("function");
    expect(config).toEqual({ load_system_dawg: "0", load_freq_dawg: "0" });
    expect(fake.workers[0].setParameters).toHaveBeenCalledWith({
      tessedit_char_whitelist: MRZ_WHITELIST,
      tessedit_pageseg_mode: "6",
    });
    expect(MRZ_WHITELIST).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<");
  });

  it("leaves the worker and core paths to tesseract.js when unset (Node)", async () => {
    const fake = fakeTesseract();
    const engine = createOcrEngine({
      loadModule: fake.loadModule,
      isSupported: () => true,
      workerPath: undefined,
      corePath: undefined,
      langPath: "/models",
      cacheMethod: "none",
    });
    await engine.ready();
    const { options } = fake.created[0];
    expect(options).not.toHaveProperty("workerPath");
    expect(options).not.toHaveProperty("corePath");
    expect(options).toMatchObject({ langPath: "/models", cacheMethod: "none" });
  });

  it("reports the start-up progress, rising to 1, and nothing once started", async () => {
    const fake = fakeTesseract();
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    const seen: number[] = [];
    await engine.ready({ onProgress: (p) => seen.push(p) });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen).toContain(LOAD_STAGES["initializing tesseract"][0]);
    const later: number[] = [];
    await engine.ready({ onProgress: (p) => later.push(p) });
    await engine.recognize(image);
    expect(later).toEqual([]);
  });

  it("moves the bar on with time while a stage downloads, but only tesseract.js completes a stage", async () => {
    // tesseract.js reports the core and the model only when their download starts and ends.
    vi.useFakeTimers();
    const core = deferred<void>();
    const model = deferred<void>();
    const worker: TesseractWorker = {
      setParameters: vi.fn(async () => ({})),
      recognize: vi.fn(async () => ({ data: { text: "TEXT" } })),
      terminate: vi.fn(async () => ({})),
    };
    const module: TesseractModule = {
      createWorker: vi.fn(async (_langs: string, _oem: number, opts: Record<string, unknown>) => {
        const log = opts.logger as (m: TesseractLoggerMessage) => void;
        log({ status: "loading tesseract core", progress: 0 });
        await core.promise;
        log({ status: "loading tesseract core", progress: 1 });
        log({ status: "initializing tesseract", progress: 0 });
        log({ status: "initializing tesseract", progress: 1 });
        log({ status: "loading language traineddata", progress: 0 });
        await model.promise;
        log({ status: "loading language traineddata", progress: 0.5 });
        log({ status: "loading language traineddata", progress: 1 });
        log({ status: "initializing api", progress: 0 });
        log({ status: "initializing api", progress: 1 });
        return worker;
      }),
    };
    const engine = createOcrEngine({ loadModule: async () => module, isSupported: () => true, loadTimeoutMs: 3_600_000 });
    const seen: number[] = [];
    const ready = engine.ready({ onProgress: (p) => seen.push(p) });
    const [, coreEnd] = LOAD_STAGES["loading tesseract core"];
    const [modelStart, modelEnd] = LOAD_STAGES["loading language traineddata"];

    await vi.advanceTimersByTimeAsync(5_000);
    const early = seen.at(-1) ?? 0;
    expect(early).toBeGreaterThan(0.05);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(seen.at(-1)).toBeGreaterThan(early);
    expect(seen.at(-1)).toBeLessThan(coreEnd);

    core.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toBe(modelStart);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen.at(-1)).toBeGreaterThan(modelStart);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(seen.at(-1)).toBeLessThan(modelEnd);

    model.resolve();
    await ready;
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    // The estimate stops with the start-up.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a new listener from 0, not from where a failed start-up stopped", async () => {
    const fake = fakeTesseract({
      start: (call, opts) => {
        if (call > 1) return;
        (opts.errorHandler as (e: unknown) => void)("Network error while fetching mrz.traineddata.gz");
        return new Promise(() => {});
      },
    });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    const first: number[] = [];
    await expect(engine.ready({ onProgress: (p) => first.push(p) })).rejects.toMatchObject({ reason: "load_failed" });
    // The fake reports every stage before it fails.
    expect(first.at(-1)).toBe(1);
    const second: number[] = [];
    await engine.ready({ onProgress: (p) => second.push(p) });
    expect(second[0]).toBe(0);
    for (let i = 1; i < second.length; i++) expect(second[i]).toBeGreaterThan(second[i - 1]);
  });

  it("reports nothing while it restarts after a cancelled read: the files are cached by then", async () => {
    const fake = fakeTesseract({ read: (_image, call) => (call === 1 ? new Promise(() => {}) : Promise.resolve("AGAIN")) });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    const first: number[] = [];
    await engine.ready({ onProgress: (p) => first.push(p) });
    expect(first.at(-1)).toBe(1);
    const controller = new AbortController();
    const read = engine.recognize(image, { signal: controller.signal });
    await vi.waitFor(() => expect(fake.workers[0].recognize).toHaveBeenCalled());
    controller.abort();
    await expect(read).rejects.toMatchObject({ reason: "aborted" });

    const restart: number[] = [];
    await engine.ready({ onProgress: (p) => restart.push(p) });
    expect(fake.workers).toHaveLength(2);
    expect(restart).toEqual([]);
    expect(await engine.recognize(image)).toBe("AGAIN");
  });

  it("reports nothing for a start-up it refuses at once", async () => {
    const seen: number[] = [];
    const engine = createOcrEngine({ loadModule: fakeTesseract().loadModule, isSupported: () => false });
    await expect(engine.ready({ onProgress: (p) => seen.push(p) })).rejects.toMatchObject({ reason: "unsupported" });
    expect(seen).toEqual([]);
  });

  it("is unavailable without WebAssembly or Web Workers, and loads nothing", async () => {
    const fake = fakeTesseract();
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => false });
    await expect(engine.ready()).rejects.toMatchObject({ reason: "unsupported" });
    await expect(engine.recognize(image)).rejects.toBeInstanceOf(OcrError);
    expect(fake.loadModule).not.toHaveBeenCalled();
  });

  it("fails a start that tesseract.js reports through errorHandler, and stops after two", async () => {
    // tesseract.js never settles createWorker when the model download fails: it only calls
    // errorHandler.
    const fake = fakeTesseract({
      start: (_call, opts) => {
        (opts.errorHandler as (e: unknown) => void)("Network error while fetching mrz.traineddata.gz");
        return new Promise(() => {});
      },
    });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    await expect(engine.ready()).rejects.toMatchObject({ reason: "load_failed" });
    await expect(engine.recognize(image)).rejects.toMatchObject({ reason: "load_failed" });
    expect(fake.module.createWorker).toHaveBeenCalledTimes(2);
    // Each failed start leaves a worker behind in tesseract.js: no third try.
    await expect(engine.ready()).rejects.toMatchObject({ reason: "load_failed" });
    expect(fake.module.createWorker).toHaveBeenCalledTimes(2);
  });

  it("fails a start that fails to import, and recovers on the next try", async () => {
    const fake = fakeTesseract();
    const loadModule = vi.fn().mockRejectedValueOnce(new Error("chunk failed")).mockImplementation(fake.loadModule);
    const engine = createOcrEngine({ loadModule, isSupported: () => true });
    await expect(engine.ready()).rejects.toMatchObject({ reason: "load_failed" });
    await engine.ready();
    expect(await engine.recognize(image)).toBe("TEXT");
  });

  it("times out a slow start and terminates the worker if it starts afterwards", async () => {
    vi.useFakeTimers();
    const late = deferred<void>();
    const fake = fakeTesseract({ start: (call) => (call === 1 ? late.promise : undefined) });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true, loadTimeoutMs: 60_000 });
    const ready = engine.ready();
    const check = expect(ready).rejects.toMatchObject({ reason: "load_timeout" });
    await vi.advanceTimersByTimeAsync(60_000);
    await check;
    late.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.workers[0].terminate).toHaveBeenCalled();
    // The next read starts afresh.
    expect(await engine.recognize(image)).toBe("TEXT");
    expect(fake.module.createWorker).toHaveBeenCalledTimes(2);
  });

  it("does not stop the start-up when a wait for it is cancelled", async () => {
    const gate = deferred<void>();
    const fake = fakeTesseract({ start: () => gate.promise });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    const controller = new AbortController();
    const waiting = engine.ready({ signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ reason: "aborted" });
    gate.resolve();
    await engine.ready();
    expect(fake.module.createWorker).toHaveBeenCalledTimes(1);
    expect(fake.workers[0].terminate).not.toHaveBeenCalled();
  });

  it("returns the text of each read, one job at a time", async () => {
    const first = deferred<string>();
    const fake = fakeTesseract({ read: (_image, call) => (call === 1 ? first.promise : Promise.resolve("SECOND")) });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    const a = engine.recognize(image);
    const b = engine.recognize(new Uint8Array([9]));
    await vi.waitFor(() => expect(fake.workers[0]?.recognize).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.workers[0].recognize).toHaveBeenCalledTimes(1);
    first.resolve("FIRST");
    expect(await a).toBe("FIRST");
    expect(await b).toBe("SECOND");
    expect(fake.workers[0].recognize).toHaveBeenLastCalledWith(new Uint8Array([9]));
  });

  it("terminates the worker when a read takes too long; the next read starts a new one", async () => {
    vi.useFakeTimers();
    const fake = fakeTesseract({ read: (_image, call) => (call === 1 ? new Promise(() => {}) : Promise.resolve("AGAIN")) });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true, readTimeoutMs: 20_000 });
    await engine.ready();
    const slow = engine.recognize(image);
    const check = expect(slow).rejects.toMatchObject({ reason: "read_timeout" });
    await vi.advanceTimersByTimeAsync(20_000);
    await check;
    expect(fake.workers[0].terminate).toHaveBeenCalled();
    const next = engine.recognize(image);
    await vi.advanceTimersByTimeAsync(0);
    expect(await next).toBe("AGAIN");
    expect(fake.workers).toHaveLength(2);
  });

  it("terminates the worker when a read is cancelled", async () => {
    const fake = fakeTesseract({ read: (_image, call) => (call === 1 ? new Promise(() => {}) : Promise.resolve("AGAIN")) });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    await engine.ready();
    const controller = new AbortController();
    const read = engine.recognize(image, { signal: controller.signal });
    await vi.waitFor(() => expect(fake.workers[0].recognize).toHaveBeenCalled());
    controller.abort();
    await expect(read).rejects.toMatchObject({ reason: "aborted" });
    expect(fake.workers[0].terminate).toHaveBeenCalled();
    expect(await engine.recognize(image)).toBe("AGAIN");
    // An already-cancelled read does not even start.
    await expect(engine.recognize(image, { signal: AbortSignal.abort() })).rejects.toMatchObject({ reason: "aborted" });
  });

  it("rejects a failed job as read_failed", async () => {
    const fake = fakeTesseract({ read: () => Promise.reject("Error attempting to read image.") });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    await expect(engine.recognize(image)).rejects.toMatchObject({ reason: "read_failed" });
  });

  it("terminates the worker on dispose, also one still starting, and starts anew afterwards", async () => {
    const gate = deferred<void>();
    const fake = fakeTesseract({ start: (call) => (call === 2 ? gate.promise : undefined) });
    const engine = createOcrEngine({ loadModule: fake.loadModule, isSupported: () => true });
    await engine.ready();
    engine.dispose();
    expect(fake.workers[0].terminate).toHaveBeenCalled();
    // Dispose while the second worker is starting: it is terminated as soon as it is up.
    const starting = engine.ready();
    await vi.waitFor(() => expect(fake.module.createWorker).toHaveBeenCalledTimes(2));
    engine.dispose();
    gate.resolve();
    await expect(starting).rejects.toMatchObject({ reason: "aborted" });
    expect(fake.workers[1].terminate).toHaveBeenCalled();
    expect(await engine.recognize(image)).toBe("TEXT");
    expect(fake.workers).toHaveLength(3);
  });
});
