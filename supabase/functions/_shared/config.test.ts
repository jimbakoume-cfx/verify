import { describe, expect, it } from "vitest";
import {
  configProblems,
  DEFAULT_TEST_SESSION_TTL_MINUTES,
  parseAllowedOrigins,
  parseRiderAppUrl,
  parseTtlMinutes,
  parseWorkerRingUrl,
  readConfig,
  resolveServiceKey,
  withDefaults,
} from "./config.ts";
import { TEST_ENVIRONMENT_DEFAULTS } from "./environment.ts";

describe("parseAllowedOrigins", () => {
  it("keeps exact origins, trimmed, without a trailing slash", () => {
    const origins = parseAllowedOrigins(" https://a.example , http://localhost:5173/,https://B.example");
    expect([...origins]).toEqual(["https://a.example", "http://localhost:5173", "https://b.example"]);
  });

  it("ignores wildcards, paths, null and other schemes rather than widening", () => {
    const origins = parseAllowedOrigins("*,null,https://a.example/path,ftp://x.example,https://*.example,,");
    expect(origins.size).toBe(0);
  });

  it("is empty when unset", () => {
    expect(parseAllowedOrigins(undefined).size).toBe(0);
  });
});

describe("parseRiderAppUrl", () => {
  it("accepts https and local http, trimming trailing slashes", () => {
    expect(parseRiderAppUrl("https://rider.example/")).toBe("https://rider.example");
    expect(parseRiderAppUrl("https://rider.example/verify")).toBe("https://rider.example/verify");
    expect(parseRiderAppUrl("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("rejects plain http, queries, fragments, credentials and garbage", () => {
    expect(parseRiderAppUrl("http://rider.example")).toBeNull();
    expect(parseRiderAppUrl("https://rider.example/?a=1")).toBeNull();
    expect(parseRiderAppUrl("https://rider.example/#x")).toBeNull();
    expect(parseRiderAppUrl("https://user:pw@rider.example")).toBeNull();
    expect(parseRiderAppUrl("javascript:alert(1)")).toBeNull();
    expect(parseRiderAppUrl("not a url")).toBeNull();
    expect(parseRiderAppUrl(undefined)).toBeNull();
  });
});

describe("parseWorkerRingUrl", () => {
  it("accepts an https URL as is", () => {
    expect(parseWorkerRingUrl(" https://worker.example/api/process ")).toBe("https://worker.example/api/process");
  });

  it("rejects plain http (even local), queries, fragments, credentials and garbage", () => {
    expect(parseWorkerRingUrl("http://worker.example/api/process")).toBeNull();
    expect(parseWorkerRingUrl("http://localhost:3000/api/process")).toBeNull();
    expect(parseWorkerRingUrl("https://worker.example/api/process?token=x")).toBeNull();
    expect(parseWorkerRingUrl("https://worker.example/api/process#x")).toBeNull();
    expect(parseWorkerRingUrl("https://user:pw@worker.example/api/process")).toBeNull();
    expect(parseWorkerRingUrl("not a url")).toBeNull();
    expect(parseWorkerRingUrl(undefined)).toBeNull();
    expect(parseWorkerRingUrl("")).toBeNull();
  });
});

describe("parseTtlMinutes", () => {
  it("defaults to 30", () => {
    expect(parseTtlMinutes(undefined)).toBe(DEFAULT_TEST_SESSION_TTL_MINUTES);
    expect(parseTtlMinutes("")).toBe(30);
    expect(parseTtlMinutes("abc")).toBe(30);
    expect(parseTtlMinutes("-5")).toBe(30);
    expect(parseTtlMinutes("0")).toBe(30);
    expect(parseTtlMinutes("1.5")).toBe(30);
  });

  it("accepts whole minutes, capped at one day", () => {
    expect(parseTtlMinutes(" 45 ")).toBe(45);
    expect(parseTtlMinutes("100000")).toBe(1440);
  });
});

describe("resolveServiceKey", () => {
  const reader = (values: Record<string, string>) => (name: string) => values[name];

  it("prefers the default key from SUPABASE_SECRET_KEYS", () => {
    expect(resolveServiceKey(reader({
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_new" }),
      SUPABASE_SERVICE_ROLE_KEY: "legacy",
    }))).toBe("sb_secret_new");
  });

  it("falls back to the legacy key when the JSON is missing, malformed or has no default", () => {
    expect(resolveServiceKey(reader({ SUPABASE_SERVICE_ROLE_KEY: "legacy" }))).toBe("legacy");
    expect(resolveServiceKey(reader({ SUPABASE_SECRET_KEYS: "{oops", SUPABASE_SERVICE_ROLE_KEY: "legacy" })))
      .toBe("legacy");
    expect(resolveServiceKey(reader({ SUPABASE_SECRET_KEYS: '{"other":"x"}', SUPABASE_SERVICE_ROLE_KEY: "legacy" })))
      .toBe("legacy");
  });

  it("is null when nothing is configured", () => {
    expect(resolveServiceKey(reader({}))).toBeNull();
  });
});

describe("readConfig", () => {
  it("reads every setting", () => {
    const config = readConfig((name) => ({
      ALLOWED_ORIGINS: "https://a.example",
      RIDER_APP_URL: "https://rider.example",
      TEST_SESSION_TTL_MINUTES: "15",
      WORKER_RING_URL: "https://worker.example/api/process",
      FACE_RING_URL: "https://face.example/api/process",
    } as Record<string, string>)[name]);
    expect([...config.allowedOrigins]).toEqual(["https://a.example"]);
    expect(config.riderAppUrl).toBe("https://rider.example");
    expect(config.testSessionTtlMinutes).toBe(15);
    expect(config.workerRingUrl).toBe("https://worker.example/api/process");
    expect(config.faceRingUrl).toBe("https://face.example/api/process");
  });

  it("refuses a face ring URL that is not plain HTTPS (M6/M7)", () => {
    const read = (value: string) => readConfig((name) => (name === "FACE_RING_URL" ? value : undefined)).faceRingUrl;
    expect(read("http://face.example/api/process")).toBeNull();
    expect(read("https://user:pw@face.example/api/process")).toBeNull();
    expect(read("https://face.example/api/process?key=1")).toBeNull();
  });
});

describe("configProblems", () => {
  const good = {
    allowedOrigins: new Set(["https://a.example"]),
    riderAppUrl: "https://r.example",
    testSessionTtlMinutes: 30,
    workerRingUrl: "https://w.example/api/process",
    faceRingUrl: "https://f.example/api/process",
  };

  it("reports settings that make the functions refuse work", () => {
    expect(configProblems(good, { needsRiderAppUrl: true, needsWorkerRingUrl: true })).toEqual([]);
    expect(configProblems({ ...good, allowedOrigins: new Set() })).toHaveLength(1);
    expect(configProblems({ ...good, riderAppUrl: null })).toEqual([]);
    expect(configProblems({ ...good, riderAppUrl: null }, { needsRiderAppUrl: true })).toHaveLength(1);
  });

  it("reports a missing worker ring URL only where the worker is rung", () => {
    expect(configProblems({ ...good, workerRingUrl: null })).toEqual([]);
    expect(configProblems({ ...good, workerRingUrl: null }, { needsWorkerRingUrl: true })).toHaveLength(1);
  });

  it("reports a missing face ring URL only where the face worker is rung", () => {
    expect(configProblems({ ...good, faceRingUrl: null })).toEqual([]);
    expect(configProblems({ ...good, faceRingUrl: null }, { needsFaceRingUrl: true })).toHaveLength(1);
  });
});

describe("withDefaults", () => {
  const env = (values: Record<string, string>) => (name: string) => values[name];

  it("uses the environment value when set", () => {
    const get = withDefaults(env({ RIDER_APP_URL: "https://riders.example" }), TEST_ENVIRONMENT_DEFAULTS);
    expect(readConfig(get).riderAppUrl).toBe("https://riders.example");
  });

  it("falls back to the test-environment defaults when unset or blank", () => {
    const config = readConfig(withDefaults(env({ ALLOWED_ORIGINS: "  " }), TEST_ENVIRONMENT_DEFAULTS));
    expect(config.riderAppUrl).toBe("https://confiance-verify.vercel.app");
    expect([...config.allowedOrigins].sort()).toEqual([
      "https://confiance-verify-ops.vercel.app",
      "https://confiance-verify.vercel.app",
    ]);
    expect(config.workerRingUrl).toBe("https://confiance-verify-worker.vercel.app/api/process");
    expect(config.faceRingUrl).toBe("https://confiance-verify-face.vercel.app/api/process");
    expect(configProblems(config, { needsRiderAppUrl: true, needsWorkerRingUrl: true, needsFaceRingUrl: true })).toEqual([]);
  });
});
