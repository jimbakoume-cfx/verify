import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyStorageError } from "./storage";
import { timeoutFetch } from "./timeoutFetch";

/** A fetch that never answers, but rejects like the real one when its signal aborts. */
function stalledFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort);
    });
}

describe("timeoutFetch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a request that never answers", async () => {
    vi.useFakeTimers();
    const pending = timeoutFetch(1000, stalledFetch())("https://storage.example/upload");
    const outcome = pending.then(
      () => "answered",
      (err: unknown) => (err as { name?: string }).name,
    );
    await vi.advanceTimersByTimeAsync(999);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe("AbortError");
  });

  it("passes the answer through and stops its timer", async () => {
    vi.useFakeTimers();
    const ok = new Response("{}", { status: 200 });
    const res = await timeoutFetch(1000, async () => ok)("https://storage.example/upload", { method: "PUT" });
    expect(res).toBe(ok);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still honours the caller's own signal, even one already aborted", async () => {
    const controller = new AbortController();
    const pending = timeoutFetch(60_000, stalledFetch())("https://storage.example/upload", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      timeoutFetch(60_000, stalledFetch())("https://storage.example/upload", { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("classifyStorageError after a timeout", () => {
  it("reports the abort as a transient timeout", () => {
    const result = classifyStorageError({
      message: "The operation was aborted.",
      originalError: { name: "AbortError" },
    });
    expect(result).not.toBe("already_stored");
    expect(result).toMatchObject({ code: "timeout" });
  });
});
