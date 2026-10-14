// The OCR engine: tesseract.js (Tesseract compiled to WebAssembly, in a Web Worker) with the MRZ
// model. tesseract.js is imported lazily, so the main bundle does not grow; every file comes from
// our own site (OCR_ASSETS), never from a CDN.
//
// One worker is kept for the session. Jobs run one at a time. A read that is cancelled or takes
// too long terminates the worker (Tesseract cannot stop a job half-way) and the next read starts a
// fresh one, so a stale job never delays the next read. Only the first start-up on the page reports
// its progress: it is the one that may download the files. A failed start leaves its worker running
// inside tesseract.js (it gives no handle on it), so the engine stops retrying after a few.
import { OCR_ASSETS } from "./types";

/** The part of tesseract.js used here, kept narrow so tests can stand in a fake. */
export interface TesseractWorker {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(image: Uint8Array): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

export interface TesseractLoggerMessage {
  status: string;
  progress: number;
}

export interface TesseractModule {
  createWorker(
    langs: string,
    oem: number,
    options: Record<string, unknown>,
    config: Record<string, string>,
  ): Promise<TesseractWorker>;
}

export interface OcrEngineOptions {
  /**
   * Worker script and folder of the WebAssembly core. Leave both unset in Node: tesseract.js then
   * uses its own Node worker and loads the core from node_modules.
   */
  workerPath?: string;
  corePath?: string;
  /** Folder of `<language>.traineddata.gz`: a URL in the browser, a URL or folder in Node. */
  langPath: string;
  language: string;
  /** IndexedDB key prefix of the cached model. */
  cachePath: string;
  /** "none" never reads or writes a cached model (tests). Default: tesseract.js's ("write"). */
  cacheMethod?: "write" | "readOnly" | "refresh" | "none";
  /** Download and start-up of the engine, first use; the model is cached afterwards. */
  loadTimeoutMs: number;
  /** One OCR job. */
  readTimeoutMs: number;
  /** Failed starts in a row after which the engine stops trying for this page. */
  maxLoadFailures: number;
  /** Imports tesseract.js. */
  loadModule: () => Promise<TesseractModule>;
  /** False when this browser cannot run the engine (no WebAssembly or no Web Workers). */
  isSupported: () => boolean;
}

export const OCR_ENGINE_DEFAULTS: OcrEngineOptions = {
  workerPath: OCR_ASSETS.workerPath,
  corePath: OCR_ASSETS.corePath,
  langPath: OCR_ASSETS.langPath,
  language: OCR_ASSETS.language,
  cachePath: OCR_ASSETS.cachePath,
  // About 2.8 MB the first time: 60 s allows a slow 3G connection.
  loadTimeoutMs: 60_000,
  // A read takes 0.2-2 s; 20 s means the phone is struggling, and the rider must not wait longer.
  readTimeoutMs: 20_000,
  maxLoadFailures: 2,
  loadModule: importTesseract,
  isSupported: canRunWebAssembly,
};

/** Characters of the MRZ alphabet: the model reads nothing else. */
export const MRZ_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";

export type OcrFailure = "unsupported" | "load_failed" | "load_timeout" | "read_failed" | "read_timeout" | "aborted";

export class OcrError extends Error {
  constructor(readonly reason: OcrFailure, cause?: unknown) {
    super(`OCR ${reason}`, cause === undefined ? undefined : { cause });
    this.name = "OcrError";
  }
}

export interface OcrEngine {
  /** Starts downloading and starting the engine in the background. Safe to call repeatedly. */
  warmUp(): void;
  /**
   * Resolves when the engine is ready to read. While its first start-up on this page is still
   * running (the one that may download the files), `onProgress` gets its progress (0..1); a
   * restart reports nothing, since the files are cached by then. Rejects with an OcrError.
   * Cancelling the wait does not stop the start-up, which a later read can use.
   */
  ready(options?: { signal?: AbortSignal; onProgress?: (progress: number) => void }): Promise<void>;
  /** Reads `image` (an encoded image, e.g. PGM) and returns the raw text. Rejects with an OcrError. */
  recognize(image: Uint8Array, options?: { signal?: AbortSignal }): Promise<string>;
  /** Terminates the worker and frees its memory. A later call starts a new one. */
  dispose(): void;
}

/**
 * Share of the start-up progress bar given to each tesseract.js status, in the order they come.
 * The shares follow what the first start-up downloads: the worker script and the WebAssembly core
 * (about 1.5 MB) before the core is loaded, then the model (about 1.3 MB).
 */
export const LOAD_STAGES: Record<string, [number, number]> = {
  "loading tesseract core": [0, 0.52],
  "initializing tesseract": [0.52, 0.55],
  "loading language traineddata": [0.55, 0.97],
  "initializing api": [0.97, 1],
};

/**
 * tesseract.js reports a stage only when it starts and when it ends, never during a download: on a
 * slow connection the bar would stand still for tens of seconds and look stuck. So in between, the
 * bar moves on with time, more and more slowly, towards 90% of the current stage; only
 * tesseract.js's own report completes a stage. 15 s is about what 1.5 MB takes on slow 3G.
 */
const ESTIMATE = { everyMs: 250, timeConstantMs: 15_000, maxShare: 0.9 };

/**
 * Web Workers and WebAssembly are there, and WebAssembly may be compiled. Compiling the smallest
 * module ("\0asm", version 1) fails at once where the page's CSP lacks 'wasm-unsafe-eval' or the
 * browser forbids WebAssembly (iOS Lockdown Mode): the engine would otherwise fail inside its
 * worker, unseen, and the rider would wait for the start-up timeout.
 */
function canRunWebAssembly(): boolean {
  if (typeof WebAssembly !== "object" || typeof Worker !== "function") return false;
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return true;
  } catch {
    return false;
  }
}

async function importTesseract(): Promise<TesseractModule> {
  // tesseract.js is CommonJS: depending on the bundler its functions are on the namespace or on
  // its default export.
  const mod = (await import("tesseract.js")) as unknown as Partial<TesseractModule> & { default?: TesseractModule };
  if (typeof mod.createWorker === "function") return mod as TesseractModule;
  if (mod.default && typeof mod.default.createWorker === "function") return mod.default;
  throw new Error("tesseract.js has no createWorker");
}

export function createOcrEngine(overrides: Partial<OcrEngineOptions> = {}): OcrEngine {
  const opts: OcrEngineOptions = { ...OCR_ENGINE_DEFAULTS, ...overrides };
  let worker: TesseractWorker | null = null;
  let loading: Promise<TesseractWorker> | null = null;
  let failures = 0;
  // Bumped by dispose(): a start-up that finishes afterwards terminates its worker.
  let generation = 0;
  // A worker started on this page before: a restart (after a cancelled or timed-out read) then
  // finds every file in the browser's cache, takes a moment, and reports no progress.
  let startedBefore = false;
  // Whether the current start-up reports its progress (to ready()'s listeners), and how far it is.
  let reporting = false;
  let progress = 0;
  const listeners = new Set<(progress: number) => void>();
  // Jobs run one at a time; each waits for the previous one to settle.
  let queue: Promise<void> = Promise.resolve();

  const report = (value: number) => {
    if (value <= progress) return;
    progress = value;
    for (const listener of listeners) listener(progress);
  };

  const start = (): Promise<TesseractWorker> => {
    if (worker) return Promise.resolve(worker);
    if (loading) return loading;
    if (!opts.isSupported()) return Promise.reject(new OcrError("unsupported"));
    if (failures >= opts.maxLoadFailures) return Promise.reject(new OcrError("load_failed"));
    const gen = generation;
    const reports = !startedBefore;
    reporting = reports;
    progress = 0;
    let created: Promise<TesseractWorker> | null = null;
    let started = false;
    // The stage under way, for the estimate between tesseract.js's reports (see ESTIMATE).
    let stage = { status: "loading tesseract core", since: Date.now() };
    const estimate = () => {
      const [from, to] = LOAD_STAGES[stage.status];
      const share = ESTIMATE.maxShare * (1 - Math.exp(-(Date.now() - stage.since) / ESTIMATE.timeConstantMs));
      return from + (to - from) * share;
    };
    // Only while this start-up is the engine's current one: after dispose() a newer one may run.
    const show = (value: number) => {
      if (reports && !started && gen === generation) report(value);
    };
    const ticker = reports ? setInterval(() => show(estimate()), ESTIMATE.everyMs) : null;
    const settle = () => {
      started = true;
      if (ticker) clearInterval(ticker);
    };
    const attempt = (async () => {
      const tesseract = await opts.loadModule();
      // tesseract.js reports a failed start (for example the model download) only through
      // errorHandler; its own promise then never settles.
      let fail: (error: unknown) => void = () => {};
      const failed = new Promise<never>((_, reject) => {
        fail = reject;
      });
      const options: Record<string, unknown> = {
        langPath: opts.langPath,
        cachePath: opts.cachePath,
        gzip: true,
        // Load the worker script by its URL: a blob: worker would need a looser CSP.
        workerBlobURL: false,
        logger: (m: TesseractLoggerMessage) => {
          const bounds = LOAD_STAGES[m.status];
          if (!bounds) return;
          if (m.status !== stage.status) stage = { status: m.status, since: Date.now() };
          show(bounds[0] + (bounds[1] - bounds[0]) * Math.max(0, Math.min(1, m.progress)));
        },
        // Without a handler tesseract.js throws from its message listener (and Node exits).
        errorHandler: (error: unknown) => {
          if (!started) fail(error);
        },
      };
      if (opts.workerPath) options.workerPath = opts.workerPath;
      if (opts.corePath) options.corePath = opts.corePath;
      if (opts.cacheMethod) options.cacheMethod = opts.cacheMethod;
      // Dictionaries are words of a language: no use on code lines, and they can only be turned
      // off when the engine starts.
      created = tesseract.createWorker(opts.language, 1, options, { load_system_dawg: "0", load_freq_dawg: "0" });
      const w = await Promise.race([created, failed]);
      // Page segmentation 6: one uniform block of text (the band holds only the code lines).
      await w.setParameters({ tessedit_char_whitelist: MRZ_WHITELIST, tessedit_pageseg_mode: "6" });
      return w;
    })();
    const pending = withTimeout(attempt, opts.loadTimeoutMs, () => new OcrError("load_timeout")).then(
      (w) => {
        settle();
        if (gen !== generation) {
          void w.terminate().catch(() => {});
          throw new OcrError("aborted");
        }
        worker = w;
        loading = null;
        failures = 0;
        startedBefore = true;
        report(1);
        return w;
      },
      (error: unknown) => {
        settle();
        // A worker that finishes starting after we gave up is not needed any more.
        void (created as Promise<TesseractWorker> | null)?.then((w) => w.terminate()).catch(() => {});
        if (gen === generation) {
          loading = null;
          failures++;
        }
        throw error instanceof OcrError ? error : new OcrError("load_failed", error);
      },
    );
    loading = pending;
    return pending;
  };

  /** Terminates `w` if it is still the current worker: the next job starts a new one. */
  const restart = (w: TesseractWorker) => {
    if (worker !== w) return;
    worker = null;
    void w.terminate().catch(() => {});
  };

  return {
    warmUp() {
      start().catch(() => {});
    },

    async ready({ signal, onProgress } = {}) {
      if (worker) return;
      // Start first: a new start-up resets the progress, so a new listener never gets what an
      // earlier one (failed, timed out) had reached. A start refused at once reports nothing.
      const starting = start();
      const listen = onProgress && reporting && loading === starting ? onProgress : null;
      if (listen) {
        listeners.add(listen);
        listen(progress);
      }
      try {
        await abortable(starting, signal);
      } finally {
        if (listen) listeners.delete(listen);
      }
    },

    async recognize(image, { signal } = {}) {
      const previous = queue;
      let release: () => void = () => {};
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await abortable(previous, signal);
        const w = await abortable(start(), signal);
        const job = w.recognize(image).then((result) => result.data.text);
        // A terminated worker leaves its job pending forever: never let it reject unhandled.
        job.catch(() => {});
        try {
          return await withTimeout(abortable(job, signal), opts.readTimeoutMs, () => new OcrError("read_timeout"));
        } catch (error) {
          // Cancelled, timed out or failed: the worker may still be busy with this job.
          restart(w);
          throw error instanceof OcrError ? error : new OcrError("read_failed", error);
        }
      } finally {
        release();
      }
    },

    dispose() {
      generation++;
      loading = null;
      listeners.clear();
      if (worker) {
        const w = worker;
        worker = null;
        void w.terminate().catch(() => {});
      }
    },
  };
}

/** Rejects with OcrError("aborted") as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new OcrError("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OcrError("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
