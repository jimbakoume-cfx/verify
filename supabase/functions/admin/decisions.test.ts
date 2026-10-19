// deno-lint-ignore-file require-await
// M8 routes of the admin function: POST /decisions and POST /thresholds, with in-memory fakes that follow
// staff_decide and staff_create_threshold_version (supabase/migrations/20261019000000_m8_decisions.sql;
// the database itself is tested in supabase/tests/60_m8_test.sql).
import { describe, expect, it, vi } from "vitest";
import type { FunctionConfig } from "../_shared/config.ts";
import type { DecisionOutcome } from "../_shared/contract.ts";
import { DEFAULT_THRESHOLD_CONFIG, type ThresholdConfig } from "../_shared/risk.ts";
import { ALLOWED_ORIGIN, makeRequest, readJson } from "../_shared/test-helpers.ts";
import { type DecideResult, type DecisionRepo, normaliseNote, type ThresholdResult } from "./decisions.ts";
import { type AdminRepo, createAdminHandler, type StaffRole } from "./handler.ts";
import { toDecideResult, toThresholdResult } from "./repo.ts";

const CASE = "83000000-0000-4000-8000-000000000001";
const OTHER_CASE = "83000000-0000-4000-8000-000000000002";

interface FakeCase {
  status: "submitted" | "in_progress" | "approved" | "rejected";
  recommendation: DecisionOutcome | null;
  hardFlags: string[];
  thresholdVersion: number | null;
}

/** staff_decide and staff_create_threshold_version, reduced to their rules. */
class FakeDecisions implements DecisionRepo {
  cases = new Map<string, FakeCase>();
  reasonCodes = new Set(["DOC_INVALID", "DOC_EXPIRED", "OTHER"]);
  versions: { version: number; config: ThresholdConfig; note: string; createdBy: string | null }[] = [
    { version: 2, config: DEFAULT_THRESHOLD_CONFIG, note: "M8", createdBy: null },
  ];
  decideCalls: Parameters<DecisionRepo["decide"]>[0][] = [];
  thresholdCalls: Parameters<DecisionRepo["createThresholdVersion"]>[0][] = [];
  /** Forces an answer, e.g. "forbidden" (the database refused the staff member). */
  override: DecideResult | ThresholdResult | null = null;
  fail = false;

  async decide(input: Parameters<DecisionRepo["decide"]>[0]): Promise<DecideResult> {
    this.decideCalls.push(input);
    if (this.fail) throw new Error(`database down while deciding with note ${input.note}`);
    if (this.override) return this.override as DecideResult;
    if (input.outcome === "reject" ? !this.reasonCodes.has(input.reasonCode ?? "") : input.reasonCode !== null) {
      return { result: "invalid_reason" };
    }
    const c = this.cases.get(input.verificationId);
    if (!c) return { result: "not_found" };
    if (c.status === "approved" || c.status === "rejected") return { result: "already_decided" };
    if (c.status !== "submitted") return { result: "not_submitted" };
    const against = c.recommendation !== null && c.recommendation !== "review" && c.recommendation !== input.outcome;
    if (input.note === null && (c.recommendation === null || against || (input.outcome === "approve" && c.hardFlags.length > 0))) {
      return { result: "note_required" };
    }
    c.status = input.outcome === "approve" ? "approved" : "rejected";
    return {
      result: "ok",
      decisionId: "d0000000-0000-4000-8000-000000000001",
      status: c.status,
      recommendation: c.recommendation,
      agreesWithRecommendation: c.recommendation === "approve" || c.recommendation === "reject"
        ? c.recommendation === input.outcome
        : null,
      thresholdVersion: c.thresholdVersion,
    };
  }

  async createThresholdVersion(input: Parameters<DecisionRepo["createThresholdVersion"]>[0]): Promise<ThresholdResult> {
    this.thresholdCalls.push(input);
    if (this.override) return this.override as ThresholdResult;
    const active = this.versions[this.versions.length - 1];
    if (input.baseVersion !== active.version) return { result: "stale", version: active.version };
    if (JSON.stringify(input.config) === JSON.stringify(active.config)) return { result: "unchanged" };
    const version = active.version + 1;
    this.versions.push({ version, config: input.config as unknown as ThresholdConfig, note: input.note, createdBy: input.actorId });
    return { result: "created", version, rescored: [...this.cases.values()].filter((c) => c.status === "submitted").length };
  }
}

const notUsed = () => Promise.reject(new Error("not used by the M8 routes"));

function setup() {
  const profiles = new Map<string, { role: StaffRole; active: boolean }>();
  const tokens = new Map<string, string>();
  const assignments: { verificationId: string; userId: string }[] = [];
  const repo: AdminRepo = {
    inviteVerify: notUsed,
    findAuthUser: notUsed,
    inviteAccept: notUsed,
    getStaffProfile: async (userId) => profiles.get(userId) ?? null,
    ensureApiClient: notUsed,
    createApplicant: notUsed,
    createVerification: notUsed,
    getCapture: notUsed,
    isAssignedReviewer: async (verificationId, userId) =>
      assignments.some((a) => a.verificationId === verificationId && a.userId === userId),
    verificationExists: async (id) => decisions.cases.has(id),
    readDocumentData: notUsed,
    audit: notUsed,
  };
  const decisions = new FakeDecisions();
  decisions.cases.set(CASE, { status: "submitted", recommendation: "reject", hardFlags: [], thresholdVersion: 3 });
  decisions.cases.set(OTHER_CASE, { status: "submitted", recommendation: "review", hardFlags: ["document_expired"], thresholdVersion: 3 });
  const log = { error: vi.fn() };
  const config: FunctionConfig = {
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
    riderAppUrl: "https://rider.example",
    testSessionTtlMinutes: 30,
    workerRingUrl: null,
  };
  const handler = createAdminHandler({
    repo,
    decisions,
    auth: {
      getUserId: async (token) => tokens.get(token) ?? null,
      createUser: notUsed,
      setPassword: notUsed,
    },
    storage: { createSignedUrl: notUsed },
    config,
    log,
  });

  function staff(role: StaffRole | null, { active = true } = {}) {
    const id = crypto.randomUUID();
    const token = `eyJ.${id}.sig`;
    tokens.set(token, id);
    if (role) profiles.set(id, { role, active });
    return { id, token };
  }

  function post(path: string, body: unknown, token?: string) {
    return handler(makeRequest(`https://ref.supabase.co/admin${path}`, {
      body,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }));
  }

  return { decisions, assignments, log, staff, post };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await readJson(res)).toEqual({ error: { code, message: expect.any(String) } });
}

// ---------------------------------------------------------------------------
// POST /decisions
// ---------------------------------------------------------------------------
describe("POST /decisions", () => {
  const approve = { verificationId: CASE, outcome: "approve", reasonCode: null, note: "Checked the photo: the OCR misread the name." };

  it("needs a signed-in, active staff member", async () => {
    const { post, staff } = setup();
    await expectError(await post("/decisions", approve), 401, "unauthorized");
    await expectError(await post("/decisions", approve, staff(null).token), 403, "forbidden");
    await expectError(await post("/decisions", approve, staff("supervisor", { active: false }).token), 403, "forbidden");
  });

  it("refuses admins: they have no routine access to cases", async () => {
    const { post, staff, decisions } = setup();
    await expectError(await post("/decisions", approve, staff("admin").token), 403, "forbidden_role");
    expect(decisions.decideCalls).toEqual([]);
  });

  it.each([
    ["no case id", { ...approve, verificationId: "nope" }],
    ["an unknown outcome", { ...approve, outcome: "review" }],
    ["a reason code of the wrong shape", { ...approve, outcome: "reject", reasonCode: "doc invalid" }],
    ["a note that is not text", { ...approve, note: 42 }],
    ["a note over 1000 characters", { ...approve, note: "x".repeat(1001) }],
    ["a note with control characters", { ...approve, note: "ok\u0000then" }],
  ])("%s -> 400 bad_request", async (_label, body) => {
    const { post, staff, decisions } = setup();
    await expectError(await post("/decisions", body, staff("supervisor").token), 400, "bad_request");
    expect(decisions.decideCalls).toEqual([]);
  });

  it("asks a reason of a reject, and none of an approval (422 invalid_reason)", async () => {
    const { post, staff } = setup();
    const { token } = staff("supervisor");
    await expectError(await post("/decisions", { ...approve, outcome: "reject", reasonCode: null }, token), 422, "invalid_reason");
    await expectError(await post("/decisions", { ...approve, reasonCode: "DOC_INVALID" }, token), 422, "invalid_reason");
    await expectError(await post("/decisions", { ...approve, outcome: "reject", reasonCode: "NOT_A_CODE" }, token), 422, "invalid_reason");
  });

  it("answers 404 for an unknown case, and for a case not assigned to the reviewer", async () => {
    const { post, staff, decisions } = setup();
    await expectError(await post("/decisions", { ...approve, verificationId: "83000000-0000-4000-8000-0000000000ff" }, staff("supervisor").token), 404, "not_found");
    await expectError(await post("/decisions", approve, staff("reviewer").token), 404, "not_found");
    expect(decisions.decideCalls).toEqual([]);
  });

  it("records a supervisor's decision against the recommendation, with the note trimmed", async () => {
    const { post, staff, decisions } = setup();
    const supervisor = staff("supervisor");
    const res = await post("/decisions", { ...approve, verificationId: CASE.toUpperCase(), note: `  ${approve.note}  ` }, supervisor.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(res)).toEqual({
      decisionId: "d0000000-0000-4000-8000-000000000001",
      status: "approved",
      recommendation: "reject",
      agreesWithRecommendation: false,
      thresholdVersion: 3,
    });
    expect(decisions.decideCalls).toEqual([{
      verificationId: CASE,
      actorId: supervisor.id,
      role: "supervisor",
      outcome: "approve",
      reasonCode: null,
      note: approve.note,
    }]);
  });

  it("lets the assigned reviewer decide", async () => {
    const { post, staff, assignments } = setup();
    const reviewer = staff("reviewer");
    assignments.push({ verificationId: CASE, userId: reviewer.id });
    const res = await post("/decisions", { verificationId: CASE, outcome: "reject", reasonCode: "DOC_INVALID" }, reviewer.token);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ status: "rejected", agreesWithRecommendation: true });
  });

  it("needs a note against the recommendation and to approve a hard flag (422 note_required)", async () => {
    const { post, staff } = setup();
    const { token } = staff("supervisor");
    await expectError(await post("/decisions", { ...approve, note: "   " }, token), 422, "note_required");
    await expectError(await post("/decisions", { ...approve, verificationId: OTHER_CASE, note: null }, token), 422, "note_required");
  });

  it("refuses a second decision and an open case (409)", async () => {
    const { post, staff, decisions } = setup();
    const { token } = staff("supervisor");
    expect((await post("/decisions", approve, token)).status).toBe(200);
    await expectError(await post("/decisions", approve, token), 409, "already_decided");
    decisions.cases.get(OTHER_CASE)!.status = "in_progress";
    await expectError(await post("/decisions", { ...approve, verificationId: OTHER_CASE }, token), 409, "not_submitted");
  });

  it("answers 403 when the database refuses the staff member (role or assignment changed meanwhile)", async () => {
    const { post, staff, decisions } = setup();
    decisions.override = { result: "forbidden" };
    await expectError(await post("/decisions", approve, staff("supervisor").token), 403, "forbidden_role");
  });

  it("never logs the note when the database fails", async () => {
    const { post, staff, decisions, log } = setup();
    decisions.fail = true;
    await expectError(await post("/decisions", approve, staff("supervisor").token), 500, "server_error");
    expect(log.error).toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("OCR misread");
  });
});

// ---------------------------------------------------------------------------
// POST /thresholds
// ---------------------------------------------------------------------------
describe("POST /thresholds", () => {
  const lower = { ...structuredClone(DEFAULT_THRESHOLD_CONFIG), rejectMin: 0.5 };
  const request = { baseVersion: 2, config: lower, note: "Lower the reject cut-off for the PM test" };

  it("is for admins only", async () => {
    const { post, staff, decisions } = setup();
    await expectError(await post("/thresholds", request), 401, "unauthorized");
    for (const role of ["reviewer", "supervisor"] as const) {
      await expectError(await post("/thresholds", request, staff(role).token), 403, "forbidden_role");
    }
    await expectError(await post("/thresholds", request, staff("admin", { active: false }).token), 403, "forbidden");
    expect(decisions.thresholdCalls).toEqual([]);
  });

  it("creates the next version, active at once, and says how many cases were assessed again", async () => {
    const { post, staff, decisions } = setup();
    const admin = staff("admin");
    const res = await post("/thresholds", request, admin.token);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ version: 3, rescored: 2 });
    expect(decisions.thresholdCalls).toEqual([{ ...request, actorId: admin.id }]);
  });

  it.each([
    ["no base version", { ...request, baseVersion: undefined }],
    ["a base version that is not a number", { ...request, baseVersion: "2" }],
    ["a configuration that is not an object", { ...request, config: [] }],
    ["crossed cut-offs", { ...request, config: { ...lower, approveMax: 0.6 } }],
    ["a mandatory hard flag removed", { ...request, config: { ...lower, hardFlags: ["document_expired"] } }],
    ["an unknown key", { ...request, config: { ...lower, autoApproveEverything: true } }],
    ["no reason", { ...request, note: undefined }],
    ["a reason too short", { ...request, note: " ok " }],
    ["a reason too long", { ...request, note: "x".repeat(501) }],
  ])("%s -> 400 bad_request, before the database", async (_label, body) => {
    const { post, staff, decisions } = setup();
    await expectError(await post("/thresholds", body, staff("admin").token), 400, "bad_request");
    expect(decisions.thresholdCalls).toEqual([]);
  });

  it("names the configuration errors (codes only) in the message", async () => {
    const { post, staff } = setup();
    const res = await post("/thresholds", { ...request, config: { ...lower, approveMax: 0.6 } }, staff("admin").token);
    expect(((await readJson(res)).error as { message: string }).message).toContain("rejectMin:order");
  });

  it("refuses a version edited from an old base (409 stale_version) and a version with no change (400)", async () => {
    const { post, staff } = setup();
    const { token } = staff("admin");
    expect((await post("/thresholds", request, token)).status).toBe(200);
    await expectError(await post("/thresholds", request, token), 409, "stale_version");
    await expectError(await post("/thresholds", { ...request, baseVersion: 3 }, token), 400, "bad_request");
  });

  it("maps the database's own refusals", async () => {
    const { post, staff, decisions } = setup();
    const { token } = staff("admin");
    decisions.override = { result: "invalid", errors: ["rejectMin:order"] };
    await expectError(await post("/thresholds", request, token), 400, "bad_request");
    decisions.override = { result: "invalid_note" };
    await expectError(await post("/thresholds", request, token), 400, "bad_request");
    decisions.override = { result: "forbidden" };
    await expectError(await post("/thresholds", request, token), 403, "forbidden_role");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
describe("normaliseNote", () => {
  it("trims, keeps line breaks, and turns an empty note into null", () => {
    expect(normaliseNote("  a\nb\tc  ", 10)).toBe("a\nb\tc");
    expect(normaliseNote("   ", 10)).toBeNull();
    expect(normaliseNote(undefined, 10)).toBeNull();
    expect(normaliseNote(null, 10)).toBeNull();
  });

  it("counts characters, not UTF-16 units", () => {
    expect(normaliseNote("é".repeat(10), 10)).toBe("é".repeat(10));
    expect(normaliseNote("😀".repeat(10), 10)).toBe("😀".repeat(10));
    expect(() => normaliseNote("😀".repeat(11), 10)).toThrow();
  });
});

describe("reading the database's answers", () => {
  it("accepts staff_decide's answers and nothing else", () => {
    const ok = {
      result: "ok",
      decisionId: "d",
      status: "approved",
      recommendation: "review",
      agreesWithRecommendation: null,
      thresholdVersion: 3,
    };
    expect(toDecideResult(ok)).toEqual(ok);
    expect(toDecideResult({ result: "note_required" })).toEqual({ result: "note_required" });
    for (const bad of [null, [], { result: "maybe" }, { ...ok, status: "pending" }, { ...ok, thresholdVersion: "3" }, { ...ok, recommendation: "yes" }]) {
      expect(() => toDecideResult(bad)).toThrow();
    }
  });

  it("accepts staff_create_threshold_version's answers and nothing else", () => {
    expect(toThresholdResult({ result: "created", version: 3, rescored: 0 })).toEqual({ result: "created", version: 3, rescored: 0 });
    expect(toThresholdResult({ result: "stale", version: 4 })).toEqual({ result: "stale", version: 4 });
    expect(toThresholdResult({ result: "invalid", errors: ["a:b"] })).toEqual({ result: "invalid", errors: ["a:b"] });
    expect(toThresholdResult({ result: "unchanged" })).toEqual({ result: "unchanged" });
    for (const bad of [null, { result: "created", version: 3 }, { result: "invalid", errors: [1] }, { result: "forbidden" }]) {
      expect(() => toThresholdResult(bad)).toThrow();
    }
  });
});
