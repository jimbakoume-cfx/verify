import { describe, expect, it } from "vitest";
import { sessionLanguage } from "./language";

describe("sessionLanguage", () => {
  it("follows the session's language when the rider chose none", () => {
    expect(sessionLanguage("en", null, "fr")).toBe("en");
    expect(sessionLanguage("fr", null, "en")).toBe("fr");
  });

  it("keeps the rider's own choice (link or toggle)", () => {
    expect(sessionLanguage("en", "fr", "fr")).toBeNull();
  });

  it("does nothing without a session, for an unknown language, or when already shown", () => {
    expect(sessionLanguage(null, null, "fr")).toBeNull();
    expect(sessionLanguage("de", null, "fr")).toBeNull();
    expect(sessionLanguage("en", null, "en")).toBeNull();
  });
});
