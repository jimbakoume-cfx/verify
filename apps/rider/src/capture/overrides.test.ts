import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@verify/capture";
import { parseThresholdOverrides } from "./overrides";

describe("parseThresholdOverrides", () => {
  it("reads known numeric thresholds", () => {
    expect(parseThresholdOverrides("?debug=1&minSharpness=120&maxMotion=9.5", DEFAULT_THRESHOLDS)).toEqual({
      minSharpness: 120,
      maxMotion: 9.5,
    });
  });

  it("ignores unknown names, junk and negative values", () => {
    expect(
      parseThresholdOverrides("?foo=1&minSharpness=abc&maxGlareRatio=-1&minFraming=", DEFAULT_THRESHOLDS),
    ).toEqual({});
  });

  it("needs a whole positive number of stable frames", () => {
    expect(parseThresholdOverrides("?stableFramesRequired=0", DEFAULT_THRESHOLDS)).toEqual({});
    expect(parseThresholdOverrides("?stableFramesRequired=2.5", DEFAULT_THRESHOLDS)).toEqual({});
    expect(parseThresholdOverrides("?stableFramesRequired=3", DEFAULT_THRESHOLDS)).toEqual({ stableFramesRequired: 3 });
  });
});
