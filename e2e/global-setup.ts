// Makes the fake camera videos before any browser starts (Chromium reads them at launch).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CAMERAS, type CameraName, type FakeCamera, VIDEO_DIR, VIDEO_SCRIPT, scriptArgs, videoPath } from "./support/camera";

const FPS = 30;
const SECONDS = 4;

/** Size of a complete file: header, then per frame "FRAME\n" and a 4:2:0 picture. */
function expectedBytes(camera: FakeCamera): number {
  const header = `YUV4MPEG2 W${camera.width} H${camera.height} F${FPS}:1 Ip A1:1 C420jpeg\n`.length;
  return header + FPS * SECONDS * (6 + (camera.width * camera.height * 3) / 2);
}

export default function globalSetup(): void {
  mkdirSync(VIDEO_DIR, { recursive: true });
  const wanted = new Set<string>();
  for (const name of Object.keys(CAMERAS) as CameraName[]) {
    const camera: FakeCamera = CAMERAS[name];
    const file = videoPath(name);
    wanted.add(basename(file));
    if (existsSync(file) && statSync(file).size === expectedBytes(camera)) continue;
    // Write under a temporary name: an interrupted run never leaves a truncated video behind.
    const partial = `${file}.partial`;
    const run = spawnSync(
      process.env.PYTHON ?? "python3",
      [VIDEO_SCRIPT, partial, ...scriptArgs(camera), `--fps=${FPS}`, `--seconds=${SECONDS}`],
      { encoding: "utf8" },
    );
    if (run.status !== 0) {
      throw new Error(`make-fake-camera-video.py failed for "${name}": ${run.error?.message ?? run.stderr}`);
    }
    renameSync(partial, file);
  }
  // Older videos (another script version) would only fill the disk.
  for (const entry of readdirSync(VIDEO_DIR)) {
    if (/\.y4m(\.partial)?$/.test(entry) && !wanted.has(entry)) rmSync(join(VIDEO_DIR, entry), { force: true });
  }
}
