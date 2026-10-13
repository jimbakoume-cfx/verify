import { describe, expect, it, vi } from "vitest";
import { type PhotoSourceDeps, openPhotoSource } from "./photo";

const SIGNED = "https://abc.supabase.co/storage/v1/object/sign/id-captures/x.jpg?token=t";

function deps(response: Response = new Response(new Blob([new Uint8Array([0xff, 0xd8])]), { status: 200 })) {
  const revoked: string[] = [];
  const d: PhotoSourceDeps = {
    fetch: vi.fn(async () => response),
    createObjectURL: vi.fn(() => "blob:photo-1"),
    revokeObjectURL: (url) => void revoked.push(url),
  };
  return { d, revoked };
}

describe("openPhotoSource", () => {
  it("fetches past the HTTP cache, without cookies or referrer, and shows a blob: URL", async () => {
    const { d } = deps();
    const source = openPhotoSource(SIGNED, d);
    await expect(source.ready).resolves.toBe("blob:photo-1");
    expect(d.fetch).toHaveBeenCalledWith(
      SIGNED,
      expect.objectContaining({ cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }),
    );
  });

  it("frees the image when closed (link expired, photo hidden, page left)", async () => {
    const { d, revoked } = deps();
    const source = openPhotoSource(SIGNED, d);
    await source.ready;
    source.close();
    expect(revoked).toEqual(["blob:photo-1"]);
    source.close();
    expect(revoked).toEqual(["blob:photo-1"]);
  });

  it("cancels a download still running when closed, and keeps nothing", async () => {
    let signal: AbortSignal | undefined;
    const { d, revoked } = deps();
    d.fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const source = openPhotoSource(SIGNED, d);
    source.close();
    await expect(source.ready).rejects.toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
    expect(d.createObjectURL).not.toHaveBeenCalled();
    expect(revoked).toEqual([]);
  });

  it("fails on an error answer (e.g. the link expired)", async () => {
    const { d } = deps(new Response("{}", { status: 400 }));
    await expect(openPhotoSource(SIGNED, d).ready).rejects.toThrow(/HTTP 400/);
    expect(d.createObjectURL).not.toHaveBeenCalled();
  });

  it("shows an inline preview image as is", async () => {
    const { d } = deps();
    await expect(openPhotoSource("data:image/svg+xml,<svg/>", d).ready).resolves.toBe("data:image/svg+xml,<svg/>");
    expect(d.fetch).not.toHaveBeenCalled();
  });
});
