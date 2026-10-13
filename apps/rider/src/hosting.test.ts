// The app is hosted from its built files on Netlify (public/_headers) or Vercel (vercel.json).
// Both must send the same security headers, so a change to one cannot silently miss the other.
import { describe, expect, it } from "vitest";
import netlifyHeadersFile from "../public/_headers?raw";
import vercelConfig from "../vercel.json";

function netlifyHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of netlifyHeadersFile.split("\n")) {
    const match = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (match) headers[match[1]] = match[2].trim();
  }
  return headers;
}

describe("hosting configuration", () => {
  const vercel = vercelConfig as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
    rewrites: { source: string; destination: string }[];
  };

  it("sends the same security headers on Vercel as on Netlify", () => {
    const all = vercel.headers.find((h) => h.source === "/(.*)");
    expect(all).toBeDefined();
    const fromVercel = Object.fromEntries(all!.headers.map((h) => [h.key, h.value]));
    expect(fromVercel).toEqual(netlifyHeaders());
    expect(fromVercel["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("serves the app for every page but never for a missing build file", () => {
    expect(vercel.rewrites).toEqual([{ source: "/((?!assets/).*)", destination: "/index.html" }]);
  });
});
