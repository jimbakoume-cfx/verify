// Camera: the ID card, heavily out of focus (a Full HD phone held upright, 1080x1920 stream).
import { GUIDES } from "./support/camera";
import { expect, test } from "./support/fixtures";

/** Spec: the manual shutter appears when auto-capture has not fired within 8 s. */
const SHUTTER_AFTER_MS = 8_000;

test("blurred card: a blur hint, no automatic photo, the shutter after 8 s, and the blurred photo is refused", async ({
  page,
  rider,
  backend,
}) => {
  await rider.begin("cni_legacy", "?debug=1");
  await expect(rider.captureHeading("cni_legacy", "document_front")).toBeVisible();
  await expect(rider.hint).toHaveText(rider.t("hints.blurry"));
  const hintShownAt = Date.now();

  // The card is found where the video put it, filling the guide: only sharpness fails.
  const live = await rider.debugValues("live");
  expect(live[rider.t("debug.video")]).toBe("1080×1920");
  expect(live[rider.t("debug.hints")]).toBe("blurry");
  expect(Number(live[rider.t("debug.confidence")])).toBeGreaterThanOrEqual(0.5);
  expect(Number(live[rider.t("debug.framing")])).toBeGreaterThan(0.8);
  expect(Number(live[rider.t("debug.framing")])).toBeLessThan(0.95);
  const guide = await rider.guide();
  expect(guide.x).toBeCloseTo(GUIDES.id1.x, 0);
  expect(guide.width).toBeCloseTo(GUIDES.id1.width, 0);
  expect(guide.height).toBeCloseTo(GUIDES.id1.height, 0);
  // The hint always reserves two lines: the guide does not move with it.
  expect(Math.abs(guide.y - GUIDES.id1.y)).toBeLessThanOrEqual(0.5);

  // Until the shutter appears, the rider is told the photo is automatic.
  await expect(rider.shutter).toBeHidden();
  await expect(page.getByText(rider.t("capture.auto"))).toBeVisible();
  await expect(rider.shutter).toBeVisible({ timeout: SHUTTER_AFTER_MS + 4_000 });
  // The hint shows a few frames after the camera starts, and the 8 s count from the camera start.
  expect(Date.now() - hintShownAt).toBeGreaterThan(SHUTTER_AFTER_MS - 2_000);
  await expect(rider.hint).toHaveText(rider.t("hints.blurry"));
  await expect(rider.heading("review.title")).toHaveCount(0);

  await rider.shutter.click();
  await expect(rider.heading("review.title")).toBeVisible();
  const refusal = page.getByRole("alert").filter({ hasText: rider.t("review.refused") });
  await expect(refusal).toContainText(rider.t("hints.blurry"));
  await expect(rider.button("review.use")).toHaveCount(0);
  await expect(rider.button("review.useAnyway")).toHaveCount(0);
  const still = await rider.debugValues("still");
  expect(still[rider.t("debug.video")]).toMatch(/^1080×1920 · manual · \d+ ms$/);
  expect(still[rider.t("debug.hints")]).toContain("blurry");

  // Retake: back to the live camera, still blurred.
  await rider.button("review.retake").click();
  await expect(rider.captureHeading("cni_legacy", "document_front")).toBeVisible();
  await expect(rider.hint).toHaveText(rider.t("hints.blurry"));
  expect(backend.routes).toEqual(["GET /session", "POST /consent", "POST /document-type"]);
});
