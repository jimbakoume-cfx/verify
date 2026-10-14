// deno-lint-ignore-file require-await
import { describe, expect, it, vi } from "vitest";
import { createWorkerRing, noRing, RING_TIMEOUT_MS } from "./ring.ts";

const URL_ = "https://worker.example/api/process";

function harness(respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const tasks: Promise<unknown>[] = [];
  const log = { error: vi.fn() };
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return await respond(input, init);
  }) as typeof fetch;
  const ring = createWorkerRing({ url: URL_, fetch: fetchFake, waitUntil: (task) => tasks.push(task), log });
  const failures: string[] = [];
  const onFailure = async () => {
    failures.push("failed");
  };
  return { ring, calls, tasks, log, failures, onFailure, settle: () => Promise.all(tasks) };
}

describe("createWorkerRing", () => {
  it("posts an empty body to the worker, in the background", async () => {
    const h = harness(async () => new Response('{"ok":true}', { status: 200 }));
    h.ring("capture", h.onFailure);
    expect(h.tasks).toHaveLength(1);
    await h.settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe(URL_);
    expect(h.calls[0].init?.method).toBe("POST");
    expect(h.calls[0].init?.body).toBe("");
    expect(h.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    // No header carries authority: the ring is a doorbell.
    expect(h.calls[0].init?.headers).toBeUndefined();
    expect(h.failures).toEqual([]);
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it("reports a refused ring (5xx, 4xx) as a failure, with the status only", async () => {
    for (const status of [500, 502, 404, 403]) {
      const h = harness(async () => new Response("secret page", { status }));
      h.ring("capture", h.onFailure);
      await h.settle();
      expect(h.failures, String(status)).toEqual(["failed"]);
      expect(h.log.error).toHaveBeenCalledWith("flow.ring_failed.capture", expect.objectContaining({ status }));
    }
  });

  it("treats the firewall's rate limit (429) as reached: a worker is already running", async () => {
    const h = harness(async () => new Response(null, { status: 429 }));
    h.ring("warm_up", h.onFailure);
    await h.settle();
    expect(h.failures).toEqual([]);
  });

  it("reports a network error as a failure", async () => {
    const h = harness(async () => {
      throw new TypeError("connection refused");
    });
    h.ring("capture", h.onFailure);
    await h.settle();
    expect(h.failures).toEqual(["failed"]);
    expect(h.log.error).toHaveBeenCalledWith("flow.ring_failed.capture", expect.any(TypeError));
  });

  it("treats a timeout as reached: the worker answers only when its run ends", async () => {
    const h = harness(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    h.ring("capture", h.onFailure);
    await h.settle();
    expect(h.failures).toEqual([]);
    expect(RING_TIMEOUT_MS).toBe(30_000);
  });

  it("logs, never throws, when the failure cannot be recorded", async () => {
    const h = harness(async () => new Response(null, { status: 500 }));
    h.ring("capture", async () => {
      throw new Error("db down");
    });
    await h.settle();
    expect(h.log.error).toHaveBeenCalledWith("flow.ring_failure_not_recorded", expect.any(Error));
  });

  it("runs without waitUntil (fire-and-forget) and without onFailure", async () => {
    const calls: string[] = [];
    const ring = createWorkerRing({
      url: URL_,
      fetch: (async () => {
        calls.push("rung");
        return new Response(null, { status: 500 });
      }) as typeof fetch,
      log: { error: vi.fn() },
    });
    ring("warm_up");
    await vi.waitFor(() => expect(calls).toEqual(["rung"]));
  });

  it("never rings without a URL", () => {
    expect(createWorkerRing({ url: null, log: { error: vi.fn() } })).toBe(noRing);
  });
});
