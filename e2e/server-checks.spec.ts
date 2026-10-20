// Camera: the sharp ID card (as in capture-card.spec.ts). The server's check of the photos (M3): the
// photos upload while the rider does the face check ("ID and face steps all at once", PM 2026-10-20);
// then the app shows "Checking your ID…" and asks GET /flow/checks until the AI worker has looked at
// them (every FAST_POLL_MS at first), for at most CHECKS_WAIT_MS; a retake is asked only then. The fake backend runs the real server's rules
// (flow/checks.ts) on a scripted worker (FakeBackend.worker), so each test sets what the worker finds.
import {
  CHECKS_POLL_MS,
  CHECKS_WAIT_MS,
  FAST_POLL_FOR_MS,
  FAST_POLL_MS,
  type FlowChecks,
  SERVER_RETAKES_PER_SIDE,
} from "../supabase/functions/_shared/contract";
import { OCR_ASSETS, mrzModelFor } from "../apps/rider/src/mrz/types";
import type { FakeBackend } from "./support/backend";
import { GUIDES } from "./support/camera";
import { CARD_FLOW, LIVENESS, afterPhotos, expectCleanPhoto } from "./support/expectations";
import { expect, test } from "./support/fixtures";

/** The routes of one round of photos sent: an upload link and its confirmation per photo. */
const SEND = (photos: number) => Array.from({ length: photos }, () => ["POST /upload-url", "POST /captures"]).flat();

/** Each answer of GET /checks as the states of its sides, in order. */
function states(backend: FakeBackend): string[][] {
  return backend.checksAnswers.map((answer) => answer.sides.map((side) => side.state));
}

/** Typed expected answers (Playwright's toEqual takes no type argument). */
function checksOf(answers: FlowChecks[]): FlowChecks[] {
  return answers;
}

function callTimes(backend: FakeBackend, route: string): number[] {
  return backend.calls.filter((c) => c.route === route).map((c) => c.at);
}

test("checks pass: the face check right after the photos, then 'Checking your ID…' every second, then the submit", async ({
  page,
  rider,
  backend,
}) => {
  backend.verdicts({}, 2); // each photo is still being checked for the first two answers
  await rider.begin("cni_legacy");
  await rider.photographCard("cni_legacy");
  // No wait between the photos and the face check.
  await rider.passLiveness(5_000);

  // One result step: a spinner and nothing to press.
  await expect(rider.checkingHeading).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status")).toHaveText(rider.t("result.pendingBody"));
  await expect(page.locator("main > :not(header) button")).toHaveCount(0);
  await rider.waitForResult();

  expect(afterPhotos(backend.routes)).toEqual([...SEND(2), ...LIVENESS, "GET /checks", "GET /checks", "GET /checks", "POST /submit"]);
  expect(states(backend)).toEqual([
    ["pending", "pending"],
    ["pending", "pending"],
    ["ok", "ok"],
  ]);
  expect(backend.checksAnswers.map((a) => a.done)).toEqual([false, false, true]);
  // Asked as soon as the face check is recorded, then every FAST_POLL_MS (the 10-second target).
  const [faceCheck] = callTimes(backend, "POST /liveness/captures");
  const asked = callTimes(backend, "GET /checks");
  expect(asked[0] - faceCheck).toBeLessThan(1_500);
  for (let i = 1; i < asked.length; i++) {
    expect(asked[i] - asked[i - 1]).toBeGreaterThanOrEqual(FAST_POLL_MS - 100);
    expect(asked[i] - asked[i - 1]).toBeLessThan(FAST_POLL_MS + 1_500);
  }
  const screens = await rider.screensSeen();
  // The photos went up during the face check: no upload screen, no "Checking your photos…" between.
  expect(screens).not.toContain(rider.t("upload.title"));
  expect(screens).not.toContain(rider.t("checks.title"));
  expect(screens.indexOf(rider.t("result.pendingTitle"))).toBeGreaterThan(screens.indexOf(rider.t("liveness.title")));
  expect(backend.status).toBe("submitted");
});

test("server retake of the front: straight back to its camera, told why; only that photo is sent again", async ({
  page,
  rider,
  backend,
}) => {
  backend.verdicts({ document_front: ["no_document"] });
  await rider.begin("cni_legacy");
  await rider.photographCard("cni_legacy");
  // The retake is asked at the end, after the face check (PM, 2026-10-20).
  await rider.passLiveness(5_000);

  // No "turn over" step: the front's camera, with the side named and the reason.
  const alert = rider.cameraRetakeAlert("cni_legacy", "document_front");
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(rider.captureHeading("cni_legacy", "document_front")).toBeVisible();
  await expect(alert).toContainText(rider.retakeReason("no_document"));
  // The alert sits above the hint, so the guide is placed lower than usual: the fake camera's card is
  // no longer centred in it, and the photo is taken with the shutter (see Rider.shutterCapture).
  expect((await rider.guide()).y).toBeGreaterThan(GUIDES.id1.y + 10);
  await rider.shutterCapture("cni_legacy", "document_front");
  await expect(alert).toHaveCount(0);
  await rider.usePhoto();
  // The face check is not asked again.
  await rider.waitForResult();

  // The back was already on the server: only the new front is sent, then checked again.
  expect(afterPhotos(backend.routes)).toEqual([...SEND(2), ...LIVENESS, "GET /checks", ...SEND(1), "GET /checks", "POST /submit"]);
  expect(backend.calls.filter((c) => c.route === "POST /upload-url").map((c) => c.body)).toEqual([
    { kind: "document_front" },
    { kind: "document_back" },
    { kind: "document_front" },
  ]);
  const [firstFront, back, newFront] = backend.captures;
  expect(backend.captures.map((c) => [c.kind, c.live])).toEqual([
    ["document_front", false],
    ["document_back", true],
    ["document_front", true],
  ]);
  expect(newFront.quality.source).toBe("manual");
  // The server erased the photo it replaced.
  expect(backend.objects.has(firstFront.path)).toBe(false);
  expect(backend.objects.has(newFront.path)).toBe(true);
  expect(backend.checksAnswers).toEqual(checksOf([
    {
      done: true,
      expired: false,
      sides: [
        { kind: "document_front", captureId: firstFront.captureId, state: "retake", reason: "no_document" },
        { kind: "document_back", captureId: back.captureId, state: "ok", reason: null },
      ],
    },
    {
      done: true,
      expired: false,
      sides: [
        { kind: "document_front", captureId: newFront.captureId, state: "ok", reason: null },
        { kind: "document_back", captureId: back.captureId, state: "ok", reason: null },
      ],
    },
  ]));
  for (const capture of backend.captures) expectCleanPhoto(capture.object);
  const screens = await rider.screensSeen();
  expect(screens.filter((title) => title === rider.t("turnOver.title"))).toHaveLength(1);
  expect(screens.filter((title) => title === rider.t("liveness.title"))).toHaveLength(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(backend.status).toBe("submitted");
});

test("both sides retaken (in English): the front's camera first, then 'turn over' for the back, each told why", async ({
  rider,
  backend,
}) => {
  backend.verdicts({ document_front: ["unreadable"], document_back: ["no_document"] });
  await rider.open();
  await rider.switchLanguage("en");
  await rider.start();
  await rider.acceptConsent();
  await rider.chooseDocument("cni_legacy");
  await rider.photographCard("cni_legacy");
  await rider.passLiveness(5_000);

  const front = rider.cameraRetakeAlert("cni_legacy", "document_front");
  await expect(front).toBeVisible({ timeout: 20_000 });
  await expect(front).toContainText("Front: please take this photo again");
  await expect(front).toContainText("Text unreadable: avoid blur and glare");
  await rider.shutterCapture("cni_legacy", "document_front");
  await rider.usePhoto();
  // The back comes next, through the "turn over" step, which now says why.
  await rider.turnOverForRetake("cni_legacy", "no_document");
  await expect(rider.cameraRetakeAlert("cni_legacy", "document_back")).toContainText(rider.retakeReason("no_document"));
  await rider.shutterCapture("cni_legacy", "document_back");
  await rider.usePhoto();
  await rider.waitForResult();

  expect(afterPhotos(backend.routes)).toEqual([...SEND(2), ...LIVENESS, "GET /checks", ...SEND(2), "GET /checks", "POST /submit"]);
  expect(backend.calls[1].body).toMatchObject({ language: "en" });
  expect(backend.captures.map((c) => [c.kind, c.live])).toEqual([
    ["document_front", false],
    ["document_back", false],
    ["document_front", true],
    ["document_back", true],
  ]);
  expect(states(backend)).toEqual([
    ["retake", "retake"],
    ["ok", "ok"],
  ]);
  expect(backend.status).toBe("submitted");
});

test("server retake of the code-lines side (new CNI back): read again on the phone, and reported again", async ({
  page,
  rider,
  backend,
}) => {
  // Three photos and two reads of the back.
  test.setTimeout(90_000);
  // The phone cannot read the code lines (as on a network that blocks the engine): only the server
  // can tell the photo is unreadable.
  await page.route(
    (url) => url.pathname === OCR_ASSETS.workerPath,
    (route) => route.abort("blockedbyclient"),
  );
  backend.verdicts({ document_back: ["unreadable"] });
  await rider.begin("cni_biometric");
  await rider.photographCard("cni_biometric");
  await rider.passLiveness(5_000);

  await rider.turnOverForRetake("cni_biometric", "unreadable");
  await expect(rider.cameraRetakeAlert("cni_biometric", "document_back")).toContainText(rider.retakeReason("unreadable"));
  await rider.shutterCapture("cni_biometric", "document_back");
  await rider.usePhoto();
  await rider.waitForResult();

  // The new photo of the back goes through the reading screen again, and its own report follows it.
  const screens = await rider.screensSeen();
  expect(screens.filter((title) => title === rider.t("reading.title"))).toHaveLength(2);
  expect(afterPhotos(backend.routes)).toEqual([
    ...SEND(2),
    "POST /mrz",
    ...LIVENESS,
    "GET /checks",
    ...SEND(1),
    "POST /mrz",
    "GET /checks",
    "POST /submit",
  ]);
  const [, firstBack, newBack] = backend.captures;
  expect([firstBack.kind, firstBack.live, newBack.kind, newBack.live]).toEqual(["document_back", false, "document_back", true]);
  expect(backend.mrzReports.map((r) => r.body)).toEqual([
    { captureId: firstBack.captureId, result: "unreadable", reason: "reader_unavailable", attempts: 1, engine: mrzModelFor(true).engine },
    { captureId: newBack.captureId, result: "unreadable", reason: "reader_unavailable", attempts: 2, engine: mrzModelFor(true).engine },
  ]);
  expect(states(backend)).toEqual([
    ["ok", "retake"],
    ["ok", "ok"],
  ]);
  expect(backend.checksAnswers[0].sides[1]).toMatchObject({ captureId: firstBack.captureId, reason: "unreadable" });
  expect(backend.status).toBe("submitted");
});

test("code lines read right on the phone: never retaken, whatever the server's reader made of the photo", async ({
  rider,
  backend,
}) => {
  backend.verdicts({ document_back: ["unreadable"] });
  // The server's own rule already passes such a photo; a server that asked anyway is still not obeyed.
  const computed: FlowChecks[] = [];
  backend.checksOverride = (checks) => {
    computed.push(checks);
    return {
      ...checks,
      sides: checks.sides.map((s) => (s.kind === "document_back" ? { ...s, state: "retake", reason: "unreadable" } : s)),
    };
  };
  await rider.begin("cni_biometric");
  await rider.photographCard("cni_biometric");
  await rider.waitForSubmit();

  expect(afterPhotos(backend.routes)).toEqual([...SEND(2), "POST /mrz", ...LIVENESS, "GET /checks", "POST /submit"]);
  expect(backend.mrzReports.map((r) => r.outcome)).toEqual(["pass"]);
  expect(computed.map((c) => c.sides.map((s) => s.state))).toEqual([["ok", "ok"]]);
  expect(backend.captures.every((c) => c.live)).toBe(true);
  expect(backend.status).toBe("submitted");
});

test("retake limit: a second unusable photo of the same side goes to staff, the rider is not asked again", async ({
  rider,
  backend,
}) => {
  expect(SERVER_RETAKES_PER_SIDE).toBe(1);
  // The worker finds no document on any photo of the front.
  backend.worker = (capture) => ({ result: "done", verdict: capture.kind === "document_front" ? "no_document" : "ok" });
  await rider.begin("cni_legacy");
  await rider.photographCard("cni_legacy");
  await rider.passLiveness(5_000);
  await expect(rider.cameraRetakeAlert("cni_legacy", "document_front")).toBeVisible({ timeout: 20_000 });
  await rider.shutterCapture("cni_legacy", "document_front");
  await rider.usePhoto();
  await rider.waitForResult();

  // The server's rule: one retake per side, then the photo is flagged, never refused.
  expect(afterPhotos(backend.routes)).toEqual([...SEND(2), ...LIVENESS, "GET /checks", ...SEND(1), "GET /checks", "POST /submit"]);
  expect(states(backend)).toEqual([
    ["retake", "ok"],
    ["ok", "ok"],
  ]);
  expect(backend.status).toBe("submitted");
});

test("retake limit on the phone too: a server asking for the same side again is not obeyed", async ({ rider, backend }) => {
  // A server breaking its own rule (asking for the front every time): the app's own limit holds.
  backend.checksOverride = (checks) => ({
    ...checks,
    sides: checks.sides.map((s) => (s.kind === "document_front" ? { ...s, state: "retake", reason: "no_document" } : s)),
  });
  await rider.begin("cni_legacy");
  await rider.photographCard("cni_legacy");
  await rider.passLiveness(5_000);
  await expect(rider.cameraRetakeAlert("cni_legacy", "document_front")).toBeVisible({ timeout: 20_000 });
  await rider.shutterCapture("cni_legacy", "document_front");
  await rider.usePhoto();
  await rider.waitForResult();

  expect(afterPhotos(backend.routes)).toEqual([...SEND(2), ...LIVENESS, "GET /checks", ...SEND(1), "GET /checks", "POST /submit"]);
  expect(states(backend)).toEqual([
    ["retake", "ok"],
    ["retake", "ok"],
  ]);
  expect(backend.captures.filter((c) => c.kind === "document_front")).toHaveLength(1 + SERVER_RETAKES_PER_SIDE);
  expect(backend.status).toBe("submitted");
});

test("time-out: the worker never answers; after CHECKS_WAIT_MS the photos are submitted, with no error shown", async ({
  page,
  rider,
  backend,
}) => {
  // About 10 s of photos, then the full 20 s wait.
  test.setTimeout(90_000);
  backend.worker = () => ({ result: "stuck" });
  await rider.begin("cni_legacy");
  await rider.photographCard("cni_legacy");
  await rider.passLiveness(5_000);
  await expect(rider.checkingHeading).toBeVisible({ timeout: 20_000 });
  await rider.waitForResult(CHECKS_WAIT_MS + 15_000);
  await expect(page.getByRole("alert")).toHaveCount(0);

  const asked = callTimes(backend, "GET /checks");
  // The checks are over when the case is submitted.
  const [checksOver] = callTimes(backend, "POST /submit");
  // The real defaults (no ?debug=1 override): asked every second for 15 s, then every 2 s, for 20 s.
  expect(checksOver - asked[0]).toBeGreaterThanOrEqual(CHECKS_WAIT_MS - 250);
  expect(checksOver - asked[0]).toBeLessThan(CHECKS_WAIT_MS + 5_000);
  const expected = FAST_POLL_FOR_MS / FAST_POLL_MS + (CHECKS_WAIT_MS - FAST_POLL_FOR_MS) / CHECKS_POLL_MS;
  expect(asked.length).toBeGreaterThanOrEqual(expected - 3);
  expect(asked.length).toBeLessThanOrEqual(expected + 1);
  expect(states(backend).every((answer) => answer.every((state) => state === "pending"))).toBe(true);
  expect(afterPhotos(backend.routes).at(-1)).toBe("POST /submit");
  expect(backend.status).toBe("submitted");
});

test("unchecked: the worker is out of budget for one photo and could not be rung for the other: submitted at once", async ({
  page,
  rider,
  backend,
}) => {
  backend.worker = (capture) =>
    capture.kind === "document_front" ? { result: "failed", error: "budget" } : { result: "stuck", ringFailed: true };
  await rider.begin("cni_legacy");
  await rider.photographCard("cni_legacy");
  await rider.waitForSubmit(5_000);
  await expect(page.getByRole("alert")).toHaveCount(0);

  expect(backend.routes).toEqual(CARD_FLOW);
  expect(backend.checksAnswers).toEqual(checksOf([
    {
      done: true,
      expired: false,
      sides: [
        { kind: "document_front", captureId: backend.captures[0].captureId, state: "unchecked", reason: null },
        { kind: "document_back", captureId: backend.captures[1].captureId, state: "unchecked", reason: null },
      ],
    },
  ]));
  const [asked] = callTimes(backend, "GET /checks");
  // The checks are over at once: the case is submitted.
  const [checksOver] = callTimes(backend, "POST /submit");
  expect(checksOver - asked).toBeLessThan(CHECKS_POLL_MS);
  expect(backend.status).toBe("submitted");
});

test("checks unavailable (the function answers 503): asked again until the wait is over, then submitted", async ({
  page,
  rider,
  backend,
}) => {
  backend.failChecks(Number.POSITIVE_INFINITY);
  // Debug mode lets the wait be shortened (flow/checks.ts parseChecksTiming), as the PM can on a phone.
  await rider.begin("cni_legacy", "?debug=1&checksWaitMs=3000&checksPollMs=500");
  await rider.photographCard("cni_legacy");
  await rider.waitForSubmit(5_000);
  await expect(page.getByRole("alert")).toHaveCount(0);

  const asked = callTimes(backend, "GET /checks");
  // The checks are over when the case is submitted.
  const [checksOver] = callTimes(backend, "POST /submit");
  expect(asked.length).toBeGreaterThanOrEqual(3);
  expect(asked.length).toBeLessThanOrEqual(3_000 / 500 + 1);
  expect(checksOver - asked[0]).toBeGreaterThanOrEqual(3_000 - 250);
  expect(checksOver - asked[0]).toBeLessThan(3_000 + 5_000);
  expect(backend.checksAnswers).toEqual([]);
  expect(backend.status).toBe("submitted");
});
