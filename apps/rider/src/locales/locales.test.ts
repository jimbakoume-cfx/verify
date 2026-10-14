import { describe, expect, it } from "vitest";
import { CAPTURE_SIDES, DECLARED_DOCUMENTS, MRZ_LAYOUT, type MrzFormat } from "@verify/shared";
import en from "./en.json";
import fr from "./fr.json";

/** Every leaf of a locale as "a.b.c" -> text. */
function flatten(node: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) {
      for (const [k, v] of flatten(value, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
    }
  } else {
    out.set(prefix, node);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

const frKeys = flatten(fr);
const enKeys = flatten(en);

describe("FR/EN locales", () => {
  it("have exactly the same keys", () => {
    expect([...frKeys.keys()].sort()).toEqual([...enKeys.keys()].sort());
  });

  it("have a non-empty string for every key", () => {
    for (const [key, value] of [...frKeys, ...enKeys]) {
      expect(typeof value, key).toBe("string");
      expect((value as string).trim(), key).not.toBe("");
    }
  });

  it("use the same {{placeholders}} in both languages", () => {
    for (const [key, value] of frKeys) {
      expect(placeholders(value as string), key).toEqual(placeholders(enKeys.get(key) as string));
    }
  });

  it("name every document and side", () => {
    for (const doc of DECLARED_DOCUMENTS) {
      expect(frKeys.has(`documents.${doc}`), doc).toBe(true);
    }
    for (const side of CAPTURE_SIDES) {
      expect(frKeys.has(`sides.${side}`), side).toBe(true);
    }
  });

  it("give the code-lines tip for each MRZ format, naming its number of lines", () => {
    // Its own text per format: a count filled into one sentence gave "All 2 lines" (passport).
    const count: Record<number, RegExp> = { 2: /^(Both|Les 2) /, 3: /^(All|Les) 3 / };
    for (const format of Object.keys(MRZ_LAYOUT) as MrzFormat[]) {
      for (const [lang, keys] of [["fr", frKeys], ["en", enKeys]] as const) {
        expect(keys.get(`mrz.tipLines.${format}`), `${lang} ${format}`).toMatch(count[MRZ_LAYOUT[format].lines]);
      }
    }
  });

  it("keep every live camera message to two lines, so the guide never moves", () => {
    // The hint box reserves two lines (rider.css). At 360 px, two lines of its bold 1.2rem text
    // hold about 44 characters: the longest hint when this was written ("Reflet sur la pièce :
    // inclinez-la légèrement"). A longer message wraps to a third line and pushes the guide down.
    const live = [
      ...[...frKeys.keys()].filter((key) => key.startsWith("hints.")),
      ...["starting", "ready", "processing", "turnUpright", "tooLittleDetail", "loading"].map((k) => `capture.${k}`),
    ];
    for (const key of live) {
      for (const [lang, keys] of [["fr", frKeys], ["en", enKeys]] as const) {
        expect((keys.get(key) as string).length, `${lang} ${key}`).toBeLessThanOrEqual(44);
      }
    }
  });

  it("are actually translated (French differs from English for most texts)", () => {
    const same = [...frKeys].filter(([key, value]) => enKeys.get(key) === value).map(([key]) => key);
    // A few short words may legitimately be the same in both languages.
    expect(same.length).toBeLessThan(frKeys.size * 0.1);
  });
});
