import { describe, expect, it } from "vitest";
import { DECLARED_DOCUMENTS } from "@verify/shared";
import { CAPTURE_KINDS, VERIFICATION_STATUSES } from "./lib/records";
import { STAFF_ROLES } from "./lib/roles";
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

  it("keep the shared ServerStatus keys", () => {
    for (const state of ["checking", "ok", "not-configured", "unreachable"]) {
      expect(FR.has(`server.${state}`)).toBe(true);
      expect(EN.has(`server.${state}`)).toBe(true);
    }
  });
});
