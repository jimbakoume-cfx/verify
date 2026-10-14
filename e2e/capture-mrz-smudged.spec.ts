// Camera: the sharp ID card, declared as the new CNI (2025), but with a greasy smear across its code
// lines: the photo is fine, the lines cannot be read. PM rule: tips and Retake; after 3 failed tries
// "Continue anyway" appears, and the case is flagged for staff.
import { MRZ_TRIES_BEFORE_OVERRIDE } from "../supabase/functions/_shared/contract";
import { OCR_ASSETS } from "../apps/rider/src/mrz/types";
import { NEW_CNI_FLOW } from "./support/expectations";
import { expect, test } from "./support/fixtures";

test("smudged code lines: tips and Retake, then 'Continue anyway' after 3 tries, and the case is flagged", async ({
  page,
  rider,
  backend,
}) => {
  // Three photos of the back, each read: about 30 s in all.
  test.setTimeout(120_000);
  await rider.begin("cni_biometric");
  await rider.autoCapture("cni_biometric", "document_front");
  await rider.usePhoto();
  await rider.turnOver();

  for (let attempt = 1; attempt <= MRZ_TRIES_BEFORE_OVERRIDE; attempt++) {
    await rider.autoCapture("cni_biometric", "document_back");
    await expect(rider.mrzWarning).toBeVisible();
    await expect(rider.mrzWarning.getByRole("listitem")).toHaveText([
      rider.t("mrz.tipLines", { lines: 3 }),
      rider.t("mrz.tipGlare"),
      rider.t("mrz.tipSteady"),
    ]);
    await expect(rider.mrzRead).toHaveCount(0);
    // Retake is the main button. The photo itself cannot be used until the last try.
    await expect(rider.button("review.retake")).toHaveClass(/primary/);
    await expect(rider.button("review.use")).toHaveCount(0);
    if (attempt === MRZ_TRIES_BEFORE_OVERRIDE) break;
    await expect(rider.mrzWarning).toContainText(rider.t("mrz.retake"));
    await expect(rider.button("mrz.continue")).toHaveCount(0);
    await rider.button("review.retake").click();
  }

  // Third failed try: the rider may go on, told that the check will take longer.
  await expect(rider.mrzWarning).toContainText(rider.t("mrz.retakeIfYouCan"));
  await expect(rider.mrzWarning).toContainText(rider.t("mrz.continueNote"));
  await expect(rider.button("mrz.continue")).toHaveClass(/secondary/);
  await rider.button("mrz.continue").click();
  await expect(rider.heading("done.title")).toBeVisible({ timeout: 20_000 });

  // Retakes never reach the server: only the photo finally used is sent, with its report.
  expect(backend.routes).toEqual(NEW_CNI_FLOW);
  expect(backend.captures.map((c) => c.kind)).toEqual(["document_front", "document_back"]);
  const backCapture = backend.captures.find((c) => c.kind === "document_back")!;
  expect(backend.mrzReports).toHaveLength(1);
  const [report] = backend.mrzReports;
  expect(report.body).toMatchObject({ captureId: backCapture.captureId, attempts: MRZ_TRIES_BEFORE_OVERRIDE, engine: OCR_ASSETS.engine });
  // Whatever the reader made of the smear (no complete lines, or lines failing their check digits),
  // the server flags the case for staff.
  if (report.body.result === "unreadable") {
    expect(report.body.reason).toBe("not_found");
  } else {
    expect(Object.values(report.details.checks ?? {})).toContain(false);
  }
  expect(report.outcome).toBe("flag");
  expect(backend.status).toBe("submitted");
  await expect(page.getByText(rider.t("done.next"))).toBeVisible();
});
