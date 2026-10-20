// Camera: a sharp, well-framed ID card, as a Full HD phone held upright sees it. These tests declare
// the old CNI, which has no code lines: nothing is read. The new CNI is in capture-cni-biometric.spec.ts.
import { CONSENT_VERSION } from "../supabase/functions/_shared/contract";
import { CARD_FLOW, LIVENESS, expectAutoQuality, expectCleanPhoto, photoAttempts } from "./support/expectations";
import { cameraRequests, expect, liveCameraTracks, test } from "./support/fixtures";

const readStoredToken = () => sessionStorage.getItem("verify.session");

test("old CNI happy path: both sides captured automatically, uploaded and submitted, nothing read", async ({
  page,
  rider,
  backend,
}) => {
  await rider.open("?debug=1");
  // The token leaves the address bar before anything renders, and is kept for this tab only.
  await expect(rider.button("start")).toBeEnabled();
  await expect(page).toHaveURL(/\/\?debug=1$/);
  expect(page.url()).not.toContain(backend.token);
  expect(await page.evaluate(readStoredToken)).toBe(backend.token);
  await expect(page.getByText(rider.t("welcome.testBadge"))).toBeVisible();

  await rider.start();
  await rider.acceptConsent();
  await rider.chooseDocument("cni_legacy");

  await rider.autoCapture("cni_legacy", "document_front");
  // The camera is released as soon as the photo is taken.
  expect(await liveCameraTracks(page)).toBe(0);
  const still = await rider.debugValues("still");
  expect(still[rider.t("debug.video")]).toMatch(/^1080×1920 · auto · \d+ ms$/);
  expect(Number(still[rider.t("debug.framing")])).toBeGreaterThan(0.8);
  await rider.usePhoto();
  await rider.turnOver();
  await rider.autoCapture("cni_legacy", "document_back");
  // The old card has no code lines: no reading, nothing about them on the review.
  await expect(rider.mrzDebug).toHaveCount(0);
  await expect(rider.mrzRead).toHaveCount(0);
  await rider.usePhoto();

  await rider.waitForSubmit();
  await expect(page.getByText(rider.t("result.reviewBody"))).toBeVisible();
  expect(await liveCameraTracks(page)).toBe(0);
  expect(await rider.screensSeen()).not.toContain(rider.t("reading.title"));

  // The app asked for the back camera at Full HD, without audio (spec), then (M5) the front camera.
  const requests = await cameraRequests(page);
  expect(requests).toHaveLength(3);
  for (const request of requests.slice(0, 2)) {
    expect(request).toEqual({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  }
  expect(requests[2]).toEqual({ video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });

  expect(backend.routes).toEqual(CARD_FLOW);
  // M5: the optional "keep my face images" box is sent unticked.
  expect(backend.calls[1].body).toEqual({ consentVersion: CONSENT_VERSION, language: "fr", keepFaceImages: false });
  expect(backend.calls[2].body).toEqual({ declaredDocument: "cni_legacy" });
  expect(backend.calls.filter((c) => c.route === "POST /upload-url").map((c) => c.body)).toEqual([
    { kind: "document_front" },
    { kind: "document_back" },
  ]);
  expect(photoAttempts(backend).map((a) => a.status)).toEqual([200, 200]);
  expect(backend.captures.map((c) => c.kind)).toEqual(["document_front", "document_back"]);
  expect(backend.livenessRecords).toHaveLength(1);
  for (const capture of backend.captures) {
    expectCleanPhoto(capture.object);
    expectAutoQuality(capture.quality);
  }
  expect(backend.status).toBe("submitted");
});

test("upload failure: automatic retries, then the rider's retry succeeds without a new upload link", async ({
  page,
  rider,
  backend,
}) => {
  backend.failUploads(3); // every automatic try of the first photo
  await rider.begin("cni_legacy");
  await rider.photographCard("cni_legacy");
  // The photos upload during the face check, which the failure never interrupts.
  await expect.poll(() => photoAttempts(backend).map((a) => a.status), { timeout: 20_000 }).toEqual([503, 503, 503]);
  await rider.passLiveness(5_000);

  // Told once the face check is done.
  await expect(rider.heading("upload.failedTitle")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveText(rider.t("errors.server_error"));

  await rider.button("common.retry").click();
  await rider.waitForResult();

  // The retry resumed with the same signed upload (no extra link counted against the session).
  const notFace = (routes: string[]) => routes.filter((r) => !LIVENESS.includes(r));
  expect(notFace(backend.routes)).toEqual(notFace(CARD_FLOW));
  expect(backend.routes.filter((r) => LIVENESS.includes(r))).toEqual(LIVENESS);
  const attempts = photoAttempts(backend);
  expect(attempts.map((a) => a.status)).toEqual([503, 503, 503, 200, 200]);
  expect(new Set(attempts.slice(0, 4).map((a) => a.path)).size).toBe(1);
  for (const capture of backend.captures) expectCleanPhoto(capture.object);
  expect(backend.status).toBe("submitted");
});

test("expired link: the expiry screen, and the token is forgotten", async ({ page, rider, backend }) => {
  backend.expire();
  await rider.open();
  await expect(rider.heading("sessionError.expiredTitle")).toBeVisible();
  await expect(page.getByText(rider.t("sessionError.expired"))).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(readStoredToken)).toBeNull();
  await expect(rider.button("start")).toHaveCount(0);
  expect(backend.routes).toEqual(["GET /session"]);
});

test("session expiring during the photos: the upload ends on the expiry screen", async ({ page, rider, backend }) => {
  await rider.begin("cni_legacy");
  await rider.autoCapture("cni_legacy", "document_front");
  backend.expire(); // the 30 minutes run out while the rider is busy with the photos
  await rider.usePhoto();
  await rider.turnOver();
  await rider.autoCapture("cni_legacy", "document_back");
  await rider.usePhoto();

  await expect(rider.heading("sessionError.expiredTitle")).toBeVisible();
  expect(backend.routes.at(-1)).toBe("POST /upload-url");
  expect(backend.storageAttempts).toEqual([]);
  expect(await page.evaluate(readStoredToken)).toBeNull();
});

test.describe("language", () => {
  // A phone language the app does not offer: French, the default for Cameroon.
  test.use({ locale: "de-DE" });

  test("French by default; switching to English mid-flow keeps the photos and the progress", async ({
    page,
    rider,
    backend,
  }) => {
    await rider.open();
    await expect(page).toHaveURL(/\/$/);
    expect(page.url()).not.toContain(backend.token);
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page.getByRole("heading", { level: 1, name: rider.t("welcome.title") })).toBeVisible();

    await rider.start();
    await rider.acceptConsent();
    await rider.chooseDocument("cni_legacy");
    await rider.autoCapture("cni_legacy", "document_front");
    const front = () => page.getByRole("img", { name: rider.t("review.alt", { side: rider.t("sides.document_front") }) });
    const photo = await front().getAttribute("src");
    expect(photo).toMatch(/^blob:/);

    await rider.switchLanguage("en");
    // Same screen, same photo, now in English; the choice is remembered.
    await expect(rider.heading("review.title")).toBeVisible();
    await expect(front()).toHaveAttribute("src", photo!);
    await expect(page.getByText(`${rider.t("sides.document_front")} · ${rider.t("documents.cni_legacy")}`)).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("verify.lang"))).toBe("en");

    await rider.usePhoto();
    await rider.turnOver();
    await rider.autoCapture("cni_legacy", "document_back");
    await rider.usePhoto();
    await rider.waitForSubmit();

    // Nothing was redone: one consent (given in French), one document choice, two photos.
    expect(backend.routes).toEqual(CARD_FLOW);
    expect(backend.calls[1].body).toEqual({ consentVersion: CONSENT_VERSION, language: "fr", keepFaceImages: false });
    expect(backend.captures.map((c) => c.kind)).toEqual(["document_front", "document_back"]);
  });
});
