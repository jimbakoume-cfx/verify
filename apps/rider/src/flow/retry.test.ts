import { describe, expect, it, vi } from "vitest";
import { FlowError, isTransient, toFlowError } from "./errors";
import { UPLOAD_RETRY, backoffDelay, withRetry } from "./retry";

const noWait = () => Promise.resolve();

describe("backoffDelay", () => {
  it("doubles from the base delay and caps it", () => {
    const mid = () => 0.5; // no jitter
    expect(backoffDelay(1, UPLOAD_RETRY, mid)).toBe(1500);
    expect(backoffDelay(2, UPLOAD_RETRY, mid)).toBe(3000);
    expect(backoffDelay(3, UPLOAD_RETRY, mid)).toBe(6000);
    expect(backoffDelay(4, UPLOAD_RETRY, mid)).toBe(8000);
  });

  it("jitters by at most 25%", () => {
    expect(backoffDelay(1, UPLOAD_RETRY, () => 0)).toBe(1125);
    expect(backoffDelay(1, UPLOAD_RETRY, () => 0.999999)).toBe(1875);
  });
});

describe("withRetry", () => {
  const options = { policy: UPLOAD_RETRY, toError: toFlowError, shouldRetry: isTransient, sleep: noWait };

  it("returns the first success", async () => {
    const task = vi.fn().mockRejectedValueOnce(new FlowError("network")).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    await expect(withRetry(task, { ...options, onRetry, random: () => 0.5 })).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(2, expect.objectContaining({ code: "network" }), 1500);
  });

  it("gives up after three tries with the last error", async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(new FlowError("network"))
      .mockRejectedValueOnce(new FlowError("timeout"))
      .mockRejectedValueOnce(new FlowError("server_error", 503));
    await expect(withRetry(task, options)).rejects.toMatchObject({ code: "server_error" });
    expect(task).toHaveBeenCalledTimes(3);
    expect(task.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
  });

  it("does not retry a permanent error", async () => {
    const task = vi.fn().mockRejectedValue(new FlowError("too_many_uploads", 429));
    await expect(withRetry(task, options)).rejects.toMatchObject({ code: "too_many_uploads" });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("waits between attempts", async () => {
    const waits: number[] = [];
    const task = vi.fn().mockRejectedValue(new FlowError("network"));
    await expect(
      withRetry(task, { ...options, random: () => 0.5, sleep: async (ms) => void waits.push(ms) }),
    ).rejects.toBeInstanceOf(FlowError);
    expect(waits).toEqual([1500, 3000]);
  });
});
