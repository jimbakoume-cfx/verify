import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import {
  CAMERA_CONSTRAINTS,
  CAMERA_ERROR_KINDS,
  CameraError,
  cameraSupport,
  classifyCameraError,
  openCamera,
  stopStream,
} from "./camera";

const domError = (name: string) => Object.assign(new Error(name), { name });

describe("cameraSupport", () => {
  it("needs a secure page and getUserMedia", () => {
    expect(cameraSupport({ isSecureContext: false, mediaDevices: undefined })).toBe("insecure");
    expect(cameraSupport({ isSecureContext: true, mediaDevices: undefined })).toBe("unsupported");
    expect(cameraSupport({ isSecureContext: true, mediaDevices: { getUserMedia: () => undefined } })).toBeNull();
  });
});

describe("classifyCameraError", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["PermissionDeniedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "no_camera"],
    ["OverconstrainedError", "no_camera"],
    ["NotReadableError", "busy"],
    ["AbortError", "busy"],
    ["SomethingElse", "unknown"],
  ])("%s -> %s", (name, kind) => {
    expect(classifyCameraError(domError(name))).toBe(kind);
  });

  it("blames the insecure page for a SecurityError there", () => {
    expect(classifyCameraError(domError("SecurityError"), false)).toBe("insecure");
  });

  it("handles non-errors", () => {
    expect(classifyCameraError("oops")).toBe("unknown");
    expect(classifyCameraError(new CameraError("busy"))).toBe("busy");
  });

  it("has a French and English title and message for every kind", () => {
    for (const kind of CAMERA_ERROR_KINDS) {
      for (const locale of [fr, en]) {
        const camera = locale.camera as Record<string, string>;
        expect(camera[kind]).toBeTruthy();
        expect(camera[`${kind}Title`]).toBeTruthy();
      }
    }
  });
});

function fakeNavigator(getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>) {
  return { mediaDevices: { getUserMedia: vi.fn(getUserMedia) } } as unknown as Navigator & {
    mediaDevices: { getUserMedia: ReturnType<typeof vi.fn> };
  };
}

describe("openCamera", () => {
  const stream = {} as MediaStream;

  it("asks for the back camera without audio", async () => {
    const nav = fakeNavigator(async () => stream);
    await expect(openCamera(nav, true)).resolves.toBe(stream);
    expect(nav.mediaDevices.getUserMedia).toHaveBeenCalledWith(CAMERA_CONSTRAINTS);
    expect(CAMERA_CONSTRAINTS).toEqual({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  });

  it("refuses on an insecure page without prompting", async () => {
    const nav = fakeNavigator(async () => stream);
    await expect(openCamera(nav, false)).rejects.toMatchObject({ kind: "insecure" });
    expect(nav.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("reports a denied permission", async () => {
    const nav = fakeNavigator(async () => {
      throw domError("NotAllowedError");
    });
    await expect(openCamera(nav, true)).rejects.toMatchObject({ kind: "denied" });
  });

  it("falls back to any camera when the constraints cannot be met", async () => {
    const nav = fakeNavigator(async (c) => {
      if (c.video !== true) throw domError("OverconstrainedError");
      return stream;
    });
    await expect(openCamera(nav, true)).resolves.toBe(stream);
    expect(nav.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  });
});

describe("stopStream", () => {
  it("stops every track and tolerates no stream", () => {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    stopStream({ getTracks: () => tracks } as unknown as MediaStream);
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(() => stopStream(null)).not.toThrow();
  });
});
