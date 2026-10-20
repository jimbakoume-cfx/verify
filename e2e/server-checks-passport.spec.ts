// Camera: the sharp passport data page (as in capture-passport.spec.ts). The server's check (M3) asks
// for a new photo of the page, the only photo of a passport and the one that carries the code lines.
import { OCR_ASSETS, mrzModelFor } from "../apps/rider/src/mrz/types";
import { LIVENESS, afterPhotos } from "./support/expectations";
import { expect, test } from "./support/fixtures";

test("passport photo page retaken: its camera says why, the new photo is read and reported again, then submitted", async ({
  page,
  rider,
  backend,
}) => {
  // The phone cannot read the code lines (as on a network that blocks the engine): only the server
  // can tell the photo is unreadable. A photo whose lines the phone read is never retaken.
  await page.route(
    (url) => url.pathname === OCR_ASSETS.workerPath,
    (route) => route.abort("blockedbyclient"),
  );
  backend.verdicts({ document_front: ["unreadable"] });
  await rider.begin("passport");
  await rider.autoCapture("passport", "document_front");
  await rider.usePhoto();
  // The retake is asked at the end, after the face check (PM, 2026-10-20).
  await rider.passLiveness(5_000);

  // No other side to keep: back to the page's camera, which names it and says why.
  const alert = rider.cameraRetakeAlert("passport", "document_front");
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(rider.captureHeading("passport", "document_front")).toBeVisible();
  await expect(alert).toContainText(rider.retakeReason("unreadable"));
  await rider.shutterCapture("passport", "document_front");
  await expect(alert).toHaveCount(0);
  await rider.usePhoto();
  await rider.waitForResult();

  expect(afterPhotos(backend.routes)).toEqual([
    "POST /upload-url",
    "POST /captures",
    "POST /mrz",
    ...LIVENESS,
    "GET /checks",
    "POST /upload-url",
    "POST /captures",
    "POST /mrz",
    "GET /checks",
    "POST /submit",
  ]);
  const [first, second] = backend.captures;
  expect([first.live, second.live]).toEqual([false, true]);
  expect(backend.objects.has(first.path)).toBe(false);
  // Each photo has its own report, the second one counted as the second read of the page.
  expect(backend.mrzReports.map((r) => r.body)).toEqual([
    { captureId: first.captureId, result: "unreadable", reason: "reader_unavailable", attempts: 1, engine: mrzModelFor(true).engine },
    { captureId: second.captureId, result: "unreadable", reason: "reader_unavailable", attempts: 2, engine: mrzModelFor(true).engine },
  ]);
  expect(backend.checksAnswers.map((a) => a.sides.map((s) => [s.kind, s.state, s.reason]))).toEqual([
    [["document_front", "retake", "unreadable"]],
    [["document_front", "ok", null]],
  ]);
  expect(backend.status).toBe("submitted");
});
