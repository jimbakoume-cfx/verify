import { describe, expect, it, vi } from "vitest";
import { LIVENESS_LIMITS, type LivenessChallengeResponse } from "@verify/shared";
import { FlowError } from "../flow/errors";
import { ovalRect } from "./frames";
import { LIVENESS_TIMING, frameByteTarget, frameSchedule, stepAt } from "./schedule";
import { type LivenessService, type TakenFrame, captureReport, recoveryFor, sendFaceCheck } from "./send";

const CHALLENGE: LivenessChallengeResponse = {
  challengeId: "0d9f6a8e-1b7c-4c11-9b0e-6f2b8a2f4f10",
  actions: ["blink", "turn_left", "smile"],
  code: "482913",
  expiresAt: "2026-10-19T10:10:00Z",
  bucket: "id-captures",
  uploads: Array.from({ length: 15 }, (_, i) => ({ path: `v/liveness-c-${String(i).padStart(2, "0")}.jpg`, token: `t${i}` })),
};

const META = { stepStartsMs: [0, 1500.4, 4500, 7500], startedWithWarning: false, videoWidth: 480, videoHeight: 640 };

function frames(n = 13): TakenFrame[] {
  return frameSchedule(3).frames.slice(0, n).map((f, i) => ({
    blob: new Blob([new Uint8Array(100 + i)]),
    sha256: String(i).padStart(64, "0"),
    atMs: f.atMs + 0.6,
    step: f.step,
  }));
}

describe("frameSchedule", () => {
  it("plans 1 frame before the actions and 4 during each, inside their steps", () => {
    const plan = frameSchedule(3);
    expect(plan.frames).toHaveLength(13);
    expect(plan.frames.length).toBeGreaterThanOrEqual(LIVENESS_LIMITS.minFrames);
    expect(plan.frames.length).toBeLessThanOrEqual(LIVENESS_LIMITS.maxFrames);
    expect(plan.stepStartsMs).toEqual([0, 1500, 4500, 7500]);
    expect(plan.totalMs).toBe(10_500);
    expect(plan.frames.map((f) => f.atMs)).toEqual([900, 2100, 2700, 3300, 3900, 5100, 5700, 6300, 6900, 8100, 8700, 9300, 9900]);
    for (const frame of plan.frames) {
      expect(frame.atMs).toBeGreaterThanOrEqual(plan.stepStartsMs[frame.step]);
      expect(frame.atMs).toBeLessThan(plan.stepStartsMs[frame.step + 1] ?? plan.totalMs);
      expect(stepAt(plan, frame.atMs)).toBe(frame.step);
    }
    // At least the server's minimum per action, and a time per action the server finds plausible.
    for (let step = 1; step <= 3; step++) {
      expect(plan.frames.filter((f) => f.step === step).length).toBeGreaterThanOrEqual(LIVENESS_LIMITS.minFramesPerAction);
    }
    expect(LIVENESS_TIMING.actionMs).toBeGreaterThanOrEqual(1000);
  });
});

describe("frameByteTarget", () => {
  it("keeps every frame together under the server's total, with room to spare", () => {
    expect(frameByteTarget(13) * 13).toBeLessThan(LIVENESS_LIMITS.maxTotalBytes);
    expect(frameByteTarget(15) * 15).toBeLessThan(LIVENESS_LIMITS.maxTotalBytes);
    expect(frameByteTarget(1)).toBeLessThanOrEqual(LIVENESS_LIMITS.maxFrameBytes);
    expect(frameByteTarget(13)).toBe(40_000);
  });
});

describe("ovalRect", () => {
  it("is a centred 3:4 oval that fits a phone screen", () => {
    const oval = ovalRect({ width: 390, height: 844 });
    expect(oval.width / oval.height).toBeCloseTo(0.75);
    expect(oval.x + oval.width / 2).toBeCloseTo(195);
    expect(oval.y).toBeGreaterThan(0);
    expect(oval.y + oval.height).toBeLessThan(844);
    // Sideways, the height limits it.
    const wide = ovalRect({ width: 844, height: 390 });
    expect(wide.height).toBeLessThanOrEqual(390);
  });
});

describe("captureReport", () => {
  it("fills each frame's slot, rounds the times, and carries the challenge's code", () => {
    const report = captureReport(CHALLENGE, frames(), META);
    expect(report.challengeId).toBe(CHALLENGE.challengeId);
    expect(report.code).toBe("482913");
    expect(report.frames).toHaveLength(13);
    expect(report.frames[2]).toEqual({ index: 2, path: CHALLENGE.uploads[2].path, sha256: frames()[2].sha256, atMs: 2701, step: 1 });
    expect(report.stepStartsMs).toEqual([0, 1500, 4500, 7500]);
    expect(Object.keys(report).sort()).toEqual(
      ["challengeId", "code", "frames", "startedWithWarning", "stepStartsMs", "videoHeight", "videoWidth"],
    );
  });
});

function service(overrides: Partial<LivenessService> = {}): LivenessService & { uploads: string[]; records: unknown[] } {
  const uploads: string[] = [];
  const records: unknown[] = [];
  return {
    uploads,
    records,
    challenge: async () => CHALLENGE,
    upload: async (target) => {
      uploads.push(target.path);
    },
    record: async (body) => {
      records.push(body);
      return { recorded: true };
    },
    ...overrides,
  };
}

const NO_WAIT = { sleep: async () => {} };

describe("sendFaceCheck", () => {
  it("uploads every frame into its slot, then reports them once, with progress", async () => {
    const s = service();
    const progress = vi.fn();
    expect(await sendFaceCheck(s, CHALLENGE, frames(), META, { ...NO_WAIT, onProgress: progress })).toEqual({ ok: true });
    expect(s.uploads.sort()).toEqual(CHALLENGE.uploads.slice(0, 13).map((u) => u.path).sort());
    expect(s.records).toHaveLength(1);
    expect(progress).toHaveBeenLastCalledWith(14, 14);
    expect(progress).toHaveBeenCalledTimes(15);
  });

  it("sends at most 3 frames at a time", async () => {
    let running = 0;
    let peak = 0;
    const s = service({
      upload: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 1));
        running--;
      },
    });
    await sendFaceCheck(s, CHALLENGE, frames(), META, NO_WAIT);
    expect(peak).toBe(3);
  });

  it("retries a frame that failed for a moment, then goes on", async () => {
    let failures = 2;
    const s = service({
      upload: async () => {
        if (failures-- > 0) throw new FlowError("network");
      },
    });
    expect(await sendFaceCheck(s, CHALLENGE, frames(), META, NO_WAIT)).toEqual({ ok: true });
  });

  it("stops at the first refusal, with its code", async () => {
    const s = service({
      record: async () => {
        throw new FlowError("challenge_expired", 410);
      },
    });
    expect(await sendFaceCheck(s, CHALLENGE, frames(), META, NO_WAIT)).toEqual({ ok: false, error: "challenge_expired" });
  });

  it("gives up after the retries on a network that stays down", async () => {
    const upload = vi.fn(async () => {
      throw new FlowError("network");
    });
    expect(await sendFaceCheck(service({ upload }), CHALLENGE, frames(8), META, { ...NO_WAIT, concurrency: 1 })).toEqual({
      ok: false,
      error: "network",
    });
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("stops the other frames once one has failed for good, and reports no progress after it", async () => {
    let calls = 0;
    const progress = vi.fn();
    const s = service({
      upload: async (target) => {
        calls++;
        if (target.path.endsWith("-00.jpg")) throw new FlowError("network");
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    const outcome = await sendFaceCheck(s, CHALLENGE, frames(), META, { ...NO_WAIT, onProgress: progress });
    expect(outcome).toEqual({ ok: false, error: "network" });
    await new Promise((r) => setTimeout(r, 30));
    // Frame 0 tried 3 times; the two other workers finish the frame they hold and start no other.
    expect(calls).toBeLessThanOrEqual(3 + 2);
    expect(progress.mock.calls.every(([done]) => done === 0)).toBe(true);
    expect(s.records).toHaveLength(0);
  });

  it("refuses more frames than the challenge has slots", async () => {
    const tooMany = [...frames(), ...frames()];
    expect(await sendFaceCheck(service(), CHALLENGE, tooMany, META, NO_WAIT)).toEqual({ ok: false, error: "unexpected" });
  });
});

describe("recoveryFor", () => {
  it.each([
    ["network", "resend"],
    ["timeout", "resend"],
    ["server_error", "resend"],
    ["storage_failed", "resend"],
    ["challenge_expired", "restart"],
    ["challenge_used", "restart"],
    ["invalid_liveness", "restart"],
    ["invalid_image", "restart"],
    ["upload_missing", "restart"],
    ["interrupted", "restart"],
    ["too_many_challenges", "stop"],
  ] as const)("%s -> %s", (error, expected) => {
    expect(recoveryFor(error)).toBe(expected);
  });
});
