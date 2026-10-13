import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@verify/shared";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import {
  ALL_ERROR_CODES,
  CLIENT_ERROR_CODES,
  FlowError,
  errorMessageKey,
  isErrorCode,
  isImageRejection,
  isTransient,
  sessionErrorReason,
  toFlowError,
} from "./errors";

function lookup(locale: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale);
}

describe("error messages", () => {
  it("covers every server ErrorCode and every client code", () => {
    expect(ALL_ERROR_CODES).toEqual([...ERROR_CODES, ...CLIENT_ERROR_CODES]);
  });

  it.each(ALL_ERROR_CODES)("%s has French and English text", (code) => {
    const key = errorMessageKey(code);
    expect(key).toBe(`errors.${code}`);
    for (const locale of [fr, en]) {
      const text = lookup(locale, key);
      expect(typeof text).toBe("string");
      expect((text as string).trim().length).toBeGreaterThan(5);
    }
  });

  it("has no message for an unknown code", () => {
    expect(Object.keys(fr.errors).sort()).toEqual([...ALL_ERROR_CODES].sort());
    expect(Object.keys(en.errors).sort()).toEqual([...ALL_ERROR_CODES].sort());
  });
});

describe("error classification", () => {
  it("recognises contract codes only", () => {
    expect(isErrorCode("session_expired")).toBe(true);
    expect(isErrorCode("network")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });

  it("maps session-ending codes to a reason", () => {
    expect(sessionErrorReason("invalid_session")).toBe("invalid");
    expect(sessionErrorReason("session_expired")).toBe("expired");
    expect(sessionErrorReason("already_submitted")).toBe("already_submitted");
    expect(sessionErrorReason("network")).toBeNull();
    expect(sessionErrorReason("unauthorized")).toBeNull();
  });

  it("sends image rejections back to the camera", () => {
    for (const code of ["invalid_image", "image_too_small", "image_too_large", "image_resolution_too_low"] as const) {
      expect(isImageRejection(code)).toBe(true);
    }
    expect(isImageRejection("upload_missing")).toBe(false);
    expect(isImageRejection("too_many_uploads")).toBe(false);
  });

  it("retries transient failures only", () => {
    expect(isTransient(new FlowError("network"))).toBe(true);
    expect(isTransient(new FlowError("timeout"))).toBe(true);
    expect(isTransient(new FlowError("server_error", 500))).toBe(true);
    expect(isTransient(new FlowError("unexpected", 502))).toBe(true);
    expect(isTransient(new FlowError("unexpected", 404))).toBe(false);
    expect(isTransient(new FlowError("upload_missing", 404))).toBe(true);
    expect(isTransient(new FlowError("too_many_uploads", 429))).toBe(false);
    expect(isTransient(new FlowError("session_expired", 410))).toBe(false);
    expect(isTransient(new FlowError("image_too_small", 422))).toBe(false);
    expect(isTransient(new FlowError("bad_request", 400))).toBe(false);
  });

  it("wraps unknown throwables", () => {
    const own = new FlowError("timeout");
    expect(toFlowError(own)).toBe(own);
    expect(toFlowError(new TypeError("boom")).code).toBe("unexpected");
  });
});
