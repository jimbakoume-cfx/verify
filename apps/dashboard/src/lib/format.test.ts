import { describe, expect, it } from "vitest";
import { formatBytes, formatCalendarDate, formatDimensions, formatPercent, shortId, toLanguage } from "./format";

// Intl uses narrow no-break spaces in French; compare with plain spaces.
const plain = (text: string) => text.replace(/[  ]/g, " ");

describe("format helpers", () => {
  it("writes sizes in kB, as ko in French", () => {
    expect(formatBytes(241_337, "en")).toBe("241 kB");
    expect(plain(formatBytes(241_337, "fr"))).toBe("241 ko");
    expect(formatBytes(9_500, "en")).toBe("9.5 kB");
    expect(plain(formatBytes(9_500, "fr"))).toBe("9,5 ko");
  });

  it("formats ratios as percentages", () => {
    expect(formatPercent(0.93, "en")).toBe("93%");
    expect(plain(formatPercent(0.93, "fr"))).toBe("93 %");
    expect(formatPercent(null, "en")).toBe("—");
  });

  it("formats dimensions and short ids", () => {
    expect(formatDimensions(1600, 1009)).toBe("1600 × 1009");
    expect(formatDimensions(null, 1009)).toBe("—");
    expect(shortId("7d0c1a52-3f0e-4c8e-9a51-2b6f4f1d9e10")).toBe("7d0c1a52");
  });

  it("writes calendar dates in words, on the same day whatever the time zone", () => {
    expect(formatCalendarDate("1974-08-12", "en")).toBe("12 August 1974");
    expect(plain(formatCalendarDate("1974-08-12", "fr"))).toBe("12 août 1974");
    expect(formatCalendarDate("2012-04-15", "en")).toBe("15 April 2012");
    expect(formatCalendarDate("740812", "en")).toBe("—");
    expect(formatCalendarDate("", "fr")).toBe("—");
  });

  it("maps i18next language tags to fr or en", () => {
    expect(toLanguage("en")).toBe("en");
    expect(toLanguage("en-GB")).toBe("en");
    expect(toLanguage("fr")).toBe("fr");
    expect(toLanguage(undefined)).toBe("fr");
  });
});
