// Camera: the sharp ID card (as in capture-card.spec.ts), declared as the new CNI (2025), whose back
// carries 3 code lines (TD1). The fake card prints real OCR-B specimen lines with valid check digits
// (e2e/fixtures/mrz), and the real OCR engine reads them in the browser.
import { MRZ_MODELS, OCR_ASSETS, mrzModelFor } from "../apps/rider/src/mrz/types";
import { MRZ_LINES } from "./support/camera";
import { NEW_CNI_FLOW, expectCleanPhoto } from "./support/expectations";
import { expect, test } from "./support/fixtures";

test("new CNI: the code lines on the back are read, the rider only sees 'Code lines read', and they reach the server", async ({
  page,
  rider,
  backend,
}) => {
  await rider.begin("cni_biometric");
  await rider.autoCapture("cni_biometric", "document_front");
  // The front carries no code lines: it is not read.
  await expect(rider.mrzRead).toHaveCount(0);
  await rider.usePhoto();
  await rider.turnOver();
  await rider.autoCapture("cni_biometric", "document_back");

  await expect(rider.mrzRead).toHaveText(rider.t("mrz.read"));
  // Nothing of what was read is shown to the rider (no ?debug=1).
  await expect(rider.mrzDebug).toHaveCount(0);
  for (const line of MRZ_LINES.td1) await expect(page.getByText(line)).toHaveCount(0);
  await rider.usePhoto();
  await rider.waitForSubmit();

  // The back's photo went to the reading screen before its review; the front's did not.
  const screens = await rider.screensSeen();
  const front = screens.indexOf(rider.t("sides.document_front"));
  const back = screens.indexOf(rider.t("sides.document_back"));
  expect(screens.slice(front, front + 2)).toEqual([rider.t("sides.document_front"), rider.t("review.title")]);
  expect(screens.slice(back, back + 3)).toEqual([rider.t("sides.document_back"), rider.t("reading.title"), rider.t("review.title")]);

  // The report follows the back's capture, before the submit, and names that capture.
  expect(backend.routes).toEqual(NEW_CNI_FLOW);
  expect(backend.calls[2].body).toEqual({ declaredDocument: "cni_biometric" });
  for (const capture of backend.captures) expectCleanPhoto(capture.object);
  const backCapture = backend.captures.find((c) => c.kind === "document_back")!;
  expect(backend.mrzReports).toHaveLength(1);
  const [report] = backend.mrzReports;
  expect(report.body).toEqual({
    captureId: backCapture.captureId,
    result: "read",
    lines: MRZ_LINES.td1,
    attempts: 1,
    corrections: expect.any(Number),
    engine: mrzModelFor(true).engine,
    ms: expect.any(Number),
  });
  // The server's own verdict: every check digit right, the dates real, "I" fits an ID card.
  expect(report.outcome).toBe("pass");
  expect(report.details).toMatchObject({
    result: "read",
    format: "TD1",
    checks: { documentNumber: true, birthDate: true, expiryDate: true, composite: true },
    documentCodeFits: true,
    datesValid: true,
  });
  expect(backend.status).toBe("submitted");
});

test("OCR engine blocked: the rider is not held up, and the server is told the reader was unavailable", async ({
  page,
  rider,
  backend,
}) => {
  // As on a network that blocks the file, or a site where it is missing.
  let blocked = 0;
  await page.route(
    (url) => url.pathname === OCR_ASSETS.workerPath,
    (route) => {
      blocked++;
      return route.abort("blockedbyclient");
    },
  );
  await rider.begin("cni_biometric");
  await rider.autoCapture("cni_biometric", "document_front");
  await rider.usePhoto();
  await rider.turnOver();
  await rider.autoCapture("cni_biometric", "document_back");

  // Nothing could be read, and nothing asks for a retake: "Use this photo" comes first, as usual.
  await expect(rider.mrzRead).toHaveCount(0);
  await expect(rider.mrzWarning).toHaveCount(0);
  await expect(rider.button("review.use")).toHaveClass(/primary/);
  await rider.usePhoto();
  await rider.waitForSubmit();
  expect(blocked).toBeGreaterThan(0);

  expect(backend.routes).toEqual(NEW_CNI_FLOW);
  const backCapture = backend.captures.find((c) => c.kind === "document_back")!;
  expect(backend.mrzReports.map((r) => r.body)).toEqual([
    { captureId: backCapture.captureId, result: "unreadable", reason: "reader_unavailable", attempts: 1, engine: mrzModelFor(true).engine },
  ]);
  // Staff are asked to look at it.
  expect(backend.mrzReports[0].outcome).toBe("flag");
  expect(backend.status).toBe("submitted");
});

test("M4: the model follows the session: ours for a test session, Doubango's for any other", async ({ page, rider, backend }) => {
  const models: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith(".traineddata.gz")) models.push(path);
  });
  backend.isTest = false;
  await rider.begin("cni_biometric");
  await rider.autoCapture("cni_biometric", "document_front");
  await rider.usePhoto();
  await rider.turnOver();
  await rider.autoCapture("cni_biometric", "document_back");
  await expect(rider.mrzRead).toHaveText(rider.t("mrz.read"));
  await rider.usePhoto();
  await rider.waitForSubmit();

  // Only Doubango's file was fetched, and the report names it.
  expect(new Set(models)).toEqual(new Set([`${MRZ_MODELS["mrz-1"].langPath}/${OCR_ASSETS.language}.traineddata.gz`]));
  expect(backend.mrzReports.map((r) => [r.body.engine, r.outcome])).toEqual([[MRZ_MODELS["mrz-1"].engine, "pass"]]);
  expect(mrzModelFor(false)).toBe(MRZ_MODELS["mrz-1"]);
});

test("M4: a test session fetches our own model only", async ({ page, rider, backend }) => {
  const models: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith(".traineddata.gz")) models.push(path);
  });
  await rider.begin("cni_biometric");
  await rider.autoCapture("cni_biometric", "document_front");
  await rider.usePhoto();
  await rider.turnOver();
  await rider.autoCapture("cni_biometric", "document_back");
  await expect(rider.mrzRead).toHaveText(rider.t("mrz.read"));
  expect(new Set(models)).toEqual(new Set([`${MRZ_MODELS["mrz-2"].langPath}/${OCR_ASSETS.language}.traineddata.gz`]));
  expect(backend.session().isTest).toBe(true);
});
