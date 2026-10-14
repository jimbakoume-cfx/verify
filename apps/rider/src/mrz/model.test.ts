// Pins the vendored OCR model. Changing it changes what riders' phones read: a new model needs a new
// folder and cache key (OCR_ASSETS.langPath and cachePath, so phones drop the cached copy), its
// licence in public/ocr/NOTICE.txt and docs/LICENSES.md, and new hashes here.
// Also checks that the notices of the OCR engine files reach riders with those files.
import { describe, expect, it } from "vitest";
import licensesDoc from "../../../../docs/LICENSES.md?raw";
import noticeText from "../../public/ocr/NOTICE.txt?raw";
import { OCR_ASSETS } from "./types";

// The rider app is typed for the browser (no Node types): Node's fs and the Vite config (which uses
// Node) are imported by a non-literal name and given the functions used here.
interface NodeFs {
  readFileSync(path: URL | string): Uint8Array<ArrayBuffer>;
}
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as NodeFs;
const viteConfig = new URL("../../vite.config.ts", import.meta.url).href;
/** Published path (no leading '/') -> file in node_modules, as the build emits them. */
const { ocrFiles } = (await import(/* @vite-ignore */ viteConfig)) as { ocrFiles(): Record<string, string> };

const readText = (path: string) => new TextDecoder().decode(readFileSync(path));
/** Runs of spaces and line breaks as one space, to compare licence texts laid out differently. */
const words = (text: string) => text.replace(/\s+/g, " ").trim();

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

describe("notices of the OCR engine files", () => {
  const files = ocrFiles();

  it("are served with the files: every licence file a served script points to is served too", () => {
    const pointers = Object.entries(files)
      .filter(([published]) => published.endsWith(".js"))
      .flatMap(([published, source]) => {
        const target = /For license information please see (\S+?)\s*\*\//.exec(readText(source).slice(0, 300))?.[1];
        return target ? [published.replace(/[^/]+$/, target)] : [];
      });
    expect(pointers).toEqual([`${OCR_ASSETS.corePath.slice(1)}/worker.min.js.LICENSE.txt`]);
    for (const published of pointers) expect(Object.keys(files)).toContain(published);
  });

  it("name every library that docs/LICENSES.md lists inside them", () => {
    const section = /### Inside the OCR engine files\n([\s\S]*?)\n### /.exec(licensesDoc)?.[1] ?? "";
    const libraries = section
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Library") && !line.startsWith("|---"))
      .map((line) => line.split("|")[1].trim());
    expect(libraries).toEqual(expect.arrayContaining(["tesseract.js", "idb-keyval", "wasm-feature-detect", "libjpeg", "openlibm"]));
    for (const library of libraries) {
      expect(noticeText, library).toMatch(new RegExp(`^\\s*(- )?${library.replace(/[.+]/g, "\\$&")} `, "m"));
    }
  });

  it("carry the licence texts and statements the licences require", () => {
    // Apache-2.0 (tesseract.js, tesseract.js-core, Tesseract, idb-keyval, wasm-feature-detect):
    // recipients get a copy of the licence.
    const apache = readText(files[`${OCR_ASSETS.corePath.slice(1)}/tesseract-core-lstm.wasm.js`].replace(/[^/\\]+$/, "LICENSE"));
    expect(apache).toContain("Apache License");
    expect(words(noticeText)).toContain(words(apache));
    // IJG licence, executable code only: the documentation must say so.
    expect(noticeText).toContain("This software is based in part on the work of the Independent JPEG Group.");
    // MIT: the permission notice; BSD: the conditions and disclaimer.
    expect(noticeText).toContain("The above copyright notice and this permission notice shall be included in");
    expect(noticeText.match(/Redistributions in binary form must reproduce/g)?.length).toBeGreaterThanOrEqual(5);
    // The banners minified out of the worker, also served next to it.
    const banners = readText(files[`${OCR_ASSETS.corePath.slice(1)}/worker.min.js.LICENSE.txt`]);
    for (const holder of ["Feross Aboukhadijeh", "Facebook, Inc.", "imaya"]) {
      expect(banners).toContain(holder);
      expect(noticeText).toContain(holder);
    }
  });
});
