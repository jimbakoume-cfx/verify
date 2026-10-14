import { describe, expect, it } from "vitest";
import {
  canCreateTestSessions,
  documentDataAccess,
  isStaffRole,
  photoAccess,
  seesAllVerifications,
  STAFF_ROLES,
} from "./roles";

describe("role permissions", () => {
  it("lets supervisors and admins create test sessions, not reviewers", () => {
    expect(canCreateTestSessions("supervisor")).toBe(true);
    expect(canCreateTestSessions("admin")).toBe(true);
    expect(canCreateTestSessions("reviewer")).toBe(false);
  });

  it("offers View photo to supervisors and reviewers, and an explanation to admins", () => {
    expect(photoAccess("supervisor")).toBe("view");
    expect(photoAccess("reviewer")).toBe("view");
    expect(photoAccess("admin")).toBe("admin_blocked");
  });

  it("offers Show data read to supervisors and reviewers, and an explanation to admins", () => {
    expect(documentDataAccess("supervisor")).toBe("view");
    expect(documentDataAccess("reviewer")).toBe("view");
    expect(documentDataAccess("admin")).toBe("admin_blocked");
  });

  it("tells reviewers that their list holds assigned cases only", () => {
    expect(seesAllVerifications("reviewer")).toBe(false);
    expect(seesAllVerifications("supervisor")).toBe(true);
    expect(seesAllVerifications("admin")).toBe(true);
  });

  it("recognises exactly the database's staff roles", () => {
    expect(STAFF_ROLES).toEqual(["reviewer", "supervisor", "admin"]);
    for (const role of STAFF_ROLES) expect(isStaffRole(role)).toBe(true);
    for (const value of ["Admin", "owner", "", null, undefined, 1]) expect(isStaffRole(value)).toBe(false);
  });
});
