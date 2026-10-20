// The rider's steps through the flow, found by role and visible text in the current language.
import { type Locator, type Page, expect } from "@playwright/test";
import {
  type CaptureSide,
  type DeclaredDocument,
  MRZ_EXPECTATION,
  type RetakeReason,
} from "../../supabase/functions/_shared/contract";
import type { FakeBackend } from "./backend";
import { type Language, translate } from "./i18n";

/** Spec: the front is auto-captured within 10 s with a sharp, well-framed card. */
export const AUTO_CAPTURE_TIMEOUT = 10_000;
/**
 * Reading the code lines after the photo: about 0.5-2 s in headless Chromium, including the
 * engine's start on a fresh browser profile (the model is not cached yet). Generous for CI.
 */
export const READ_TIMEOUT = 20_000;
/** Spec: the manual shutter appears when auto-capture has not fired within 8 s. */
export const SHUTTER_TIMEOUT = 12_000;
/**
 * M5: Start is offered once the brightness check has passed for about a second, or after 6 s
 * whatever it says. Generous for CI.
 */
export const LIVENESS_START_TIMEOUT = 12_000;
/** M5: the capture (10.5 s), then the frames' upload and report. */
export const LIVENESS_CAPTURE_TIMEOUT = 30_000;

export class Rider {
  /** The language the rider currently sees (French by default). */
  lang: Language = "fr";

  constructor(
    readonly page: Page,
    readonly backend: FakeBackend,
  ) {}

  t(key: string, vars?: Record<string, string | number>): string {
    return translate(this.lang, key, vars);
  }

  button(key: string): Locator {
    return this.page.getByRole("button", { name: this.t(key), exact: true });
  }

  heading(key: string, vars?: Record<string, string | number>): Locator {
    return this.page.getByRole("heading", { level: 1, name: this.t(key, vars), exact: true });
  }

  /** The camera screen's title: "Recto", "Verso" or "Page photo". */
  captureHeading(document: DeclaredDocument, side: CaptureSide): Locator {
    return this.heading(sideKey(document, side));
  }

  /** How the app names a side: "Recto", "Verso" or "Page photo". */
  sideName(document: DeclaredDocument, side: CaptureSide): string {
    return this.t(sideKey(document, side));
  }

  /** "Checking your photos…" (M3): the app waits for the server's checks of the photos just sent. */
  get checkingHeading(): Locator {
    return this.heading("checks.title");
  }

  /** "<Side>: please take this photo again", as the server asked (M3). */
  retakeTitle(document: DeclaredDocument, side: CaptureSide): string {
    return this.t("checks.retake", { side: this.sideName(document, side) });
  }

  /** Why the server asked for a new photo, as the rider reads it. */
  retakeReason(reason: RetakeReason): string {
    return this.t(reason === "no_document" ? "hints.no_document" : "checks.unreadable");
  }

  /** The camera's alert after a server retake: the side to take again, then why. */
  cameraRetakeAlert(document: DeclaredDocument, side: CaptureSide): Locator {
    return this.page.locator(".capture-alert[role=alert]").filter({ hasText: this.retakeTitle(document, side) });
  }

  get hint(): Locator {
    return this.page.locator(".hint-pill");
  }

  get shutter(): Locator {
    return this.page.getByRole("button", { name: this.t("capture.shutter"), exact: true });
  }

  /** "Code lines read ✓" on the review screen: all a rider learns about the reading. */
  get mrzRead(): Locator {
    return this.page.locator("p.mrz-read");
  }

  /** "The code lines could not be read", with tips, on the review screen. */
  get mrzWarning(): Locator {
    return this.page.locator(".notice.warn").filter({ hasText: this.t("mrz.unreadTitle") });
  }

  /** The ?debug=1 section about the code lines (review screen). */
  get mrzDebug(): Locator {
    return this.page.locator(".mrz-debug");
  }

  /** Opens the rider link: `/#s=<token>`, with an optional query such as "?debug=1". */
  async open(query = ""): Promise<void> {
    await this.page.goto(`/${query}#s=${this.backend.token}`);
  }

  async start(): Promise<void> {
    await expect(this.button("start")).toBeEnabled();
    await this.button("start").click();
  }

  async acceptConsent(): Promise<void> {
    await expect(this.heading("consent.title")).toBeVisible();
    await expect(this.button("consent.accept")).toBeDisabled();
    await this.page.getByRole("checkbox", { name: this.t("consent.checkbox") }).check();
    await this.button("consent.accept").click();
  }

  async chooseDocument(document: DeclaredDocument): Promise<void> {
    await expect(this.heading("document.title")).toBeVisible();
    await this.page.getByRole("radio", { name: this.t(`documents.${document}`) }).check();
    await this.button("document.continue").click();
  }

  /** From the link to the camera for the first side. */
  async begin(document: DeclaredDocument, query = ""): Promise<void> {
    await this.open(query);
    await this.start();
    await this.acceptConsent();
    await this.chooseDocument(document);
  }

  /**
   * Waits for the camera screen of `side`, then for the automatic photo, then (for the side that
   * carries the code lines) for their reading: ends on the review screen.
   */
  async autoCapture(document: DeclaredDocument, side: CaptureSide): Promise<void> {
    await expect(this.captureHeading(document, side)).toBeVisible();
    const taken = this.heading("review.title").or(this.heading("reading.title"));
    await expect(taken).toBeVisible({ timeout: AUTO_CAPTURE_TIMEOUT });
    const read = MRZ_EXPECTATION[document]?.side === side;
    await expect(this.heading("review.title")).toBeVisible({ timeout: read ? READ_TIMEOUT : undefined });
  }

  /**
   * The photo taken with the shutter, offered after 8 s without an automatic one, then (for the side
   * that carries the code lines) their reading: ends on the review screen. Used after a server retake:
   * the camera's alert ("photo à reprendre") sits above the hint and places the guide lower, where
   * the fake camera's card, drawn for the usual guide, is not centred for an automatic photo.
   */
  async shutterCapture(document: DeclaredDocument, side: CaptureSide): Promise<void> {
    await expect(this.captureHeading(document, side)).toBeVisible();
    await expect(this.shutter).toBeVisible({ timeout: SHUTTER_TIMEOUT });
    await this.shutter.click();
    const read = MRZ_EXPECTATION[document]?.side === side;
    await expect(this.heading("review.title")).toBeVisible({ timeout: read ? READ_TIMEOUT : undefined });
  }

  async usePhoto(): Promise<void> {
    await expect(this.page.locator(".notice.warn")).toHaveCount(0);
    await this.button("review.use").click();
  }

  async turnOver(): Promise<void> {
    await expect(this.heading("turnOver.title")).toBeVisible();
    await this.button("turnOver.continue").click();
  }

  /** The "turn over" step after the server asked for a new photo of the back: titled so, with why. */
  async turnOverForRetake(document: DeclaredDocument, reason: RetakeReason): Promise<void> {
    await expect(this.page.getByRole("heading", { level: 1, name: this.retakeTitle(document, "document_back"), exact: true })).toBeVisible();
    await expect(this.page.getByRole("alert")).toHaveText(this.retakeReason(reason));
    await this.button("turnOver.continue").click();
  }

  /** Both sides of an ID-1 card, automatically, then the upload. */
  async photographCard(document: DeclaredDocument): Promise<void> {
    await this.autoCapture(document, "document_front");
    await this.usePhoto();
    await this.turnOver();
    await this.autoCapture(document, "document_back");
    await this.usePhoto();
  }

  /** "Face check" (M5): its camera screen's title. */
  get livenessHeading(): Locator {
    return this.heading("liveness.title");
  }

  /** The face check's Start button. */
  get livenessStart(): Locator {
    return this.button("liveness.start");
  }

  /**
   * M5: waits for the face check (after the server's checks, within `timeout`), starts it as soon as
   * the app allows, and waits until the frames are recorded and the screen moves on. The capture
   * itself takes about 10.5 s.
   */
  async passLiveness(timeout = 30_000): Promise<void> {
    await expect(this.livenessHeading).toBeVisible({ timeout });
    await expect(this.livenessStart).toBeEnabled({ timeout: LIVENESS_START_TIMEOUT });
    await this.livenessStart.click();
    await expect(this.livenessHeading).toBeHidden({ timeout: LIVENESS_CAPTURE_TIMEOUT });
  }

  /**
   * From the checking screen to the end: the server's checks are over, the face check is done, the case
   * is submitted, and the result screen has its answer (the fake backend's default: review).
   */
  async waitForSubmit(timeout = 30_000): Promise<void> {
    await this.passLiveness(timeout);
    await expect(this.heading("result.reviewTitle").or(this.heading("result.verifiedTitle"))).toBeVisible({ timeout: 20_000 });
  }

  /** Every screen title shown since the link was opened, in order (logged by fixtures.ts). */
  screensSeen(): Promise<string[]> {
    return this.page.evaluate(() => [...(window as unknown as { __screens: string[] }).__screens]);
  }

  /** When (Date.now()) the screen titled `title` first appeared; NaN if it never did. */
  async screenShownAt(title: string): Promise<number> {
    const [screens, times] = await this.page.evaluate(() => {
      const w = window as unknown as { __screens: string[]; __screenTimes: number[] };
      return [[...w.__screens], [...w.__screenTimes]] as const;
    });
    const index = screens.indexOf(title);
    return index < 0 ? Number.NaN : times[index];
  }

  async switchLanguage(lang: Language): Promise<void> {
    await this.page.getByRole("button", { name: lang.toUpperCase(), exact: true }).click();
    this.lang = lang;
    await expect(this.page.locator("html")).toHaveAttribute("lang", lang);
  }

  /** The ?debug=1 panel (live camera or review) as { label: value } in the current language. */
  async debugValues(panel: "live" | "still"): Promise<Record<string, string>> {
    const selector = panel === "live" ? ".capture-debug > div" : ".debug-box dl > div";
    const rows = await this.page.locator(selector).evaluateAll((divs) =>
      divs.map((div) => [div.querySelector("dt")?.textContent ?? "", div.querySelector("dd")?.textContent ?? ""]),
    );
    return Object.fromEntries(rows);
  }

  /** The guide drawn over the camera, in CSS pixels. */
  async guide(): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.page.locator(".guide-frame").evaluate((path) => {
      const box = (path as SVGGraphicsElement).getBBox();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  }
}

/** The locale key of a side's name: the passport has a single "photo page". */
function sideKey(document: DeclaredDocument, side: CaptureSide): string {
  return document === "passport" && side === "document_front" ? "sides.passportPage" : `sides.${side}`;
}
