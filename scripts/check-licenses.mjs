#!/usr/bin/env node
// Fails if any npm package in package-lock.json (direct or indirect) has a licence that is
// not on the commercial-use allowlist. See docs/LICENSES.md for the policy.
import { readFileSync } from "node:fs";

const ALLOWED = new Set([
  "MIT", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0",
  "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Python-2.0", "Zlib",
  // File-level copyleft: allowed commercially; we must publish changes to those files only.
  // Currently only build tools (lightningcss), which never ship to users.
  "MPL-2.0",
]);

// Explicit exceptions, each with a written reason.
const EXCEPTIONS = {
  // "package-name": "reason",
};

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

/** Accepts SPDX expressions like "(MIT OR Apache-2.0)": OR needs one allowed side, AND needs all. */
function isAllowed(expr) {
  const clean = expr.replace(/[()]/g, " ").trim();
  if (/\sOR\s/i.test(clean)) return clean.split(/\sOR\s/i).some((p) => isAllowed(p));
  if (/\sAND\s/i.test(clean)) return clean.split(/\sAND\s/i).every((p) => isAllowed(p));
  return ALLOWED.has(clean);
}

const problems = [];
let count = 0;
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path.includes("node_modules/") || info.link) continue; // skip our own workspaces
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  count++;
  if (EXCEPTIONS[name]) continue;
  const license = typeof info.license === "string" ? info.license : "UNKNOWN";
  if (!isAllowed(license)) problems.push(`${name}@${info.version}: ${license}`);
}

if (problems.length) {
  console.error(`Licence check FAILED. ${problems.length} package(s) not on the allowlist:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("Replace the package, or add a justified exception in scripts/check-licenses.mjs and docs/LICENSES.md.");
  process.exit(1);
}
console.log(`Licence check passed: ${count} npm packages, all on the commercial-use allowlist.`);
