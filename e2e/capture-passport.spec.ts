// Camera: a sharp passport data page, as a Full HD phone held upright sees it. The page prints real
// OCR-B specimen code lines (TD3, valid check digits; e2e/fixtures/mrz), read in the browser.
import { OCR_ASSETS, mrzModelFor } from "../apps/rider/src/mrz/types";
import { MRZ_LINES } from "./support/camera";
import { PASSPORT_FLOW, expectAutoQuality, expectCleanPhoto } from "./support/expectations";
import { expect, test } from "./support/fixtures";

test("passport: only the photo page is taken, its code lines are read (every check digit ✅ in ?debug=1), then sent", async ({
  page,
  rider,
  backend,
}) => {
  await rider.begin("passport", "?debug=1");
  await rider.autoCapture("passport", "document_front");
  await expect(page.getByText(`${rider.t("sides.passportPage")} · ${rider.t("documents.passport")}`)).toBeVisible();
  await expect(rider.mrzRead).toHaveText(rider.t("mrz.read"));

  // The debug panel: what the phone read, and each check digit it recomputed. The browser's page
  // translation (an online service) must never get it.
  await expect(rider.mrzDebug).toHaveAttribute("translate", "no");
  await expect(rider.mrzDebug).toContainClass("notranslate");
  const checks =["documentNumber", "birthDate", "expiryDate", "personalNumber", "composite"];
  await expect(rider.mrzDebug.locator("ul.mrz-checks li")).toHaveText(checks.map((key) => `✅ ${rider.t(`debug.mrz.check.${key}`)}`));
  const values = await rider.debugValues("still");
  expect(values[rider.t("debug.mrz.status")]).toBe("valid");
  // M4: a test session reads with our own model, and the panel says which model read the lines.
  expect(values[rider.t("debug.mrz.model")]).toBe(mrzModelFor(true).engine);
  expect(values[rider.t("debug.mrz.format")]).toBe("TD3");
  expect(values[rider.t("debug.mrz.field.documentCode")]).toBe("P ✅");
  expect(values[rider.t("debug.mrz.field.issuingState")]).toBe("UTO");
  expect(values[rider.t("debug.mrz.attempt")]).toBe("1");
  // Characters about 2.4 mm tall at the page's ~6 px/mm in the photo (calibration aid).
  expect(parseFloat(values[rider.t("debug.mrz.charHeight")])).toBeGreaterThan(10);
  await expect(rider.mrzDebug.locator("pre.mrz-lines").first()).toHaveText(MRZ_LINES.td3.join("\n"));
  await rider.usePhoto();

  // No "turn the card over" step: straight to the upload.
  await expect(rider.heading("done.title")).toBeVisible({ timeout: 20_000 });
  expect(backend.routes).toEqual(PASSPORT_FLOW);
  expect(backend.calls[2].body).toEqual({ declaredDocument: "passport" });
  expect(backend.calls[3].body).toEqual({ kind: "document_front" });
  expect(backend.session().requiredSides).toEqual(["document_front"]);
  expect(backend.captures).toHaveLength(1);
  expectCleanPhoto(backend.captures[0].object);
  expectAutoQuality(backend.captures[0].quality);

  // The lines reach the server, which re-checks them all, the personal number included (TD3).
  expect(backend.mrzReports).toHaveLength(1);
  const [report] = backend.mrzReports;
  expect(report.body).toMatchObject({
    captureId: backend.captures[0].captureId,
    result: "read",
    lines: MRZ_LINES.td3,
    attempts: 1,
    engine: mrzModelFor(true).engine,
  });
  expect(report.outcome).toBe("pass");
  expect(report.details.checks).toEqual({
    documentNumber: true,
    birthDate: true,
    expiryDate: true,
    personalNumber: true,
    composite: true,
  });
  expect(backend.status).toBe("submitted");
});
