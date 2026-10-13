import { describe, expect, it } from "vitest";
import { AutoCapture } from "./autoCapture";
import { DEFAULT_THRESHOLDS } from "./thresholds";

const good = { ok: true };
const bad = { ok: false };

describe("AutoCapture", () => {
  it("fires once after the required number of good frames in a row", () => {
    const auto = new AutoCapture(3);
    expect([auto.push(good), auto.push(good)]).toEqual(["wait", "wait"]);
    expect(auto.push(good)).toBe("capture");
    expect(auto.fired).toBe(true);
    // Quiet afterwards, however many good frames follow.
    for (let i = 0; i < 10; i++) expect(auto.push(good)).toBe("wait");
  });

  it("starts the count again after a bad frame", () => {
    const auto = new AutoCapture(3);
    auto.push(good);
    auto.push(good);
    expect(auto.push(bad)).toBe("wait");
    expect(auto.progress).toBe(0);
    auto.push(good);
    auto.push(good);
    expect(auto.push(good)).toBe("capture");
  });

  it("can fire again after reset", () => {
    const auto = new AutoCapture(2);
    auto.push(good);
    expect(auto.push(good)).toBe("capture");
    auto.reset();
    expect(auto.fired).toBe(false);
    expect(auto.push(good)).toBe("wait");
    expect(auto.push(good)).toBe("capture");
  });

  it("reports progress for the UI", () => {
    const auto = new AutoCapture(4);
    expect(auto.progress).toBe(0);
    auto.push(good);
    expect(auto.progress).toBe(0.25);
    auto.push(good);
    auto.push(good);
    auto.push(good);
    expect(auto.progress).toBe(1);
  });

  it("defaults to the threshold's frame count and validates it", () => {
    expect(new AutoCapture().required).toBe(DEFAULT_THRESHOLDS.stableFramesRequired);
    const once = new AutoCapture(1);
    expect(once.push(good)).toBe("capture");
    expect(() => new AutoCapture(0)).toThrow(RangeError);
    expect(() => new AutoCapture(2.5)).toThrow(RangeError);
  });
});
