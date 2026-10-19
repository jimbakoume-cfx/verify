import { describe, expect, it } from "vitest";
import { LIVENESS_ACTIONS, LIVENESS_LIMITS } from "../_shared/contract.ts";
import { cryptoRandomInt, drawChallenge, livenessFramePath, validateLivenessCapture } from "./liveness.ts";

const VID = "7d0c1a52-3f0e-4c8e-9a51-2b6f4f1d9e10";
const CID = "0d9f6a8e-1b7c-4c11-9b0e-6f2b8a2f4f10";

function body(frames = 13): Record<string, unknown> {
  return {
    challengeId: CID,
    code: "048213",
    stepStartsMs: [0, 1500, 4500, 7500],
    startedWithWarning: false,
    videoWidth: 480,
    videoHeight: 640,
    frames: Array.from({ length: frames }, (_, i) => ({
      index: i,
      path: livenessFramePath(VID, CID, i),
      sha256: "a".repeat(64),
      atMs: 900 + i * 700,
      step: i === 0 ? 0 : Math.min(3, Math.ceil(i / 4)),
    })),
  };
}

describe("cryptoRandomInt", () => {
  it("stays in range and skips the values that would bias the result", () => {
    const values = [0xffffffff, 7];
    let n = 0;
    const fill = (a: Uint32Array) => {
      a[0] = values[n++];
      return a;
    };
    // 2^32 - 1 is above the largest multiple of 10, so it is drawn again.
    expect(cryptoRandomInt(10, fill)).toBe(7);
    expect(n).toBe(2);
    for (let i = 0; i < 200; i++) {
      const v = cryptoRandomInt(5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
    }
    expect(() => cryptoRandomInt(0)).toThrow(RangeError);
  });
});

describe("drawChallenge", () => {
  it("draws distinct known actions and a 6-digit code, and differs between draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { actions, code } = drawChallenge();
      expect(actions).toHaveLength(LIVENESS_LIMITS.actionsPerChallenge);
      expect(new Set(actions).size).toBe(actions.length);
      for (const action of actions) expect(LIVENESS_ACTIONS).toContain(action);
      expect(code).toMatch(/^\d{6}$/);
      seen.add(`${actions.join()}|${code}`);
    }
    expect(seen.size).toBeGreaterThan(45);
  });

  it("reaches every action in every position", () => {
    const positions = Array.from({ length: 3 }, () => new Set<string>());
    for (let i = 0; i < 400; i++) drawChallenge().actions.forEach((a, p) => positions[p].add(a));
    for (const set of positions) expect(set.size).toBe(LIVENESS_ACTIONS.length);
  });
});

describe("livenessFramePath", () => {
  it("numbers the slots with two digits inside the session's folder", () => {
    expect(livenessFramePath(VID, CID, 3)).toBe(`${VID}/liveness-${CID}-03.jpg`);
    expect(livenessFramePath(VID, CID, 14)).toBe(`${VID}/liveness-${CID}-14.jpg`);
  });
});

describe("validateLivenessCapture", () => {
  it("returns a fresh request with only the known fields", () => {
    const given = body();
    const check = validateLivenessCapture(given);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.request).toEqual(given);
    expect(check.request.frames[0]).not.toBe((given.frames as unknown[])[0]);
  });

  it("lower-cases the challenge id", () => {
    const check = validateLivenessCapture({ ...body(), challengeId: CID.toUpperCase() });
    expect(check.ok && check.request.challengeId).toBe(CID);
  });

  it("accepts 8 to 15 frames", () => {
    expect(validateLivenessCapture(body(LIVENESS_LIMITS.minFrames)).ok).toBe(true);
    expect(validateLivenessCapture(body(LIVENESS_LIMITS.maxFrames)).ok).toBe(true);
  });

  const frame0 = (patch: Record<string, unknown>) => {
    const b = body();
    const frames = b.frames as Record<string, unknown>[];
    return { ...b, frames: [{ ...frames[0], ...patch }, ...frames.slice(1)] };
  };

  it.each<[string, Record<string, unknown>]>([
    ["an unknown field", { ...body(), extra: 1 }],
    ["no challenge id", { ...body(), challengeId: undefined }],
    ["a code with letters", { ...body(), code: "04821a" }],
    ["a 7-digit code", { ...body(), code: "0482130" }],
    ["a code as a number", { ...body(), code: 482130 }],
    ["a missing flag", { ...body(), startedWithWarning: "no" }],
    ["a negative width", { ...body(), videoWidth: -1 }],
    ["a fractional height", { ...body(), videoHeight: 1.5 }],
    ["too few step starts", { ...body(), stepStartsMs: [0, 1500, 4500] }],
    ["a first step start other than 0", { ...body(), stepStartsMs: [1, 1500, 4500, 7500] }],
    ["a step start past the limit", { ...body(), stepStartsMs: [0, 1500, 4500, LIVENESS_LIMITS.maxCaptureMs + 1] }],
    ["7 frames", body(7)],
    ["16 frames", body(16)],
    ["frames that are not a list", { ...body(), frames: {} }],
    ["a frame that is not an object", { ...body(), frames: ["x", ...(body().frames as unknown[]).slice(1)] }],
    ["a frame with an unknown field", frame0({ bytes: "x" })],
    ["a frame out of place", frame0({ index: 1 })],
    ["a frame without its path", frame0({ path: 5 })],
    ["a very long path", frame0({ path: "x".repeat(161) })],
    ["a short hash", frame0({ sha256: "a".repeat(63) })],
    ["an upper-case hash", frame0({ sha256: "A".repeat(64) })],
    ["a time past the limit", frame0({ atMs: LIVENESS_LIMITS.maxCaptureMs + 1 })],
    ["a fractional time", frame0({ atMs: 1.5 })],
    ["a negative step", frame0({ step: -1 })],
    ["a step past the actions", frame0({ step: 4 })],
  ])("refuses %s", (_label, given) => {
    const check = validateLivenessCapture(given);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).not.toContain("048213");
  });
});
