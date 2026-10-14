// Camera: the table only, no card (a Full HD phone held upright, 1080x1920 stream).
import { GUIDES } from "./support/camera";
import { expect, test } from "./support/fixtures";

test("no card: the 'place your ID' hint, a surface tip, and no automatic photo", async ({ page, rider, backend }) => {
  await rider.begin("cni_legacy", "?debug=1");
  await expect(rider.captureHeading("cni_legacy", "document_front")).toBeVisible();
  await expect(rider.hint).toHaveText(rider.t("hints.no_document"));

  const live = await rider.debugValues("live");
  expect(live[rider.t("debug.video")]).toBe("1080×1920");
  expect(live[rider.t("debug.hints")]).toMatch(/^no_document/);
  expect(live[rider.t("debug.framing")]).toBe("0.00");
  const guide = await rider.guide();
  expect(guide.width).toBeCloseTo(GUIDES.id1.width, 0);
  expect(Math.abs(guide.y - GUIDES.id1.y)).toBeLessThanOrEqual(0.5);

  // After 5 s without a card, a tip about the surface; after 8 s, the manual shutter.
  await expect(page.getByText(rider.t("capture.tipSurface"))).toBeVisible({ timeout: 8_000 });
  await expect(rider.shutter).toBeVisible({ timeout: 8_000 });
  await expect(rider.hint).toHaveText(rider.t("hints.no_document"));
  await expect(rider.heading("review.title")).toHaveCount(0);
  expect(backend.routes).toEqual(["GET /session", "POST /consent", "POST /document-type"]);
});
