// The app is hosted from its built files on Netlify (public/_headers, public/_redirects) or Vercel
// (vercel.json). Both must send the same headers on every path, so a change to one cannot silently
// miss the other; and a missing build or OCR file must be a 404, never the app's HTML.
import { describe, expect, it } from "vitest";
import netlifyHeadersFile from "../public/_headers?raw";
import netlifyRedirectsFile from "../public/_redirects?raw";
import vercelConfig from "../vercel.json";
import { OCR_ASSETS } from "./mrz/types";

interface Rule {
  source: string;
  headers: [string, string][];
}

/** public/_headers: a path line, then indented `Name: value` lines; `#` starts a comment. */
function netlifyRules(): Rule[] {
  const rules: Rule[] = [];
  for (const line of netlifyHeadersFile.split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue;
    const header = /^\s+([A-Za-z0-9-]+):\s*(.+?)\s*$/.exec(line);
    if (header) rules[rules.length - 1].headers.push([header[1], header[2]]);
    else rules.push({ source: line.trim(), headers: [] });
  }
  return rules;
}

const vercel = vercelConfig as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
  rewrites: { source: string; destination: string }[];
};

/** Netlify `/ocr/*` and Vercel `/ocr/(.*)` (path-to-regexp) as regular expressions. */
const netlifyPattern = (source: string) => new RegExp(`^${source.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
const vercelPattern = (source: string) => new RegExp(`^${source}$`);

/** Netlify: every matching rule applies, a header named twice is joined. */
function netlifyHeadersAt(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of netlifyRules()) {
    if (!netlifyPattern(rule.source).test(path)) continue;
    for (const [name, value] of rule.headers) out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

/** Vercel: every matching rule applies, the last one wins for a header named twice. */
function vercelHeadersAt(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of vercel.headers) {
    if (!vercelPattern(rule.source).test(path)) continue;
    for (const { key, value } of rule.headers) out[key] = value;
  }
  return out;
}

const PATHS = [
  "/",
  "/index.html",
  "/404.html",
  "/favicon.svg",
  "/assets/index-abc123.js",
  OCR_ASSETS.workerPath,
  `${OCR_ASSETS.corePath}/tesseract-core-simd-lstm.wasm.js`,
  `${OCR_ASSETS.langPath}/${OCR_ASSETS.language}.traineddata.gz`,
  "/ocr/NOTICE.txt",
  "/session/xyz",
];

describe("hosting configuration", () => {
  it("has the same header rules on Netlify and Vercel, path pattern by path pattern", () => {
    const fromNetlify = netlifyRules().map((r) => ({
      source: r.source.replace(/\*/g, "(.*)"),
      headers: Object.fromEntries(r.headers),
    }));
    const fromVercel = vercel.headers.map((r) => ({
      source: r.source,
      headers: Object.fromEntries(r.headers.map((h) => [h.key, h.value])),
    }));
    expect(fromVercel).toEqual(fromNetlify);
  });

  it("sends the same headers on Netlify and Vercel for every kind of path", () => {
    for (const path of PATHS) {
      expect({ path, headers: vercelHeadersAt(path) }).toEqual({ path, headers: netlifyHeadersAt(path) });
      expect(netlifyHeadersAt(path)["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    }
  });

  it("allows the OCR engine (WebAssembly in a same-origin worker) and nothing looser", () => {
    const csp = netlifyHeadersAt("/")["Content-Security-Policy"];
    const directives = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    expect(directives["script-src"]).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives["worker-src"]).toEqual(["'self'"]);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directives["connect-src"]).toEqual(["'self'", "https://*.supabase.co"]);
  });

  it("caches the versioned OCR files for a year, and nothing else", () => {
    const immutable = "public, max-age=31536000, immutable";
    for (const path of PATHS) {
      expect({ path, cache: netlifyHeadersAt(path)["Cache-Control"] }).toEqual({
        path,
        cache: path.startsWith("/ocr/") ? immutable : undefined,
      });
    }
    expect(OCR_ASSETS.workerPath.startsWith(`${OCR_ASSETS.corePath}/`)).toBe(true);
    expect(OCR_ASSETS.corePath).toMatch(/^\/ocr\/\d+\.\d+\.\d+$/);
    expect(OCR_ASSETS.langPath).toMatch(/^\/ocr\/mrz-\d+$/);
  });

  it("serves the app for every page but never for a missing build or OCR file", () => {
    expect(vercel.rewrites).toEqual([{ source: "/((?!assets/|ocr/).*)", destination: "/index.html" }]);
    const rewrite = vercelPattern(vercel.rewrites[0].source);
    expect(rewrite.test("/session/xyz")).toBe(true);
    expect(rewrite.test("/")).toBe(true);
    expect(rewrite.test("/assets/old.js")).toBe(false);
    expect(rewrite.test(OCR_ASSETS.workerPath)).toBe(false);

    // Netlify: the 404 rules come before the app's catch-all.
    const rules = netlifyRedirectsFile
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => line.trim().split(/\s+/));
    expect(rules).toEqual([
      ["/assets/*", "/404.html", "404"],
      ["/ocr/*", "/404.html", "404"],
      ["/*", "/index.html", "200"],
    ]);
  });
});
