// The fake cameras: synthetic videos made by scripts/make-fake-camera-video.py and played by
// Chromium as the camera. Shared by playwright.config.ts (launch flags), global-setup.ts (makes the
// files) and the tests (expected geometry).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(__dirname, "../..");
export const VIDEO_SCRIPT = join(REPO_ROOT, "scripts/make-fake-camera-video.py");

/** The phone screen of every test, in CSS pixels. */
export const VIEWPORT = { width: 390, height: 844 };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the rider app draws the guide at 390x844 (the hint always reserves two lines, so the guide
 * does not move with the hint). A test checks these against the live screen, so a layout change
 * that moves the guide fails loudly instead of silently placing the fake card off-guide.
 */
export const GUIDES = {
  id1: { x: 15.6, y: 340.5, width: 358.8, height: 226.3 },
  passport: { x: 15.6, y: 327.4, width: 358.8, height: 252.6 },
} satisfies Record<string, Rect>;

export interface FakeCamera {
  variant: "sharp" | "blurred" | "none";
  document: keyof typeof GUIDES;
  width: number;
  height: number;
  /**
   * Emulate a phone held upright. The app asks for an ideal 1920x1080; a phone's sensor is
   * landscape, so in portrait the browser rotates it and the page gets 1080x1920. Desktop Chromium
   * does not rotate: it would crop a portrait file to 1080x1080. The test page therefore swaps the
   * requested width and height before they reach the fake device (see fixtures.ts).
   */
  portrait: boolean;
}

export const CAMERAS = {
  // A Full HD phone held upright: the guide covers ~816 video pixels, so the photo clears the
  // server's 800 px minimum.
  card: { variant: "sharp", document: "id1", width: 1080, height: 1920, portrait: true },
  passport: { variant: "sharp", document: "passport", width: 1080, height: 1920, portrait: true },
  blurred: { variant: "blurred", document: "id1", width: 1080, height: 1920, portrait: true },
  noCard: { variant: "none", document: "id1", width: 1080, height: 1920, portrait: true },
  // A camera limited to 720p, held upright: the photo would be ~566 px long, under the server's
  // minimum whatever the rider does. The app says so and never takes it by itself.
  lowRes: { variant: "sharp", document: "id1", width: 720, height: 1280, portrait: true },
} satisfies Record<string, FakeCamera>;

export type CameraName = keyof typeof CAMERAS;

/** Generated videos are large (160-370 MB each): they live in a temp dir, never in the repo. */
export const VIDEO_DIR = process.env.E2E_CAMERA_DIR ?? join(tmpdir(), "confiance-verify-e2e-camera");

export function scriptArgs(camera: FakeCamera): string[] {
  const g = GUIDES[camera.document];
  return [
    `--variant=${camera.variant}`,
    `--document=${camera.document}`,
    `--size=${camera.width}x${camera.height}`,
    `--viewport=${VIEWPORT.width}x${VIEWPORT.height}`,
    `--guide=${g.x},${g.y},${g.width},${g.height}`,
  ];
}

/** The video's file name changes with the script and its arguments, so a stale file is never reused. */
export function videoPath(name: CameraName): string {
  const camera: FakeCamera = CAMERAS[name];
  const hash = createHash("sha256").update(readFileSync(VIDEO_SCRIPT)).update(scriptArgs(camera).join(" ")).digest("hex");
  return join(VIDEO_DIR, `${name}-${hash.slice(0, 12)}.y4m`);
}

/** Chromium flags: a fake camera playing `name`, and camera permission granted without a prompt. */
export function cameraArgs(name: CameraName): string[] {
  return ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${videoPath(name)}`];
}

/** Chromium flags: a camera exists, but the permission prompt is answered "Block". */
export const DENIED_CAMERA_ARGS = ["--use-fake-device-for-media-stream", "--deny-permission-prompts"];
