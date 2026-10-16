import { afterEach, describe, expect, it, vi } from "vitest";
import type { MrzExpectation } from "@verify/shared";
import { READER_LOAD_TIMEOUT_MS, type ReaderModule, createLazyMrzReader, unavailableRead } from "./lazyReader";
import { MRZ_MODELS, type MrzReadResult, type MrzReader } from "./types";

const EXPECTATION: MrzExpectation = { side: "document_front", format: "TD3", required: true };
const IMAGE = { width: 4, height: 2, data: new Uint8Array(8) };

const VALID: MrzReadResult = { ...unavailableRead("TD3"), status: "valid", ms: 210 };

function fakeReader() {
  return {
    warmUp: vi.fn<MrzReader["warmUp"]>(),
    read: vi.fn<MrzReader["read"]>(async () => VALID),
    dispose: vi.fn<MrzReader["dispose"]>(),
  };
}

function module(reader: MrzReader): ReaderModule {
  return { createMrzReader: () => reader };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createLazyMrzReader", () => {
  it("makes the real reader with the model it was given (M4), and names it when it cannot read", async () => {
    const real = fakeReader();
    const create = vi.fn<ReaderModule["createMrzReader"]>(() => real);
    const own = MRZ_MODELS["mrz-2"];
    const reader = createLazyMrzReader(async () => ({ createMrzReader: create }), READER_LOAD_TIMEOUT_MS, own);
    await reader.read(IMAGE, EXPECTATION);
    expect(create).toHaveBeenCalledWith({ model: own });
    reader.dispose();
    expect(await reader.read(IMAGE, EXPECTATION)).toEqual(unavailableRead("TD3", own.engine));
    expect(unavailableRead("TD3").engine).toBe(MRZ_MODELS["mrz-1"].engine);
  });

  it("loads the reader once, on the first warm-up, then reads with it", async () => {
    const real = fakeReader();
    const load = vi.fn(async () => module(real));
    const reader = createLazyMrzReader(load);
    expect(load).not.toHaveBeenCalled();

    reader.warmUp();
    reader.warmUp();
    const signal = new AbortController().signal;
    expect(await reader.read(IMAGE, EXPECTATION, { signal })).toBe(VALID);
    expect(load).toHaveBeenCalledTimes(1);
    expect(real.warmUp).toHaveBeenCalledTimes(2);
    expect(real.read).toHaveBeenCalledWith(IMAGE, EXPECTATION, { signal });
  });

  it("reads as unavailable when its code cannot be downloaded, and tries the download again later", async () => {
    const real = fakeReader();
    const load = vi
      .fn<() => Promise<ReaderModule>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
      .mockResolvedValue(module(real));
    const reader = createLazyMrzReader(load);

    expect(await reader.read(IMAGE, EXPECTATION)).toEqual(unavailableRead("TD3"));
    expect(await reader.read(IMAGE, EXPECTATION)).toBe(VALID);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives up on a download that stalls, reads as unavailable, and downloads again on the next read", async () => {
    vi.useFakeTimers();
    const real = fakeReader();
    const load = vi
      .fn<() => Promise<ReaderModule>>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue(module(real));
    const reader = createLazyMrzReader(load);
    reader.warmUp();

    const stalled = reader.read(IMAGE, EXPECTATION);
    await vi.advanceTimersByTimeAsync(READER_LOAD_TIMEOUT_MS - 1);
    let settled = false;
    void stalled.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stalled).toEqual(unavailableRead("TD3"));

    expect(await reader.read(IMAGE, EXPECTATION)).toBe(VALID);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("returns at once when a read is cancelled while the reader is still downloading", async () => {
    const real = fakeReader();
    let finish: (value: ReaderModule) => void = () => {};
    const load = vi.fn(() => new Promise<ReaderModule>((resolve) => (finish = resolve)));
    const reader = createLazyMrzReader(load);
    const controller = new AbortController();
    const read = reader.read(IMAGE, EXPECTATION, { signal: controller.signal });
    controller.abort();
    expect(await read).toEqual(unavailableRead("TD3"));
    expect(real.read).not.toHaveBeenCalled();

    // The download goes on, and the next read uses it.
    finish(module(real));
    expect(await reader.read(IMAGE, EXPECTATION)).toBe(VALID);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await reader.read(IMAGE, EXPECTATION, { signal: AbortSignal.abort() })).toEqual(unavailableRead("TD3"));
  });

  it("never rejects, even when the reader itself throws", async () => {
    const real = fakeReader();
    real.read.mockRejectedValue(new Error("out of memory"));
    const reader = createLazyMrzReader(async () => module(real));
    expect(await reader.read(IMAGE, { ...EXPECTATION, format: "TD1" })).toEqual(unavailableRead("TD1"));
  });

  it("stops the loaded reader on dispose, and does nothing afterwards", async () => {
    const real = fakeReader();
    const load = vi.fn(async () => module(real));
    const reader = createLazyMrzReader(load);
    reader.warmUp();
    await vi.waitFor(() => expect(real.warmUp).toHaveBeenCalled());

    reader.dispose();
    await vi.waitFor(() => expect(real.dispose).toHaveBeenCalledTimes(1));
    reader.warmUp();
    expect(await reader.read(IMAGE, EXPECTATION)).toEqual(unavailableRead("TD3"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(real.read).not.toHaveBeenCalled();
  });

  it("stops a reader that finishes loading after dispose", async () => {
    const real = fakeReader();
    let finish: (value: ReaderModule) => void = () => {};
    const reader = createLazyMrzReader(() => new Promise((resolve) => (finish = resolve)));
    reader.warmUp();
    reader.dispose();
    finish(module(real));
    await vi.waitFor(() => expect(real.dispose).toHaveBeenCalledTimes(1));
    expect(real.warmUp).not.toHaveBeenCalled();
  });
});
