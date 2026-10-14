import { checkDigit, parseMrz } from "./mrz.ts";
import { describe, expect, it } from "vitest";
import {
  FIELD_TYPES,
  MAX_NUMBER_CANDIDATES,
  OPTIONAL_DATA,
  cleanLine,
  correctMrz,
  repairDocumentNumber,
  restoreFillers,
  restoreOptionalFillers,
  snapLength,
  swapByFieldType,
} from "./mrzCorrect.ts";

// ICAO 9303 specimens (Utopia, fictitious).
const TD3 = ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10"];
const TD1 = ["I<UTOD231458907<<<<<<<<<<<<<<<", "7408122F1204159UTO<<<<<<<<<<<6", "ERIKSSON<<ANNA<MARIA<<<<<<<<<<"];

/** A TD3 MRZ for `number`, with every check digit right. */
function td3(number: string, personal = "ZE184226B<<<<<"): string[] {
  const n = number.padEnd(9, "<");
  let l2 = n + checkDigit(n) + "UTO740812" + checkDigit("740812") + "F120415" + checkDigit("120415");
  l2 += personal + checkDigit(personal);
  l2 += checkDigit(l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43));
  return [TD3[0], l2];
}

/** A TD1 MRZ for `number`, using the long-number layout beyond 9 characters. */
function td1(number: string): string[] {
  const head = number.length > 9 ? `${number.slice(0, 9)}<${number.slice(9)}${checkDigit(number)}` : number.padEnd(9, "<") + checkDigit(number.padEnd(9, "<"));
  const l1 = `I<UTO${head}`.padEnd(30, "<");
  let l2 = "7408122F1204159UTO<<<<<<<<<<<";
  l2 += checkDigit(l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29));
  return [l1, l2, TD1[2]];
}

const at = (line: string, i: number, c: string) => line.slice(0, i) + c + line.slice(i + 1);
const text = (lines: string[]) => lines.join("\n");

/** xorshift32, for the property tests. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

describe("test vectors", () => {
  it("are valid MRZs", () => {
    for (const lines of [TD3, TD1, td3("SP7654321"), td1("D23145890734"), td1("D00000000000")]) {
      expect(parseMrz(lines)?.valid).toBe(true);
    }
    expect(td1("D23145890734")[0]).toBe("I<UTOD23145890<7349<<<<<<<<<<<");
  });
});

describe("FIELD_TYPES", () => {
  it("has one type per character of each line", () => {
    expect(FIELD_TYPES.TD1.map((l) => l.length)).toEqual([30, 30, 30]);
    expect(FIELD_TYPES.TD3.map((l) => l.length)).toEqual([44, 44]);
  });
});

describe("cleanLine", () => {
  it("removes spaces and stray characters, upper-cases, and reads '«' as a filler", () => {
    expect(cleanLine(" p<uto eriksson<<anna «« ")).toBe("P<UTOERIKSSON<<ANNA<<");
    expect(cleanLine("L898902C3 6UTO.7408122-F")).toBe("L898902C36UTO7408122F");
    expect(cleanLine("‹‹")).toBe("<<");
  });
});

describe("restoreFillers", () => {
  it("turns K and X inside long runs of fillers back into '<'", () => {
    expect(restoreFillers("ERIKSSON<<ANNA<MARIA<<<K<<<<X<")).toEqual({ line: "ERIKSSON<<ANNA<MARIA<<<<<<<<<<", changed: 2 });
    expect(restoreFillers("ZE184226B<<KX<<10")).toEqual({ line: "ZE184226B<<<<<<10", changed: 2 });
  });

  it("restores one at the end of the line after two fillers", () => {
    expect(restoreFillers("ANNA<MARIA<<<<K")).toEqual({ line: "ANNA<MARIA<<<<<", changed: 1 });
    expect(restoreFillers("ANNA<MARIA<<<KK")).toEqual({ line: "ANNA<MARIA<<<<<", changed: 2 });
  });

  it("keeps real letters: an initial between names, a name ending in X or K, the sex X", () => {
    expect(restoreFillers("ERIKSSON<<ANNA<K<<<<<<").changed).toBe(0);
    expect(restoreFillers("SURNAME<<MAX<<<<<<<<<").changed).toBe(0);
    expect(restoreFillers("SURNAME<<KIRK<<<<<<<<").changed).toBe(0);
    expect(restoreFillers("7408122X1204159UTO<<<<").changed).toBe(0);
    // A run mostly of K and X is not a filler run.
    expect(restoreFillers("AB<<KXKX<<").changed).toBe(0);
  });

  it("keeps a one-letter given name after the surname, and a name of one letter after it", () => {
    expect(restoreFillers("DOE<<K<<<<<<<<<<<<<<<<<<<<<<<<")).toEqual({ line: "DOE<<K<<<<<<<<<<<<<<<<<<<<<<<<", changed: 0 });
    expect(restoreFillers("NGUEMA<<X<<<<<<<<<<<<<<<<<<<<<").changed).toBe(0);
    expect(restoreFillers("DOE<<K<X<<<<<<<").changed).toBe(0);
    // ALEX, then the initial K: the X of ALEX starts the run.
    expect(restoreFillers("DOE<<ALEX<K<<<<<<<").changed).toBe(0);
  });

  it("still restores one further from the names, or after a word with digits", () => {
    expect(restoreFillers("DOE<<K<<<K<<<<<<")).toEqual({ line: "DOE<<K<<<<<<<<<<", changed: 1 });
    expect(restoreFillers("NGUEMA<<<X<<<<<<")).toEqual({ line: "NGUEMA<<<<<<<<<<", changed: 1 });
    // The optional data after the nationality on the second TD1 line.
    expect(restoreFillers("7408122F1204159UTO<<K<<<<<<<<6")).toEqual({ line: "7408122F1204159UTO<<<<<<<<<<<6", changed: 1 });
  });

  it("counts only real fillers around a K or X: the unspecified nationality XXX stays whole", () => {
    // Its third X has two X before it, not two '<'.
    expect(restoreFillers("7408122F1204159XXX<<<<<<<<<<<6")).toEqual({ line: "7408122F1204159XXX<<<<<<<<<<<6", changed: 0 });
    expect(restoreFillers("ZE184226B<KX<<<10").changed).toBe(0);
  });
});

describe("restoreOptionalFillers", () => {
  it("covers the optional-data fields exactly, which the field types call X (letters or digits)", () => {
    for (const format of ["TD1", "TD3"] as const) {
      for (const [l, from, to] of OPTIONAL_DATA[format]) {
        const types = FIELD_TYPES[format][l];
        expect(types.slice(from, to)).toBe("X".repeat(to - from));
        expect(types[from - 1]).not.toBe("X");
        expect(types[to] ?? "end of line").not.toBe("X");
      }
    }
  });

  it("restores K and X anywhere in the run of fillers that ends the field, even at its very start", () => {
    const empty = "<".repeat(14);
    const passport = td3("L898902C3", empty);
    for (const i of [28, 29, 40, 41]) {
      for (const c of ["K", "X"]) {
        const read = [passport[0], at(passport[1], i, c)];
        expect(restoreOptionalFillers(read, "TD3"), `${c} at ${i}`).toEqual({ lines: passport, changed: 1 });
      }
    }
    const card = td1("D23145890");
    for (const [l, i] of [[0, 15], [0, 16], [0, 29], [1, 18], [1, 19], [1, 28]]) {
      for (const c of ["K", "X"]) {
        const read = [...card];
        read[l] = at(read[l], i, c);
        expect(restoreOptionalFillers(read, "TD1"), `${c} at ${l}:${i}`).toEqual({ lines: card, changed: 1 });
      }
    }
    // After data, the run starts at the first '<'.
    const data = td3("L898902C3", "ZE184226B<<<<<");
    expect(restoreOptionalFillers([data[0], at(data[1], 38, "K")], "TD3")).toEqual({ lines: data, changed: 1 });
  });

  it("keeps a K or X written right after other data, a run that is mostly K and X, and the other fields", () => {
    const tail = td3("L898902C3", "ZE184226BK<<<<");
    expect(restoreOptionalFillers(tail, "TD3")).toEqual({ lines: tail, changed: 0 });
    const mostly = td3("L898902C3", "ZE184226B<KXK<");
    expect(restoreOptionalFillers(mostly, "TD3")).toEqual({ lines: mostly, changed: 0 });
    const nationality = [TD1[0], TD1[1].replace("UTO", "XXX"), TD1[2]];
    expect(restoreOptionalFillers(nationality, "TD1")).toEqual({ lines: nationality, changed: 0 });
    // A long TD1 number fills the start of the optional data.
    expect(restoreOptionalFillers(td1("D23145890734"), "TD1").changed).toBe(0);
  });
});

describe("snapLength", () => {
  it("leaves a line of the right length alone", () => {
    expect(snapLength(TD3[1], 44)).toEqual({ line: TD3[1], changed: 0 });
  });

  it("removes extra fillers from the longest run of fillers", () => {
    const long = TD3[1].replace("<<<<<", "<<<<<<<");
    expect(snapLength(long, 44)).toEqual({ line: TD3[1], changed: 2 });
  });

  it("adds missing fillers to the longest run of fillers, the last one on a tie", () => {
    expect(snapLength(TD3[0].slice(0, 43), 44)).toEqual({ line: TD3[0], changed: 1 });
    expect(snapLength(TD1[0].replace("<<<<", "<<"), 30)).toEqual({ line: TD1[0], changed: 2 });
    expect(snapLength("AB<<CD<<EF", 11)).toEqual({ line: "AB<<CD<<<EF", changed: 1 });
  });

  it("gives up 3 or more characters off, or when only short runs could be cut", () => {
    expect(snapLength(TD3[1] + "<<<", 44)).toBeNull();
    expect(snapLength(TD3[1].slice(0, 41), 44)).toBeNull();
    expect(snapLength("ERIKSSON<<ANNA<MARIA", 19)).toBeNull();
    expect(snapLength("ABCDEFGHIJ", 11)).toBeNull();
  });
});

describe("swapByFieldType", () => {
  it("turns look-alike letters into digits in dates and check digits", () => {
    // 7408122F1204159UTO<<<<<<<<<<<6: O for 0, B for 8, I for 1, Z for 2, D for 0, S for 5, G for 6.
    const read = "74OBIZ2F12D41S9UTO<<<<<<<<<<<G";
    const { lines, changed } = swapByFieldType([TD1[0], read, TD1[2]], "TD1");
    expect(lines[1]).toBe(TD1[1]);
    expect(changed).toBe(7);
    expect(swapByFieldType([TD1[0], "74Q8122F1204159UTO<<<<<<<<<<<6", TD1[2]], "TD1").lines[1]).toBe(TD1[1]);
  });

  it("turns look-alike digits into letters in codes, countries and names", () => {
    const { lines, changed } = swapByFieldType(["P<UT0ER1K55ON<<ANNA<MAR1A<<<<<<<<<<<<<<<<<<<", "L898902C36UT07408122F1204159ZE184226B<<<<<10"], "TD3");
    expect(lines).toEqual(TD3);
    expect(changed).toBe(6);
    expect(swapByFieldType(["1<UT0D231458907<<<<<<<<<<<<<<<", TD1[1], "ER1KSS0N<<ANNA<MAR1A<<<<<<<<<<"], "TD1").lines).toEqual(TD1);
  });

  it("leaves the document number, optional data and sex as read", () => {
    const lines = ["I<UTOO23I458907<<<<<<<<<<<<<<<", "7408122X1204159UTO<<<<<0<<<<<6", TD1[2]];
    expect(swapByFieldType(lines, "TD1")).toEqual({ lines, changed: 0 });
    const passport = [TD3[0], "L8989O2C36UTO7408122F1204159ZE1842Z6B<<<<<10"];
    expect(swapByFieldType(passport, "TD3")).toEqual({ lines: passport, changed: 0 });
  });
});

describe("repairDocumentNumber", () => {
  // Read: the 0 of L898902C3 as O. Evidence: another pass read that 0 correctly, but misread the
  // personal number (2 as Z, which no rule may undo), so it is not valid on its own.
  const read = [TD3[0], at(TD3[1], 5, "O")];
  const other = [TD3[0], at(TD3[1], 34, "Z")];

  it("swaps a look-alike that another reading saw, when its check digits then agree", () => {
    expect(parseMrz(read)?.checks.documentNumber).toBe(false);
    expect(parseMrz(other)?.valid).toBe(false);
    expect(repairDocumentNumber(read, "TD3", [other])).toEqual({ lines: TD3, changed: 1 });
  });

  it("never swaps without evidence from another reading: the check digit alone is too weak", () => {
    expect(repairDocumentNumber(read, "TD3")).toEqual({ lines: read, changed: 0 });
    // Another reading with the same O is no evidence.
    expect(repairDocumentNumber(read, "TD3", [read])).toEqual({ lines: read, changed: 0 });
  });

  it("does not turn a number misread in another way into a wrong number that passes", () => {
    // L read as C (not a look-alike). Swapping the 0 at position 5 for a D would make BOTH the
    // number's check digit and the composite pass, with a wrong number: a blind search accepts it.
    const misread = [TD3[0], at(TD3[1], 0, "C")];
    const blind = [TD3[0], at(misread[1], 5, "D")];
    expect(parseMrz(blind)?.valid).toBe(true);
    expect(repairDocumentNumber(misread, "TD3")).toEqual({ lines: misread, changed: 0 });
    expect(repairDocumentNumber(misread, "TD3", [misread, other])).toEqual({ lines: misread, changed: 0 });
  });

  it("gives up when two different swaps would both fit", () => {
    // OBIBBZ51B: reading Z as 2 can be undone at position 5 (2 -> Z, the truth) or at position 2
    // (I -> 1): both make the check digits agree.
    const truth = td3("OBIBBZ51B");
    const misread = [truth[0], at(truth[1], 5, "2")];
    const evidence = [truth[0], at(at(truth[1], 2, "1"), 34, "Z")];
    expect(parseMrz([truth[0], at(misread[1], 2, "1")])?.checks.documentNumber).toBe(true);
    expect(repairDocumentNumber(misread, "TD3", [evidence])).toEqual({ lines: misread, changed: 0 });
  });

  it("covers the rest of a long TD1 number, and stays within the candidate cap", () => {
    const truth = td1("D23145890734");
    const misread = [at(truth[0], 5, "0"), truth[1], truth[2]];
    const evidence = [truth[0], at(truth[1], 20, "X"), truth[2]];
    expect(repairDocumentNumber(misread, "TD1", [evidence])).toEqual({ lines: truth, changed: 1 });

    // D00000000000 with one 0 read as O, and a reading with every other 0 as O: 11 supported
    // swaps, more than the cap.
    const zeros = td1("D00000000000");
    const misreadZeros = [at(zeros[0], 7, "O"), zeros[1], zeros[2]];
    let allO = zeros[0];
    for (const i of [6, 8, 9, 10, 11, 12, 13, 15, 16, 17]) allO = at(allO, i, "O");
    expect(MAX_NUMBER_CANDIDATES).toBeLessThan(11);
    expect(repairDocumentNumber(misreadZeros, "TD1", [[allO, zeros[1], zeros[2]]]).changed).toBe(0);
  });

  it("never swaps G and 6, which the check digit cannot tell apart", () => {
    const truth = td3("G12345678");
    const misread = [truth[0], at(at(truth[1], 0, "6"), 3, "Z")];
    const evidence = [truth[0], at(truth[1], 34, "Z")];
    expect(repairDocumentNumber(misread, "TD3", [evidence]).lines[1].slice(0, 1)).toBe("6");
  });

  it("leaves a number whose check digit is right alone", () => {
    expect(repairDocumentNumber(TD3, "TD3", [other])).toEqual({ lines: TD3, changed: 0 });
  });
});

describe("correctMrz", () => {
  it("returns exact lines unchanged", () => {
    expect(correctMrz(text(TD3), "TD3")).toEqual({ lines: TD3, corrections: 0 });
    expect(correctMrz(text(TD1), "TD1")).toEqual({ lines: TD1, corrections: 0 });
  });

  it("handles spaces, CRLF, empty lines and lower case", () => {
    const raw = "\r\n P<UTO ERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<< \r\n\r\nl898902c36uto 7408122f1204159ze184226b<<<<<10\r\n";
    expect(correctMrz(raw, "TD3")).toEqual({ lines: TD3, corrections: 0 });
  });

  it("combines every step and counts the characters changed", () => {
    const raw = [
      "P<UT0ERIKSSON<<ANNA<MARIA<<<<<<<<<<K<<<<<<<<<", // 0 for O; K for <; one < too many
      "L898902C36UT074O8I22F12O4I59ZE184226B<<<<1O", // 0 for O, O/I in dates; one < missing
    ].join("\n");
    // Line 1: UT0, K, one filler removed. Line 2: UT0, four O/I in the dates, the O of the last
    // check digit, one filler added.
    expect(correctMrz(raw, "TD3")).toEqual({ lines: TD3, corrections: 3 + 1 + 4 + 1 + 1 });
  });

  it("picks the code lines out of other text read with them", () => {
    const raw = [
      "REPUBLIQUE D UTOPIE",
      "SPECIMEN OFFICE UTOVILLE 01 01 2025", // 29 characters once cleaned: close to TD1's 30
      ...TD1,
      "<<",
    ].join("\n");
    expect(correctMrz(raw, "TD1")).toEqual({ lines: TD1, corrections: 0 });
    // Noise between the lines is skipped.
    expect(correctMrz([TD1[0], "IIII", TD1[1], TD1[2]].join("\n"), "TD1").lines).toEqual(TD1);
  });

  it("prefers the window whose check digits pass", () => {
    // A 30-character line above the MRZ: [it, line 1, line 2] and [line 1, line 2, line 3] both fit.
    const raw = ["IDUTO123456789012345678901234<", ...TD1].join("\n");
    expect(correctMrz(raw, "TD1").lines).toEqual(TD1);
  });

  it("keeps a one-letter given name, which no check digit protects", () => {
    // Valid with or without the X: turning it into '<' would drop the given name unseen.
    const lines = ["IDUTOSP01234566<<<<<<<<<<<<<<<", "9002155F3501014UTO<<<<<<<<<<<8", "NGUEMA<<X<<<<<<<<<<<<<<<<<<<<<"];
    expect(parseMrz(lines)?.valid).toBe(true);
    expect(correctMrz(text(lines), "TD1")).toEqual({ lines, corrections: 0 });
    const passport = td3("SP7654321");
    const named = [passport[0].replace("ERIKSSON<<ANNA<MARIA", "ERIKSSON<<K<<<<<<<<<"), passport[1]];
    expect(named[0]).toBe("P<UTOERIKSSON<<K".padEnd(44, "<"));
    expect(correctMrz(text(named), "TD3")).toEqual({ lines: named, corrections: 0 });
  });

  it("keeps an unspecified nationality (XXX), which no check digit covers", () => {
    const stateless = [TD1[0], TD1[1].replace("UTO", "XXX"), TD1[2]];
    expect(parseMrz(stateless)?.nationality).toBe("XXX");
    expect(correctMrz(text(stateless), "TD1")).toEqual({ lines: stateless, corrections: 0 });
  });

  it("restores a filler misread as K or X at the start of empty optional data, where K passes every check", () => {
    const passport = td3("SP7654321", "<".repeat(14));
    // K is worth 20: it changes no check digit, so left there it would pass as data.
    expect(parseMrz([passport[0], at(passport[1], 28, "K")])?.valid).toBe(true);
    for (const i of [28, 29, 40, 41]) {
      for (const c of ["K", "X"]) {
        expect(correctMrz(text([passport[0], at(passport[1], i, c)]), "TD3"), `${c} at ${i}`).toEqual({ lines: passport, corrections: 1 });
      }
    }
    for (const [l, i] of [[0, 15], [0, 16], [1, 18], [1, 19]]) {
      for (const c of ["K", "X"]) {
        const read = [...TD1];
        read[l] = at(read[l], i, c);
        expect(correctMrz(text(read), "TD1"), `${c} at ${l}:${i}`).toEqual({ lines: TD1, corrections: 1 });
      }
    }
  });

  it("returns lines that fail their check digits as they are (status invalid)", () => {
    const wrong = [TD3[0], at(TD3[1], 15, "9")]; // birth date 749812: check digit fails
    const { lines } = correctMrz(text(wrong), "TD3");
    expect(lines).toEqual(wrong);
    expect(parseMrz(lines!)?.valid).toBe(false);
  });

  it("uses other readings of the band only as evidence for the document number", () => {
    const read = [TD3[0], at(TD3[1], 5, "O")];
    const other = [TD3[0], at(TD3[1], 34, "Z")];
    expect(correctMrz(text(read), "TD3")).toEqual({ lines: read, corrections: 0 });
    expect(correctMrz(text(read), "TD3", [text(other)])).toEqual({ lines: TD3, corrections: 1 });
  });

  it("finds nothing in text that is not an MRZ of the format", () => {
    expect(correctMrz("", "TD1").lines).toBeNull();
    expect(correctMrz(text(TD3), "TD1").lines).toBeNull();
    expect(correctMrz(text(TD1), "TD3").lines).toBeNull();
    // Too short or too long by 3 or more.
    expect(correctMrz(text([TD3[0], TD3[1].slice(0, 40)]), "TD3").lines).toBeNull();
    // Right lengths, but neither a fitting document code nor two right check digits.
    const prose = ["THEQUICKBROWNFOXJUMPSOVERTHELAZYDOGANDKEEPSG", "ONRUNNINGACROSSTHEWIDEGREENFIELDSUNTILSUNSET"];
    expect(correctMrz(text(prose), "TD3").lines).toBeNull();
  });

  it("corrects look-alikes in dates and names back to the exact MRZ (property)", () => {
    const random = rng(42);
    const toLetter: Record<string, string> = { "0": "O", "1": "I", "8": "B", "5": "S", "2": "Z", "6": "G" };
    for (let n = 0; n < 200; n++) {
      const misread = TD1.map((line, l) =>
        line
          .split("")
          .map((c, i) => (FIELD_TYPES.TD1[l][i] === "N" && toLetter[c] && random() < 0.3 ? toLetter[c] : c))
          .join(""),
      );
      expect(correctMrz(text(misread), "TD1").lines).toEqual(TD1);
    }
  });

  it("never turns a document number misread as a non-look-alike into a valid MRZ (property)", () => {
    const random = rng(7);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const lookAlike: Record<string, string> = { O: "0DQ", D: "0O", Q: "0O", "0": "ODQ", I: "1", "1": "I", B: "8", "8": "B", S: "5", "5": "S", Z: "2", "2": "Z", G: "6", "6": "G" };
    let tried = 0;
    for (let n = 0; n < 400; n++) {
      const number = Array.from({ length: 9 }, () => alphabet[Math.floor(random() * 36)]).join("");
      const truth = td3(number);
      const p = Math.floor(random() * 9);
      const wrong = alphabet[Math.floor(random() * 36)];
      if (wrong === number[p] || (lookAlike[number[p]] ?? "").includes(wrong)) continue;
      const misread = [truth[0], at(truth[1], p, wrong)];
      if (parseMrz(misread)?.checks.documentNumber) continue; // an error the check digit misses
      tried++;
      // With no other reading, or another reading with the same misread.
      for (const evidence of [[], [text(misread)]]) {
        const { lines } = correctMrz(text(misread), "TD3", evidence);
        expect(parseMrz(lines!)?.valid).toBe(false);
      }
    }
    expect(tried).toBeGreaterThan(300);
  });
});
