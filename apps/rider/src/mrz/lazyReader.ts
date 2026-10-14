// The MRZ reader as the flow uses it: reader.ts (and the pipeline it pulls in) is downloaded only
// when a document with code lines is chosen, so the first page stays small and riders with another
// document never fetch it. tesseract.js itself is loaded later still, by the reader's engine.
import type { MrzFormat } from "@verify/shared";
import type { MrzReadResult, MrzReader } from "./types";

/**
 * The reader's code is a small chunk (about 15 KB): a download still pending after this long has
 * stalled (a flaky mobile network), and the browser may not give up on it for minutes.
 */
export const READER_LOAD_TIMEOUT_MS = 30_000;

/** The result of a read that could not run. It never blocks the rider. */
export function unavailableRead(format: MrzFormat): MrzReadResult {
  return {
    status: "unavailable",
    format,
    lines: null,
    parsed: null,
    corrections: 0,
    ms: 0,
    rawText: "",
    charHeight: null,
    rotated: false,
  };
}

export type ReaderModule = { createMrzReader: () => MrzReader };

/**
 * A reader that loads the real one on first use. A failed or stalled download (bad network) is
 * tried again on the next warm-up or read; until then reads come back "unavailable", which never
 * blocks the rider. A cancelled read returns at once, without waiting for the download.
 */
export function createLazyMrzReader(
  load: () => Promise<ReaderModule> = () => import("./reader"),
  loadTimeoutMs = READER_LOAD_TIMEOUT_MS,
): MrzReader {
  let loading: Promise<MrzReader> | null = null;
  let disposed = false;

  const get = (): Promise<MrzReader> => {
    if (!loading) {
      // Without the timeout a stalled download would never settle, and every read (each retake
      // too) would wait on it: the rider would never get past the reading screen.
      const attempt = withTimeout(load(), loadTimeoutMs).then(({ createMrzReader }) => createMrzReader());
      loading = attempt;
      attempt.catch(() => {
        if (loading === attempt) loading = null;
      });
    }
    return loading;
  };

  return {
    warmUp() {
      if (disposed) return;
      get().then(
        (reader) => {
          if (!disposed) reader.warmUp();
        },
        () => {},
      );
    },
    async read(image, expectation, options) {
      const signal = options?.signal;
      if (disposed || signal?.aborted) return unavailableRead(expectation.format);
      try {
        const reader = await untilAborted(get(), signal);
        if (!reader || disposed) return unavailableRead(expectation.format);
        return await reader.read(image, expectation, options);
      } catch {
        return unavailableRead(expectation.format);
      }
    },
    dispose() {
      disposed = true;
      loading?.then(
        (reader) => reader.dispose(),
        () => {},
      );
      loading = null;
    },
  };
}

/** `promise`, or null as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return promise;
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not loaded after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
