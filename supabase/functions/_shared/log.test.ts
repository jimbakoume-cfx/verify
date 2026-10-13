import { describe, expect, it } from "vitest";
import { InternalError, summarizeError } from "./log.ts";

describe("summarizeError", () => {
  it("never includes a foreign error's message, even across lines", () => {
    const err = new Error('duplicate key: (email)=(someone@example.com)\nKey "secret-token"');
    const text = JSON.stringify(summarizeError(err));
    expect(text).not.toContain("someone@example.com");
    expect(text).not.toContain("secret-token");
    expect(summarizeError(err).name).toBe("Error");
  });

  it("keeps the context, code and status of our own errors", () => {
    const summary = summarizeError(new InternalError("capture.insert", { code: "23505", status: 409 }));
    expect(summary).toMatchObject({ name: "InternalError", context: "capture.insert", code: "23505", status: 409 });
  });

  it("describes non-errors by type only", () => {
    expect(summarizeError("user@example.com")).toEqual({ name: "string" });
  });
});
