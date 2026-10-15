// Camera: the sharp ID card, declared as the new CNI (2025). M4: the server finds the document expired
// from its code lines (the consistency check's firm flag document_expired; FakeBackend.expiredDocuments)
// and GET /flow/checks says so once the back is checked. "Checking your photos…" then stops waiting
// and asks the rider to use another, valid document, or to continue anyway.
import { expect, test } from "./support/fixtures";
import { CARD_FLOW, NEW_CNI_FLOW, afterPhotos } from "./support/expectations";

/** The routes of one round of photos sent: an upload link and its confirmation per photo. */
const SEND = (photos: number) => Array.from({ length: photos }, () => ["POST /upload-url", "POST /captures"]).flat();

test("expired document, 'Continue anyway': told at once, then the case is submitted as usual", async ({ page, rider, backend }) => {
  backend.expiredDocuments.add("cni_biometric");
  await rider.begin("cni_biometric");
  await rider.autoCapture("cni_biometric", "document_front");
  await rider.usePhoto();
  await rider.turnOver();
  await rider.autoCapture("cni_biometric", "document_back");
  await rider.usePhoto();

  // On "Checking your photos…": the message and the two choices; nothing else is asked meanwhile.
  await expect(rider.checkingHeading).toBeVisible({ timeout: 20_000 });
  const notice = page.locator(".notice.warn[role=alert]");
  await expect(notice).toContainText(rider.t("checks.expired.title"));
  await expect(notice).toContainText(rider.t("checks.expired.body"));
  await expect(rider.button("checks.expired.another")).toHaveClass(/primary/);
  await expect(page.getByText(rider.t("checks.body"))).toHaveCount(0);
  await page.waitForTimeout(2_500);
  expect(backend.routes.filter((r) => r === "GET /checks")).toHaveLength(1);
  expect(backend.checksAnswers[0]).toMatchObject({ done: true, expired: true });
  expect(backend.status).toBe("in_progress");

  await rider.button("checks.expired.continue").click();
  await rider.waitForSubmit();
  // Asked once more after "Continue anyway", then submitted: staff see the hard flag.
  expect(backend.routes).toEqual([...NEW_CNI_FLOW.slice(0, -1), "GET /checks", "POST /submit"]);
  expect(backend.status).toBe("submitted");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("expired document, 'Use another document': back to the list; the next document starts with new photos", async ({
  page,
  rider,
  backend,
}) => {
  backend.expiredDocuments.add("cni_biometric");
  rider.lang = "en";
  await rider.open("?lang=en");
  await rider.start();
  await rider.acceptConsent();
  await rider.chooseDocument("cni_biometric");
  await rider.autoCapture("cni_biometric", "document_front");
  await rider.usePhoto();
  await rider.turnOver();
  await rider.autoCapture("cni_biometric", "document_back");
  await rider.usePhoto();

  await expect(page.getByText("This document has expired")).toBeVisible({ timeout: 20_000 });
  await rider.button("checks.expired.another").click();

  // The document list again; the old CNI this time.
  await expect(rider.heading("document.title")).toBeVisible();
  await rider.chooseDocument("cni_legacy");
  await rider.photographCard("cni_legacy");
  await rider.waitForSubmit();

  expect(backend.declaredDocuments).toEqual(["cni_biometric", "cni_legacy"]);
  // Both sides photographed again and sent: each new photo replaced the expired document's.
  const routes = afterPhotos(backend.routes);
  expect(routes).toEqual([
    ...SEND(2),
    "POST /mrz",
    "GET /checks",
    "POST /document-type",
    ...SEND(2),
    "GET /checks",
    "POST /submit",
  ]);
  expect(backend.captures.map((c) => [c.kind, c.live])).toEqual([
    ["document_front", false],
    ["document_back", false],
    ["document_front", true],
    ["document_back", true],
  ]);
  expect(backend.checksAnswers.map((a) => a.expired)).toEqual([true, false]);
  expect(backend.status).toBe("submitted");
  // The flow after the new choice is the ordinary one for the old CNI.
  expect(CARD_FLOW.slice(-2)).toEqual(routes.slice(-2));
});
