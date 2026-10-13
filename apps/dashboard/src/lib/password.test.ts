import { describe, expect, it } from "vitest";
import { STAFF_PASSWORD_MAX_BYTES, STAFF_PASSWORD_MAX_LENGTH, STAFF_PASSWORD_MIN_LENGTH } from "@verify/shared";
import { checkPassword, passwordAcceptable, passwordLength } from "./password";

const EMAIL = "Jean.Dupont@example.org";

describe("checkPassword", () => {
  it("uses the contract's length limits", () => {
    const min = "x".repeat(STAFF_PASSWORD_MIN_LENGTH);
    const max = "x".repeat(STAFF_PASSWORD_MAX_LENGTH);
    expect(checkPassword(min.slice(1), "", EMAIL).length).toBe(false);
    expect(checkPassword(min, "", EMAIL).length).toBe(true);
    expect(checkPassword(max, "", EMAIL).length).toBe(true);
    expect(checkPassword(`${max}x`, "", EMAIL).length).toBe(false);
  });

  it("refuses what the server's bcrypt limit refuses: more than 72 bytes", () => {
    expect(STAFF_PASSWORD_MAX_BYTES).toBe(72);
    // 73 ASCII characters: one character and one byte too long.
    const ascii73 = "a".repeat(73);
    expect(checkPassword(ascii73, ascii73, EMAIL)).toMatchObject({ length: false, bytes: false });
    expect(passwordAcceptable(checkPassword(ascii73, ascii73, EMAIL))).toBe(false);
    expect(checkPassword(ascii73.slice(1), "", EMAIL).bytes).toBe(true);
    // A French passphrase: 37 characters, but each "é" is 2 bytes (74 in all).
    const accented = "é".repeat(37);
    expect(checkPassword(accented, accented, EMAIL)).toMatchObject({ length: true, bytes: false });
    // The longest ASCII password the contract allows fits exactly.
    expect(checkPassword("x".repeat(STAFF_PASSWORD_MAX_LENGTH), "", EMAIL).bytes).toBe(true);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(passwordLength("🔒🔒🔒")).toBe(3);
    expect(checkPassword("🔒".repeat(STAFF_PASSWORD_MIN_LENGTH), "", EMAIL).length).toBe(true);
  });

  it("refuses a password containing the email's local part, in any case", () => {
    expect(checkPassword("my-JEAN.DUPONT-pass", "", EMAIL).notEmailName).toBe(false);
    expect(checkPassword("correct horse battery", "", EMAIL).notEmailName).toBe(true);
  });

  it("does not judge the email rule before there is a password or an email", () => {
    expect(checkPassword("", "", EMAIL).notEmailName).toBe(false);
    expect(checkPassword("anything at all", "", "").notEmailName).toBe(true);
    expect(checkPassword("anything at all", "", "no-at-sign").notEmailName).toBe(true);
  });

  it("requires a non-empty, identical confirmation", () => {
    expect(checkPassword("", "", EMAIL).matches).toBe(false);
    expect(checkPassword("correct horse battery", "correct horse", EMAIL).matches).toBe(false);
    expect(checkPassword("correct horse battery", "correct horse battery", EMAIL).matches).toBe(true);
  });

  it("is acceptable only when every rule holds", () => {
    expect(passwordAcceptable(checkPassword("correct horse battery", "correct horse battery", EMAIL))).toBe(true);
    expect(passwordAcceptable(checkPassword("short", "short", EMAIL))).toBe(false);
    expect(passwordAcceptable(checkPassword("jean.dupont 2026!", "jean.dupont 2026!", EMAIL))).toBe(false);
    expect(passwordAcceptable(checkPassword("correct horse battery", "correct horse batterY", EMAIL))).toBe(false);
  });
});
