import { describe, expect, it } from "vitest";
import { isJpeg, readJpegSize } from "./jpeg.ts";
import { buildJpeg, bytes, commentSegments, sofSegment } from "./test-helpers.ts";

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const APP0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];

describe("isJpeg", () => {
  it("accepts SOI followed by a marker", () => {
    expect(isJpeg(buildJpeg({ width: 10, height: 10 }))).toBe(true);
  });

  it("rejects other formats and short input", () => {
    expect(isJpeg(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe(false); // PNG
    expect(isJpeg(bytes(0x52, 0x49, 0x46, 0x46))).toBe(false); // RIFF/WebP
    expect(isJpeg(bytes(0xff, 0xd8, 0xff))).toBe(false);
    expect(isJpeg(bytes())).toBe(false);
    expect(isJpeg(bytes(0xff, 0xd8, 0x00, 0x00))).toBe(false);
  });
});

describe("readJpegSize", () => {
  it("reads a baseline (SOF0) frame after APP0", () => {
    expect(readJpegSize(buildJpeg({ width: 1600, height: 1009 }))).toEqual({ width: 1600, height: 1009 });
  });

  it("reads a progressive (SOF2) frame", () => {
    expect(readJpegSize(buildJpeg({ width: 1009, height: 1600, sof: 0xc2 }))).toEqual({ width: 1009, height: 1600 });
  });

  it("reads a greyscale frame and large values", () => {
    expect(readJpegSize(buildJpeg({ width: 65535, height: 1, components: 1 }))).toEqual({ width: 65535, height: 1 });
  });

  it("skips large segments placed before the frame header", () => {
    expect(readJpegSize(buildJpeg({ width: 1200, height: 800, padTo: 150_000 }))).toEqual({ width: 1200, height: 800 });
  });

  it("skips fill bytes and standalone markers", () => {
    const data = bytes(...SOI, 0xff, 0xff, ...APP0, 0xff, 0xd0, 0xff, 0x01, ...sofSegment(900, 600), ...EOI);
    expect(readJpegSize(data)).toEqual({ width: 900, height: 600 });
  });

  it("does not mistake DHT (C4), JPG (C8) or DAC (CC) for a frame header", () => {
    const dht = [0xff, 0xc4, 0x00, 0x08, 0x07, 0x00, 0x07, 0x00, 0x00, 0x00];
    const dac = [0xff, 0xcc, 0x00, 0x04, 0x01, 0x01];
    const data = bytes(...SOI, ...dht, ...dac, ...sofSegment(1024, 768), ...EOI);
    expect(readJpegSize(data)).toEqual({ width: 1024, height: 768 });
  });

  it("returns null when the image data or the end comes before any frame header", () => {
    expect(readJpegSize(bytes(...SOI, ...APP0, ...EOI))).toBeNull();
    expect(readJpegSize(bytes(...SOI, ...APP0, 0xff, 0xda, 0x00, 0x02, ...sofSegment(900, 600)))).toBeNull();
  });

  it("returns null for truncated input at every cut point", () => {
    const full = buildJpeg({ width: 1600, height: 1000 });
    const sofEnd = full.length - EOI.length;
    for (let cut = 0; cut < sofEnd; cut++) {
      expect(readJpegSize(full.slice(0, cut)), `cut at ${cut}`).toBeNull();
    }
    expect(readJpegSize(full.slice(0, sofEnd))).toEqual({ width: 1600, height: 1000 });
  });

  it("returns null for a segment length that overruns the buffer or is below 2", () => {
    expect(readJpegSize(bytes(...SOI, 0xff, 0xe0, 0xff, 0xff, 0x00))).toBeNull();
    expect(readJpegSize(bytes(...SOI, 0xff, 0xe0, 0x00, 0x01, ...sofSegment(900, 600)))).toBeNull();
  });

  it("returns null for zero dimensions or a short frame header", () => {
    expect(readJpegSize(buildJpeg({ width: 0, height: 600 }))).toBeNull();
    expect(readJpegSize(buildJpeg({ width: 600, height: 0 }))).toBeNull();
    expect(readJpegSize(bytes(...SOI, 0xff, 0xc0, 0x00, 0x07, 8, 0x02, 0x00, 0x03, 0x00, ...EOI))).toBeNull();
    // Declares 3 components but the segment only has room for one.
    expect(readJpegSize(bytes(...SOI, 0xff, 0xc0, 0x00, 0x0b, 8, 0x02, 0x00, 0x03, 0x00, 3, 1, 0x11, 0, ...EOI)))
      .toBeNull();
  });

  it("returns null for garbage", () => {
    expect(readJpegSize(bytes())).toBeNull();
    expect(readJpegSize(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(readJpegSize(bytes(...SOI, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x12, 0x34))).toBeNull(); // no marker
    expect(readJpegSize(bytes(...SOI, 0xff, 0x00, 0x00))).toBeNull(); // stuffed byte
    expect(readJpegSize(bytes(...SOI, 0xff, 0xd8, ...sofSegment(900, 600)))).toBeNull(); // second SOI
    expect(readJpegSize(bytes(...SOI, 0xff, 0xff, 0xff))).toBeNull(); // only fill bytes
    let seed = 7;
    for (let n = 0; n < 200; n++) {
      const random = new Uint8Array(64).map(() => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff);
      random.set([0xff, 0xd8, 0xff], 0);
      const size = readJpegSize(random);
      if (size) expect(size.width > 0 && size.height > 0).toBe(true);
    }
  });

  it("commentSegments pads to the requested size", () => {
    expect(commentSegments(70_000).length).toBe(70_000);
    expect(buildJpeg({ width: 10, height: 10, padTo: 20_000 }).length).toBe(20_000);
  });
});
