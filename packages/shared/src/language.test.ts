import { describe, expect, it } from "vitest";
import { pickLanguage } from "./language";

describe("pickLanguage", () => {
  it("uses the explicit choice when supported", () => {
    expect(pickLanguage("en", ["fr-CM"])).toBe("en");
    expect(pickLanguage("EN-gb", [])).toBe("en");
  });

  it("ignores an unsupported explicit choice", () => {
    expect(pickLanguage("de", ["en-US"])).toBe("en");
  });

  it("falls back to the phone's languages in order", () => {
    expect(pickLanguage(null, ["de-DE", "en-CM", "fr"])).toBe("en");
    expect(pickLanguage(undefined, ["fr_CM"])).toBe("fr");
  });

  it("defaults to French", () => {
    expect(pickLanguage(null, [])).toBe("fr");
    expect(pickLanguage("", ["es", "pt-BR"])).toBe("fr");
  });
});
