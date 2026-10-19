import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLD_CONFIG } from "@verify/shared";
import { checkForm, configFromForm, errorsFor, formFromConfig, parseScore } from "./thresholdForm";

describe("parseScore", () => {
  it("reads decimals with a point or a comma (French)", () => {
    expect(parseScore("0.5")).toBe(0.5);
    expect(parseScore(" 0,25 ")).toBe(0.25);
    expect(parseScore("1")).toBe(1);
    expect(parseScore(".5")).toBe(0.5);
  });

  it("keeps anything else as text, so the rules say it is not a number", () => {
    for (const text of ["", "abc", "0.5.1", "-0.1", "1e-3", "0,5,0"]) expect(parseScore(text)).toBe(text);
  });
});

describe("the threshold form", () => {
  it("gives back the configuration it was made from", () => {
    const form = formFromConfig(DEFAULT_THRESHOLD_CONFIG);
    expect(configFromForm(form)).toEqual(DEFAULT_THRESHOLD_CONFIG);
    const check = checkForm(form, DEFAULT_THRESHOLD_CONFIG);
    expect(check).toMatchObject({ ok: true, changes: [], noteError: "missing" });
  });

  it("lists the changes against the active version, with the reason checked", () => {
    const form = { ...formFromConfig(DEFAULT_THRESHOLD_CONFIG), rejectMin: "0,5", note: "PM test" };
    form.enabled = { ...form.enabled, quality_poor: false };
    const check = checkForm(form, DEFAULT_THRESHOLD_CONFIG);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.changes).toEqual([
      { kind: "rejectMin", from: 0.9, to: 0.5 },
      { kind: "enabled", signal: "quality_poor", from: true, to: false },
    ]);
    expect(check.noteError).toBeNull();
    expect(check.config.rejectMin).toBe(0.5);
  });

  it("reports each problem against its field", () => {
    const form = {
      ...formFromConfig(DEFAULT_THRESHOLD_CONFIG),
      approveMax: "0.95",
      note: "abc",
    };
    form.weights = { ...form.weights, date_logic: "abc", number_format: "1.5", quality_poor: "0.00001" };
    const check = checkForm(form, DEFAULT_THRESHOLD_CONFIG);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(errorsFor(check.errors, "signals.date_logic.weight")).toEqual(["not_number"]);
    expect(errorsFor(check.errors, "signals.number_format.weight")).toEqual(["out_of_range"]);
    expect(errorsFor(check.errors, "signals.quality_poor.weight")).toEqual(["too_precise"]);
    expect(errorsFor(check.errors, "rejectMin")).toEqual(["order"]);
    expect(errorsFor(check.errors, "approveMax")).toEqual([]);
    expect(check.noteError).toBe("short");
  });

  it("never drops a mandatory hard flag or document, even if the form lost it", () => {
    const form = { ...formFromConfig(DEFAULT_THRESHOLD_CONFIG), hardFlags: [], alwaysReviewDocuments: [] };
    const check = checkForm(form, DEFAULT_THRESHOLD_CONFIG);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(errorsFor(check.errors, "hardFlags")).toEqual(["mandatory"]);
    expect(errorsFor(check.errors, "alwaysReviewDocuments")).toEqual(["mandatory"]);
  });
});
