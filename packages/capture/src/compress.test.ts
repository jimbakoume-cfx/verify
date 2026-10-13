import { describe, expect, it } from "vitest";
import { CAPTURE_LIMITS } from "../../../supabase/functions/_shared/contract";
import { COMPRESSION_QUALITIES, compressToTarget, compressionScales, outputSize } from "./compress";

describe("outputSize", () => {
  it("shrinks the long side to 1600 px", () => {
    expect(outputSize(3000, 2000)).toEqual({ width: 1600, height: 1067, scale: 1600 / 3000 });
    expect(outputSize(1000, 2000)).toEqual({ width: 800, height: 1600, scale: 0.8 });
  });

  it("never enlarges", () => {
    expect(outputSize(1000, 631)).toEqual({ width: 1000, height: 631, scale: 1 });
  });

  it("accepts another limit and rejects bad sizes", () => {
    expect(outputSize(2000, 1000, 1000)).toEqual({ width: 1000, height: 500, scale: 0.5 });
    expect(() => outputSize(0, 100)).toThrow(RangeError);
    expect(() => outputSize(100, Number.NaN)).toThrow(RangeError);
  });
});

/** A fake JPEG encoder: size proportional to quality and to the pixel count. */
function fakeEncoder(bytesAtFullQuality: number) {
  const calls: [number, number][] = [];
  const encode = async (quality: number, scale: number) => {
    calls.push([quality, scale]);
    return { size: Math.round(bytesAtFullQuality * quality * scale * scale), label: `${quality}@${scale}` };
  };
  return { encode, calls };
}

describe("compressToTarget", () => {
  it("returns the first quality under the 300 KB target", async () => {
    const { encode, calls } = fakeEncoder(500_000); // 440k, 400k, 360k, 320k, 280k
    const result = await compressToTarget(encode);
    expect(result).toMatchObject({ quality: 0.56, scale: 1, attempts: 5 });
    expect(result.blob.size).toBeLessThanOrEqual(CAPTURE_LIMITS.targetBytes);
    expect(calls.map(([q]) => q)).toEqual([...COMPRESSION_QUALITIES]);
  });

  it("stops at the first attempt that fits", async () => {
    const { encode, calls } = fakeEncoder(200_000);
    const result = await compressToTarget(encode);
    expect(result).toMatchObject({ quality: 0.88, scale: 1, attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it("falls back to scale 0.8 with the same qualities", async () => {
    // Scale 1 never fits (>= 448k); at 0.8 the sizes are 512k x quality.
    const { encode, calls } = fakeEncoder(800_000);
    const result = await compressToTarget(encode);
    expect(result).toMatchObject({ quality: 0.56, scale: 0.8, attempts: 10 });
    expect(calls.slice(5).every(([, s]) => s === 0.8)).toBe(true);
  });

  it("returns the smallest attempt when nothing fits", async () => {
    const { encode } = fakeEncoder(5_000_000);
    const result = await compressToTarget(encode);
    expect(result.quality).toBe(0.56);
    expect(result.scale).toBe(0.8);
    expect(result.attempts).toBe(10);
    expect(result.blob.label).toBe("0.56@0.8");
  });

  it("accepts a custom target, qualities and scales", async () => {
    const { encode, calls } = fakeEncoder(100_000);
    const result = await compressToTarget(encode, 50_000, { qualities: [0.9, 0.5], scales: [1, 0.5] });
    expect(result).toMatchObject({ quality: 0.5, scale: 1, attempts: 2 });
    expect(calls).toEqual([
      [0.9, 1],
      [0.5, 1],
    ]);
  });

  it("propagates encoder errors", async () => {
    await expect(compressToTarget(async () => Promise.reject(new Error("toBlob failed")))).rejects.toThrow("toBlob failed");
  });

  it("rejects empty quality or scale lists", async () => {
    await expect(compressToTarget(async () => ({ size: 1 }), 10, { qualities: [] })).rejects.toThrow(RangeError);
  });
});

describe("compressionScales", () => {
  it("keeps the fallback above the server's minimum long side", () => {
    const min = CAPTURE_LIMITS.minLongSide;
    expect(compressionScales(1600)).toEqual([1, 0.8]);
    expect(compressionScales(Math.ceil(min / 0.8))).toEqual([1, 0.8]);
    const between = Math.round(min * 1.1); // 0.8 would go below the minimum
    const [, s] = compressionScales(between);
    expect(Math.round(between * s)).toBe(min);
    expect(compressionScales(min)).toEqual([1]);
    expect(compressionScales(Math.round(min * 0.8))).toEqual([1]);
  });
});
