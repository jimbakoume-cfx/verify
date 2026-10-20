// Automatic approval (PM decision 2026-10-20): the result screen after the submit. Camera: the sharp ID
// card (old CNI, nothing read). The fake backend scripts what the server's flow_result answers.
import { FAST_POLL_MS, RESULT_POLL_MS } from "../supabase/functions/_shared/contract";
import { CARD_FLOW } from "./support/expectations";
import { expect, test } from "./support/fixtures";
import type { Rider } from "./support/rider";

const RETURN_URL = "https://ride.example/verified?ride=e2e";

/** From the link to the submit: consent, the old CNI's two sides, the face check, the server's checks. */
async function submitCard(rider: Rider, query = ""): Promise<void> {
  await rider.begin("cni_legacy", query);
  await rider.photographCard("cni_legacy");
  await rider.passLiveness();
}

test("verified: the rider is told the ID is verified, and Continue goes back to the ride app", async ({ page, rider, backend }) => {
  // The server is still checking for two answers (the face worker), then the system approves.
  backend.result = (n) => (n <= 2 ? { state: "pending", returnUrl: null } : { state: "verified", returnUrl: RETURN_URL });
  await page.route("https://ride.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Ride</title><p>Back in the ride app</p>" }),
  );
  await submitCard(rider);

  await expect(rider.heading("result.pendingTitle")).toBeVisible();
  await expect(rider.heading("result.verifiedTitle")).toBeVisible({ timeout: 20_000 });
  await expect(rider.heading("result.verifiedTitle")).toHaveText("Votre pièce d'identité est vérifiée ✓");
  // Asked at once after the submit, then every FAST_POLL_MS (the 10-second target; RESULT_POLL_MS later).
  expect(backend.results.map((r) => r.answer.state)).toEqual(["pending", "pending", "verified"]);
  const gaps = backend.results.slice(1).map((r, i) => r.at - backend.results[i].at);
  for (const gap of gaps) {
    expect(gap).toBeGreaterThanOrEqual(FAST_POLL_MS - 100);
    expect(gap).toBeLessThan(FAST_POLL_MS + 1_500);
  }
  const submitAt = backend.calls.find((c) => c.route === "POST /submit")!.at;
  expect(backend.results[0].at - submitAt).toBeLessThan(1_500);
  expect(backend.routes).toEqual(CARD_FLOW);
  // Nothing about a review or a refusal.
  await expect(page.getByText(rider.t("result.reviewBody"))).toHaveCount(0);

  await rider.button("result.continue").click();
  await page.waitForURL(RETURN_URL);
  await expect(page.getByText("Back in the ride app")).toBeVisible();
});

test("verified without a return address (in English): Continue ends on the done screen", async ({ page, rider, backend }) => {
  backend.result = () => ({ state: "verified", returnUrl: null });
  await rider.open();
  await rider.switchLanguage("en");
  await rider.start();
  await rider.acceptConsent();
  await rider.chooseDocument("cni_legacy");
  await rider.photographCard("cni_legacy");
  await rider.passLiveness();

  await expect(rider.heading("result.verifiedTitle")).toHaveText("Your ID is verified ✓", { timeout: 20_000 });
  await rider.button("result.continue").click();
  await expect(rider.heading("done.verifiedTitle")).toBeVisible();
  await expect(page.getByText(rider.t("done.close"))).toBeVisible();
  expect(backend.results).toHaveLength(1);
});

test("review: the rider is told a few details are being checked, with nothing to press", async ({ page, rider, backend }) => {
  backend.result = (n) => (n === 1 ? { state: "pending", returnUrl: null } : { state: "review", returnUrl: null });
  await submitCard(rider);

  await expect(rider.heading("result.reviewTitle")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(rider.t("result.reviewBody"))).toHaveText(
    "Nous vérifions quelques détails, nous vous tiendrons informé.",
  );
  await expect(rider.button("result.continue")).toHaveCount(0);
  expect(backend.results.map((r) => r.answer.state)).toEqual(["pending", "review"]);
  // Settled: the app stops asking.
  await page.waitForTimeout(RESULT_POLL_MS + 1_000);
  expect(backend.results).toHaveLength(2);
});

test("time-out: still pending when the wait ends, the rider is told what a review says", async ({ page, rider, backend }) => {
  backend.result = () => ({ state: "pending", returnUrl: null });
  // Debug mode: a 6-second wait instead of 75 (flow/result.ts parseResultTiming).
  await submitCard(rider, "?debug=1&resultWaitMs=6000");

  await expect(rider.heading("result.pendingTitle")).toBeVisible();
  await expect(rider.heading("result.reviewTitle")).toBeVisible({ timeout: 15_000 });
  const polls = backend.results.length;
  // Every second during the 6 s.
  expect(polls).toBeGreaterThanOrEqual(4);
  expect(polls).toBeLessThanOrEqual(7);
  await expect(rider.button("result.continue")).toHaveCount(0);
  await page.waitForTimeout(RESULT_POLL_MS + 1_000);
  expect(backend.results).toHaveLength(polls);
});

test("speed: the answer within 10 s of the end of the face check, never waiting for a sweep", async ({ rider, backend }) => {
  // Fixes after the PM's first real test (27 s from submit to the assessment): the photos are checked
  // during the face check, the face worker answers about 3 s after the frames (three pending answers
  // here), and the app asks every second. The database assesses the case as the last check lands
  // (supabase/tests/95_real_test_fixes_test.sql): nothing waits for the minute's sweep.
  backend.verdicts({}, 1);
  backend.result = (n) => (n <= 3 ? { state: "pending", returnUrl: null } : { state: "verified", returnUrl: null });
  await rider.begin("cni_legacy");
  await rider.photographCard("cni_legacy");
  await rider.passLiveness(5_000);
  await expect(rider.heading("result.verifiedTitle")).toBeVisible({ timeout: 20_000 });

  const faceCheckRecorded = backend.calls.find((c) => c.route === "POST /liveness/captures")!.at;
  const verifiedAt = await rider.screenShownAt(rider.t("result.verifiedTitle"));
  expect(verifiedAt - faceCheckRecorded).toBeLessThan(10_000);
  // About 4 s here: the checks at once, the submit, then four answers a second apart.
  expect(verifiedAt - faceCheckRecorded).toBeLessThan(4 * FAST_POLL_MS + 3_000);
});
