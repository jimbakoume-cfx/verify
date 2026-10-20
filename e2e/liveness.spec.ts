// Camera: a drawn face (no real person) in front of a wall, turning, blinking and smiling in a loop
// (scripts/make-fake-camera-video.py --variant=face). Chromium's fake device is both cameras, so the
// document photos are taken with the shutter (no card for an automatic photo), then the face check
// (M5) runs on the same picture through the front-camera request.
import { CAPTURE_LIMITS, LIVENESS_LIMITS, type LivenessAction } from "../supabase/functions/_shared/contract";
import type { FakeBackend } from "./support/backend";
import { LIVENESS, afterPhotos } from "./support/expectations";
import { cameraRequests, expect, liveCameraTracks, test } from "./support/fixtures";
import { hasApp1 } from "./support/jpeg";
import type { Rider } from "./support/rider";

/** Both sides of the old CNI with the shutter (the face scene has no card for an automatic photo). */
async function photographByShutter(rider: Rider): Promise<void> {
  await rider.shutterCapture("cni_legacy", "document_front");
  await useWhatever(rider);
  await rider.turnOver();
  await rider.shutterCapture("cni_legacy", "document_back");
  await useWhatever(rider);
}

/** "Use this photo": the face scene is sharp and without glare, so the manual photo is offered as usual. */
async function useWhatever(rider: Rider): Promise<void> {
  await rider.button("review.use").click();
}

const prompt = (rider: Rider, action: LivenessAction) => rider.t(`liveness.actions.${action}`);
const spacedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Waits for the face check, starts it, and follows its prompts in the challenge's order. */
async function followFaceCheck(rider: Rider, backend: FakeBackend, challengeNo = 1): Promise<void> {
  await expect(rider.livenessHeading).toBeVisible({ timeout: 30_000 });
  await expect(rider.livenessStart).toBeEnabled({ timeout: 12_000 });
  await rider.livenessStart.click();
  await expect.poll(() => backend.challenges.length).toBe(challengeNo);
  const challenge = backend.challenges[challengeNo - 1].response;
  const hint = rider.page.locator(".hint-pill");
  await expect(rider.page.locator(".liveness-code")).toHaveText(rider.t("liveness.code", { code: spacedCode(challenge.code) }));
  await expect(hint).toHaveText(rider.t("liveness.lookStraight"));
  for (const [i, action] of challenge.actions.entries()) {
    await expect(hint).toHaveText(prompt(rider, action), { timeout: 5_000 });
    await expect(rider.page.locator(".hint-tip")).toHaveText(rider.t("liveness.stepOf", { step: i + 1, total: 3 }));
  }
}

test("face check: right after the photos, a random challenge with its code on screen, 14 small frames to their slots, recorded, then submitted", async ({
  page,
  rider,
  backend,
}) => {
  await rider.begin("cni_legacy");
  await photographByShutter(rider);
  await followFaceCheck(rider, backend);
  await expect(rider.heading("result.reviewTitle")).toBeVisible({ timeout: 30_000 });
  expect(await liveCameraTracks(page)).toBe(0);

  // The front camera, at a modest size, without audio.
  expect((await cameraRequests(page)).at(-1)).toEqual({
    video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  // The face check came at once (the photos were sent meanwhile), then the checks and the submit.
  expect(afterPhotos(backend.routes).slice(-4)).toEqual([...LIVENESS, "GET /checks", "POST /submit"]);
  const screens = await rider.screensSeen();
  expect(screens).not.toContain(rider.t("checks.title"));
  expect(screens).not.toContain(rider.t("upload.title"));

  // The challenge: 3 different actions and a 6-digit code, drawn by the server's own code.
  const [challenge] = backend.challenges;
  expect(new Set(challenge.response.actions).size).toBe(3);
  expect(challenge.response.code).toMatch(/^\d{6}$/);

  // What the server recorded, judged by the server's own rule: complete and plausible, not evaluated.
  const [record] = backend.livenessRecords;
  expect(record.outcome).toBe("pass");
  // 3.5 s per action and a tail frame for the last one since the PM's first real test.
  expect(record.details).toMatchObject({ evaluated: false, frames: 14, framesPerStep: [1, 4, 4, 5], problems: [], startedWithWarning: false });
  expect(record.details.durationMs).toBeGreaterThan(12_000);
  expect(record.details.durationMs).toBeLessThan(14_500);
  expect(record.body.code).toBe(challenge.response.code);
  expect(record.body.frames.map((f) => f.path)).toEqual(challenge.response.uploads.slice(0, 14).map((u) => u.path));

  // Each frame: a canvas JPEG of the whole picture, 480 px long, no metadata, small enough for slow networks.
  let total = 0;
  for (const frame of record.frames) {
    expect(frame.contentType).toBe("image/jpeg");
    expect(frame.jpeg).not.toBeNull();
    expect(hasApp1(frame.jpeg!)).toBe(false);
    expect(Math.max(frame.jpeg!.width, frame.jpeg!.height)).toBe(480);
    expect(frame.bytes.length).toBeLessThanOrEqual(LIVENESS_LIMITS.maxFrameBytes);
    total += frame.bytes.length;
  }
  expect(total).toBeLessThanOrEqual(LIVENESS_LIMITS.maxTotalBytes);
  expect(new Set(record.frames.map((f) => f.bytes.toString("base64"))).size).toBe(14);
  // The document photos are unchanged by the face check.
  for (const capture of backend.captures) expect(capture.object.bytes.length).toBeGreaterThanOrEqual(CAPTURE_LIMITS.minBytes);
  expect(backend.status).toBe("submitted");
});

test("a new challenge each time: a refused report, then 'Start again' with another challenge (in English)", async ({
  page,
  rider,
  backend,
}) => {
  backend.failLiveness(1, 410, "challenge_expired");
  await rider.begin("cni_legacy");
  await photographByShutter(rider);
  await expect(rider.livenessHeading).toBeVisible({ timeout: 30_000 });
  await rider.switchLanguage("en");
  await followFaceCheck(rider, backend);

  const panel = page.getByRole("alertdialog");
  await expect(panel).toContainText(rider.t("liveness.failedTitle"), { timeout: 30_000 });
  await expect(panel).toContainText(rider.t("errors.challenge_expired"));
  // Only "Start again": the same frames cannot be sent for this challenge.
  await expect(rider.button("common.retry")).toHaveCount(0);
  await rider.button("liveness.startAgain").click();

  await followFaceCheck(rider, backend, 2);
  await expect(rider.heading("result.reviewTitle")).toBeVisible({ timeout: 30_000 });

  const [first, second] = backend.challenges.map((c) => c.response);
  expect(second.challengeId).not.toBe(first.challengeId);
  expect(backend.livenessRecords).toHaveLength(1);
  expect(backend.livenessRecords[0].body.challengeId).toBe(second.challengeId);
  expect(afterPhotos(backend.routes).slice(-6)).toEqual([...LIVENESS, ...LIVENESS, "GET /checks", "POST /submit"]);
});

test("the network fails while sending the frames: 'Try again' sends the same frames, with no new challenge", async ({
  page,
  rider,
  backend,
}) => {
  await rider.begin("cni_legacy");
  await photographByShutter(rider);
  await expect(rider.livenessHeading).toBeVisible({ timeout: 30_000 });
  // The photos upload during the face check: only the frames' uploads must fail.
  await expect.poll(() => backend.captures.length).toBe(2);
  backend.failUploads(Number.POSITIVE_INFINITY);
  await followFaceCheck(rider, backend);

  const panel = page.getByRole("alertdialog");
  await expect(panel).toContainText(rider.t("liveness.failedTitle"), { timeout: 40_000 });
  await expect(panel).toContainText(rider.t("errors.server_error"));
  backend.failUploads(0);
  await rider.button("common.retry").click();
  await expect(rider.heading("result.reviewTitle")).toBeVisible({ timeout: 30_000 });

  expect(backend.challenges).toHaveLength(1);
  expect(backend.livenessRecords).toHaveLength(1);
  expect(backend.livenessRecords[0].details.problems).toEqual([]);
  expect(backend.livenessRecords[0].outcome).toBe("pass");
});
