import { describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES } from "./config.ts";
import { ERROR_CODES } from "./contract.ts";
import {
  createRouter,
  errorResponse,
  HttpError,
  isUuid,
  jsonResponse,
  parseJsonObject,
  readBodyBytes,
  readJsonObject,
  routePath,
} from "./http.ts";
import { ALLOWED_ORIGIN, makeRequest, readJson } from "./test-helpers.ts";

function router(log = { error: vi.fn() }) {
  const echo = vi.fn(async (req: Request) => jsonResponse(200, await readJsonObject(req, { allowEmpty: true })));
  const handler = createRouter({
    name: "demo",
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
    log,
    routes: {
      "/echo": { POST: echo },
      "/ping": { GET: () => Promise.resolve(jsonResponse(200, { pong: true })) },
      "/boom": {
        GET: () => Promise.reject(new Error("db said: user@example.com")),
        POST: () => Promise.reject(new HttpError(409, "already_submitted")),
      },
    },
  });
  return { handler, echo, log };
}

describe("routePath", () => {
  it("tolerates the function prefix, the /functions/v1 prefix and a trailing slash", () => {
    expect(routePath("/demo/echo", "demo")).toBe("/echo");
    expect(routePath("/echo", "demo")).toBe("/echo");
    expect(routePath("/functions/v1/demo/echo/", "demo")).toBe("/echo");
    expect(routePath("/demo", "demo")).toBe("/");
    expect(routePath("/demoecho", "demo")).toBe("/demoecho");
    expect(routePath("/demo/captures/view", "demo")).toBe("/captures/view");
  });
});

describe("CORS", () => {
  it("answers an allowed preflight with the allowlisted origin, methods and headers", async () => {
    const { handler, echo } = router();
    const res = await handler(makeRequest("https://fn.example/demo/echo", {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST", "access-control-request-headers": "x-session-token" },
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type, authorization, apikey, x-session-token");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(echo).not.toHaveBeenCalled();
  });

  it("refuses a preflight from a disallowed origin without CORS headers", async () => {
    const { handler } = router();
    const res = await handler(makeRequest("https://fn.example/demo/echo", { method: "OPTIONS", origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await readJson(res)).error).toMatchObject({ code: "forbidden" });
  });

  it("refuses an actual request from a disallowed origin before running the route", async () => {
    const { handler, echo } = router();
    const res = await handler(makeRequest("https://fn.example/demo/echo", { body: {}, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(echo).not.toHaveBeenCalled();
  });

  it("refuses look-alike origins", async () => {
    const { handler } = router();
    for (const origin of ["https://app.example.evil.example", "http://app.example", "https://app.example:8443", "null"]) {
      const res = await handler(makeRequest("https://fn.example/demo/ping", { method: "GET", origin }));
      expect(res.status, origin).toBe(403);
    }
  });

  it("adds CORS headers to responses for an allowed origin, errors included", async () => {
    const { handler } = router();
    const ok = await handler(makeRequest("https://fn.example/demo/ping", { method: "GET" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    const err = await handler(makeRequest("https://fn.example/demo/boom", { body: {} }));
    expect(err.status).toBe(409);
    expect(err.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("serves requests without an Origin header (non-browser) without CORS headers", async () => {
    const { handler } = router();
    const res = await handler(makeRequest("https://fn.example/demo/ping", { method: "GET", origin: null }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("routing and methods", () => {
  it("only allows GET, POST and OPTIONS", async () => {
    const { handler } = router();
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD"]) {
      const res = await handler(makeRequest("https://fn.example/demo/echo", { method }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST, OPTIONS");
    }
  });

  it("returns 405 for a known route with the wrong method", async () => {
    const { handler } = router();
    const res = await handler(makeRequest("https://fn.example/demo/echo", { method: "GET" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
    expect((await readJson(res)).error).toMatchObject({ code: "bad_request" });
  });

  it("returns 404 not_found for unknown routes, including prototype keys", async () => {
    const { handler } = router();
    for (const path of ["/demo/nope", "/demo/", "/demo/constructor", "/demo/__proto__", "/other/echo"]) {
      const res = await handler(makeRequest(`https://fn.example${path}`, { method: "GET" }));
      expect(res.status, path).toBe(404);
      expect((await readJson(res)).error).toMatchObject({ code: "not_found" });
    }
  });

  it("hides unexpected errors behind server_error and logs no message", async () => {
    const { handler, log } = router();
    const res = await handler(makeRequest("https://fn.example/demo/boom", { method: "GET" }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "server_error", message: expect.any(String) } });
    expect(text).not.toContain("user@example.com");
    expect(text).not.toMatch(/\bat\s/);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("has a fixed default message for every error code of the contract", async () => {
    for (const code of ERROR_CODES) {
      const body = await readJson(errorResponse(400, code));
      expect(body, code).toEqual({ error: { code, message: expect.stringMatching(/^[A-Z].+\.$/) } });
    }
  });

  it("sends JSON with no-store caching", () => {
    const res = errorResponse(400, "bad_request");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("request bodies", () => {
  it("parses a JSON object", async () => {
    const { handler } = router();
    const res = await handler(makeRequest("https://fn.example/demo/echo", { body: { a: 1 } }));
    expect(await readJson(res)).toEqual({ a: 1 });
  });

  it("rejects a declared Content-Length over 16 KB", async () => {
    const { handler, echo } = router();
    const res = await handler(makeRequest("https://fn.example/demo/echo", {
      rawBody: "{}",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    }));
    expect(res.status).toBe(413);
    expect(echo).not.toHaveBeenCalled();
  });

  it("rejects a streamed body over 16 KB even without Content-Length", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < big.length; i += 1000) controller.enqueue(big.slice(i, i + 1000));
        controller.close();
      },
    });
    const req = new Request("https://fn.example/demo/echo", {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const res = await router().handler(req);
    expect(res.status).toBe(413);
  });

  it("accepts a body of exactly 16 KB", async () => {
    const pad = "x".repeat(MAX_BODY_BYTES - '{"p":""}'.length);
    const res = await router().handler(makeRequest("https://fn.example/demo/echo", { rawBody: `{"p":"${pad}"}` }));
    expect(res.status).toBe(200);
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["an array", "[1,2]"],
    ["null", "null"],
    ["a string", '"x"'],
  ])("rejects %s with bad_request", async (_label, rawBody) => {
    const res = await router().handler(makeRequest("https://fn.example/demo/echo", { rawBody }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toMatchObject({ code: "bad_request" });
  });

  it("rejects bytes that are not UTF-8", async () => {
    const req = new Request("https://fn.example/demo/echo", {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN },
      body: Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    });
    const res = await router().handler(req);
    expect(res.status).toBe(400);
  });

  it("requires a body unless allowEmpty is set", async () => {
    await expect(readJsonObject(new Request("https://x.example", { method: "POST" }))).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(await readJsonObject(new Request("https://x.example", { method: "POST" }), { allowEmpty: true })).toEqual({});
  });
});

describe("raw bodies (the worker function verifies a signature over them)", () => {
  it("reads the exact bytes, up to the given limit", async () => {
    const bytes = Uint8Array.from([0x7b, 0x7d, 0x0a, 0xc3, 0xa9]);
    expect(await readBodyBytes(new Request("https://x.example", { method: "POST", body: bytes }), 5)).toEqual(bytes);
    expect(await readBodyBytes(new Request("https://x.example", { method: "POST" }), 5)).toEqual(new Uint8Array(0));
    await expect(readBodyBytes(new Request("https://x.example", { method: "POST", body: bytes }), 4)).rejects.toMatchObject({
      status: 413,
      code: "bad_request",
    });
  });

  it("parses a JSON object from bytes, 400 otherwise", () => {
    expect(parseJsonObject(new TextEncoder().encode('{"a":1}'))).toEqual({ a: 1 });
    for (const raw of ["[]", "1", "{nope", ""]) {
      expect(() => parseJsonObject(new TextEncoder().encode(raw))).toThrow(HttpError);
    }
  });

  it("lets a router accept larger bodies than the default", async () => {
    const handler = createRouter({
      name: "big",
      allowedOrigins: new Set(),
      maxBodyBytes: 32 * 1024,
      routes: { "/in": { POST: async (req) => jsonResponse(200, { bytes: (await readBodyBytes(req, 32 * 1024)).length }) } },
    });
    const ok = await handler(makeRequest("https://fn.example/big/in", {
      origin: null,
      rawBody: "x".repeat(20_000),
      headers: { "content-length": "20000" },
    }));
    expect(await readJson(ok)).toEqual({ bytes: 20_000 });
    const tooBig = await handler(makeRequest("https://fn.example/big/in", {
      origin: null,
      rawBody: "{}",
      headers: { "content-length": String(32 * 1024 + 1) },
    }));
    expect(tooBig.status).toBe(413);
  });
});

describe("isUuid", () => {
  it("accepts canonical UUIDs only", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("11111111-1111-4111-8111-11111111111")).toBe(false);
    expect(isUuid("11111111-1111-4111-8111-111111111111 ")).toBe(false);
    expect(isUuid("x1111111-1111-4111-8111-111111111111")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
