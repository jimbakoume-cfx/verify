import { describe, expect, it } from "vitest";
import { HINT_PRIORITY } from "@verify/capture";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import { HintStabilizer, readinessOf, topMessage } from "./hints";

describe("topMessage and readiness", () => {
  it("shows the most important hint, or ready", () => {
    expect(topMessage(["move_closer", "blurry"])).toBe("move_closer");
    expect(topMessage([])).toBe("ready");
  });

  it("colours the guide by readiness", () => {
    expect(readinessOf(null)).toBe("searching");
    expect(readinessOf("no_document")).toBe("searching");
    expect(readinessOf("glare")).toBe("adjust");
    expect(readinessOf("ready")).toBe("ready");
  });

  it("has French and English text for every hint", () => {
    for (const hint of HINT_PRIORITY) {
      expect(fr.hints[hint]).toBeTruthy();
      expect(en.hints[hint]).toBeTruthy();
    }
  });
});

describe("HintStabilizer", () => {
  it("shows the first message at once", () => {
    const s = new HintStabilizer(2);
    expect(s.push("no_document", 0)).toBe("no_document");
  });

  it("switches only after the new message holds for enough frames", () => {
    const s = new HintStabilizer(2);
    s.push("no_document", 0);
    expect(s.push("move_closer", 125)).toBe("no_document");
    expect(s.push("move_closer", 250)).toBe("move_closer");
  });

  it("ignores a one-frame flicker", () => {
    const s = new HintStabilizer(2);
    s.push("blurry", 0);
    expect(s.push("hold_still", 125)).toBe("blurry");
    expect(s.push("blurry", 250)).toBe("blurry");
    expect(s.push("hold_still", 375)).toBe("blurry");
    expect(s.push("ready", 500)).toBe("blurry");
    expect(s.push("ready", 625)).toBe("ready");
  });

  it("measures how long a message has been shown", () => {
    const s = new HintStabilizer(2);
    expect(s.shownFor(100)).toBe(0);
    s.push("no_document", 1000);
    s.push("no_document", 4000);
    expect(s.shownFor(6000)).toBe(5000);
    s.push("glare", 6100);
    s.push("glare", 6200);
    expect(s.shownFor(6300)).toBe(100);
  });

  it("starts over after a reset", () => {
    const s = new HintStabilizer(3);
    s.push("glare", 0);
    s.reset();
    expect(s.shown).toBeNull();
    expect(s.push("ready", 10)).toBe("ready");
  });
});
