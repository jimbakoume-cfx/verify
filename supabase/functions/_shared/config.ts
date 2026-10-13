// Function settings read from the environment. Pure (the reader is injected) so it can be unit-tested;
// env.ts wires it to Deno.env.

/** Private bucket holding ID images (created by the M0 migration, no storage policies). */
export const ID_CAPTURES_BUCKET = "id-captures";

/** Lifetime of the signed link returned by POST /admin/captures/view. */
export const CAPTURE_VIEW_SECONDS = 60;

/** Request bodies above this size are refused before parsing. */
export const MAX_BODY_BYTES = 16 * 1024;

export const DEFAULT_TEST_SESSION_TTL_MINUTES = 30;
const MAX_TEST_SESSION_TTL_MINUTES = 24 * 60;

export type EnvReader = (name: string) => string | undefined;

export interface FunctionConfig {
  /** Exact browser origins allowed to call the functions. Empty = every browser origin refused. */
  allowedOrigins: ReadonlySet<string>;
  /** Base URL of the rider web app, without trailing slash; null when unset or invalid. */
  riderAppUrl: string | null;
  testSessionTtlMinutes: number;
}

export function readConfig(get: EnvReader): FunctionConfig {
  return {
    allowedOrigins: parseAllowedOrigins(get("ALLOWED_ORIGINS")),
    riderAppUrl: parseRiderAppUrl(get("RIDER_APP_URL")),
    testSessionTtlMinutes: parseTtlMinutes(get("TEST_SESSION_TTL_MINUTES")),
  };
}

/** Settings that make the function refuse work. They fail closed, so they are reported at startup. */
export function configProblems(config: FunctionConfig, { needsRiderAppUrl = false } = {}): string[] {
  const problems: string[] = [];
  if (config.allowedOrigins.size === 0) {
    problems.push("ALLOWED_ORIGINS has no valid origin: every browser request will be refused");
  }
  if (needsRiderAppUrl && !config.riderAppUrl) {
    problems.push("RIDER_APP_URL is missing or invalid: test sessions cannot be created");
  }
  return problems;
}

/**
 * Comma-separated list of origins such as "https://a.example,http://localhost:5173".
 * Entries that are not a bare origin (a path, a wildcard, "null") are ignored rather than widened.
 */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const candidate = entry.trim().replace(/\/$/, "");
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const isHttp = url.protocol === "https:" || url.protocol === "http:";
      // The URL parser accepts "*" in a host name; only plain host names and IP literals are kept.
      const plainHost = /^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/.test(url.hostname);
      if (isHttp && plainHost && url.origin === candidate.toLowerCase()) origins.add(url.origin);
    } catch {
      // Not a URL: ignored.
    }
  }
  return origins;
}

/** HTTPS only, except http://localhost for local development. No query or fragment. */
export function parseRiderAppUrl(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !local) return null;
    if (url.search || url.hash || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}

export function parseTtlMinutes(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return DEFAULT_TEST_SESSION_TTL_MINUTES;
  const minutes = Number(value);
  if (minutes < 1) return DEFAULT_TEST_SESSION_TTL_MINUTES;
  return Math.min(minutes, MAX_TEST_SESSION_TTL_MINUTES);
}

/** SUPABASE_SECRET_KEYS is a JSON object of named secret keys; the legacy service-role JWT is the fallback. */
export function resolveServiceKey(get: EnvReader): string | null {
  const keys = get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed: unknown = JSON.parse(keys);
      if (parsed && typeof parsed === "object") {
        const key = (parsed as Record<string, unknown>)["default"];
        if (typeof key === "string" && key) return key;
      }
    } catch {
      // Malformed: fall through to the legacy key.
    }
  }
  return get("SUPABASE_SERVICE_ROLE_KEY") || null;
}
