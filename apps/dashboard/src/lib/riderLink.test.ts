import { describe, expect, it } from "vitest";
import { debugRiderUrl } from "./riderLink";

const TOKEN = "Abc123-_xyz".repeat(4);

describe("debugRiderUrl", () => {
  it("adds ?debug=1 before the fragment and keeps the token as it was", () => {
    expect(debugRiderUrl(`https://verify.example.org/#s=${TOKEN}`)).toBe(`https://verify.example.org/?debug=1#s=${TOKEN}`);
  });

  it("keeps the path and any query parameters already there", () => {
    expect(debugRiderUrl(`https://host.example/r/?lang=fr#s=${TOKEN}`)).toBe(
      `https://host.example/r/?lang=fr&debug=1#s=${TOKEN}`,
    );
  });

  it("does not repeat debug when the link already has it", () => {
    expect(debugRiderUrl(`https://host.example/?debug=0#s=${TOKEN}`)).toBe(`https://host.example/?debug=1#s=${TOKEN}`);
  });

  it("works for a local development link", () => {
    expect(debugRiderUrl(`http://localhost:5173/#s=${TOKEN}`)).toBe(`http://localhost:5173/?debug=1#s=${TOKEN}`);
  });

  it("offers nothing for a link that is not http(s)", () => {
    expect(debugRiderUrl("not a link")).toBeNull();
    expect(debugRiderUrl("")).toBeNull();
    expect(debugRiderUrl("javascript:alert(1)//#s=x")).toBeNull();
  });
});
