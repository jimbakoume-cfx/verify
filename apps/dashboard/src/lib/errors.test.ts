import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@verify/shared";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import {
  allErrorMessageKeys,
  ClientError,
  errorCodeFromResponse,
  errorMessageKey,
  isErrorCode,
  signInErrorKey,
  toClientError,
} from "./errors";

const LOCALES = { fr, en } as const;

function lookup(messages: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
}

describe("error messages", () => {
  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])("has a %s message for every ErrorCode", (lang) => {
    for (const code of ERROR_CODES) {
      const text = lookup(LOCALES[lang], errorMessageKey(code));
      expect(text, `${lang}: ${code}`).toBeTypeOf("string");
      expect((text as string).trim().length, `${lang}: ${code}`).toBeGreaterThan(10);
    }
  });

  it("has FR and EN text for every key any context can produce", () => {
    for (const key of allErrorMessageKeys()) {
      expect(lookup(fr, key), `fr: ${key}`).toBeTypeOf("string");
      expect(lookup(en, key), `en: ${key}`).toBeTypeOf("string");
      expect(lookup(fr, key), key).not.toBe(lookup(en, key));
    }
  });

  it("maps codes to errors.<code> by default", () => {
    expect(errorMessageKey("invalid_invite")).toBe("errors.invalid_invite");
    expect(errorMessageKey("weak_password", "enroll")).toBe("errors.weak_password");
    expect(errorMessageKey("network")).toBe("errors.network");
  });

  it("explains forbidden_role by context: admins and photos, roles and test sessions", () => {
    expect(errorMessageKey("forbidden_role", "photo")).toBe("errors.adminNoImageAccess");
    expect(errorMessageKey("forbidden_role", "testSession")).toBe("errors.testSessionRole");
    expect(errorMessageKey("forbidden_role")).toBe("errors.forbidden_role");
    expect(errorMessageKey("not_found", "photo")).toBe("errors.photoNotFound");
    expect(errorMessageKey("bad_request", "enroll")).toBe("errors.enrollBadRequest");
  });
});

describe("errorCodeFromResponse", () => {
  it("trusts a known code in the body", () => {
    expect(errorCodeFromResponse(403, { error: { code: "forbidden_role", message: "x" } })).toBe("forbidden_role");
    expect(errorCodeFromResponse(500, { error: { code: "audit_failed", message: "x" } })).toBe("audit_failed");
  });

  it("falls back on the status when the body has no known code", () => {
    expect(errorCodeFromResponse(401, null)).toBe("unauthorized");
    expect(errorCodeFromResponse(403, { error: { code: "nope" } })).toBe("forbidden");
    expect(errorCodeFromResponse(404, "text")).toBe("not_found");
    expect(errorCodeFromResponse(400, {})).toBe("bad_request");
    expect(errorCodeFromResponse(502, undefined)).toBe("server_error");
  });

  it("recognises only contract codes", () => {
    expect(isErrorCode("invalid_invite")).toBe(true);
    expect(isErrorCode("network")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });
});

describe("toClientError", () => {
  it("keeps ClientErrors, treats TypeErrors as network failures and hides anything else", () => {
    const original = new ClientError("too_many_uploads", 429);
    expect(toClientError(original)).toBe(original);
    expect(toClientError(new TypeError("Failed to fetch")).code).toBe("network");
    expect(toClientError(new Error("boom")).code).toBe("server_error");
    expect(toClientError("weird").code).toBe("server_error");
  });
});

describe("signInErrorKey", () => {
  it("gives one generic message for wrong credentials and unknown accounts", () => {
    expect(signInErrorKey({ name: "AuthApiError", status: 400, code: "invalid_credentials" })).toBe(
      "signIn.errors.invalidCredentials",
    );
    expect(signInErrorKey({ name: "AuthApiError", status: 400, code: "email_not_confirmed" })).toBe(
      "signIn.errors.invalidCredentials",
    );
    expect(signInErrorKey(null)).toBe("signIn.errors.invalidCredentials");
  });

  it("separates network failures, rate limits and server errors", () => {
    expect(signInErrorKey({ name: "AuthRetryableFetchError", status: 0 })).toBe("errors.network");
    expect(signInErrorKey({ name: "AuthApiError", status: 429, code: "over_request_rate_limit" })).toBe(
      "signIn.errors.rateLimited",
    );
    expect(signInErrorKey({ name: "AuthApiError", status: 500 })).toBe("errors.server_error");
  });

  it("returns keys that exist in both languages", () => {
    for (const key of ["signIn.errors.invalidCredentials", "signIn.errors.rateLimited"]) {
      expect(lookup(fr, key)).toBeTypeOf("string");
      expect(lookup(en, key)).toBeTypeOf("string");
    }
  });
});
