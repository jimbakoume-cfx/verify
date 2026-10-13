// Test fixtures: every test gets a fresh fake backend, a page wired to it, and a probe on the camera.
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

export const test = base.extend<Fixtures & TestOptions>({
  camera: [null, { option: true }],

  page: async ({ page, camera }, use) => {
    await page.addInitScript(installCameraProbe, { portrait: camera ? CAMERAS[camera].portrait : false });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors, "uncaught errors in the page").toEqual([]);
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
