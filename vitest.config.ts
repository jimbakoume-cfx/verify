import { configDefaults, defineConfig } from "vitest/config";

const ALL = ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "supabase/functions/**/*.test.ts"];
const SWEEPS = ["packages/capture/src/calibration.test.ts", "packages/capture/src/detect.test.ts"];
const FRAME_BUDGET = ["packages/capture/src/analyze.test.ts"];

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ALL, exclude: [...configDefaults.exclude, ...SWEEPS, ...FRAME_BUDGET] } },
      // The capture sweeps render hundreds of frames per test: up to about 4.5 s each on a 4-vCPU
      // runner on their own, more beside the other files. The default 5 s limit is too tight for
      // that work; they assert on what is detected, not on time.
      { extends: true, test: { name: "sweeps", include: SWEEPS, testTimeout: 20_000 } },
      // The analyzer's frame-budget test measures time itself: it runs after every other file, on
      // its own, so the files beside it (the real OCR, the sweeps) cannot slow it down.
      { extends: true, test: { name: "frame-budget", include: FRAME_BUDGET, sequence: { groupOrder: 1 } } },
    ],
  },
});
