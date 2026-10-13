// The rider's steps through the flow, found by role and visible text in the current language.
import { type Locator, type Page, expect } from "@playwright/test";
import type { CaptureSide, DeclaredDocument } from "../../supabase/functions/_shared/contract";
import type { FakeBackend } from "./backend";
import { type Language, translate } from "./i18n";

/** Spec: the front is auto-captured within 10 s with a sharp, well-framed card. */
export const AUTO_CAPTURE_TIMEOUT = 10_000;

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
    return this.heading(document === "passport" && side === "document_front" ? "sides.passportPage" : `sides.${side}`);
  }

  get hint(): Locator {
    return this.page.locator(".hint-pill");
  }

  get shutter(): Locator {
    return this.page.getByRole("button", { name: this.t("capture.shutter"), exact: true });
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

  /** Waits for the camera screen of `side`, then for the automatic photo (review screen). */
  async autoCapture(document: DeclaredDocument, side: CaptureSide): Promise<void> {
    await expect(this.captureHeading(document, side)).toBeVisible();
    await expect(this.heading("review.title")).toBeVisible({ timeout: AUTO_CAPTURE_TIMEOUT });
  }

  async usePhoto(): Promise<void> {
    await expect(this.page.locator(".notice.warn")).toHaveCount(0);
    await this.button("review.use").click();
  }

  async turnOver(): Promise<void> {
    await expect(this.heading("turnOver.title")).toBeVisible();
    await this.button("turnOver.continue").click();
  }

  /** Both sides of an ID-1 card, automatically, then the upload. */
  async photographCard(): Promise<void> {
    await this.autoCapture("cni", "document_front");
    await this.usePhoto();
    await this.turnOver();
    await this.autoCapture("cni", "document_back");
    await this.usePhoto();
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
