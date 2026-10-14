// Shared checks on what reached the fake backend.
import { expect } from "@playwright/test";
import { CAPTURE_LIMITS, type ClientQuality } from "../../supabase/functions/_shared/contract";
import type { StoredObject } from "./backend";
import { hasApp1 } from "./jpeg";

/** The calls of a complete ID-card flow: photos are sent after both sides are accepted. */
export const CARD_FLOW = [
  "GET /session",
  "POST /consent",
  "POST /document-type",
  "POST /upload-url",
  "POST /captures",
  "POST /upload-url",
  "POST /captures",
  "POST /submit",
];

/** The new CNI: as above, plus the report of its code lines once the back is on the server. */
export const NEW_CNI_FLOW = [...CARD_FLOW.slice(0, -1), "POST /mrz", "POST /submit"];

/** A passport: one photo (the data page), the report of its code lines, then the submit. */
export const PASSPORT_FLOW = [
  "GET /session",
  "POST /consent",
  "POST /document-type",
  "POST /upload-url",
  "POST /captures",
  "POST /mrz",
  "POST /submit",
];

/** A photo as the server must receive it: a small canvas JPEG, no metadata, big enough to read. */
export function expectCleanPhoto(object: StoredObject): void {
  expect(object.contentType).toBe("image/jpeg");
  expect(object.bytes.subarray(0, 2).toString("hex"), "JPEG start of image").toBe("ffd8");
  expect(object.bytes.length).toBeLessThan(CAPTURE_LIMITS.targetBytes);
  expect(object.bytes.length).toBeGreaterThanOrEqual(CAPTURE_LIMITS.minBytes);
  expect(object.jpeg, "a readable JPEG frame header").not.toBeNull();
  expect(hasApp1(object.jpeg!), "an APP1 (EXIF/XMP) segment").toBe(false);
  const longSide = Math.max(object.jpeg!.width, object.jpeg!.height);
  expect(longSide).toBeGreaterThanOrEqual(CAPTURE_LIMITS.minLongSide);
  expect(longSide).toBeLessThanOrEqual(CAPTURE_LIMITS.maxLongSide);
}

/** Quality metrics of an automatic photo of the sharp card video (1080x1920 portrait stream). */
export function expectAutoQuality(quality: ClientQuality): void {
  expect(quality.source).toBe("auto");
  expect([quality.videoWidth, quality.videoHeight]).toEqual([1080, 1920]);
  // The card was drawn at 93% of the guide's width: ~0.86 of its area.
  expect(quality.framing).toBeGreaterThan(0.8);
  expect(quality.framing).toBeLessThan(0.95);
  expect(quality.glareRatio).toBeLessThan(0.02);
  expect(quality.sharpness).toBeGreaterThan(100);
  expect(quality.meanLuma).toBeGreaterThan(50);
  expect(quality.meanLuma).toBeLessThan(225);
  expect(quality.elapsedMs).toBeLessThan(10_000);
}
