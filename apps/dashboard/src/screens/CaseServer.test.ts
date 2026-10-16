// The "Server checks" pieces that M4 adds, rendered to HTML on the server side (react-dom/server):
// the consistency check and the hard flags among the reasons. No browser is needed; the text and the
// classes the page relies on are checked, and that nothing but generic codes and labels comes out.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import type { ConsistencyDetails, PolicyReason } from "@verify/shared";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import { type CheckRecord, type ServerChecks, toDocumentPolicyDetails } from "../lib/records";
import { serverOverview } from "../lib/serverChecks";
import { ConsistencyItem, ReasonsItem } from "./CaseServer";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: "en",
  fallbackLng: "fr",
  interpolation: { escapeValue: false },
});

function render(element: ReactElement, lng: "en" | "fr" = "en"): string {
  void i18n.changeLanguage(lng);
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));
}

function consistencyCheck(details: Partial<ConsistencyDetails>, outcome: CheckRecord<ConsistencyDetails>["outcome"] = "flag") {
  const full: ConsistencyDetails = { flags: [], provisional: [], basis: "mrz", mismatches: [], ...details };
  return {
    id: "c",
    captureId: null,
    checkVersion: "server-checks-v1",
    outcome,
    details: full,
    createdAt: "2026-10-15T09:00:00Z",
  } satisfies CheckRecord<ConsistencyDetails>;
}

const NONE: ServerChecks = {
  quality: [],
  mrz: [],
  fields: [],
  classification: null,
  policy: null,
  consistency: null,
  jobs: new Map(),
};

/** The case's reasons as the page reads them: stored sorted by name, put in the contract's order. */
function reasons(list: PolicyReason[]) {
  const details = toDocumentPolicyDetails({ reasons: [...list].sort() });
  const policy = { id: "p", captureId: null, checkVersion: "server-checks-v1", outcome: "flag" as const, details, createdAt: "2026-10-15T09:00:00Z" };
  return serverOverview("passport", [], { ...NONE, policy });
}

describe("ConsistencyItem", () => {
  it("says when the server has not decided yet", () => {
    expect(render(createElement(ConsistencyItem, { consistency: null }))).toContain("No server result yet.");
  });

  it("shows an expired document as a hard flag, in red, with its code", () => {
    const html = render(createElement(ConsistencyItem, { consistency: consistencyCheck({ flags: ["document_expired"] }) }));
    expect(html).toContain("Consistency");
    expect(html).toContain("From the code lines (firm)");
    expect(html).toMatch(/<li class="hard"><strong>Document expired <span class="badge bad">Hard flag<\/span><\/strong>/);
    expect(html).toContain("document_expired");
  });

  it("names the kinds of field that disagree, never their values, and keeps an ordinary flag apart from hard ones", () => {
    const html = render(createElement(ConsistencyItem, {
      consistency: consistencyCheck({ flags: ["mrz_print_mismatch"], mismatches: ["name", "birth_date"] }),
    }));
    expect(html).toContain("Printed text differs from the code lines");
    expect(html).toContain("Fields that differ: Name, Birth date");
    expect(html).not.toContain("Hard flag");
    expect(html).not.toContain('class="hard"');
  });

  it("lists provisional notes under their own heading, never as flags", () => {
    const html = render(createElement(ConsistencyItem, {
      consistency: consistencyCheck({ basis: "printed", provisional: ["document_expired", "number_format"] }, "pass"),
    }));
    expect(html).toContain("From the printed text only (provisional).");
    expect(html).toContain("Provisional notes");
    expect(html).toContain("Unexpected number format");
    // Provisional: no hard-flag badge even for document_expired.
    expect(html).not.toContain("Hard flag");
  });

  it("says when nothing was inconsistent, or nothing could be compared", () => {
    expect(render(createElement(ConsistencyItem, { consistency: consistencyCheck({}, "pass") }))).toContain("Nothing inconsistent.");
    expect(render(createElement(ConsistencyItem, { consistency: consistencyCheck({ basis: "none" }, "skipped") })))
      .toContain("Nothing to compare.");
  });

  it("speaks French too", () => {
    const html = render(createElement(ConsistencyItem, { consistency: consistencyCheck({ flags: ["under_18"] }) }), "fr");
    expect(html).toContain("Cohérence");
    expect(html).toContain("Moins de 18 ans");
    expect(html).toContain("Signal bloquant");
  });
});

describe("ReasonsItem", () => {
  it("lists the hard flags first, in red, then the other reasons", () => {
    const html = render(createElement(ReasonsItem, { overview: reasons(["manual_review_document", "under_18", "document_expired"]) }));
    const order = ["Document expired", "Under 18", "Always checked by a person"].map((label) => html.indexOf(label));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/class="hard"/g)).toHaveLength(2);
    expect(html.match(/<span class="badge bad">Hard flag<\/span>/g)).toHaveLength(2);
  });

  it("shows no hard flag for the M3 reasons", () => {
    const html = render(createElement(ReasonsItem, { overview: reasons(["mrz_disagreement", "type_mismatch"]) }));
    expect(html).not.toContain("Hard flag");
  });
});
