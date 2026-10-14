// Pins the vendored OCR model. Changing it changes what riders' phones read: a new model needs a new
// folder and cache key (OCR_ASSETS.langPath and cachePath, so phones drop the cached copy), its
// licence in public/ocr/NOTICE.txt and docs/LICENSES.md, and new hashes here.
import { describe, expect, it } from "vitest";
import noticeText from "../../public/ocr/NOTICE.txt?raw";
import { OCR_ASSETS } from "./types";

// The rider app is typed for the browser (no Node types): Node's fs is imported by a non-literal
// name and given the one function used here.
interface NodeFs {
  readFileSync(path: URL): Uint8Array<ArrayBuffer>;
}
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as NodeFs;

/** DoubangoTelecom tessdata_fast mrz.traineddata (BSD-3-Clause), gzipped as served. */
const MODEL_GZ_SHA256 = "dbbd4add162b8d28ed82b4a384c5f16dff274c63ddcd80b63e0315fd130a3909";
const MODEL_SHA256 = "ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01";

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("vendored OCR model", () => {
  const gz = readFileSync(new URL(`../../public${OCR_ASSETS.langPath}/${OCR_ASSETS.language}.traineddata.gz`, import.meta.url));

  it("is the pinned file", async () => {
    expect(await sha256(gz)).toBe(MODEL_GZ_SHA256);
    expect(await sha256(await gunzip(gz))).toBe(MODEL_SHA256);
  });

  it("is listed in the notice served next to it, with its hash and licence", () => {
    expect(noticeText).toContain(`${OCR_ASSETS.langPath}/${OCR_ASSETS.language}.traineddata.gz`);
    expect(noticeText).toContain(MODEL_SHA256);
    expect(noticeText).toContain("BSD 3-Clause");
  });

  it("is cached on the phone under a key named after its folder", () => {
    expect(OCR_ASSETS.langPath).toBe("/ocr/mrz-1");
    expect(OCR_ASSETS.cachePath).toBe("ocr-mrz-1");
    expect(OCR_ASSETS.engine).toBe("tesseract.js-7.0.0/mrz-1");
  });
});
