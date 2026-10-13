// Staff API (contract.ts, "Admin API"). Routing and business rules only: data access goes through the
// injected AdminRepo / StaffAuth / SignedUrlStorage so the rules can be tested with in-memory fakes.
import {
  type CaptureViewResponse,
  type EnrollResponse,
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_PASSWORD_MIN_LENGTH,
  type TestSessionResponse,
} from "../_shared/contract.ts";
import { STAFF_PASSWORD_MAX_BYTES, passwordByteLength } from "../_shared/staffPassword.ts";
import type { AuditEntry } from "../_shared/audit.ts";
import { CAPTURE_VIEW_SECONDS, type FunctionConfig } from "../_shared/config.ts";
import { randomHex as defaultRandomHex, randomToken as defaultRandomToken, sha256Hex } from "../_shared/crypto.ts";
import { badRequest, createRouter, type Handler, HttpError, isUuid, jsonResponse, readJsonObject } from "../_shared/http.ts";
import { consoleLogger, type Logger } from "../_shared/log.ts";

export type StaffRole = "reviewer" | "supervisor" | "admin";
export type InviteResult = "ok" | "invalid";

export interface CaptureRecord {
  id: string;
  verificationId: string;
  storagePath: string;
  deletedAt: string | null;
}

export interface AdminRepo {
  /** staff_invite_verify: counts a wrong code against an open invite. */
  inviteVerify(email: string, codeHash: string): Promise<InviteResult>;
  /** staff_find_auth_user. */
  findAuthUser(email: string): Promise<{ userId: string; emailConfirmed: boolean } | null>;
  /** staff_invite_accept: re-checks the invite, creates the staff profile, consumes the invite, audits. */
  inviteAccept(email: string, codeHash: string, userId: string): Promise<InviteResult>;
  getStaffProfile(userId: string): Promise<{ role: StaffRole; active: boolean } | null>;
  /** Id of the api_client with this name, creating it with apiKeyHash when missing. */
  ensureApiClient(name: string, apiKeyHash: string): Promise<string>;
  createApplicant(applicant: { apiClientId: string; externalUserId: string }): Promise<string>;
  createVerification(verification: {
    applicantId: string;
    tokenHash: string;
    expiresAt: string;
    locale: "fr" | "en";
  }): Promise<string>;
  getCapture(captureId: string): Promise<CaptureRecord | null>;
  /** Same rule as private.is_assigned_reviewer: an 'assigned' review task held by this user. */
  isAssignedReviewer(verificationId: string, userId: string): Promise<boolean>;
  audit(entry: AuditEntry): Promise<void>;
}

/** Unexpected failures throw; only a password refused by Supabase Auth's policy is a result. */
export type PasswordResult = { ok: true; userId: string } | { ok: false; reason: "weak_password" };

export interface StaffAuth {
  /** User id for a valid access token; null when the token is invalid, expired or the user is gone. */
  getUserId(accessToken: string): Promise<string | null>;
  /** auth.admin.createUser({ email, password, email_confirm: true }). */
  createUser(email: string, password: string): Promise<PasswordResult>;
  /** auth.admin.updateUserById(id, { password, email_confirm: true }). */
  setPassword(userId: string, password: string): Promise<PasswordResult>;
}

export interface SignedUrlStorage {
  createSignedUrl(path: string, expiresIn: number): Promise<string>;
}

export interface AdminDeps {
  repo: AdminRepo;
  auth: StaffAuth;
  storage: SignedUrlStorage;
  config: FunctionConfig;
  now?: () => Date;
  randomToken?: () => string;
  randomHex?: (bytes: number) => string;
  log?: Logger;
}

/** Test sessions hang off this client; its key hash can never match a real key. */
export const TEST_API_CLIENT_NAME = "internal-test";

const MAX_EMAIL_LENGTH = 254;
const MAX_CODE_LENGTH = 128;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email) ? email : null;
}

/** Codes are typed by hand: case, spaces and dashes do not matter. */
export function normaliseInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "");
}

/** Length in characters (code points), the bcrypt byte limit, and not containing the email's local part. */
export function isAcceptablePassword(password: string, email: string): boolean {
  const length = [...password].length;
  if (length < STAFF_PASSWORD_MIN_LENGTH || length > STAFF_PASSWORD_MAX_LENGTH) return false;
  if (passwordByteLength(password) > STAFF_PASSWORD_MAX_BYTES) return false;
  const localPart = email.slice(0, email.indexOf("@"));
  return !password.toLowerCase().includes(localPart);
}

export function createAdminHandler(deps: AdminDeps): Handler {
  const { repo, auth, storage, config } = deps;
  const now = deps.now ?? (() => new Date());
  const randomToken = deps.randomToken ?? (() => defaultRandomToken());
  const randomHex = deps.randomHex ?? defaultRandomHex;
  const log = deps.log ?? consoleLogger;

  // One response for every invite failure: unknown address, expired, used, locked or wrong code.
  const invalidInvite = () => new HttpError(403, "invalid_invite");

  async function requireStaff(req: Request): Promise<{ userId: string; role: StaffRole }> {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{1,8192})$/.exec(req.headers.get("authorization") ?? "");
    if (!match) throw new HttpError(401, "unauthorized");
    const userId = await auth.getUserId(match[1]);
    if (!userId) throw new HttpError(401, "unauthorized");
    const profile = await repo.getStaffProfile(userId);
    if (!profile || !profile.active) throw new HttpError(403, "forbidden");
    return { userId, role: profile.role };
  }

  // Never log the email, the code or the password: errors below carry only codes.
  const postEnroll: Handler = async (req) => {
    const body = await readJsonObject(req);
    const { email: rawEmail, code: rawCode, password } = body;
    if (typeof rawEmail !== "string" || typeof rawCode !== "string" || typeof password !== "string") {
      throw badRequest("email, code and password are required.");
    }
    const email = normaliseEmail(rawEmail);
    if (!email) throw badRequest("Invalid email address.");
    if (!isAcceptablePassword(password, email)) throw new HttpError(400, "weak_password");
    if (rawCode.length > MAX_CODE_LENGTH) throw badRequest("Invite code too long.");
    const code = normaliseInviteCode(rawCode);
    if (!code) throw invalidInvite();
    const codeHash = await sha256Hex(code);

    if ((await repo.inviteVerify(email, codeHash)) !== "ok") throw invalidInvite();

    // Holding the code proves the right to this address, so an existing auth user (a stranger's
    // unconfirmed sign-up, or an earlier half-finished enrollment) is taken over: new password, confirmed.
    const existing = await repo.findAuthUser(email);
    const result = existing ? await auth.setPassword(existing.userId, password) : await auth.createUser(email, password);
    if (!result.ok) throw new HttpError(400, "weak_password");

    if ((await repo.inviteAccept(email, codeHash, result.userId)) !== "ok") throw invalidInvite();
    const response: EnrollResponse = { ok: true };
    return jsonResponse(200, response);
  };

  const postTestSessions: Handler = async (req) => {
    const staff = await requireStaff(req);
    if (staff.role !== "supervisor" && staff.role !== "admin") throw new HttpError(403, "forbidden_role");
    const body = await readJsonObject(req, { allowEmpty: true });
    if (body.locale !== undefined && body.locale !== "fr" && body.locale !== "en") {
      throw badRequest("locale must be fr or en.");
    }
    const locale = body.locale ?? "fr";
    if (!config.riderAppUrl) {
      log.error("admin.rider_app_url_missing");
      throw new HttpError(500, "server_error");
    }

    const apiClientId = await repo.ensureApiClient(TEST_API_CLIENT_NAME, `disabled:${randomHex(32)}`);
    const applicantId = await repo.createApplicant({ apiClientId, externalUserId: `test-${randomHex(8)}` });
    const token = randomToken();
    const ttlMinutes = config.testSessionTtlMinutes;
    const expiresAt = new Date(now().getTime() + ttlMinutes * 60_000).toISOString();
    const verificationId = await repo.createVerification({
      applicantId,
      tokenHash: await sha256Hex(token),
      expiresAt,
      locale,
    });
    await repo.audit({
      actorType: "staff",
      actorId: staff.userId,
      action: "test_session.create",
      targetType: "verification",
      targetId: verificationId,
      details: { locale, ttlMinutes },
    });

    // The token travels in the fragment, which browsers never send to a server.
    const response: TestSessionResponse = {
      verificationId,
      riderUrl: `${config.riderAppUrl}/#s=${token}`,
      expiresAt,
    };
    return jsonResponse(200, response);
  };

  const postCaptureView: Handler = async (req) => {
    const staff = await requireStaff(req);
    // Plan: admins manage the system but have no routine access to ID images.
    if (staff.role === "admin") throw new HttpError(403, "forbidden_role");
    const body = await readJsonObject(req);
    if (!isUuid(body.captureId)) throw badRequest("captureId must be a UUID.");

    const capture = await repo.getCapture(body.captureId.toLowerCase());
    if (!capture || capture.deletedAt !== null) throw new HttpError(404, "not_found");
    // A reviewer who does not hold the case gets the same answer as for a missing capture, matching
    // the RLS rule under which the case is invisible to them.
    if (staff.role !== "supervisor" && !(await repo.isAssignedReviewer(capture.verificationId, staff.userId))) {
      throw new HttpError(404, "not_found");
    }

    // No link without a record of who asked for it.
    try {
      await repo.audit({
        actorType: "staff",
        actorId: staff.userId,
        action: "capture.view",
        targetType: "capture",
        targetId: capture.id,
        details: { verificationId: capture.verificationId, role: staff.role, expiresIn: CAPTURE_VIEW_SECONDS },
      });
    } catch (err) {
      log.error("admin.capture_view_audit_failed", err);
      throw new HttpError(500, "audit_failed");
    }

    const url = await storage.createSignedUrl(capture.storagePath, CAPTURE_VIEW_SECONDS);
    const response: CaptureViewResponse = { url, expiresIn: CAPTURE_VIEW_SECONDS };
    return jsonResponse(200, response);
  };

  return createRouter({
    name: "admin",
    allowedOrigins: config.allowedOrigins,
    log,
    routes: {
      "/enroll": { POST: postEnroll },
      "/test-sessions": { POST: postTestSessions },
      "/captures/view": { POST: postCaptureView },
    },
  });
}
