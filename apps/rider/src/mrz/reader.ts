// PLACEHOLDER until the reading pipeline lands: always "unavailable", which never blocks the rider.
import type { MrzReader } from "./types";

export function createMrzReader(): MrzReader {
  return {
    warmUp() {},
    async read(_image, expectation) {
      return {
        status: "unavailable",
        format: expectation.format,
        lines: null,
        parsed: null,
        corrections: 0,
        ms: 0,
        rawText: "",
        charHeight: null,
        rotated: false,
      };
    },
    dispose() {},
  };
}
