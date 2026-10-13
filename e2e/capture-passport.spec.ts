// Camera: a sharp passport data page, as a Full HD phone held upright sees it.
import { expectAutoQuality, expectCleanPhoto } from "./support/expectations";
import { expect, test } from "./support/fixtures";

test("passport: only the photo page is taken, then sent", async ({ page, rider, backend }) => {
  await rider.begin("passport");
  await rider.autoCapture("passport", "document_front");
  await expect(page.getByText(`${rider.t("sides.passportPage")} · ${rider.t("documents.passport")}`)).toBeVisible();
  await rider.usePhoto();

  // No "turn the card over" step: straight to the upload.
  await expect(rider.heading("done.title")).toBeVisible({ timeout: 20_000 });
  expect(backend.routes).toEqual([
    "GET /session",
    "POST /consent",
    "POST /document-type",
    "POST /upload-url",
    "POST /captures",
    "POST /submit",
  ]);
  expect(backend.calls[2].body).toEqual({ declaredDocument: "passport" });
  expect(backend.calls[3].body).toEqual({ kind: "document_front" });
  expect(backend.session().requiredSides).toEqual(["document_front"]);
  expect(backend.captures).toHaveLength(1);
  expectCleanPhoto(backend.captures[0].object);
  expectAutoQuality(backend.captures[0].quality);
  expect(backend.status).toBe("submitted");
});
