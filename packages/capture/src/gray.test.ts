import { describe, expect, it } from "vitest";
import { toGray } from "./gray";

function rgba(...pixels: [number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels.flatMap(([r, g, b]) => [r, g, b, 255]));
}

describe("toGray", () => {
  it("uses Rec. 601 luma weights", () => {
    const img = toGray(rgba([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0], [100, 150, 200]), 6, 1);
    // 0.299 R + 0.587 G + 0.114 B, rounded.
    expect(Array.from(img.data)).toEqual([77, 149, 29, 255, 0, Math.round(0.299 * 100 + 0.587 * 150 + 0.114 * 200)]);
    expect(img.width).toBe(6);
    expect(img.height).toBe(1);
  });

  it("ignores alpha", () => {
    const data = new Uint8ClampedArray([200, 200, 200, 0]);
    expect(toGray(data, 1, 1).data[0]).toBe(200);
  });

  it("writes into a reusable buffer", () => {
    const out = new Uint8Array(10).fill(7);
    const img = toGray(rgba([10, 10, 10], [20, 20, 20]), 2, 1, out);
    expect(img.data.buffer).toBe(out.buffer);
    expect(Array.from(img.data)).toEqual([10, 20]);
    expect(out[2]).toBe(7);
  });

  it("rejects bad sizes and short buffers", () => {
    expect(() => toGray(new Uint8ClampedArray(4), 2, 1)).toThrow(RangeError);
    expect(() => toGray(new Uint8ClampedArray(8), 2, 1, new Uint8Array(1))).toThrow(RangeError);
    expect(() => toGray(new Uint8ClampedArray(8), 1.5, 1)).toThrow(RangeError);
  });
});
