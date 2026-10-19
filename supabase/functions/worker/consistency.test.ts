import { describe, expect, it } from "vitest";
import {
  CONSISTENCY_DETAIL_KEYS,
  CONSISTENCY_FLAGS,
  type DeclaredDocument,
  HARD_FLAGS,
  MISMATCH_KINDS,
  POLICY_REASONS,
  type WorkerFields,
} from "../_shared/contract.ts";
import { checkDigit } from "../_shared/mrz.ts";
import {
  addYears,
  decideConsistency,
  doualaDate,
  MAX_VALIDITY_YEARS,
  nameFieldFull,
  type SideDocumentData,
} from "./consistency.ts";

/** 15 October 2026, 10:00 in Douala. */
const NOW = new Date("2026-10-15T09:00:00Z");

// ---------------------------------------------------------------------------
// Fictitious code lines with correct check digits
// ---------------------------------------------------------------------------
const cd = (field: string) => String(checkDigit(field));
const pad = (text: string, length: number) => (text + "<".repeat(length)).slice(0, length);

interface Person {
  surname?: string;
  given?: string;
  number?: string;
  /** YYMMDD */
  birth?: string;
  expiry?: string;
}

/** TD1 (the new CNI's back). */
function td1({ surname = "SPECIMEN", given = "HELENE<TEST", number = "SPC000123", birth = "900215", expiry = "350302" }: Person = {}): string[] {
  const field = pad(number, 9);
  const l1 = pad("ID" + "CMR" + field + cd(field), 30);
  const head = birth + cd(birth) + "F" + expiry + cd(expiry) + "CMR" + pad("", 11);
  const composite = cd(l1.slice(5, 30) + head.slice(0, 7) + head.slice(8, 15) + head.slice(18, 29));
  return [l1, head + composite, pad(`${surname}<<${given}`, 30)];
}

/** TD3 (a passport's data page). */
function td3({ surname = "ECHANTILLON", given = "FRANCOIS<ESSAI", number = "SP7654321", birth = "850704", expiry = "280630" }: Person = {}): string[] {
  const l1 = pad(`P<CMR${surname}<<${given}`, 44);
  const head = number + cd(number) + "CMR" + birth + cd(birth) + "M" + expiry + cd(expiry) + pad("", 14) + "<";
  const composite = cd(head.slice(0, 10) + head.slice(13, 20) + head.slice(21, 43));
  return [l1, head + composite];
}

function breakDigit(lines: string[]): string[] {
  const copy = [...lines];
  const row = copy.length === 2 ? 1 : 0;
  const at = copy.length === 2 ? 9 : 14;
  const digit = copy[row][at];
  copy[row] = copy[row].slice(0, at) + String((Number(digit) + 1) % 10) + copy[row].slice(at + 1);
  return copy;
}

const FRONT = "00000000-0000-4000-8000-000000000001";
const BACK = "00000000-0000-4000-8000-000000000002";

function front(fields: WorkerFields | null, mrzLines: string[] | null = null): SideDocumentData {
  return { kind: "document_front", captureId: FRONT, mrzLines, fields };
}
function back(fields: WorkerFields | null, mrzLines: string[] | null = null): SideDocumentData {
  return { kind: "document_back", captureId: BACK, mrzLines, fields };
}

/** The new CNI as printed on the specimen front, consistent with td1(). */
const CNI_FRONT: WorkerFields = {
  surname: "SPECIMEN",
  givenNames: "HELENE TEST",
  birthDate: "1990-02-15",
  expiryDate: "2035-03-02",
};
const PASSPORT: WorkerFields = {
  surname: "ECHANTILLON",
  givenNames: "FRANCOIS ESSAI",
  documentNumber: "SP7654321",
  birthDate: "1985-07-04",
  expiryDate: "2028-06-30",
  issueDate: "2023-06-30",
};

function decide(declared: DeclaredDocument | null, sides: SideDocumentData[], now = NOW) {
  return decideConsistency(declared, sides, now);
}

describe("doualaDate and addYears", () => {
  it("is the date in Douala (UTC+1), not in UTC", () => {
    expect(doualaDate(new Date("2026-10-15T22:59:59Z"))).toBe("2026-10-15");
    expect(doualaDate(new Date("2026-10-15T23:00:00Z"))).toBe("2026-10-16");
    expect(doualaDate(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    // No daylight saving time: the same offset in July.
    expect(doualaDate(new Date("2026-07-01T23:00:00Z"))).toBe("2026-07-02");
  });

  it("adds years, 29 February becoming 1 March", () => {
    expect(addYears("2008-10-16", 18)).toBe("2026-10-16");
    expect(addYears("2008-02-29", 18)).toBe("2026-03-01");
    expect(addYears("2008-02-29", 16)).toBe("2024-02-29");
  });
});

describe("nameFieldFull", () => {
  it("is true only when the name field reaches its last character", () => {
    expect(nameFieldFull(td1())).toBe(false);
    expect(nameFieldFull(td1({ surname: "SPECIMENSPECIMEN", given: "HELENE<TESTEXTRA" }))).toBe(true);
    expect(nameFieldFull(td3())).toBe(false);
    expect(nameFieldFull(td3({ surname: "ECHANTILLONECHANTILLONS", given: "FRANCOIS<ESSAI<EXEMPLE" }))).toBe(true);
  });
});

describe("decideConsistency: a consistent document", () => {
  it("passes the new CNI, front and back, with every code line agreeing", () => {
    expect(decide("cni_biometric", [front(CNI_FRONT), back({ issueDate: "2025-03-02" }, td1())])).toEqual({
      outcome: "pass",
      details: { flags: [], provisional: [], basis: "mrz", mismatches: [] },
    });
  });

  it("passes a passport", () => {
    expect(decide("passport", [front(PASSPORT, td3())]).details).toEqual({ flags: [], provisional: [], basis: "mrz", mismatches: [] });
  });

  it("is skipped when nothing was read", () => {
    expect(decide("cni_legacy", [front(null), back(null)])).toEqual({
      outcome: "skipped",
      details: { flags: [], provisional: [], basis: "none", mismatches: [] },
    });
    expect(decide(null, []).outcome).toBe("skipped");
  });

  it("stores generic codes only, in the contract's keys", () => {
    const { details } = decide("passport", [front({ ...PASSPORT, surname: "AUTRE" }, td3({ expiry: "200101" }))]);
    expect(Object.keys(details)).toEqual([...CONSISTENCY_DETAIL_KEYS]);
    const text = JSON.stringify(details);
    for (const value of ["AUTRE", "ECHANTILLON", "SP7654321", "1985", "2020", "2023"]) expect(text).not.toContain(value);
  });
});

describe("decideConsistency: expiry", () => {
  it("flags a document whose code lines expired before today (firm)", () => {
    const d = decide("passport", [front(null, td3({ expiry: "261014" }))]);
    expect(d.outcome).toBe("flag");
    expect(d.details.flags).toEqual(["document_expired"]);
    expect(d.details.basis).toBe("mrz");
  });

  it("does not flag a document expiring today or later (Douala's date)", () => {
    expect(decide("passport", [front(null, td3({ expiry: "261015" }))]).details.flags).toEqual([]);
    // 23:30 UTC on the 14th is already the 15th in Douala: still valid that day.
    expect(decide("passport", [front(null, td3({ expiry: "261015" }))], new Date("2026-10-14T23:30:00Z")).details.flags).toEqual([]);
    // 23:30 UTC on the 15th is the 16th in Douala: expired.
    expect(decide("passport", [front(null, td3({ expiry: "261015" }))], new Date("2026-10-15T23:30:00Z")).details.flags)
      .toEqual(["document_expired"]);
  });

  it("is provisional from a printed expiry date when there are no firm code lines", () => {
    const d = decide("cni_legacy", [front({ surname: "EXEMPLE" }), back({ expiryDate: "12.05.2019", issueDate: "12.05.2009" })]);
    expect(d.details).toEqual({ flags: [], provisional: ["document_expired"], basis: "printed", mismatches: [] });
    expect(d.outcome).toBe("pass");
  });

  it("does not trust code lines with a wrong check digit: the print decides, provisionally", () => {
    const d = decide("passport", [front({ expiryDate: "2020-01-01" }, breakDigit(td3({ expiry: "200101" })))]);
    expect(d.details.basis).toBe("printed");
    expect(d.details.flags).toEqual([]);
    expect(d.details.provisional).toEqual(["document_expired"]);
  });

  it("lets the firm code lines win over a printed date that says otherwise", () => {
    const d = decide("passport", [front({ ...PASSPORT, expiryDate: "2020-01-01" }, td3())]);
    expect(d.details.flags).toEqual(["mrz_print_mismatch"]);
    expect(d.details.provisional).toEqual([]);
    expect(d.details.mismatches).toEqual(["expiry_date"]);
  });
});

describe("decideConsistency: under 18", () => {
  it("flags a holder under 18 from the code lines", () => {
    // Born 16 October 2008: 18 tomorrow.
    expect(decide("passport", [front(null, td3({ birth: "081016" }))]).details.flags).toEqual(["under_18"]);
    // Born 15 October 2008: 18 today.
    expect(decide("passport", [front(null, td3({ birth: "081015" }))]).details.flags).toEqual([]);
  });

  it("flags it from a printed birth date too (PM decision), with basis printed", () => {
    const d = decide("cni_legacy", [front({ birthDate: "16.10.2008" }), back(null)]);
    expect(d.details.flags).toEqual(["under_18"]);
    expect(d.details.basis).toBe("printed");
    expect(d.outcome).toBe("flag");
  });

  it("is a hard flag, as document_expired", () => {
    expect([...HARD_FLAGS]).toEqual(["document_expired", "under_18"]);
  });
});

describe("decideConsistency: printed fields against the code lines", () => {
  it.each([
    ["the surname", { surname: "DIFFERENT" }, ["name"]],
    ["the given names", { givenNames: "MARIE ESSAI" }, ["name"]],
    ["the number", { documentNumber: "SP7654329" }, ["number"]],
    ["the birth date", { birthDate: "05.07.1985" }, ["birth_date"]],
    ["the expiry date", { expiryDate: "30 JUIN/JUN 2029" }, ["expiry_date"]],
    ["two kinds", { surname: "DIFFERENT", documentNumber: "XX0000000" }, ["name", "number"]],
  ] as const)("flags a real difference in %s", (_label, change, kinds) => {
    const d = decide("passport", [front({ ...PASSPORT, ...change }, td3())]);
    expect(d.details.flags).toEqual(["mrz_print_mismatch"]);
    expect(d.details.mismatches).toEqual(kinds);
    expect(d.outcome).toBe("flag");
  });

  it.each([
    ["accents and case", { surname: "Échantillon", givenNames: "François Essai" }],
    ["look-alikes in the number", { documentNumber: "SP765432I" }],
    ["another date format", { birthDate: "04 JUIL/JUL 1985", expiryDate: "30.06.2028" }],
    ["an unreadable date", { birthDate: "XX.07.1985" }],
    ["fields not read", { surname: undefined, documentNumber: undefined }],
  ] as const)("forgives %s", (_label, change) => {
    const d = decide("passport", [front({ ...PASSPORT, ...change }, td3())]);
    expect(d.details).toEqual({ flags: [], provisional: [], basis: "mrz", mismatches: [] });
  });

  it("allows names the code lines cut short", () => {
    // The given names keep 14 characters: "FRANCOIS<ESSAI".
    const lines = td3({ surname: "ECHANTILLONECHANTILLONS", given: "FRANCOIS<ESSAI<EXEMPLAIRE" });
    const printed = { surname: "ÉCHANTILLONÉCHANTILLONS", givenNames: "FRANÇOIS ESSAI EXEMPLAIRE" };
    expect(decide("passport", [front(printed, lines)]).details.mismatches).toEqual([]);
  });

  it("compares the front's print with the back's code lines on a card", () => {
    const d = decide("cni_biometric", [front({ ...CNI_FRONT, surname: "AUTRE" }), back({ issueDate: "2025-03-02" }, td1())]);
    expect(d.details.mismatches).toEqual(["name"]);
  });

  it("never compares with code lines that fail a check digit", () => {
    const d = decide("passport", [front({ ...PASSPORT, surname: "DIFFERENT" }, breakDigit(td3()))]);
    expect(d.details.flags).toEqual([]);
    expect(d.details.mismatches).toEqual([]);
  });

  it("ignores code lines on a side the declared document does not carry them on", () => {
    // A TD1 card read as a passport: its lines are not this document's.
    const d = decide("passport", [front({ surname: "X" }), back(null, td1({ expiry: "200101" }))]);
    expect(d.details.basis).toBe("printed");
    expect(d.details.flags).toEqual([]);
  });

  it("takes a field from the front first, the back only when the front lacks it", () => {
    const d = decide("cni_biometric", [back({ surname: "AUTRE", issueDate: "2025-03-02" }, td1()), front(CNI_FRONT)]);
    expect(d.details.mismatches).toEqual([]);
  });
});

describe("decideConsistency: date logic", () => {
  it("flags firmly a birth date not before the expiry date, both from the code lines", () => {
    // Born in 2010, expired in 2000.
    const d = decide("passport", [front(null, td3({ birth: "100101", expiry: "000101" }))], NOW);
    expect(d.details.flags).toEqual(["document_expired", "under_18", "date_logic"]);
  });

  it.each([
    ["issued before birth", { birthDate: "1990-01-01", issueDate: "1989-01-01", expiryDate: "1999-01-01" }],
    ["issued after expiry", { issueDate: "2025-01-01", expiryDate: "2024-01-01", birthDate: "1990-01-01" }],
    ["issued in the future", { issueDate: "2026-10-16", expiryDate: "2036-10-15", birthDate: "1990-01-01" }],
    ["born in the future", { birthDate: "2030-01-01" }],
    [`valid more than ${MAX_VALIDITY_YEARS} years`, { issueDate: "2010-01-01", expiryDate: "2025-01-02", birthDate: "1990-01-01" }],
  ] as const)("is provisional when a printed date is involved: %s", (_label, fields) => {
    const d = decide("cni_legacy", [front(fields), back(null)]);
    expect(d.details.provisional).toContain("date_logic");
    expect(d.details.flags).not.toContain("date_logic");
  });

  it(`accepts exactly ${MAX_VALIDITY_YEARS} years of validity, and an issue date of today`, () => {
    const fields = { issueDate: "2026-10-15", expiryDate: "2041-10-15", birthDate: "1990-01-01" };
    expect(decide("cni_legacy", [front(fields), back(null)]).details.provisional).not.toContain("date_logic");
  });

  it("is provisional with the firm code lines' dates against a printed issue date", () => {
    const d = decide("passport", [front({ ...PASSPORT, issueDate: "2029-01-01" }, td3())]);
    expect(d.details.flags).toEqual([]);
    expect(d.details.provisional).toEqual(["date_logic"]);
  });
});

describe("decideConsistency: number format", () => {
  it.each([
    ["cni_legacy", "100200300", []],
    ["cni_legacy", "10020030", ["number_format"]],
    ["cni_legacy", "AB0200300", ["number_format"]],
    ["residence_permit", "SJ0004242", []],
    ["residence_permit", "SJ00", ["number_format"]],
    ["driving_licence", "X", []],
    ["voter_card", "X", []],
  ] as const)("%s %s -> provisional %j", (declared, number, expected) => {
    const d = decide(declared, [front({ documentNumber: number }), back(null)]);
    expect(d.details.provisional).toEqual(expected);
    expect(d.details.flags).toEqual([]);
  });

  it("checks the firm code lines' number first, and only provisionally", () => {
    const d = decide("cni_biometric", [front(CNI_FRONT), back(null, td1({ number: "AB12345" }))]);
    expect(d.details.provisional).toEqual(["number_format"]);
    expect(d.details.flags).toEqual([]);
  });
});

describe("the contract's codes", () => {
  it("are every policy reason the consistency check can add", () => {
    for (const code of CONSISTENCY_FLAGS) expect(POLICY_REASONS).toContain(code);
    expect(POLICY_REASONS.slice(0, HARD_FLAGS.length)).toEqual([...HARD_FLAGS]);
  });

  it("are exactly what the database accepts (M4 migration), in order", async () => {
    // node:fs through a variable, so that type checkers without Node's types (deno check) skip it.
    const nodeFs = "node:fs";
    const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL, encoding: "utf8"): string };
    const migration = readFileSync(new URL("../../migrations/20261017000000_m4_consistency.sql", import.meta.url), "utf8");
    const list = (codes: readonly string[]) => codes.map((c) => `'${c}'`).join(", ");
    expect(migration).toContain(`flag_codes constant text[] := array[${list(CONSISTENCY_FLAGS)}]`);
    expect(migration).toContain(`mismatch_codes constant text[] := array[${list(MISMATCH_KINDS)}]`);
    expect(migration).toContain(`k not in (${list(CONSISTENCY_DETAIL_KEYS)})`);
  });
});
