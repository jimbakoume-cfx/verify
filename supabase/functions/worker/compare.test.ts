import { describe, expect, it } from "vitest";
import {
  compareDate,
  compareName,
  compareNames,
  compareNumber,
  normalizeName,
  normalizeNumber,
  printedDate,
  readPrintedDate,
} from "./compare.ts";

const TODAY = "2026-10-15";

describe("normalizeName", () => {
  it.each([
    ["Hélène", "HELENE"],
    ["ÉCHANTILLON", "ECHANTILLON"],
    ["François", "FRANCOIS"],
    ["Jean-Paul", "JEANPAUL"],
    ["N'Diaye", "NDIAYE"],
    ["N’Diaye", "NDIAYE"],
    ["Mbappé  Lottin", "MBAPPELOTTIN"],
    ["JEAN<PAUL", "JEANPAUL"],
    ["Œuvre", "OEUVRE"],
    ["Ægir", "AEGIR"],
    ["Groß", "GROSS"],
    ["Ngo Bíyíḿ", "NGOBIYIM"],
    ["AÏCHA", "AICHA"],
    ["HEL3NE", "HELNE"],
    ["SPEC1MEN", "SPECIMEN"],
    ["ESSA1", "ESSAI"],
    ["B0B", "BOB"],
    ["", ""],
    ["--", ""],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it("spells Ä, Ö, Ü and Å with two letters the ICAO way when asked", () => {
    expect(normalizeName("Müller", true)).toBe("MUELLER");
    expect(normalizeName("Müller")).toBe("MULLER");
    expect(normalizeName("Ångström", true)).toBe("AANGSTROEM");
  });
});

describe("compareName", () => {
  it.each([
    // [printed, code lines, name field full, expected]
    ["SPÉCIMEN", "SPECIMEN", false, "agree"],
    ["spécimen", "SPECIMEN", false, "agree"],
    ["HÉLÈNE TEST", "HELENE TEST", false, "agree"],
    ["JEAN-PAUL ESSAI", "JEAN PAUL ESSAI", false, "agree"],
    ["N'DIAYE", "NDIAYE", false, "agree"],
    ["MÜLLER", "MUELLER", false, "agree"],
    ["MÜLLER", "MULLER", false, "agree"],
    ["SPEC1MEN", "SPECIMEN", false, "agree"],
    // Truncated code lines (the name field is full): one may start with the other.
    ["ALEXANDRA MARIE-CHRISTINE", "ALEXANDRA MARIE CHRIS", true, "agree"],
    ["ALEXANDRA", "ALEXANDRA MARIE", true, "agree"],
    // ... but not when the field has room left.
    ["ALEXANDRA MARIE-CHRISTINE", "ALEXANDRA MARIE CHRIS", false, "disagree"],
    // Fixes after the PM's first real test: a middle name on one side only, words in another order, OCR
    // splits and merges, labels read into the value, one misread letter in a long word.
    ["ALEXANDRA", "ALEXANDRA MARIE", false, "agree"],
    ["MARIE", "ALEXANDRA MARIE", true, "agree"],
    ["ALEXANDRA MARIE PAULE", "ALEXANDRA PAULE", false, "agree"],
    ["MARIE ALEXANDRA", "ALEXANDRA MARIE", false, "agree"],
    ["ALEXANDRAMARIE", "ALEXANDRA MARIE", false, "agree"],
    ["ALEX ANDRA MARIE", "ALEXANDRA MARIE", false, "agree"],
    ["NOM/SURNAME SPÉCIMEN", "SPECIMEN", false, "agree"],
    ["Prénoms / Given names: Hélène", "HELENE", false, "agree"],
    ["SPECIMAN", "SPECIMEN", false, "agree"],
    // A real difference.
    ["DIFFERENT", "SPECIMEN", false, "disagree"],
    ["MODELE", "MODEL", false, "agree"],
    ["MODELE", "MOREAU", false, "disagree"],
    ["PAUL", "PAOLO", false, "disagree"],
    ["SPECIMEN", "SPECIMEN MARIE", false, "agree"],
    ["MARTIN", "ALEXANDRA MARIE", true, "disagree"],
    ["ALEXANDRA MARIE-CHRIS", "ALEXANDRA MARIE CHRISTINE", false, "disagree"],
    // Nothing to compare.
    [null, "SPECIMEN", false, "unknown"],
    ["", "SPECIMEN", false, "unknown"],
    ["SPECIMEN", "", false, "unknown"],
    ["--", "SPECIMEN", false, "unknown"],
  ] as const)("%s vs %s (full: %s) -> %s", (printed, mrz, full, expected) => {
    expect(compareName(printed, mrz, full)).toBe(expected);
  });
});

describe("compareNames", () => {
  const mrz = { surname: "SPECIMEN", givenNames: "HELENE TEST" };

  it("agrees part by part", () => {
    expect(compareNames({ surname: "SPÉCIMEN", givenNames: "HÉLÈNE TEST" }, mrz, false)).toBe("agree");
  });

  it("compares the parts that were printed only", () => {
    expect(compareNames({ surname: "SPÉCIMEN" }, mrz, false)).toBe("agree");
    expect(compareNames({ givenNames: "Hélène Test" }, mrz, false)).toBe("agree");
    expect(compareNames({}, mrz, false)).toBe("unknown");
    expect(compareNames({ surname: "AUTRE" }, mrz, false)).toBe("disagree");
  });

  it("agrees when the layout put the names in the other fields, or split them differently", () => {
    expect(compareNames({ surname: "SPECIMEN HELENE", givenNames: "TEST" }, mrz, false)).toBe("agree");
  });

  it("disagrees on a real difference in either part", () => {
    expect(compareNames({ surname: "SPECIMEN", givenNames: "MARIE TEST" }, mrz, false)).toBe("disagree");
    expect(compareNames({ surname: "DIFFÉRENT", givenNames: "HÉLÈNE TEST" }, mrz, false)).toBe("disagree");
  });

  it("forgives what OCR does to a real card's names (fixes after the PM's first real test)", () => {
    const real = { surname: "MBARGA ATANGANA", givenNames: "JEAN PIERRE" };
    // Surname and given names swapped by the layout, labels read into the values, a middle name missing.
    expect(compareNames({ surname: "JEAN PIERRE", givenNames: "MBARGA ATANGANA" }, real, false)).toBe("agree");
    expect(compareNames({ surname: "NOM MBARGA ATANGANA", givenNames: "PRÉNOMS JEAN" }, real, false)).toBe("agree");
    expect(compareNames({ surname: "MBARGA", givenNames: "JEAN PIERRE" }, real, false)).toBe("agree");
    expect(compareNames({ surname: "MBARGAATANGANA", givenNames: "JEAN-PIERRE" }, real, false)).toBe("agree");
    expect(compareNames({ surname: "MBARGA ATANGANA JEAN", givenNames: "PIERRE" }, real, false)).toBe("agree");
    // Another person is still another person.
    expect(compareNames({ surname: "ESSOMBA", givenNames: "JEAN PIERRE" }, real, false)).toBe("disagree");
    expect(compareNames({ surname: "MBARGA ATANGANA", givenNames: "PAUL" }, real, false)).toBe("disagree");
  });

  it("does not compare given names the code lines have none of", () => {
    expect(compareNames({ surname: "SPECIMEN", givenNames: "HELENE" }, { surname: "SPECIMEN", givenNames: "" }, true)).toBe("agree");
  });

  it("allows truncated given names on a full name field", () => {
    const cut = { surname: "SPECIMEN", givenNames: "HELENE TES" };
    expect(compareNames({ surname: "SPECIMEN", givenNames: "HÉLÈNE TEST" }, cut, true)).toBe("agree");
    expect(compareNames({ surname: "SPECIMEN", givenNames: "HÉLÈNE TEST" }, cut, false)).toBe("disagree");
  });
});

describe("normalizeNumber and compareNumber", () => {
  it.each([
    ["SPC000123", "SPC000123", "agree"],
    ["SPC 000 123", "SPC000123", "agree"],
    ["SPC-000-123", "SPC000123", "agree"],
    ["spc000123", "SPC000123", "agree"],
    // Look-alikes, either way round.
    ["SPCOOO123", "SPC000123", "agree"],
    ["SP7654321", "SP765432I", "agree"],
    ["5P7654321", "SP7654321", "agree"],
    ["UT1234567", "UTI234567", "agree"],
    ["8A1234567", "BA1234567", "agree"],
    ["2A1234567", "ZA1234567", "agree"],
    ["D23145890", "D23I4589O", "agree"],
    ["100.200.300", "100200300", "agree"],
    ["100/200/300", "100200300", "agree"],
    // Real differences.
    ["SPC000124", "SPC000123", "disagree"],
    ["SPC00123", "SPC000123", "disagree"],
    ["SPC000123", "SPD000123", "disagree"],
    ["3A1234567", "8A1234567", "disagree"],
    // Nothing to compare.
    [null, "SPC000123", "unknown"],
    ["", "SPC000123", "unknown"],
    ["---", "SPC000123", "unknown"],
    ["SPC000123", undefined, "unknown"],
  ] as const)("%s vs %s -> %s", (printed, mrz, expected) => {
    expect(compareNumber(printed, mrz)).toBe(expected);
  });

  it("folds look-alikes to one form", () => {
    expect(normalizeNumber("o I s B z")).toBe("01582");
    expect(normalizeNumber("N° 12-34")).toBe("N1234");
  });
});

describe("readPrintedDate", () => {
  it.each([
    ["1990-02-15", "birth", ["1990-02-15"]],
    ["15.02.1990", "birth", ["1990-02-15"]],
    ["15/02/1990", "birth", ["1990-02-15"]],
    ["15-02-1990", "birth", ["1990-02-15"]],
    ["15 02 1990", "birth", ["1990-02-15"]],
    ["15.02.90", "birth", ["1990-02-15"]],
    ["15.02.08", "birth", ["2008-02-15"]],
    ["15.02.30", "birth", ["1930-02-15"]],
    ["15.02.30", "expiry", ["2030-02-15"]],
    ["02.03.2035", "expiry", ["2035-03-02", "2035-02-03"]],
    ["30 JUIN/JUN 2023", "issue", ["2023-06-30"]],
    ["04 JUIL/JUL 1985", "birth", ["1985-07-04"]],
    ["12 MAR 1979", "birth", ["1979-03-12"]],
    ["5 mars 79", "birth", ["1979-03-05"]],
    ["05MAR1979", "birth", ["1979-03-05"]],
    ["1 févr. 2025", "issue", ["2025-02-01"]],
    ["31 AUG 2032", "expiry", ["2032-08-31"]],
    ["01 août 2020", "issue", ["2020-08-01"]],
    ["MAR 12 1979", "birth", ["1979-03-12"]],
    ["March 12, 1979", "birth", ["1979-03-12"]],
    ["19790312", "birth", ["1979-03-12"]],
    ["1979/03/12", "birth", ["1979-03-12"]],
    // Unknown or impossible parts: nothing.
    ["XX.03.1991", "birth", []],
    ["XX.XX.1984", "birth", []],
    ["31.02.1990", "birth", []],
    ["31 FOO 1990", "birth", []],
    ["1990-13-01", "birth", []],
    ["", "birth", []],
    ["SPECIMEN", "birth", []],
    ["15.02.1890", "birth", []],
  ] as const)("%s (%s) -> %j", (value, kind, expected) => {
    expect(readPrintedDate(value, kind, TODAY)).toEqual(expected);
  });

  it("reads a numeric date month first only when day first is impossible", () => {
    expect(readPrintedDate("12/31/1990", "birth", TODAY)).toEqual(["1990-12-31"]);
    expect(printedDate("12/31/1990", "birth", TODAY)).toBe("1990-12-31");
  });

  it("judges an ambiguous date on its own day first, as the documents print it", () => {
    expect(printedDate("02.03.2035", "expiry", TODAY)).toBe("2035-03-02");
    expect(printedDate("XX.03.1991", "birth", TODAY)).toBeNull();
    expect(printedDate(undefined, "birth", TODAY)).toBeNull();
  });
});

describe("compareDate", () => {
  it.each([
    ["1990-02-15", "1990-02-15", "agree"],
    ["15.02.1990", "1990-02-15", "agree"],
    ["15/02/90", "1990-02-15", "agree"],
    ["15 FEV/FEB 1990", "1990-02-15", "agree"],
    // Day and month either way round: agrees if either reading does.
    ["03.02.2035", "2035-03-02", "agree"],
    ["02.03.2035", "2035-03-02", "agree"],
    // Real differences.
    ["16.02.1990", "1990-02-15", "disagree"],
    ["15.02.1991", "1990-02-15", "disagree"],
    ["1990-02-15", "1990-02-16", "disagree"],
    // Nothing to compare.
    ["XX.02.1990", "1990-02-15", "unknown"],
    [null, "1990-02-15", "unknown"],
    ["15.02.1990", null, "unknown"],
  ] as const)("%s vs %s -> %s", (printed, mrz, expected) => {
    expect(compareDate(printed, mrz, "birth", TODAY)).toBe(expected);
  });
});
