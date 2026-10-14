import { describe, expect, it } from "vitest";
import {
  CAPTURE_SIDES,
  DECLARED_DOCUMENTS,
  DETECTED_DOCUMENT_TYPES,
  KEYWORD_GROUPS,
  type MrzServerDetails,
  parseMrz,
  POLICY_REASONS,
  RETAKE_REASONS,
} from "@verify/shared";
import { KNOWN_SUBTYPES } from "./lib/documentData";
import { mrzCheckLines, mrzFields, serverMrzCheckLines } from "./lib/mrz";
import { CAPTURE_KINDS, CHECK_OUTCOMES, PRINTED_FIELDS, VERIFICATION_STATUSES } from "./lib/records";
import { STAFF_ROLES } from "./lib/roles";
import { SERVER_FOCUS_LABEL } from "./lib/serverChecks";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

type Messages = Record<string, unknown>;

function flatten(messages: Messages, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value as Messages, path)) out.set(k, v);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

const FR = flatten(fr);
const EN = flatten(en);

describe("FR/EN locales", () => {
  it("have exactly the same keys", () => {
    expect([...FR.keys()].sort()).toEqual([...EN.keys()].sort());
  });

  it("have no empty strings", () => {
    for (const [key, text] of [...FR, ...EN]) expect(text.trim(), key).not.toBe("");
  });

  it("use the same placeholders in both languages", () => {
    for (const [key, text] of FR) expect(placeholders(text), key).toEqual(placeholders(EN.get(key) ?? ""));
  });

  it("label every status, document, capture kind and role", () => {
    const keys = [
      ...VERIFICATION_STATUSES.map((s) => `status.${s}`),
      ...DECLARED_DOCUMENTS.map((d) => `documents.${d}`),
      ...CAPTURE_KINDS.map((k) => `kinds.${k}`),
      ...STAFF_ROLES.map((r) => `roles.${r}`),
      "capture.source.auto",
      "capture.source.manual",
    ];
    for (const key of keys) {
      expect(FR.has(key), `fr: ${key}`).toBe(true);
      expect(EN.has(key), `en: ${key}`).toBe(true);
    }
  });

  it("label every check outcome and everything the MRZ section can show", () => {
    // A passport result gives every ✅/❌ line (TD1 has the same ones minus the personal number).
    const lines = mrzCheckLines({
      source: "mrz_phone",
      parserVersion: "mrz-v1",
      captureId: "c",
      result: "read",
      reason: null,
      expectedFormat: "TD3",
      format: "TD3",
      checks: { documentNumber: true, birthDate: true, expiryDate: true, personalNumber: true, composite: true },
      documentCodeFits: true,
      datesValid: true,
      attempts: 1,
      corrections: 0,
      engine: "e",
      ms: 1,
    });
    const passport = parseMrz([
      "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
      "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
    ])!;
    const keys = [
      ...CHECK_OUTCOMES.map((o) => `checkOutcome.${o}`),
      ...CAPTURE_SIDES.map((side) => `mrz.expectedOn.${side}`),
      ...["not_found", "reader_unavailable", "unknown"].map((reason) => `mrz.unreadable.${reason}`),
      ...["M", "F", "X"].map((sex) => `mrz.sex.${sex}`),
      ...["ok", "bad", "unknown"].map((tick) => `mrz.tick.${tick}`),
      ...lines.map((line) => line.key),
      ...mrzFields(passport).map((field) => `mrz.fields.${field.key}`),
    ];
    expect(lines).toHaveLength(8);
    for (const key of keys) {
      expect(FR.has(key), `fr: ${key}`).toBe(true);
      expect(EN.has(key), `en: ${key}`).toBe(true);
    }
  });

  it("label everything the server checks and the data viewer can show (M3)", () => {
    const passport: MrzServerDetails = {
      parserVersion: "mrz-v1",
      found: true,
      format: "TD3",
      checks: { documentNumber: true, birthDate: true, expiryDate: true, personalNumber: true, composite: true },
      documentCodeFits: true,
      datesValid: true,
      corrections: 0,
      phone: "agrees",
    };
    const phoneStates = (["agrees", "differs", "missing", "unreadable"] as const).flatMap((phone) =>
      [true, false].map((found) => ({ ...passport, found, phone })),
    );
    const mrzLines = phoneStates.flatMap((details) => serverMrzCheckLines(details, "TD3")).map((line) => line.key);
    const keys = [
      ...["ok", "poor", ...RETAKE_REASONS].map((verdict) => `serverChecks.verdict.${verdict}`),
      ...["poor", ...RETAKE_REASONS].map((verdict) => `serverChecks.verdictBody.${verdict}`),
      ...POLICY_REASONS.flatMap((reason) => [`serverChecks.reasons.label.${reason}`, `serverChecks.reasons.body.${reason}`]),
      ...DETECTED_DOCUMENT_TYPES.map((type) => (type === "unknown" ? "serverChecks.document.unknown" : `documents.${type}`)),
      ...["mrz", "keywords", "none"].map((basis) => `serverChecks.document.basis.${basis}`),
      ...["yes", "no", "unknown"].map((match) => `serverChecks.document.match.${match}`),
      ...KEYWORD_GROUPS.map((group) => `serverChecks.keywordGroups.${group}`),
      ...mrzLines,
      ...PRINTED_FIELDS.map((field) => `data.fields.${field}`),
      ...KNOWN_SUBTYPES.map((subtype) => `data.subtypes.${subtype}`),
      ...["mrz_phone", "mrz_server"].flatMap((source) =>
        ["linesOf", "rawLines", "same", "differs"].map((key) => `data.${key}.${source}`),
      ),
      "capture.replaced",
      ...["pendingBadge", "pending", "uncheckedBadge", "unchecked", "notSent"].map((key) => `serverChecks.side.${key}`),
    ];
    expect(new Set(mrzLines)).toEqual(
      new Set([
        "serverChecks.mrz.found",
        "mrz.checks.format",
        "mrz.checks.documentNumber",
        "mrz.checks.birthDate",
        "mrz.checks.expiryDate",
        "mrz.checks.personalNumber",
        "mrz.checks.composite",
        "mrz.checks.documentCode",
        "mrz.checks.dates",
        "serverChecks.mrz.phone.agrees",
        "serverChecks.mrz.phone.differs",
        "serverChecks.mrz.phone.phoneOnly",
        "serverChecks.mrz.phone.missing",
        "serverChecks.mrz.phone.unreadable",
      ]),
    );
    for (const key of keys) {
      expect(FR.has(key), `fr: ${key}`).toBe(true);
      expect(EN.has(key), `en: ${key}`).toBe(true);
    }
  });

  it("never label the server's focus score like the phone's sharpness (different measures)", () => {
    for (const messages of [FR, EN]) {
      const server = messages.get(SERVER_FOCUS_LABEL) ?? "";
      expect(server).not.toBe("");
      expect(server).not.toBe(messages.get("capture.sharpness"));
      // Its threshold is named, so "poor" (under 5) can be read against it.
      expect(server).toContain("5");
    }
  });

  it("keep the shared ServerStatus keys", () => {
    for (const state of ["checking", "ok", "not-configured", "unreachable"]) {
      expect(FR.has(`server.${state}`)).toBe(true);
      expect(EN.has(`server.${state}`)).toBe(true);
    }
  });
});
