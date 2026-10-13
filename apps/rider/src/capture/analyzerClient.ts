// The analysis loop's engine: a Web Worker when the browser has one, else the main thread.
import { DEFAULT_THRESHOLDS, FrameAnalyzer, type QualityThresholds, type Rect } from "@verify/capture";
import type { AnalysisResult, FromWorker, ToWorker } from "./protocol";

export interface Analyzer {
  readonly mode: "worker" | "main";
  /** Analyses one frame. The frame's buffer is transferred to the worker: do not reuse it. */
  analyze(frame: ImageData, guide: Rect): Promise<AnalysisResult>;
  /** Forgets the previous frame and re-arms auto-capture. */
  reset(): void;
  dispose(): void;
}

function mainThreadAnalyzer(thresholds: QualityThresholds): Analyzer {
  const analyzer = new FrameAnalyzer(thresholds);
  return {
    mode: "main",
    async analyze(frame, guide) {
      const started = performance.now();
      const { analysis, decision } = analyzer.push(frame, guide);
      return {
        hints: analysis.hints,
        ok: analysis.ok,
        metrics: analysis.metrics,
        decision,
        progress: analyzer.autoCapture.progress,
        ms: performance.now() - started,
      };
    },
    reset: () => analyzer.reset(),
    dispose: () => undefined,
  };
}

function workerAnalyzer(worker: Worker, overrides: Partial<QualityThresholds>, fallback: () => Analyzer): Analyzer {
  const pending = new Map<number, { resolve: (r: AnalysisResult) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  // If the worker cannot load (old WebView, blocked script), the loop carries on in the main thread.
  let backup: Analyzer | null = null;

  const failAll = () => {
    for (const { reject } of pending.values()) reject(new Error("analyzer worker failed"));
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === "result") {
      const { type: _type, id: _id, ...result } = message;
      entry.resolve(result);
    } else {
      entry.reject(new Error("analysis failed"));
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    worker.terminate();
    backup ??= fallback();
    failAll();
  };
  const post = (message: ToWorker, transfer: Transferable[] = []) => worker.postMessage(message, transfer);
  if (Object.keys(overrides).length > 0) post({ type: "configure", thresholds: overrides });

  return {
    get mode() {
      return backup ? backup.mode : ("worker" as const);
    },
    analyze(frame, guide) {
      if (backup) return backup.analyze(frame, guide);
      const id = nextId++;
      return new Promise<AnalysisResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const buffer = frame.data.buffer as ArrayBuffer;
        post({ type: "frame", id, width: frame.width, height: frame.height, buffer, guide }, [buffer]);
      });
    },
    reset() {
      if (backup) backup.reset();
      else post({ type: "reset" });
    },
    dispose() {
      failAll();
      worker.terminate();
      backup?.dispose();
    },
  };
}

export function createAnalyzer(overrides: Partial<QualityThresholds> = {}): Analyzer {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  if (typeof Worker === "undefined") return mainThreadAnalyzer(thresholds);
  try {
    // Vite emits the worker as its own chunk.
    const worker = new Worker(new URL("./analyzer.worker.ts", import.meta.url), { type: "module" });
    return workerAnalyzer(worker, overrides, () => mainThreadAnalyzer(thresholds));
  } catch {
    return mainThreadAnalyzer(thresholds);
  }
}
