/// <reference lib="webworker" />
// Runs the capture quality engine off the main thread, so the camera preview stays smooth on
// mid-range phones. Imports @verify/capture only (no React, no i18n) to keep this chunk small.
import { DEFAULT_THRESHOLDS, FrameAnalyzer } from "@verify/capture";
import type { FromWorker, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

let analyzer = new FrameAnalyzer();

function reply(message: FromWorker) {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "configure":
      analyzer = new FrameAnalyzer({ ...DEFAULT_THRESHOLDS, ...message.thresholds });
      return;
    case "reset":
      analyzer.reset();
      return;
    case "frame": {
      const started = performance.now();
      try {
        const frame = { data: new Uint8ClampedArray(message.buffer), width: message.width, height: message.height };
        const { analysis, decision } = analyzer.push(frame, message.guide);
        reply({
          type: "result",
          id: message.id,
          hints: analysis.hints,
          ok: analysis.ok,
          metrics: analysis.metrics,
          decision,
          progress: analyzer.autoCapture.progress,
          ms: performance.now() - started,
        });
      } catch {
        reply({ type: "error", id: message.id });
      }
    }
  }
};
