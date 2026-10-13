import { describe, expect, it } from "vitest";
import { randomHex, randomToken, sha256Hex } from "./crypto.ts";

describe("sha256Hex", () => {
  it("hashes strings as UTF-8 (FIPS 180-2 test vectors)", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes bytes and strings identically", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(await sha256Hex("abc"));
  });
});

describe("randomToken", () => {
  it("encodes 32 bytes as 43 base64url characters", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
  });
});

describe("randomHex", () => {
  it("returns two hex digits per byte", () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
    expect(randomHex()).toMatch(/^[0-9a-f]{32}$/);
  });
});
