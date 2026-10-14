// End-to-end tests of the rider capture flow: the production build in Chromium, a synthetic video
// as the camera, and the Supabase backend emulated in the page (e2e/support/backend.ts).
// Run: npm run e2e (see e2e/README.md).
import { type LaunchOptions, defineConfig } from "@playwright/test";
import { DENIED_CAMERA_ARGS, VIEWPORT, cameraArgs } from "./e2e/support/camera";
import { PUBLISHABLE_KEY, SUPABASE_URL } from "./e2e/support/backend";
import type { TestOptions } from "./e2e/support/fixtures";

const PORT = Number(process.env.E2E_PORT ?? 4317);
// localhost is a secure context, so the camera API is available over plain http.
const BASE_URL = `http://localhost:${PORT}`;
const OUT = "e2e/out";

/**
 * Chromium: Playwright's own build (CI: `npx playwright install --with-deps chromium`), or the
 * binary in PW_CHROMIUM_PATH when the installed browsers do not match this Playwright version.
 * "chromium" = the full browser in new headless mode (camera, permissions as on a desktop Chrome).
 */
function launch(args: string[]): LaunchOptions {
  const executablePath = process.env.PW_CHROMIUM_PATH;
  return executablePath ? { executablePath, args } : { channel: "chromium", args };
}

export default defineConfig<TestOptions>({
  testDir: "e2e",
  outputDir: `${OUT}/results`,
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a flaky capture flow must show up as a failure.
  retries: 0,
  // Each worker plays a Full HD video at 30 fps; more than two on a 4-core runner slows the camera.
  workers: Number(process.env.E2E_WORKERS ?? 2),
  reporter: [["list"], ["html", { open: "never", outputFolder: `${OUT}/report` }]],
  use: {
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    // A phone in Cameroon set to French. The language test overrides it.
    locale: "fr-CM",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // The production build, made with a Supabase URL that only the page routes answer (backend.ts),
    // served with the real headers of public/_headers, CSP included (vite.config.ts preview hook).
    command: `npx vite build apps/rider --outDir ../../${OUT}/rider --emptyOutDir --logLevel warn && npx vite preview apps/rider --outDir ../../${OUT}/rider --port ${PORT} --strictPort`,
    url: BASE_URL,
    env: { VITE_SUPABASE_URL: SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, COMMIT_REF: "e2e" },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    {
      name: "card",
      testMatch: ["capture-card.spec.ts", "capture-cni-biometric.spec.ts"],
      use: { camera: "card", launchOptions: launch(cameraArgs("card")) },
    },
    {
      name: "passport",
      testMatch: "capture-passport.spec.ts",
      use: { camera: "passport", launchOptions: launch(cameraArgs("passport")) },
    },
    {
      name: "blurred",
      testMatch: "capture-blurred.spec.ts",
      use: { camera: "blurred", launchOptions: launch(cameraArgs("blurred")) },
    },
    {
      name: "smudged",
      testMatch: "capture-mrz-smudged.spec.ts",
      use: { camera: "smudged", launchOptions: launch(cameraArgs("smudged")) },
    },
    { name: "no-card", testMatch: "capture-no-card.spec.ts", use: { camera: "noCard", launchOptions: launch(cameraArgs("noCard")) } },
    {
      name: "low-res",
      testMatch: "capture-low-resolution.spec.ts",
      use: { camera: "lowRes", launchOptions: launch(cameraArgs("lowRes")) },
    },
    { name: "camera-denied", testMatch: "camera-denied.spec.ts", use: { camera: null, launchOptions: launch(DENIED_CAMERA_ARGS) } },
  ],
});
