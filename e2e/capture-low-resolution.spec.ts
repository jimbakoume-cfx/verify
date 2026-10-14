// Camera: a sharp ID card, but from a camera limited to 720p held upright (720x1280 stream). The
// photo can never reach the server's 800 px minimum: the screen says so at once, never takes the
// photo by itself, and a photo taken anyway cannot be sent (no upload link is spent on it).
import { GUIDES } from "./support/camera";
import { expect, test } from "./support/fixtures";

test("720p camera: the screen says the camera gives too little detail, no automatic photo, and the photo cannot be sent", async ({
  page,
  rider,
  backend,
}) => {
  await rider.begin("cni_legacy", "?debug=1");
  await expect(rider.captureHeading("cni_legacy", "document_front")).toBeVisible();
  await expect(rider.hint).toHaveText(rider.t("capture.tooLittleDetail"));

  // The message fits the two lines the hint reserves: the guide has not moved.
  const guide = await rider.guide();
  expect(guide.width).toBeCloseTo(GUIDES.id1.width, 0);
  expect(Math.abs(guide.y - GUIDES.id1.y)).toBeLessThanOrEqual(0.5);

  // The card itself is found and framed: only the camera's resolution is the problem.
  const live = await rider.debugValues("live");
  expect(live[rider.t("debug.video")]).toBe("720×1280");
  expect(live[rider.t("debug.hints")]).not.toMatch(/no_document|move_|center_document|blurry/);

  // No automatic photo, even with a good card in the guide; the manual shutter after 8 s.
  await expect(rider.shutter).toBeVisible({ timeout: 12_000 });
  await expect(rider.heading("review.title")).toHaveCount(0);
  await expect(rider.hint).toHaveText(rider.t("capture.tooLittleDetail"));

  await rider.shutter.click();
  await expect(rider.heading("review.title")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: rider.t("review.lowResolution") })).toBeVisible();
  await expect(rider.button("review.use")).toHaveCount(0);
  await expect(rider.button("review.useAnyway")).toHaveCount(0);
  await expect(rider.button("review.retake")).toBeVisible();

  await rider.button("review.retake").click();
  await expect(rider.captureHeading("cni_legacy", "document_front")).toBeVisible();
  expect(backend.routes).toEqual(["GET /session", "POST /consent", "POST /document-type"]);
});
