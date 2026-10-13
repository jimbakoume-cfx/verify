import { describe, expect, it } from "vitest";
import { formatCountdown, parseTime, secondsLeft } from "./time";

describe("secondsLeft", () => {
  it("rounds up so a fresh 60 s link shows 60 and reaches 0 only at expiry", () => {
    expect(secondsLeft(60_000, 0)).toBe(60);
    expect(secondsLeft(60_000, 500)).toBe(60);
    expect(secondsLeft(60_000, 59_001)).toBe(1);
    expect(secondsLeft(60_000, 60_000)).toBe(0);
  });

  it("never goes negative and treats invalid times as expired", () => {
    expect(secondsLeft(1_000, 5_000)).toBe(0);
    expect(secondsLeft(Number.NaN, 0)).toBe(0);
    expect(secondsLeft(1_000, Number.NaN)).toBe(0);
  });
});

describe("formatCountdown", () => {
  it.each([
    [0, "0:00"],
    [5, "0:05"],
    [59, "0:59"],
    [60, "1:00"],
    [61, "1:01"],
    [29 * 60 + 41, "29:41"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3600 + 5 * 60 + 9, "1:05:09"],
  ])("%i s -> %s", (seconds, text) => {
    expect(formatCountdown(seconds)).toBe(text);
  });

  it("shows 0:00 for negative, fractional-negative and invalid input", () => {
    expect(formatCountdown(-3)).toBe("0:00");
    expect(formatCountdown(Number.NaN)).toBe("0:00");
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatCountdown(9.8)).toBe("0:09");
  });
});

describe("parseTime", () => {
  it("parses ISO timestamps and returns NaN for missing ones", () => {
    expect(parseTime("2026-10-13T08:00:00Z")).toBe(Date.UTC(2026, 9, 13, 8));
    expect(parseTime(null)).toBeNaN();
    expect(parseTime("not a date")).toBeNaN();
  });
});
