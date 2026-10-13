// deno-lint-ignore-file require-await
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../_shared/audit.ts";
import type { FunctionConfig } from "../_shared/config.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import { ALLOWED_ORIGIN, type CallOptions, makeRequest, readJson } from "../_shared/test-helpers.ts";
import {
  type AdminRepo,
  type CaptureRecord,
  createAdminHandler,
  type InviteResult,
  isAcceptablePassword,
  normaliseEmail,
  normaliseInviteCode,
  type PasswordResult,
  type SignedUrlStorage,
  type StaffAuth,
  type StaffRole,
} from "./handler.ts";

// ---------------------------------------------------------------------------
// In-memory fakes. The invite functions mirror staff_invite_verify / staff_invite_accept /
// staff_find_auth_user from the M1 migration; auth users are shared with the StaffAuth fake.
// ---------------------------------------------------------------------------
interface Invite {
  email: string;
  role: StaffRole;
  fullName: string;
  codeHash: string;
  expiresAt: number;
  failedAttempts: number;
  acceptedAt: number | null;
  acceptedUserId: string | null;
}

interface AuthUser {
  id: string;
  email: string;
  password: string | null;
  confirmed: boolean;
}

const NOW = new Date("2026-10-13T10:00:00Z");

class World {
  users: AuthUser[] = [];
  tokens = new Map<string, string>();
  /** Ordered record of side effects, to check what happened before what. */
  events: string[] = [];
}

class MemoryAdminRepo implements AdminRepo {
  invites = new Map<string, Invite>();
  profiles = new Map<string, { role: StaffRole; active: boolean; fullName: string }>();
  apiClients: { id: string; name: string; apiKeyHash: string }[] = [];
  applicants: { id: string; apiClientId: string; externalUserId: string }[] = [];
  verifications: { id: string; applicantId: string; tokenHash: string; expiresAt: string; locale: string; isTest: boolean }[] = [];
  captures = new Map<string, CaptureRecord>();
  reviewTasks: { verificationId: string; assignedTo: string | null; status: string }[] = [];
  audits: AuditEntry[] = [];
  failAudit = false;
  /** Simulates another enrollment winning the race between verify and accept. */
  acceptOverride: InviteResult | null = null;
  calls: string[] = [];

  constructor(private world: World) {}

  private open(email: string): Invite | null {
    const invite = this.invites.get(email.toLowerCase());
    if (!invite || invite.acceptedAt !== null || invite.expiresAt <= NOW.getTime() || invite.failedAttempts >= 5) {
      return null;
    }
    return invite;
  }

  async inviteVerify(email: string, codeHash: string): Promise<InviteResult> {
    this.calls.push("inviteVerify");
    const invite = this.open(email);
    if (!invite) return "invalid";
    if (invite.codeHash !== codeHash.toLowerCase()) {
      invite.failedAttempts++;
      return "invalid";
    }
    return "ok";
  }

  async findAuthUser(email: string) {
    this.calls.push("findAuthUser");
    const user = this.world.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    return user ? { userId: user.id, emailConfirmed: user.confirmed } : null;
  }

  async inviteAccept(email: string, codeHash: string, userId: string): Promise<InviteResult> {
    this.calls.push("inviteAccept");
    if (this.acceptOverride) return this.acceptOverride;
    const invite = this.open(email);
    if (!invite || invite.codeHash !== codeHash.toLowerCase()) return "invalid";
    const user = this.world.users.find((u) => u.id === userId);
    if (!user || user.email.toLowerCase() !== invite.email) return "invalid";
    if (!this.profiles.has(userId)) {
      this.profiles.set(userId, { role: invite.role, active: true, fullName: invite.fullName });
    }
    invite.acceptedAt = NOW.getTime();
    invite.acceptedUserId = userId;
    this.audits.push({
      actorType: "staff",
      actorId: userId,
      action: "staff.enroll",
      targetType: "staff_profile",
      targetId: userId,
      details: { role: invite.role },
    });
    return "ok";
  }

  async getStaffProfile(userId: string) {
    const p = this.profiles.get(userId);
    return p ? { role: p.role, active: p.active } : null;
  }

  async ensureApiClient(name: string, apiKeyHash: string) {
    const existing = this.apiClients.find((c) => c.name === name);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.apiClients.push({ id, name, apiKeyHash });
    return id;
  }

  async createApplicant(a: { apiClientId: string; externalUserId: string }) {
    const id = crypto.randomUUID();
    this.applicants.push({ id, ...a });
    return id;
  }

  async createVerification(v: { applicantId: string; tokenHash: string; expiresAt: string; locale: "fr" | "en" }) {
    const id = crypto.randomUUID();
    this.verifications.push({ id, ...v, isTest: true });
    return id;
  }

  async getCapture(captureId: string) {
    return this.captures.get(captureId) ?? null;
  }

  async isAssignedReviewer(verificationId: string, userId: string) {
    return this.reviewTasks.some((t) =>
      t.verificationId === verificationId && t.assignedTo === userId && t.status === "assigned"
    );
  }

  async audit(entry: AuditEntry) {
    if (this.failAudit) throw new Error(`audit insert failed for ${entry.targetId}`);
    this.world.events.push(`audit:${entry.action}`);
    this.audits.push(entry);
  }
}

class MemoryAuth implements StaffAuth {
  mode: "ok" | "weak" | "throw" = "ok";
  calls: { method: string; args: unknown[] }[] = [];

  constructor(private world: World) {}

  async getUserId(accessToken: string) {
    return this.world.tokens.get(accessToken) ?? null;
  }

  private result(userId: string): PasswordResult {
    if (this.mode === "weak") return { ok: false, reason: "weak_password" };
    return { ok: true, userId };
  }

  async createUser(email: string, password: string): Promise<PasswordResult> {
    this.calls.push({ method: "createUser", args: [email, password] });
    // The message carries the secrets on purpose: the logs must not repeat it.
    if (this.mode === "throw") throw new Error(`create failed for ${email} with ${password}`);
    if (this.mode === "weak") return this.result("");
    const id = crypto.randomUUID();
    this.world.users.push({ id, email, password, confirmed: true });
    return this.result(id);
  }

  async setPassword(userId: string, password: string): Promise<PasswordResult> {
    this.calls.push({ method: "setPassword", args: [userId, password] });
    if (this.mode === "throw") throw new Error(`update failed with ${password}`);
    if (this.mode === "weak") return this.result("");
    const user = this.world.users.find((u) => u.id === userId)!;
    user.password = password;
    user.confirmed = true;
    return this.result(userId);
  }
}

class MemorySignedUrls implements SignedUrlStorage {
  fail = false;
  calls: [string, number][] = [];

  constructor(private world: World) {}

  async createSignedUrl(path: string, expiresIn: number) {
    if (this.fail) throw new Error("storage down");
    this.world.events.push("sign");
    this.calls.push([path, expiresIn]);
    return `https://ref.supabase.co/storage/v1/object/sign/id-captures/${path}?token=t`;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const RIDER_APP_URL = "https://rider.example";
const EMAIL = "jim.bakoume@confiance.example";
const CODE = "ABCD2345EFGH";
const PASSWORD = "correct horse battery";

function setup(configOverrides: Partial<FunctionConfig> = {}, { logToConsole = false } = {}) {
  const world = new World();
  const repo = new MemoryAdminRepo(world);
  const auth = new MemoryAuth(world);
  const storage = new MemorySignedUrls(world);
  const log = { error: vi.fn() };
  const config: FunctionConfig = {
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
    riderAppUrl: RIDER_APP_URL,
    testSessionTtlMinutes: 30,
    ...configOverrides,
  };
  const handler = createAdminHandler({
    repo,
    auth,
    storage,
    config,
    now: () => NOW,
    ...(logToConsole ? {} : { log }),
  });

  async function invite(overrides: Partial<Invite> = {}, code = CODE) {
    const record: Invite = {
      email: EMAIL,
      role: "supervisor",
      fullName: "Jim Bakoume",
      codeHash: await sha256Hex(code),
      expiresAt: NOW.getTime() + 7 * 86_400_000,
      failedAttempts: 0,
      acceptedAt: null,
      acceptedUserId: null,
      ...overrides,
    };
    repo.invites.set(record.email, record);
    return record;
  }

  /** A signed-in staff member; returns their access token. */
  function staff(role: StaffRole | null, { active = true } = {}) {
    const id = crypto.randomUUID();
    const token = `eyJ.${id}.sig`;
    world.users.push({ id, email: `${id}@confiance.example`, password: null, confirmed: true });
    world.tokens.set(token, id);
    if (role) repo.profiles.set(id, { role, active, fullName: "Staff" });
    return { id, token };
  }

  function call(path: string, options: CallOptions & { token?: string } = {}) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    return handler(makeRequest(`https://ref.supabase.co/admin${path}`, { ...options, headers }));
  }

  function enroll(body: Record<string, unknown>) {
    return call("/enroll", { body });
  }

  return { world, repo, auth, storage, log, handler, invite, staff, call, enroll };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await readJson(res)).toEqual({ error: { code, message: expect.any(String) } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("enrollment input rules", () => {
  it("normalises emails and rejects malformed or oversized ones", () => {
    expect(normaliseEmail("  Jim.Bakoume@Confiance.EXAMPLE ")).toBe("jim.bakoume@confiance.example");
    expect(normaliseEmail("no-at-sign")).toBeNull();
    expect(normaliseEmail("two@@example.com")).toBeNull();
    expect(normaliseEmail("space in@example.com")).toBeNull();
    expect(normaliseEmail("nodot@example")).toBeNull();
    expect(normaliseEmail(`${"a".repeat(242)}@example.com`)).toHaveLength(254);
    expect(normaliseEmail(`${"a".repeat(243)}@example.com`)).toBeNull();
  });

  it("normalises codes: trimmed, upper-case, without spaces or dashes", () => {
    expect(normaliseInviteCode("  abcd-2345 efgh\t")).toBe("ABCD2345EFGH");
    expect(normaliseInviteCode("ab--cd  ef")).toBe("ABCDEF");
    expect(normaliseInviteCode(" - - ")).toBe("");
  });

  it("checks password length in characters, the 72-byte bcrypt limit and the email's local part", () => {
    expect(isAcceptablePassword("a".repeat(11), EMAIL)).toBe(false);
    expect(isAcceptablePassword("a".repeat(12), EMAIL)).toBe(true);
    expect(isAcceptablePassword("a".repeat(72), EMAIL)).toBe(true);
    expect(isAcceptablePassword("a".repeat(73), EMAIL)).toBe(false);
    expect(isAcceptablePassword("a".repeat(129), EMAIL)).toBe(false);
    expect(isAcceptablePassword("é".repeat(12), EMAIL)).toBe(true); // 12 characters, 24 bytes
    expect(isAcceptablePassword("😀".repeat(6), EMAIL)).toBe(false); // 12 UTF-16 units, 6 characters
    expect(isAcceptablePassword("😀".repeat(18), EMAIL)).toBe(true); // 72 bytes
    expect(isAcceptablePassword("😀".repeat(19), EMAIL)).toBe(false); // 76 bytes
    expect(isAcceptablePassword("my JIM.BAKOUME pass", EMAIL)).toBe(false);
    expect(isAcceptablePassword("jim.bakoume2026!", EMAIL)).toBe(false);
    expect(isAcceptablePassword("jim bakoume 2026", EMAIL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /enroll
// ---------------------------------------------------------------------------
describe("POST /enroll", () => {
  it.each([
    ["no body", undefined],
    ["missing password", { email: EMAIL, code: CODE }],
    ["missing code", { email: EMAIL, password: PASSWORD }],
    ["missing email", { code: CODE, password: PASSWORD }],
    ["a non-string email", { email: [EMAIL], code: CODE, password: PASSWORD }],
    ["a numeric code", { email: EMAIL, code: 1234, password: PASSWORD }],
    ["an invalid email", { email: "jim", code: CODE, password: PASSWORD }],
    ["an oversized code", { email: EMAIL, code: "A".repeat(129), password: PASSWORD }],
  ])("%s -> 400 bad_request", async (_label, body) => {
    const { call, repo } = setup();
    await expectError(await call("/enroll", body === undefined ? {} : { body }), 400, "bad_request");
    expect(repo.calls).toEqual([]);
  });

  it.each([
    ["too short", "short pass"],
    ["too long", "a".repeat(129)],
    ["over 72 bytes", "a".repeat(73)],
    ["containing the email's local part", "Jim.Bakoume-is-me"],
  ])("a password %s -> 400 weak_password, before the invite is looked at", async (_label, password) => {
    const { enroll, invite, repo } = setup();
    await invite();
    await expectError(await enroll({ email: EMAIL, code: CODE, password }), 400, "weak_password");
    expect(repo.calls).toEqual([]);
    expect(repo.invites.get(EMAIL)!.failedAttempts).toBe(0);
  });

  it("creates a confirmed account and the staff profile for a new user", async () => {
    const { enroll, invite, repo, auth, world } = setup();
    await invite({ role: "reviewer" });
    const res = await enroll({ email: EMAIL, code: CODE, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true });
    expect(auth.calls).toEqual([{ method: "createUser", args: [EMAIL, PASSWORD] }]);
    const user = world.users.find((u) => u.email === EMAIL)!;
    expect(user).toMatchObject({ password: PASSWORD, confirmed: true });
    expect(repo.profiles.get(user.id)).toMatchObject({ role: "reviewer", active: true });
    expect(repo.invites.get(EMAIL)).toMatchObject({ acceptedUserId: user.id });
    expect(repo.calls).toEqual(["inviteVerify", "findAuthUser", "inviteAccept"]);
    expect(repo.audits.map((a) => a.action)).toEqual(["staff.enroll"]);
  });

  it("normalises the email and the code before hashing", async () => {
    const { enroll, invite, auth } = setup();
    await invite();
    const res = await enroll({ email: "  JIM.Bakoume@Confiance.Example ", code: " abcd-2345 efgh ", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(auth.calls[0].args[0]).toBe(EMAIL);
  });

  it("takes over an existing auth user: new password, confirmed, no second account", async () => {
    const { enroll, invite, auth, world, repo } = setup();
    await invite();
    const stranger: AuthUser = { id: crypto.randomUUID(), email: EMAIL, password: "stranger's", confirmed: false };
    world.users.push(stranger);
    const res = await enroll({ email: EMAIL, code: CODE, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(auth.calls).toEqual([{ method: "setPassword", args: [stranger.id, PASSWORD] }]);
    expect(world.users).toHaveLength(1);
    expect(stranger).toMatchObject({ password: PASSWORD, confirmed: true });
    expect(repo.profiles.has(stranger.id)).toBe(true);
  });

  it("keeps an existing staff profile unchanged", async () => {
    const { enroll, invite, world, repo } = setup();
    await invite({ role: "admin" });
    const id = crypto.randomUUID();
    world.users.push({ id, email: EMAIL, password: "old", confirmed: true });
    repo.profiles.set(id, { role: "reviewer", active: false, fullName: "Kept" });
    expect((await enroll({ email: EMAIL, code: CODE, password: PASSWORD })).status).toBe(200);
    expect(repo.profiles.get(id)).toEqual({ role: "reviewer", active: false, fullName: "Kept" });
  });

  it("gives the same 403 invalid_invite for every invite failure", async () => {
    const bodies = new Set<string>();
    const scenarios: [string, (h: ReturnType<typeof setup>) => Promise<unknown>, Record<string, unknown>][] = [
      ["unknown email", async () => {}, { email: EMAIL, code: CODE, password: PASSWORD }],
      ["wrong code", (h) => h.invite(), { email: EMAIL, code: "WRONG-CODE", password: PASSWORD }],
      ["expired", (h) => h.invite({ expiresAt: NOW.getTime() }), { email: EMAIL, code: CODE, password: PASSWORD }],
      ["used", (h) => h.invite({ acceptedAt: NOW.getTime() - 1 }), { email: EMAIL, code: CODE, password: PASSWORD }],
      ["locked", (h) => h.invite({ failedAttempts: 5 }), { email: EMAIL, code: CODE, password: PASSWORD }],
      ["empty code", (h) => h.invite(), { email: EMAIL, code: " -- ", password: PASSWORD }],
    ];
    for (const [label, arrange, body] of scenarios) {
      const harness = setup();
      await arrange(harness);
      const res = await harness.enroll(body);
      expect(res.status, label).toBe(403);
      bodies.add(await res.text());
      expect(harness.auth.calls, label).toEqual([]);
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0]).error.code).toBe("invalid_invite");
  });

  it("counts wrong codes and locks the invite after five", async () => {
    const { enroll, invite, repo } = setup();
    await invite();
    for (let i = 0; i < 5; i++) {
      await expectError(await enroll({ email: EMAIL, code: `WRONG${i}`, password: PASSWORD }), 403, "invalid_invite");
    }
    expect(repo.invites.get(EMAIL)!.failedAttempts).toBe(5);
    await expectError(await enroll({ email: EMAIL, code: CODE, password: PASSWORD }), 403, "invalid_invite");
  });

  it("does not look up the invite for an empty code", async () => {
    const { enroll, invite, repo } = setup();
    await invite();
    await enroll({ email: EMAIL, code: "- -", password: PASSWORD });
    expect(repo.calls).toEqual([]);
  });

  it("a password refused by Supabase Auth's policy -> 400 weak_password, invite still open", async () => {
    const { enroll, invite, auth, repo } = setup();
    await invite();
    auth.mode = "weak";
    await expectError(await enroll({ email: EMAIL, code: CODE, password: PASSWORD }), 400, "weak_password");
    expect(repo.invites.get(EMAIL)!.acceptedAt).toBeNull();
    expect(repo.calls).not.toContain("inviteAccept");
  });

  it("the same applies when updating an existing user", async () => {
    const { enroll, invite, auth, world } = setup();
    await invite();
    world.users.push({ id: crypto.randomUUID(), email: EMAIL, password: null, confirmed: false });
    auth.mode = "weak";
    await expectError(await enroll({ email: EMAIL, code: CODE, password: PASSWORD }), 400, "weak_password");
  });

  it("a createUser failure -> 500 server_error, invite still open, nothing secret logged", async () => {
    const { enroll, invite, auth, repo } = setup({}, { logToConsole: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await invite();
    auth.mode = "throw";
    const res = await enroll({ email: EMAIL, code: "abcd-2345-efgh", password: PASSWORD });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("server_error");
    expect(repo.invites.get(EMAIL)!.acceptedAt).toBeNull();
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.flat().join(" ") + text;
    for (const secret of [EMAIL, "jim.bakoume", PASSWORD, CODE, "abcd-2345-efgh", await sha256Hex(CODE)]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("an accept that loses a race -> 403 invalid_invite", async () => {
    const { enroll, invite, repo } = setup();
    await invite();
    repo.acceptOverride = "invalid";
    await expectError(await enroll({ email: EMAIL, code: CODE, password: PASSWORD }), 403, "invalid_invite");
  });

  it("is single use", async () => {
    const { enroll, invite } = setup();
    await invite();
    expect((await enroll({ email: EMAIL, code: CODE, password: PASSWORD })).status).toBe(200);
    await expectError(await enroll({ email: EMAIL, code: CODE, password: "another good password" }), 403, "invalid_invite");
  });

  it("is public: no bearer token needed, and a bad one is ignored", async () => {
    const { call, invite } = setup();
    await invite();
    const res = await call("/enroll", {
      body: { email: EMAIL, code: CODE, password: PASSWORD },
      headers: { authorization: "Bearer not-a-token" },
    });
    expect(res.status).toBe(200);
  });

  it("never logs or echoes the email, code or password on any path", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    for (const mode of ["ok", "weak", "throw"] as const) {
      const h = setup({}, { logToConsole: true });
      await h.invite();
      h.auth.mode = mode;
      for (const body of [
        { email: EMAIL, code: CODE, password: PASSWORD },
        { email: EMAIL, code: "WRONGCODE", password: PASSWORD },
        { email: EMAIL, code: CODE, password: "short" },
      ]) {
        seen.push(await (await h.enroll(body)).text());
      }
    }
    const output = seen.join(" ") + spy.mock.calls.flat().join(" ");
    for (const secret of [EMAIL, PASSWORD, CODE, "WRONGCODE", "short"]) expect(output).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// Staff authentication (every route but /enroll)
// ---------------------------------------------------------------------------
describe("staff authentication", () => {
  const routes: [string, Record<string, unknown>][] = [
    ["/test-sessions", {}],
    ["/captures/view", { captureId: crypto.randomUUID() }],
  ];

  it.each(routes)("%s: missing or malformed Authorization -> 401 unauthorized", async (path, body) => {
    const { call } = setup();
    await expectError(await call(path, { body }), 401, "unauthorized");
    for (const authorization of ["Basic abc", "Bearer", "Bearer ", "bearer x", "Bearer a b", `Bearer ${"a".repeat(9000)}`]) {
      await expectError(await call(path, { body, headers: { authorization } }), 401, "unauthorized");
    }
  });

  it.each(routes)("%s: unknown or expired token -> 401 unauthorized", async (path, body) => {
    const { call } = setup();
    await expectError(await call(path, { body, token: "eyJ.unknown.sig" }), 401, "unauthorized");
  });

  it.each(routes)("%s: no staff profile -> 403 forbidden", async (path, body) => {
    const { call, staff } = setup();
    const { token } = staff(null);
    await expectError(await call(path, { body, token }), 403, "forbidden");
  });

  it.each(routes)("%s: inactive staff -> 403 forbidden", async (path, body) => {
    const { call, staff } = setup();
    const { token } = staff("supervisor", { active: false });
    await expectError(await call(path, { body, token }), 403, "forbidden");
  });
});

// ---------------------------------------------------------------------------
// POST /test-sessions
// ---------------------------------------------------------------------------
describe("POST /test-sessions", () => {
  it("is refused to reviewers -> 403 forbidden_role", async () => {
    const { call, staff, repo } = setup();
    const { token } = staff("reviewer");
    await expectError(await call("/test-sessions", { body: {}, token }), 403, "forbidden_role");
    expect(repo.verifications).toHaveLength(0);
  });

  it("creates a test session with a hashed token in the URL fragment", async () => {
    const { call, staff, repo } = setup();
    const { id: staffId, token } = staff("supervisor");
    const res = await call("/test-sessions", { body: {}, token });
    expect(res.status).toBe(200);
    const body = await readJson(res) as { verificationId: string; riderUrl: string; expiresAt: string };
    const match = /^https:\/\/rider\.example\/#s=([A-Za-z0-9_-]{43})$/.exec(body.riderUrl);
    expect(match).not.toBeNull();
    const sessionToken = match![1];
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());

    expect(repo.verifications).toHaveLength(1);
    const v = repo.verifications[0];
    expect(v).toMatchObject({
      id: body.verificationId,
      tokenHash: await sha256Hex(sessionToken),
      expiresAt: body.expiresAt,
      locale: "fr",
      isTest: true,
    });
    expect(JSON.stringify(repo)).not.toContain(sessionToken);

    expect(repo.apiClients).toHaveLength(1);
    expect(repo.apiClients[0].name).toBe("internal-test");
    expect(repo.apiClients[0].apiKeyHash).toMatch(/^disabled:[0-9a-f]{64}$/);
    expect(repo.applicants[0]).toMatchObject({ apiClientId: repo.apiClients[0].id });
    expect(repo.applicants[0].externalUserId).toMatch(/^test-[0-9a-f]{16}$/);
    expect(v.applicantId).toBe(repo.applicants[0].id);

    expect(repo.audits).toEqual([{
      actorType: "staff",
      actorId: staffId,
      action: "test_session.create",
      targetType: "verification",
      targetId: body.verificationId,
      details: { locale: "fr", ttlMinutes: 30 },
    }]);
  });

  it("is allowed to admins, accepts an empty body and reuses the test client", async () => {
    const { call, staff, repo, handler } = setup();
    const { token } = staff("admin");
    expect((await call("/test-sessions", { body: { locale: "en" }, token })).status).toBe(200);
    const empty = await handler(new Request("https://ref.supabase.co/admin/test-sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: ALLOWED_ORIGIN },
    }));
    expect(empty.status).toBe(200);
    expect(repo.apiClients).toHaveLength(1);
    expect(repo.applicants).toHaveLength(2);
    expect(repo.verifications.map((v) => v.locale)).toEqual(["en", "fr"]);
    expect(new Set(repo.verifications.map((v) => v.tokenHash)).size).toBe(2);
  });

  it("rejects an unknown locale -> 400 bad_request", async () => {
    const { call, staff } = setup();
    const { token } = staff("supervisor");
    await expectError(await call("/test-sessions", { body: { locale: "de" }, token }), 400, "bad_request");
    await expectError(await call("/test-sessions", { body: { locale: null }, token }), 400, "bad_request");
  });

  it("uses TEST_SESSION_TTL_MINUTES", async () => {
    const { call, staff } = setup({ testSessionTtlMinutes: 5 });
    const { token } = staff("supervisor");
    const body = await readJson(await call("/test-sessions", { body: {}, token }));
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + 5 * 60_000).toISOString());
  });

  it("fails closed without RIDER_APP_URL -> 500 server_error, nothing created", async () => {
    const { call, staff, repo, log } = setup({ riderAppUrl: null });
    const { token } = staff("supervisor");
    await expectError(await call("/test-sessions", { body: {}, token }), 500, "server_error");
    expect(repo.verifications).toHaveLength(0);
    expect(log.error).toHaveBeenCalledWith("admin.rider_app_url_missing");
  });
});

// ---------------------------------------------------------------------------
// POST /captures/view
// ---------------------------------------------------------------------------
describe("POST /captures/view", () => {
  function withCapture(h: ReturnType<typeof setup>, overrides: Partial<CaptureRecord> = {}) {
    const capture: CaptureRecord = {
      id: crypto.randomUUID(),
      verificationId: crypto.randomUUID(),
      storagePath: "v/document_front-x.jpg",
      deletedAt: null,
      ...overrides,
    };
    h.repo.captures.set(capture.id, capture);
    return capture;
  }

  it("is refused to admins -> 403 forbidden_role, with no audit and no link", async () => {
    const h = setup();
    const capture = withCapture(h);
    const { token } = h.staff("admin");
    await expectError(await h.call("/captures/view", { body: { captureId: capture.id }, token }), 403, "forbidden_role");
    expect(h.repo.audits).toHaveLength(0);
    expect(h.storage.calls).toHaveLength(0);
  });

  it.each([["missing", {}], ["not a UUID", { captureId: "1 or 1=1" }], ["a number", { captureId: 5 }]])(
    "captureId %s -> 400 bad_request",
    async (_label, body) => {
      const h = setup();
      const { token } = h.staff("supervisor");
      await expectError(await h.call("/captures/view", { body, token }), 400, "bad_request");
    },
  );

  it("unknown or deleted capture -> 404 not_found", async () => {
    const h = setup();
    const { token } = h.staff("supervisor");
    await expectError(await h.call("/captures/view", { body: { captureId: crypto.randomUUID() }, token }), 404, "not_found");
    const deleted = withCapture(h, { deletedAt: NOW.toISOString() });
    await expectError(await h.call("/captures/view", { body: { captureId: deleted.id }, token }), 404, "not_found");
    expect(h.repo.audits).toHaveLength(0);
  });

  it("lets a supervisor view: audit first, then a 60-second link", async () => {
    const h = setup();
    const capture = withCapture(h);
    const { id: staffId, token } = h.staff("supervisor");
    const res = await h.call("/captures/view", { body: { captureId: capture.id.toUpperCase() }, token });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      url: `https://ref.supabase.co/storage/v1/object/sign/id-captures/${capture.storagePath}?token=t`,
      expiresIn: 60,
    });
    expect(h.storage.calls).toEqual([[capture.storagePath, 60]]);
    expect(h.world.events).toEqual(["audit:capture.view", "sign"]);
    expect(h.repo.audits).toEqual([{
      actorType: "staff",
      actorId: staffId,
      action: "capture.view",
      targetType: "capture",
      targetId: capture.id,
      details: { verificationId: capture.verificationId, role: "supervisor", expiresIn: 60 },
    }]);
  });

  it("lets a reviewer view only captures of a case assigned to them", async () => {
    const h = setup();
    const capture = withCapture(h);
    const reviewer = h.staff("reviewer");
    const colleague = h.staff("reviewer");
    const body = { captureId: capture.id };

    await expectError(await h.call("/captures/view", { body, token: reviewer.token }), 404, "not_found");
    h.repo.reviewTasks.push({ verificationId: capture.verificationId, assignedTo: null, status: "open" });
    await expectError(await h.call("/captures/view", { body, token: reviewer.token }), 404, "not_found");
    h.repo.reviewTasks.push({ verificationId: capture.verificationId, assignedTo: colleague.id, status: "assigned" });
    await expectError(await h.call("/captures/view", { body, token: reviewer.token }), 404, "not_found");
    h.repo.reviewTasks.push({ verificationId: capture.verificationId, assignedTo: reviewer.id, status: "done" });
    await expectError(await h.call("/captures/view", { body, token: reviewer.token }), 404, "not_found");
    expect(h.repo.audits).toHaveLength(0);

    expect((await h.call("/captures/view", { body, token: colleague.token })).status).toBe(200);
    expect(h.repo.audits[0]).toMatchObject({ actorId: colleague.id, details: { role: "reviewer" } });
  });

  it("refuses the link when the audit cannot be written -> 500 audit_failed", async () => {
    const h = setup();
    const capture = withCapture(h);
    const { token } = h.staff("supervisor");
    h.repo.failAudit = true;
    await expectError(await h.call("/captures/view", { body: { captureId: capture.id }, token }), 500, "audit_failed");
    expect(h.storage.calls).toHaveLength(0);
    expect(h.log.error).toHaveBeenCalledWith("admin.capture_view_audit_failed", expect.any(Error));
  });

  it("a signing failure after the audit -> 500 server_error", async () => {
    const h = setup();
    const capture = withCapture(h);
    const { token } = h.staff("supervisor");
    h.storage.fail = true;
    await expectError(await h.call("/captures/view", { body: { captureId: capture.id }, token }), 500, "server_error");
    expect(h.repo.audits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Routing and CORS
// ---------------------------------------------------------------------------
describe("admin routing", () => {
  it("answers preflight for allowed origins only", async () => {
    const { handler } = setup();
    const ok = await handler(makeRequest("https://ref.supabase.co/admin/enroll", { method: "OPTIONS" }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    const evil = await handler(makeRequest("https://ref.supabase.co/admin/enroll", {
      method: "OPTIONS",
      origin: "https://evil.example",
    }));
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses an enrollment from a disallowed origin before touching the invite", async () => {
    const { handler, invite, repo } = setup();
    await invite();
    const res = await handler(makeRequest("https://ref.supabase.co/admin/enroll", {
      origin: "https://evil.example",
      body: { email: EMAIL, code: CODE, password: PASSWORD },
    }));
    expect(res.status).toBe(403);
    expect(repo.calls).toEqual([]);
  });

  it("routes with or without the /admin prefix; 404 and 405 otherwise", async () => {
    const { handler, call, staff } = setup();
    const { token } = staff("supervisor");
    const plain = await handler(makeRequest("https://ref.supabase.co/test-sessions", {
      body: {},
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(plain.status).toBe(200);
    await expectError(await call("/enroll", { method: "GET" }), 405, "bad_request");
    await expectError(await call("/captures", { body: {} }), 404, "not_found");
    await expectError(await call("/captures/view/extra", { body: {} }), 404, "not_found");
    await expectError(await call("/enroll", { method: "PUT" }), 405, "bad_request");
  });
});
