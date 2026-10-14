// The reading screen, rendered to HTML. Its live region (role="status") is read out by screen
// readers each time its text changes, so it must not change with every percent of the start-up.
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { describe, expect, it } from "vitest";
import type { Shot } from "../flow/machine";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import { ReadingScreen } from "./Reading";

const shot = { side: "document_back", blob: new Blob([]), info: { width: 1600, height: 1000 } } as unknown as Shot;

async function render(lang: "en" | "fr", progress: number | null): Promise<string> {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng: lang,
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(ReadingScreen, { shot, document: "cni_biometric", progress, onBack: () => {} })),
  );
}

/** Text from React's HTML: its character references back to characters. */
function decode(html: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " " };
  return html.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return named[name] ?? entity;
  });
}

/** The live region's text, the progress bar's value, and the percent shown beside it. */
function parts(html: string): { live: string; value: string | null; shown: string | null } {
  const live = decode(/<p[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "");
  const value = /role="progressbar"[^>]*aria-valuenow="(\d+)"/.exec(html)?.[1] ?? null;
  const shown = /<p class="reading-percent" aria-hidden="true">([^<]*)<\/p>/.exec(html)?.[1] ?? null;
  return { live, value, shown: shown === null ? null : decode(shown) };
}

describe("ReadingScreen", () => {
  it("announces the start-up once: the percent changes the progress bar, never the live text", async () => {
    for (const lang of ["en", "fr"] as const) {
      const at12 = await render(lang, 0.12);
      const at13 = await render(lang, 0.13);
      const at87 = await render(lang, 0.87);
      expect(parts(at12).value).toBe("12");
      expect(parts(at87).value).toBe("87");
      expect(parts(at12).live).toBe((lang === "en" ? en : fr).reading.download);
      expect(parts(at12).live).not.toMatch(/\d/);
      expect(parts(at13).live).toBe(parts(at12).live);
      expect(parts(at87).live).toBe(parts(at12).live);
      // The number is still shown, outside the live region and hidden from screen readers.
      expect(parts(at87).shown).toMatch(/^87\s?%$/);
    }
  });

  it("says it is reading once the reader is ready, with no progress bar", async () => {
    expect(parts(await render("en", null))).toEqual({ live: en.reading.body, value: null, shown: null });
  });
});
