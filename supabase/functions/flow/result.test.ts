import { describe, expect, it } from "vitest";
import { safeReturnUrl, toFlowResult } from "./result.ts";

describe("toFlowResult", () => {
  it("keeps the three states, and the return address with verified only", () => {
    expect(toFlowResult({ state: "verified", returnUrl: "https://ride.example/back?x=1" })).toEqual({
      state: "verified",
      returnUrl: "https://ride.example/back?x=1",
    });
    expect(toFlowResult({ state: "verified", returnUrl: null })).toEqual({ state: "verified", returnUrl: null });
    expect(toFlowResult({ state: "pending", returnUrl: "https://ride.example/back" })).toEqual({ state: "pending", returnUrl: null });
    expect(toFlowResult({ state: "review", returnUrl: "https://ride.example/back" })).toEqual({ state: "review", returnUrl: null });
  });

  it("turns anything unexpected into review, never more", () => {
    for (const value of [null, undefined, "verified", [], {}, { state: "rejected" }, { state: "approved" }, { state: 1 }]) {
      expect(toFlowResult(value)).toEqual({ state: "review", returnUrl: null });
    }
  });

  it("never passes on anything else the database might add", () => {
    expect(toFlowResult({ state: "verified", returnUrl: null, score: 0, reasons: ["x"] })).toEqual({ state: "verified", returnUrl: null });
  });
});

describe("safeReturnUrl", () => {
  it("accepts https addresses only", () => {
    expect(safeReturnUrl("https://ride.example/verified")).toBe("https://ride.example/verified");
    for (const bad of ["http://ride.example/", "javascript:alert(1)", "https://ride example/", "//ride.example", "", 42, null, `https://a.example/${"x".repeat(2048)}`]) {
      expect(safeReturnUrl(bad)).toBeNull();
    }
  });
});
