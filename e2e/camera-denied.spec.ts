// Camera: present, but the rider answered "Block" to the permission prompt.
import { cameraRequests, expect, test } from "./support/fixtures";

test("camera permission denied: a clear message, a retry, and a way back", async ({ page, rider, backend }) => {
  await rider.begin("cni_legacy");
  await expect(rider.captureHeading("cni_legacy", "document_front")).toBeVisible();

  // A modal card over the camera screen (role alertdialog), which takes focus.
  const problem = page.getByRole("alertdialog", { name: rider.t("camera.deniedTitle") });
  await expect(problem).toBeVisible();
  await expect(problem).toContainText(rider.t("camera.denied"));
  await expect(problem).toBeFocused();
  await expect(rider.shutter).toHaveCount(0);

  // "Try again" asks the browser again; it still refuses.
  await problem.getByRole("button", { name: rider.t("common.retry"), exact: true }).click();
  await expect.poll(async () => (await cameraRequests(page)).length).toBe(2);
  await expect(problem).toBeVisible();

  await problem.getByRole("button", { name: rider.t("common.back"), exact: true }).click();
  await expect(rider.heading("document.title")).toBeVisible();
  expect(backend.routes).toEqual(["GET /session", "POST /consent", "POST /document-type"]);
});
