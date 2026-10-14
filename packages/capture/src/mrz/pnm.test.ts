import { describe, expect, it } from "vitest";
import { decodePgm, encodePgm } from "./pnm";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("PGM (P5)", () => {
  it("encodes a short header followed by the pixels", () => {
    const bytes = encodePgm({ width: 3, height: 2, data: new Uint8Array([0, 128, 255, 1, 2, 3]) });
    const header = ascii("P5\n3 2\n255\n");
    expect(Array.from(bytes.subarray(0, header.length))).toEqual(Array.from(header));
    expect(Array.from(bytes.subarray(header.length))).toEqual([0, 128, 255, 1, 2, 3]);
  });

  it("round-trips an image, ignoring extra bytes in its buffer", () => {
    const data = new Uint8Array(4 * 3 + 5).map((_, i) => (i * 37) % 256);
    const decoded = decodePgm(encodePgm({ width: 4, height: 3, data }));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
    expect(Array.from(decoded.data)).toEqual(Array.from(data.subarray(0, 12)));
  });

  it("reads header comments and any whitespace, and rescales a lower maxval", () => {
    const header = ascii("P5 # made by hand\n2\t1 # size\n# another\n15\n");
    const bytes = new Uint8Array(header.length + 2);
    bytes.set(header);
    bytes.set([15, 5], header.length);
    const decoded = decodePgm(bytes);
    expect(decoded).toMatchObject({ width: 2, height: 1 });
    expect(Array.from(decoded.data)).toEqual([255, 85]);
  });

  it("refuses other formats, bad sizes, 16-bit images and truncated data", () => {
    expect(() => decodePgm(ascii("P2\n1 1\n255\n0"))).toThrow(/P5/);
    expect(() => decodePgm(ascii("P6\n1 1\n255\nabc"))).toThrow(/P5/);
    expect(() => decodePgm(ascii("P5\n0 1\n255\n"))).toThrow(/size/);
    expect(() => decodePgm(ascii("P5\n1 1\n65535\n\0\0"))).toThrow(/maxval/);
    expect(() => decodePgm(ascii("P5\n4 4\n255\nabc"))).toThrow(/short/);
  });
});
