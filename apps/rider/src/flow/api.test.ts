import { describe, expect, it, vi } from "vitest";
import { createFlowApi, errorFromResponse } from "./api";
import { FlowError } from "./errors";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const BASE = "https://ref.supabase.co/functions/v1/flow";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiWith(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createFlowApi({ baseUrl: BASE, token: TOKEN, apiKey: "sb_publishable_test", fetch: fetchImpl, timeoutMs });
}

describe("createFlowApi", () => {
  it("sends the session token and publishable key, never in the URL", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, { status: "created" }));
    await apiWith(fetchMock as typeof fetch).getSession();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/session`);
    expect(String(url)).not.toContain(TOKEN);
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ "x-session-token": TOKEN, apikey: "sb_publishable_test" });
    expect(init?.credentials).toBe("omit");
  });

  it("posts JSON bodies to the contract routes", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, {}));
    const api = apiWith(fetchMock as typeof fetch);
    await api.consent({ consentVersion: "placeholder-v1", language: "fr" });
    await api.setDocumentType({ declaredDocument: "cni_legacy" });
    await api.uploadUrl({ kind: "document_front" });
    await api.reportMrz({
      captureId: "c0ffee00-0000-4000-8000-000000000001",
      result: "unreadable",
      reason: "not_found",
      attempts: 2,
      engine: "tesseract.js-7.0.0/mrz-1",
    });
    await api.livenessChallenge();
    const report = {
      challengeId: "c0ffee00-0000-4000-8000-000000000002",
      code: "123456",
      frames: [],
      stepStartsMs: [0, 1500, 4500, 7500],
      startedWithWarning: false,
      videoWidth: 480,
      videoHeight: 640,
    };
    await api.recordLiveness(report);
    await api.submit();
    const calls = fetchMock.mock.calls.map(([url, init]) => [String(url).slice(BASE.length), init?.method, init?.body]);
    expect(calls).toEqual([
      ["/consent", "POST", '{"consentVersion":"placeholder-v1","language":"fr"}'],
      ["/document-type", "POST", '{"declaredDocument":"cni_legacy"}'],
      ["/upload-url", "POST", '{"kind":"document_front"}'],
      [
        "/mrz",
        "POST",
        JSON.stringify({
          captureId: "c0ffee00-0000-4000-8000-000000000001",
          result: "unreadable",
          reason: "not_found",
          attempts: 2,
          engine: "tesseract.js-7.0.0/mrz-1",
        }),
      ],
      ["/liveness/challenge", "POST", "{}"],
      ["/liveness/captures", "POST", JSON.stringify(report)],
      ["/submit", "POST", "{}"],
    ]);
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("throws typed errors carrying the contract code", async () => {
    const api = apiWith((async () => json(410, { error: { code: "session_expired", message: "x" } })) as typeof fetch);
    await expect(api.getSession()).rejects.toMatchObject({ code: "session_expired", status: 410 });
  });

  it("maps a network failure and a timeout", async () => {
    const offline = apiWith((async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    await expect(offline.getSession()).rejects.toMatchObject({ code: "network", status: 0 });

    const hanging = apiWith(
      ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as typeof fetch,
      10,
    );
    await expect(hanging.getSession()).rejects.toMatchObject({ code: "timeout" });
  });

  it("asks for the server's checks, and stops when the caller gives up", async () => {
    const checks = { done: false, sides: [{ kind: "document_front", captureId: "c1", state: "pending", reason: null }] };
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, checks));
    expect(await apiWith(fetchMock as typeof fetch).getChecks()).toEqual(checks);
    const [url, init] = fetchMock.mock.calls[0];
    expect([String(url).slice(BASE.length), init?.method, init?.body]).toEqual(["/checks", "GET", undefined]);
    expect(init?.cache).toBe("no-store");

    const hanging = apiWith(((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch);
    const controller = new AbortController();
    const pending = hanging.getChecks(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    // Already given up: the request is abandoned at once.
    await expect(hanging.getChecks(controller.signal)).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports a missing configuration without calling the network", async () => {
    const fetchMock = vi.fn();
    const api = createFlowApi({ baseUrl: null, token: TOKEN, apiKey: undefined, fetch: fetchMock as typeof fetch });
    await expect(api.getSession()).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("errorFromResponse", () => {
  it("ignores codes that are not in the contract", async () => {
    const err = await errorFromResponse(json(401, { code: 401, message: "Invalid JWT" }));
    expect(err).toBeInstanceOf(FlowError);
    expect(err.code).toBe("unexpected");
  });

  it("treats a non-JSON 5xx as a server error", async () => {
    const err = await errorFromResponse(new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(err).toMatchObject({ code: "server_error", status: 502 });
  });
});
