import { describe, expect, it } from "vitest";
import { casePath, parseRoute } from "./routes";

const ID = "7d0c1a52-3f0e-4c8e-9a51-2b6f4f1d9e10";

describe("parseRoute", () => {
  it("reads case pages, with or without a trailing slash, lower-casing the id", () => {
    expect(parseRoute(`/case/${ID}`)).toEqual({ name: "case", id: ID });
    expect(parseRoute(`/case/${ID}/`)).toEqual({ name: "case", id: ID });
    expect(parseRoute(`/case/${ID.toUpperCase()}`)).toEqual({ name: "case", id: ID });
  });

  it("falls back to home for anything else", () => {
    for (const path of ["/", "", "/case", "/case/not-a-uuid", `/case/${ID}/extra`, `/cases/${ID}`]) {
      expect(parseRoute(path)).toEqual({ name: "home" });
    }
  });

  it("builds the path parseRoute reads", () => {
    expect(parseRoute(casePath(ID))).toEqual({ name: "case", id: ID });
  });
});
