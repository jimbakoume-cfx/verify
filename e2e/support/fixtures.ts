// Test fixtures: every test gets a fresh fake backend, a page wired to it, a probe on the camera, a
// log of the screens shown, and fails on any uncaught page error or Content Security Policy violation.
import { type Page, test as base, expect } from "@playwright/test";
import { FakeBackend } from "./backend";
import { CAMERAS, type CameraName } from "./camera";
import { Rider } from "./rider";

export interface CameraProbe {
  /** What the app passed to getUserMedia, before any test-side change. */
  constraints: MediaStreamConstraints[];
  streams: MediaStream[];
}

export interface TestOptions {
  /** The fake camera Chromium was launched with (set per project), or null for none. */
  camera: CameraName | null;
}

interface Fixtures {
  backend: FakeBackend;
  rider: Rider;
}

/**
 * Runs in the page before the app. Records the camera requests and streams, and for a "portrait"
 * camera swaps the requested width and height as a phone held upright does (see camera.ts).
 * Serialised into the page: it must not use anything from this module.
 */
function installCameraProbe({ portrait }: { portrait: boolean }): void {
  const probe: CameraProbe = { constraints: [], streams: [] };
  (window as unknown as { __camera: CameraProbe }).__camera = probe;
  const media = navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== "function") return;
  const getUserMedia = media.getUserMedia.bind(media);
  media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    probe.constraints.push(JSON.parse(JSON.stringify(constraints ?? {})) as MediaStreamConstraints);
    const video = constraints?.video;
    const asked =
      portrait && video && typeof video === "object"
        ? Object.assign({}, constraints, { video: Object.assign({}, video, { width: video.height, height: video.width }) })
        : constraints;
    const stream = await getUserMedia(asked);
    probe.streams.push(stream);
    return stream;
  };
}

/**
 * Runs in the page before the app: reports every CSP violation in the document (the preview server
 * sends the real headers) and logs each screen title (h1) as it appears, however briefly.
 * Serialised into the page: it must not use anything from this module.
 */
function installPageProbes(): void {
  const page = window as unknown as {
    __screens: string[];
    __screenTimes: number[];
    __cspViolation?: (text: string) => void;
  };
  document.addEventListener("securitypolicyviolation", (event) => {
    page.__cspViolation?.(`${event.effectiveDirective} blocked ${event.blockedURI || "inline code"}`);
  });
  const screens: string[] = [];
  const times: number[] = [];
  page.__screens = screens;
  page.__screenTimes = times;
  // A mutation observer runs before the browser paints: even a screen shown for one frame is seen.
  new MutationObserver(() => {
    const title = document.querySelector("h1")?.textContent ?? "";
    if (title && screens[screens.length - 1] !== title) {
      screens.push(title);
      times.push(Date.now());
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

export const test = base.extend<Fixtures & TestOptions>({
  camera: [null, { option: true }],

  page: async ({ page, camera }, use) => {
    const errors: string[] = [];
    const violations: string[] = [];
    await page.exposeFunction("__cspViolation", (text: string) => violations.push(text));
    await page.addInitScript(installCameraProbe, { portrait: camera ? CAMERAS[camera].portrait : false });
    await page.addInitScript(installPageProbes);
    page.on("pageerror", (error) => errors.push(error.message));
    // A worker (the analyzer, the OCR engine) gets its own CSP from its response headers and reports
    // violations only to its own global scope, which init scripts do not reach: listen there as soon
    // as it starts, and pass them on through the console. A violation in a worker's very first
    // instructions can come before the listener; the tests' checks on what the workers do (photos
    // taken, code lines read) catch those.
    page.on("worker", (worker) => {
      worker
        .evaluate(() =>
          self.addEventListener("securitypolicyviolation", (event) =>
            console.error(`Content Security Policy violation in a worker: ${event.effectiveDirective} blocked ${event.blockedURI}`),
          ),
        )
        .catch(() => {}); // the worker already ended
    });
    page.on("console", (message) => {
      if (message.type() === "error" && /Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    await use(page);
    expect(errors, "uncaught errors in the page").toEqual([]);
    expect(violations, "Content Security Policy violations").toEqual([]);
  },

  backend: async ({ page }, use) => {
    const backend = new FakeBackend();
    await backend.install(page);
    await use(backend);
    expect(backend.problems, "requests the real backend would refuse").toEqual([]);
  },

  rider: async ({ page, backend }, use) => {
    await use(new Rider(page, backend));
  },
});

export { expect };

/** Camera tracks still running: the camera light is on while this is above 0. */
export function liveCameraTracks(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __camera: CameraProbe }).__camera.streams
        .flatMap((stream) => stream.getTracks())
        .filter((track) => track.readyState === "live").length,
  );
}

export function cameraRequests(page: Page): Promise<MediaStreamConstraints[]> {
  return page.evaluate(() => (window as unknown as { __camera: CameraProbe }).__camera.constraints);
}
