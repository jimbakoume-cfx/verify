// Role-aware UI only: the database (RLS) and the admin Edge Function make the real decisions.
// These helpers just avoid offering actions the server will refuse.

export const STAFF_ROLES = ["reviewer", "supervisor", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

/** POST /admin/test-sessions accepts supervisors and admins. */
export function canCreateTestSessions(role: StaffRole): boolean {
  return role === "supervisor" || role === "admin";
}

/**
 * POST /admin/captures/view: supervisors, and reviewers on cases assigned to them (RLS only shows
 * a reviewer the captures of assigned cases, so any capture they can see is one they may open).
 * Admins have no routine image access: they get an explanation instead of the button.
 */
export type PhotoAccess = "view" | "admin_blocked";

export function photoAccess(role: StaffRole): PhotoAccess {
  return role === "admin" ? "admin_blocked" : "view";
}

/** Reviewers only see the verifications assigned to them, so their list needs saying so. */
export function seesAllVerifications(role: StaffRole): boolean {
  return role !== "reviewer";
}
