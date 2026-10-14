import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Plugin, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { OCR_ASSETS } from "./src/mrz/types.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");

/**
 * The OCR engine's files, served from our own site under OCR_ASSETS.corePath (never from a CDN):
 * tesseract.js's worker script and the three LSTM-only WebAssembly builds of its core (the worker
 * picks the one the browser supports; engine mode 1 never loads the other three). They come from
 * node_modules, so an upgrade cannot be forgotten here. The folder is named after the version,
 * so the files can be cached forever: an upgrade must change OCR_ASSETS (and the model's cache key).
 * The worker's licence file goes with it: the minified worker points to it for the copyright
 * banners taken out of it (public/ocr/NOTICE.txt has the rest). Exported for model.test.ts.
 */
export function ocrFiles(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const tesseract = path.dirname(require.resolve("tesseract.js/package.json"));
  const core = path.dirname(require.resolve("tesseract.js-core/package.json"));
  const folder = OCR_ASSETS.corePath.replace(/^\//, "");
  for (const dir of [tesseract, core]) {
    const { name, version } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name: string; version: string };
    if (folder !== `ocr/${version}`) {
      throw new Error(`${name} ${version} is installed but OCR_ASSETS points at /${folder}: update src/mrz/types.ts`);
    }
  }
  if (OCR_ASSETS.workerPath !== `/${folder}/worker.min.js`) throw new Error("OCR_ASSETS.workerPath must sit in corePath");
  const files: Record<string, string> = {
    [`${folder}/worker.min.js`]: path.join(tesseract, "dist", "worker.min.js"),
    [`${folder}/worker.min.js.LICENSE.txt`]: path.join(tesseract, "dist", "worker.min.js.LICENSE.txt"),
  };
  for (const variant of ["lstm", "simd-lstm", "relaxedsimd-lstm"]) {
    files[`${folder}/tesseract-core-${variant}.wasm.js`] = path.join(core, `tesseract-core-${variant}.wasm.js`);
  }
  return files;
}

interface HeaderRule {
  pattern: RegExp;
  headers: [string, string][];
}

/** Netlify path pattern (`/ocr/*`, `/*`, an exact path) as a regular expression. */
function netlifyPattern(source: string): RegExp {
  const escaped = source.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** public/_headers (Netlify format): a path line, then indented `Name: value` lines. */
function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue;
    const header = /^\s+([A-Za-z0-9-]+):\s*(.+?)\s*$/.exec(line);
    if (header && rules.length > 0) rules[rules.length - 1].headers.push([header[1], header[2]]);
    else if (!header) rules.push({ pattern: netlifyPattern(line.trim()), headers: [] });
  }
  return rules;
}

/** The `from to 404` rules of public/_redirects: a missing file there is a 404 page, not the app. */
function parseNotFoundRules(text: string): { pattern: RegExp; page: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[2] === "404" && !parts[0].startsWith("#"))
    .map(([from, to]) => ({ pattern: netlifyPattern(from), page: to }));
}

/**
 * Self-hosts the OCR engine (see ocrFiles): emitted into the build, served by the dev server.
 * The preview server (used by the E2E tests) also behaves like the real host: it sends the
 * public/_headers rules path by path (so the real CSP applies) and answers 404 for a missing file
 * under the public/_redirects 404 rules instead of the app's index.html.
 */
function ocrAssets(): Plugin {
  const files = ocrFiles();
  return {
    name: "verify-ocr-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0].replace(/^\//, "");
        const file = files[pathname];
        if (!file) return next();
        res.setHeader("Content-Type", `${pathname.endsWith(".js") ? "text/javascript" : "text/plain"}; charset=utf-8`);
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [fileName, file] of Object.entries(files)) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(file) });
      }
    },
    configurePreviewServer(server) {
      const outDir = path.resolve(server.config.root, server.config.build.outDir);
      const headerRules = parseHeaders(readFileSync(path.join(publicDir, "_headers"), "utf8"));
      const notFound = parseNotFoundRules(readFileSync(path.join(publicDir, "_redirects"), "utf8"));
      const isFile = (pathname: string) => {
        const file = path.resolve(outDir, `.${pathname}`);
        return file.startsWith(outDir + path.sep) && existsSync(file) && statSync(file).isFile();
      };
      server.middlewares.use((req, res, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(req.url ?? "/", "http://preview").pathname);
        } catch {
          pathname = "/";
        }
        // Like Netlify, every matching rule applies; a header named twice is joined.
        const headers = new Map<string, string>();
        for (const rule of headerRules) {
          if (!rule.pattern.test(pathname)) continue;
          for (const [name, value] of rule.headers) headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
        }
        for (const [name, value] of headers) res.setHeader(name, value);
        const rule = notFound.find((r) => r.pattern.test(pathname));
        if (rule && !isFile(pathname)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(readFileSync(path.join(outDir, rule.page)));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ocrAssets()],
  define: {
    __BUILD_ID__: JSON.stringify((process.env.COMMIT_REF ?? "local").slice(0, 7)),
  },
  // The capture analyzer runs in a module worker, emitted as its own chunk.
  worker: { format: "es" },
});
