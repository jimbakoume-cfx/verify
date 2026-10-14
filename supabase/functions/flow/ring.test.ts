// deno-lint-ignore-file require-await
import { describe, expect, it, vi } from "vitest";
import { createWorkerRing, noRing, RING_RETRY_MAX_PAUSE_MS, RING_RETRY_PAUSE_MS, RING_TIMEOUT_MS, retryPause } from "./ring.ts";

const URL_ = "https://worker.example/api/process";

function harness(respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const tasks: Promise<unknown>[] = [];
  const log = { error: vi.fn() };
  const pauses: number[] = [];
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return await respond(input, init);
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    pauses.push(ms);
  };
  const ring = createWorkerRing({ url: URL_, fetch: fetchFake, waitUntil: (task) => tasks.push(task), sleep, log });
  const failures: string[] = [];
  const onFailure = async () => {
    failures.push("failed");
  };
  return { ring, calls, tasks, log, pauses, failures, onFailure, settle: () => Promise.all(tasks) };
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

  // A 429 comes from the firewall, before the worker: it says nothing about a run in progress (a run ends
  // as soon as no job is left, while the firewall keeps counting the rings that started it).
  it("tries a rate-limited ring (429) once more after a pause: reached the second time", async () => {
    const statuses = [429, 200];
    const h = harness(async () => new Response(null, { status: statuses.shift() }));
    h.ring("capture", h.onFailure);
    await h.settle();
    expect(h.calls).toHaveLength(2);
    expect(h.pauses).toEqual([RING_RETRY_PAUSE_MS]);
    expect(h.failures).toEqual([]);
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it("reports a ring rate-limited twice as a failure, so the photo is unchecked at once", async () => {
    const h = harness(async () => new Response(null, { status: 429 }));
    h.ring("capture", h.onFailure);
    await h.settle();
    expect(h.calls).toHaveLength(2);
    expect(h.failures).toEqual(["failed"]);
    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(h.log.error).toHaveBeenCalledWith("flow.ring_failed.capture", expect.objectContaining({ status: 429 }));
  });

  it("waits for a short Retry-After, and gives up at once when the firewall asks for longer than the rider waits", async () => {
    const short = harness(async () => new Response(null, { status: 429, headers: { "retry-after": "2" } }));
    short.ring("warm_up", short.onFailure);
    await short.settle();
    expect(short.pauses).toEqual([2000]);
    expect(short.calls).toHaveLength(2);

    const long = harness(async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    long.ring("capture", long.onFailure);
    await long.settle();
    expect(long.pauses).toEqual([]);
    expect(long.calls).toHaveLength(1);
    expect(long.failures).toEqual(["failed"]);
  });

  it("reports the retry's own failure once, with its status", async () => {
    const statuses = [429, 503];
    const h = harness(async () => new Response(null, { status: statuses.shift() }));
    h.ring("capture", h.onFailure);
    await h.settle();
    expect(h.failures).toEqual(["failed"]);
    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(h.log.error).toHaveBeenCalledWith("flow.ring_failed.capture", expect.objectContaining({ status: 503 }));
  });

  it("reads Retry-After as whole seconds only", () => {
    expect(retryPause(null)).toBe(RING_RETRY_PAUSE_MS);
    expect(retryPause("0")).toBe(0);
    expect(retryPause(" 3 ")).toBe(3000);
    expect(retryPause(String(RING_RETRY_MAX_PAUSE_MS / 1000))).toBe(RING_RETRY_MAX_PAUSE_MS);
    expect(retryPause(String(RING_RETRY_MAX_PAUSE_MS / 1000 + 1))).toBeNull();
    expect(retryPause("9".repeat(20))).toBeNull();
    for (const odd of ["Wed, 21 Oct 2026 07:28:00 GMT", "-1", "1.5", ""]) {
      expect(retryPause(odd), odd).toBe(RING_RETRY_PAUSE_MS);
    }
    // The pauses fit in the rider's 20-second wait, with time left for the worker to read the photo.
    expect(RING_RETRY_MAX_PAUSE_MS).toBeLessThanOrEqual(10_000);
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
