import { describe, expect, it } from "vitest";
import { checkDigit, checkDigitMatches, detectMrzFormat, documentCodeFits, mrzCharValue, parseMrz } from "./mrz.ts";

// ICAO Doc 9303 specimens (fictitious state "UTO").
const TD3 = [
  "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
  "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
];
const TD1 = [
  "I<UTOD231458907<<<<<<<<<<<<<<<",
  "7408122F1204159UTO<<<<<<<<<<<6",
  "ERIKSSON<<ANNA<MARIA<<<<<<<<<<",
];
const TODAY = new Date("2026-10-13T00:00:00Z");

/** Replaces the character at `index` of line `line`. */
function edit(lines: readonly string[], line: number, index: number, char: string): string[] {
  return lines.map((l, i) => (i === line ? l.slice(0, index) + char + l.slice(index + 1) : l));
}

describe("check digits", () => {
  it("values characters as ICAO 9303 Part 3 says", () => {
    expect(mrzCharValue("0")).toBe(0);
    expect(mrzCharValue("9")).toBe(9);
    expect(mrzCharValue("A")).toBe(10);
    expect(mrzCharValue("Z")).toBe(35);
    expect(mrzCharValue("<")).toBe(0);
    expect(mrzCharValue("a")).toBeNaN();
    expect(mrzCharValue("")).toBeNaN();
  });

  it("computes the specimen check digits", () => {
    expect(checkDigit("L898902C3")).toBe(6);
    expect(checkDigit("740812")).toBe(2);
    expect(checkDigit("120415")).toBe(9);
    expect(checkDigit("ZE184226B<<<<<")).toBe(1);
    expect(checkDigit("D23145890")).toBe(7);
  });

  it("accepts only a digit as a check digit", () => {
    expect(checkDigitMatches("740812", "2")).toBe(true);
    expect(checkDigitMatches("740812", "3")).toBe(false);
    expect(checkDigitMatches("<<<<<<", "<")).toBe(false);
    expect(checkDigitMatches("<<<<<<", "0")).toBe(true);
  });
});

describe("detectMrzFormat", () => {
  it("recognises exact TD1 and TD3 layouts only", () => {
    expect(detectMrzFormat(TD3)).toBe("TD3");
    expect(detectMrzFormat(TD1)).toBe("TD1");
    expect(detectMrzFormat(TD1.slice(0, 2))).toBeNull();
    expect(detectMrzFormat([TD3[0], TD3[1].slice(1)])).toBeNull();
    expect(detectMrzFormat([TD3[0].toLowerCase(), TD3[1]])).toBeNull();
    expect(detectMrzFormat([TD3[0].replace("<", " "), TD3[1]])).toBeNull();
    expect(detectMrzFormat([])).toBeNull();
  });
});

describe("parseMrz: TD3 passport", () => {
  it("parses the ICAO specimen with every check digit valid", () => {
    const parsed = parseMrz(TD3, TODAY);
    expect(parsed).toMatchObject({
      format: "TD3",
      documentCode: "P",
      issuingState: "UTO",
      documentNumber: "L898902C3",
      nationality: "UTO",
      birthDate: { raw: "740812", iso: "1974-08-12" },
      sex: "F",
      expiryDate: { raw: "120415", iso: "2012-04-15" },
      optionalData: "ZE184226B",
      surname: "ERIKSSON",
      givenNames: "ANNA MARIA",
      checks: { documentNumber: true, birthDate: true, expiryDate: true, personalNumber: true, composite: true },
      valid: true,
      datesValid: true,
    });
  });

  it("flags each wrong check digit separately", () => {
    const wrongNumber = parseMrz(edit(TD3, 1, 9, "7"), TODAY)!;
    expect(wrongNumber.checks.documentNumber).toBe(false);
    expect(wrongNumber.checks.composite).toBe(false);
    expect(wrongNumber.valid).toBe(false);

    const wrongBirth = parseMrz(edit(TD3, 1, 19, "3"), TODAY)!;
    expect(wrongBirth.checks).toMatchObject({ documentNumber: true, birthDate: false, composite: false });

    const wrongExpiry = parseMrz(edit(TD3, 1, 27, "0"), TODAY)!;
    expect(wrongExpiry.checks.expiryDate).toBe(false);

    const wrongPersonal = parseMrz(edit(TD3, 1, 42, "2"), TODAY)!;
    expect(wrongPersonal.checks.personalNumber).toBe(false);

    const wrongComposite = parseMrz(edit(TD3, 1, 43, "1"), TODAY)!;
    expect(wrongComposite.checks).toMatchObject({ documentNumber: true, composite: false });
  });

  it("catches a misread character through the check digits", () => {
    // O read for 0 in the document number.
    const parsed = parseMrz(edit(TD3, 1, 4, "O"), TODAY)!;
    expect(parsed.checks.documentNumber).toBe(false);
    expect(parsed.valid).toBe(false);
  });

  it("accepts '<' or 0 as the check digit of an empty personal number", () => {
    const empty = "L898902C36UTO7408122F1204159<<<<<<<<<<<<<<";
    for (const digit of ["<", "0"]) {
      const line = `${empty}${digit}`;
      const composite = checkDigit(line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 43));
      const parsed = parseMrz([TD3[0], `${line}${composite}`], TODAY)!;
      expect(parsed.checks.personalNumber).toBe(true);
      expect(parsed.valid).toBe(true);
      expect(parsed.optionalData).toBe("");
    }
  });

  it("splits names on the double filler and keeps single fillers as spaces", () => {
    const line1 = "P<CMRNGONO<MBARGA<<JEAN<PIERRE<<<<<<<<<<<<<<";
    const parsed = parseMrz([line1, TD3[1]], TODAY)!;
    expect(parsed.issuingState).toBe("CMR");
    expect(parsed.surname).toBe("NGONO MBARGA");
    expect(parsed.givenNames).toBe("JEAN PIERRE");
  });
});

describe("parseMrz: TD1 card", () => {
  it("parses the ICAO specimen with every check digit valid", () => {
    const parsed = parseMrz(TD1, TODAY);
    expect(parsed).toMatchObject({
      format: "TD1",
      documentCode: "I",
      issuingState: "UTO",
      documentNumber: "D23145890",
      nationality: "UTO",
      birthDate: { iso: "1974-08-12" },
      sex: "F",
      expiryDate: { iso: "2012-04-15" },
      optionalData: "",
      surname: "ERIKSSON",
      givenNames: "ANNA MARIA",
      checks: { documentNumber: true, birthDate: true, expiryDate: true, composite: true },
      valid: true,
    });
    expect(parsed!.checks.personalNumber).toBeUndefined();
  });

  it("reads a long document number continued in the optional data (Part 5, 4.2.4)", () => {
    // D23145890734 with check digit 9: 9 characters, a filler, then "734" + "9" + filler.
    expect(checkDigit("D23145890734")).toBe(9);
    const line1 = "I<UTOD23145890<7349<<<<<<<<<<<";
    const line2Start = "7408122F1204159UTO<<<<<<<<<<<";
    const composite = checkDigit(line1.slice(5, 30) + line2Start.slice(0, 7) + line2Start.slice(8, 15) + line2Start.slice(18, 29));
    const parsed = parseMrz([line1, `${line2Start}${composite}`, TD1[2]], TODAY)!;
    expect(parsed.documentNumber).toBe("D23145890734");
    expect(parsed.checks.documentNumber).toBe(true);
    expect(parsed.optionalData).toBe("");
    expect(parsed.valid).toBe(true);
  });

  it("fails the composite when optional data is altered", () => {
    // "A" (value 10) would not change a weighted sum modulo 10; "B" (11) always does.
    const parsed = parseMrz(edit(TD1, 1, 20, "B"), TODAY)!;
    expect(parsed.checks.composite).toBe(false);
    expect(parsed.checks.birthDate).toBe(true);
  });
});

describe("parseMrz: dates and invalid input", () => {
  it("puts birth dates in the past and expiry dates in this century", () => {
    const line2 = "L898902C36UTO2001012F3001019ZE184226B<<<<<1";
    const composite = checkDigit(line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43));
    const parsed = parseMrz([TD3[0], `${line2}${composite}`], TODAY)!;
    expect(parsed.birthDate.iso).toBe("2020-01-01");
    expect(parsed.expiryDate.iso).toBe("2030-01-01");
    expect(parsed.valid).toBe(true);
    // A birth "year 30" is 1930, not 2030.
    const old = parseMrz([TD3[0], "L898902C36UTO3001015F3001015ZE184226B<<<<<10"], TODAY)!;
    expect(old.birthDate.iso).toBe("1930-01-01");
  });

  it("marks impossible or unknown dates as not valid dates", () => {
    const impossible = parseMrz(edit(TD3, 1, 15, "3"), TODAY)!; // month 38
    expect(impossible.birthDate.iso).toBeNull();
    expect(impossible.datesValid).toBe(false);
    const feb30 = "L898902C36UTO7402300F1204159ZE184226B<<<<<10";
    expect(parseMrz([TD3[0], feb30], TODAY)!.birthDate.iso).toBeNull();
    const unknownDay = parseMrz(edit(TD3, 1, 17, "<"), TODAY)!;
    expect(unknownDay.birthDate).toEqual({ raw: "7408<2", iso: null });
  });

  it("returns null for anything that is not exactly TD1 or TD3", () => {
    expect(parseMrz(["P<UTO"], TODAY)).toBeNull();
    expect(parseMrz([...TD1, TD1[0]], TODAY)).toBeNull();
    expect(parseMrz([TD3[0], `${TD3[1].slice(0, 43)}«`], TODAY)).toBeNull();
  });

  it("maps the sex field", () => {
    expect(parseMrz(edit(TD3, 1, 20, "M"), TODAY)!.sex).toBe("M");
    expect(parseMrz(edit(TD3, 1, 20, "<"), TODAY)!.sex).toBeNull();
    expect(parseMrz(edit(TD3, 1, 20, "X"), TODAY)!.sex).toBe("X");
  });
});

describe("documentCodeFits", () => {
  it("expects P on passports and I, A or C on TD1 cards", () => {
    expect(documentCodeFits("TD3", "P")).toBe(true);
    expect(documentCodeFits("TD3", "PM")).toBe(true);
    expect(documentCodeFits("TD3", "I")).toBe(false);
    expect(documentCodeFits("TD1", "I")).toBe(true);
    expect(documentCodeFits("TD1", "ID")).toBe(true);
    expect(documentCodeFits("TD1", "AC")).toBe(true);
    expect(documentCodeFits("TD1", "P")).toBe(false);
  });
});
