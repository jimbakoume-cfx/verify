import { describe, expect, it } from "vitest";
import type { ClientQuality } from "../_shared/contract.ts";
import { buildCapturePath, isOwnCapturePath, sanitizeQuality } from "./validation.ts";

const OWN = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";

describe("capture paths", () => {
  it("accepts the exact shape buildCapturePath produces", () => {
    const path = buildCapturePath(OWN, "document_front", FILE);
    expect(path).toBe(`${OWN}/document_front-${FILE}.jpg`);
    expect(isOwnCapturePath(path, OWN, "document_front")).toBe(true);
    expect(isOwnCapturePath(buildCapturePath(OWN, "document_back", FILE), OWN, "document_back")).toBe(true);
  });

  it.each([
    ["another verification's folder", `${OTHER}/document_front-${FILE}.jpg`],
    ["a kind that differs from the request", `${OWN}/document_back-${FILE}.jpg`],
    ["traversal", `${OWN}/../${OTHER}/document_front-${FILE}.jpg`],
    ["traversal inside the name", `${OWN}/document_front-../../${FILE.slice(6)}.jpg`],
    ["a leading slash", `/${OWN}/document_front-${FILE}.jpg`],
    ["a nested folder", `${OWN}/x/document_front-${FILE}.jpg`],
    ["another extension", `${OWN}/document_front-${FILE}.png`],
    ["upper case", `${OWN.toUpperCase()}/document_front-${FILE}.jpg`],
    ["an encoded slash", `${OWN}%2Fdocument_front-${FILE}.jpg`],
    ["a selfie kind", `${OWN}/selfie-${FILE}.jpg`],
    ["a trailing newline", `${OWN}/document_front-${FILE}.jpg\n`],
    ["a short id", `${OWN.slice(1)}/document_front-${FILE}.jpg`],
    ["empty", ""],
  ])("rejects %s", (_label, path) => {
    expect(isOwnCapturePath(path, OWN, "document_front")).toBe(false);
  });

  it("rejects non-strings and oversized values", () => {
    expect(isOwnCapturePath(42, OWN, "document_front")).toBe(false);
    expect(isOwnCapturePath(null, OWN, "document_front")).toBe(false);
    expect(isOwnCapturePath(`${OWN}/document_front-${FILE}.jpg`.padEnd(500, "x"), OWN, "document_front"))
      .toBe(false);
  });
});

const QUALITY: ClientQuality = {
  source: "auto",
  sharpness: 312.5,
  glareRatio: 0.01,
  meanLuma: 128,
  framing: 0.93,
  videoWidth: 1920,
  videoHeight: 1080,
  elapsedMs: 4200,
};

describe("sanitizeQuality", () => {
  it("keeps valid metrics unchanged", () => {
    expect(sanitizeQuality(QUALITY)).toEqual(QUALITY);
  });

  it("drops unknown keys, including a forged server verdict", () => {
    const result = sanitizeQuality({ ...QUALITY, server: { validated: true }, extra: "x".repeat(1000) });
    expect(result).toEqual(QUALITY);
  });

  it("clamps out-of-range and infinite numbers", () => {
    const result = sanitizeQuality({
      ...QUALITY,
      sharpness: -5,
      glareRatio: 3,
      meanLuma: 1e9,
      framing: -Infinity,
      videoWidth: Infinity,
      elapsedMs: JSON.parse("1e999"),
    });
    expect(result).toMatchObject({
      sharpness: 0,
      glareRatio: 1,
      meanLuma: 255,
      framing: 0,
      videoWidth: 16384,
      elapsedMs: 86_400_000,
    });
    for (const value of Object.values(result!)) {
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
    }
  });

  it.each([
    ["null", null],
    ["an array", [QUALITY]],
    ["a string", "auto"],
    ["an unknown source", { ...QUALITY, source: "upload" }],
    ["a missing metric", { ...QUALITY, framing: undefined }],
    ["a numeric string", { ...QUALITY, sharpness: "312" }],
    ["NaN", { ...QUALITY, meanLuma: NaN }],
    ["a nested object", { ...QUALITY, videoWidth: { value: 1 } }],
  ])("rejects %s", (_label, value) => {
    expect(sanitizeQuality(value)).toBeNull();
  });
});
