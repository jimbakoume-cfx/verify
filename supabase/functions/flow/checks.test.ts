import { describe, expect, it } from "vitest";
import { SERVER_RETAKES_PER_SIDE } from "../_shared/contract.ts";
import { type CheckStateRow, flowChecks } from "./checks.ts";

let n = 0;
function row(overrides: Partial<CheckStateRow> = {}): CheckStateRow {
  n++;
  return {
    captureId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "document_front",
    live: true,
    createdAt: new Date(Date.UTC(2026, 9, 14, 9, 0, n)).toISOString(),
    jobStatus: "pending",
    jobError: null,
    ringFailed: false,
    qualityVerdict: null,
    phoneMrzPass: null,
    ...overrides,
  };
}

describe("flowChecks: the state of one side", () => {
  it.each<[string, Partial<CheckStateRow>, string, string | null]>([
    ["waiting for the worker", { jobStatus: "pending" }, "pending", null],
    ["being processed", { jobStatus: "claimed" }, "pending", null],
    ["the ring failed while it waits", { jobStatus: "pending", ringFailed: true }, "unchecked", null],
    ["claimed after a failed ring", { jobStatus: "claimed", ringFailed: true }, "pending", null],
    ["checked: ok", { jobStatus: "done", qualityVerdict: "ok" }, "ok", null],
    ["checked: poor (flagged, never retaken)", { jobStatus: "done", qualityVerdict: "poor" }, "ok", null],
    ["checked: no document", { jobStatus: "done", qualityVerdict: "no_document" }, "retake", "no_document"],
    ["checked: unreadable", { jobStatus: "done", qualityVerdict: "unreadable" }, "retake", "unreadable"],
    ["unreadable, but the phone read every check digit", { jobStatus: "done", qualityVerdict: "unreadable", phoneMrzPass: true }, "ok", null],
    ["unreadable, the phone's read was flagged", { jobStatus: "done", qualityVerdict: "unreadable", phoneMrzPass: false }, "retake", "unreadable"],
    ["done without a verdict", { jobStatus: "done", qualityVerdict: null }, "ok", null],
    ["over budget", { jobStatus: "failed", jobError: "budget" }, "unchecked", null],
    ["not eligible", { jobStatus: "failed", jobError: "ineligible" }, "unchecked", null],
    ["three attempts", { jobStatus: "failed", jobError: "attempts" }, "unchecked", null],
    ["a photo from before M3 (no job)", { jobStatus: null }, "unchecked", null],
  ])("%s -> %s", (_label, overrides, state, reason) => {
    const newest = row(overrides);
    expect(flowChecks(["document_front"], [newest])).toEqual({
      done: state !== "pending",
      sides: [{ kind: "document_front", captureId: newest.captureId, state, reason }],
    });
  });
});

describe("flowChecks: the case", () => {
  it("follows the newest live photo of each required side, in the required order", () => {
    const oldFront = row({ live: false, jobStatus: "superseded" });
    const back = row({ kind: "document_back", jobStatus: "done", qualityVerdict: "ok" });
    const front = row({ jobStatus: "claimed" });
    const selfie = row({ kind: "selfie", jobStatus: null });
    expect(flowChecks(["document_front", "document_back"], [oldFront, back, front, selfie])).toEqual({
      done: false,
      sides: [
        { kind: "document_front", captureId: front.captureId, state: "pending", reason: null },
        { kind: "document_back", captureId: back.captureId, state: "ok", reason: null },
      ],
    });
  });

  it("is null when a required side has no live photo", () => {
    expect(flowChecks(["document_front", "document_back"], [row()])).toBeNull();
    expect(flowChecks(["document_front"], [row({ live: false })])).toBeNull();
    expect(flowChecks(["document_front"], [])).toBeNull();
  });

  it(`allows ${SERVER_RETAKES_PER_SIDE} server retake per side, counted from the replaced photos`, () => {
    const first = row({ live: false, jobStatus: "done", qualityVerdict: "no_document" });
    const second = row({ jobStatus: "done", qualityVerdict: "unreadable" });
    expect(flowChecks(["document_front"], [first, second])?.sides[0]).toMatchObject({ state: "ok", reason: null });
    // A photo replaced for another reason does not use up the retake.
    const replacedOk = row({ live: false, jobStatus: "done", qualityVerdict: "ok" });
    const third = row({ jobStatus: "done", qualityVerdict: "unreadable" });
    expect(flowChecks(["document_front"], [replacedOk, third])?.sides[0]).toMatchObject({ state: "retake" });
    // The other side's retakes do not count either.
    const backRetaken = row({ kind: "document_back", live: false, jobStatus: "done", qualityVerdict: "no_document" });
    const front = row({ jobStatus: "done", qualityVerdict: "no_document" });
    const back = row({ kind: "document_back", jobStatus: "done", qualityVerdict: "ok" });
    expect(flowChecks(["document_front", "document_back"], [backRetaken, front, back])?.sides.map((s) => s.state))
      .toEqual(["retake", "ok"]);
  });

  it("is done when no side is pending, whatever the states", () => {
    const front = row({ jobStatus: "done", qualityVerdict: "no_document" });
    const back = row({ kind: "document_back", jobStatus: "failed", jobError: "budget" });
    expect(flowChecks(["document_front", "document_back"], [front, back])?.done).toBe(true);
  });
});
