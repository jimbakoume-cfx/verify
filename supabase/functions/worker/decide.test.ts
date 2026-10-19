import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_DETAIL_KEYS,
  type DeclaredDocument,
  type PolicyReason,
  type WorkerQuality,
  type WorkerResultRequest,
} from "../_shared/contract.ts";
import { checkDigit, MRZ_PARSER_VERSION, parseMrz } from "../_shared/mrz.ts";
import { decideCaseChecks } from "./case.ts";
import {
  type CaptureEvidence,
  type CaseSide,
  decideCapture,
  decideCase,
  fieldsCheck,
  fieldsPlaintext,
  mrzFamily,
  parseEvidence,
  qualityVerdict,
  readServerMrz,
  SERVER_CHECKS_VERSION,
} from "./decide.ts";

const TODAY = new Date("2026-10-14T09:00:00Z");

// ---------------------------------------------------------------------------
// Fictitious MRZ lines with correct check digits
// ---------------------------------------------------------------------------
function cd(field: string): string {
  return String(checkDigit(field));
}

function pad(text: string, length: number): string {
  return (text + "<".repeat(length)).slice(0, length);
}

/** TD1 (ID-1 card): document code, issuing state, nationality; everything else fixed and fictitious. */
function td1({ code = "ID", issuing = "CMR", nationality = "CMR", number = "AB1234567" } = {}): string[] {
  const l1 = pad(code, 2) + issuing + number + cd(number) + pad("", 15);
  const birth = "900101";
  const expiry = "350101";
  const l2Head = birth + cd(birth) + "F" + expiry + cd(expiry) + nationality + pad("", 11);
  const composite = cd(l1.slice(5, 30) + l2Head.slice(0, 7) + l2Head.slice(8, 15) + l2Head.slice(18, 29));
  return [l1, l2Head + composite, pad("SPECIMEN<<TESTA", 30)];
}

/** TD3 (passport page). */
function td3({ issuing = "CMR", nationality = "CMR", number = "P0123456A" } = {}): string[] {
  const l1 = pad(`P<${issuing}SPECIMEN<<TESTA`, 44);
  const birth = "900101";
  const expiry = "310101";
  const personal = pad("", 14);
  const head = number + cd(number) + nationality + birth + cd(birth) + "M" + expiry + cd(expiry) + personal + "<";
  const composite = cd(head.slice(0, 10) + head.slice(13, 20) + head.slice(21, 43));
  return [l1, head + composite];
}

function breakCheck(lines: string[], format: "TD1" | "TD3"): string[] {
  // Changes the document number's check digit.
  const copy = [...lines];
  if (format === "TD1") copy[0] = copy[0].slice(0, 14) + String((Number(copy[0][14]) + 1) % 10) + copy[0].slice(15);
  else copy[1] = copy[1].slice(0, 9) + String((Number(copy[1][9]) + 1) % 10) + copy[1].slice(10);
  return copy;
}

// Values read from these documents: none may reach a check result.
const VALUES = ["SPECIMEN", "TESTA", "AB1234567", "P0123456A", "900101", "350101", "310101", "CMR", "XXB", "UTO", "Jane", "Doe", "2031-01-01"];

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------
const GOOD: WorkerQuality = {
  sharpness: 40,
  glareRatio: 0.001,
  meanLuma: 140,
  documentFound: true,
  documentConfidence: 0.9,
  longSide: 1600,
  textLines: 12,
};

describe("qualityVerdict", () => {
  it.each<[string, Partial<WorkerQuality>, boolean, string]>([
    ["a good photo", {}, false, "ok"],
    ["no document and almost no text", { documentFound: false, textLines: 2 }, false, "no_document"],
    ["no document, no text", { documentFound: false, textLines: 0, documentConfidence: 0 }, false, "no_document"],
    ["a document without readable text (a blank card)", { textLines: 0 }, false, "unreadable"],
    ["a document with two lines of text", { textLines: 2 }, false, "unreadable"],
    ["three lines of text is enough", { textLines: 3 }, false, "ok"],
    ["code lines read prove it readable", { textLines: 1 }, true, "ok"],
    ["code lines read, no document found", { documentFound: false, textLines: 1 }, true, "poor"],
    ["text but no document found (flagged, not retaken)", { documentFound: false }, false, "poor"],
    ["blurry but readable", { sharpness: 4 }, false, "poor"],
    ["glare", { glareRatio: 0.03 }, false, "poor"],
    ["too dark", { meanLuma: 40 }, false, "poor"],
    ["too bright", { meanLuma: 230 }, false, "poor"],
    ["a weak detection", { documentConfidence: 0.4 }, false, "poor"],
  ])("%s -> %s", (_label, overrides, codeLines, verdict) => {
    expect(qualityVerdict({ ...GOOD, ...overrides }, codeLines)).toBe(verdict);
  });
});

// ---------------------------------------------------------------------------
// Code lines
// ---------------------------------------------------------------------------
describe("mrzFamily (firm classification from code lines)", () => {
  it.each<[string, string[], string | null]>([
    ["TD3 from Cameroon", td3(), "passport"],
    ["TD3 from another state (passports from any country)", td3({ issuing: "UTO", nationality: "UTO" }), "passport"],
    ["TD1 issued by Cameroon to a Cameroonian", td1(), "cni_biometric"],
    ["TD1 issued by Cameroon, code I<", td1({ code: "I" }), "cni_biometric"],
    ["TD1 issued by Cameroon to a foreigner", td1({ code: "IR", nationality: "NGA" }), "residence_permit"],
    ["TD1 issued by Cameroon to a refugee", td1({ code: "IR", nationality: "XXB" }), "residence_permit"],
    ["TD1 issued by another state", td1({ issuing: "UTO", nationality: "UTO" }), "foreign_card"],
    ["TD1 issued by another state to a Cameroonian", td1({ issuing: "NGA" }), "foreign_card"],
    ["TD1 with a code that is not an ID card", td1({ code: "V" }), null],
  ])("%s -> %s", (_label, lines, family) => {
    const parsed = parseMrz(lines, TODAY);
    expect(parsed).not.toBeNull();
    expect(mrzFamily(parsed!)).toBe(family);
  });
});

describe("readServerMrz", () => {
  const passport = { side: "document_front", format: "TD3", required: true } as const;
  const cniBack = { side: "document_back", format: "TD1", required: true } as const;

  it("reads the expected lines on the side that carries them, through the shared corrector", () => {
    const lines = td3();
    // OCR noise the corrector fixes: a space, lower case, an O for a 0 in the birth date.
    const noisy = [lines[0].toLowerCase(), lines[1].slice(0, 13) + "9OO101" + lines[1].slice(19)];
    const read = readServerMrz(["PASSEPORT", ...noisy, "RANDOM TEXT"], passport, "document_front", TODAY);
    expect(read.lines).toEqual(lines);
    expect(read.anyRead).toBe(true);
    expect(read.family).toEqual({ family: "passport", valid: true });
    expect(read.check).toEqual({
      outcome: "pass",
      details: {
        parserVersion: MRZ_PARSER_VERSION,
        found: true,
        format: "TD3",
        checks: { documentNumber: true, birthDate: true, expiryDate: true, personalNumber: true, composite: true },
        documentCodeFits: true,
        datesValid: true,
        corrections: 2,
        phone: "missing",
      },
    });
  });

  it("flags lines read with a wrong check digit, and keeps them for staff", () => {
    const lines = breakCheck(td1(), "TD1");
    const read = readServerMrz(lines, cniBack, "document_back", TODAY);
    expect(read.lines).toEqual(lines);
    expect(read.check?.outcome).toBe("flag");
    expect(read.check?.details).toMatchObject({ found: true, checks: { documentNumber: false, composite: false } });
    expect(read.family).toEqual({ family: "cni_biometric", valid: false });
  });

  it("reports the other format on the expected side without keeping its lines", () => {
    const read = readServerMrz(td1(), passport, "document_front", TODAY);
    expect(read.lines).toBeNull();
    expect(read.check?.outcome).toBe("flag");
    expect(read.check?.details).toMatchObject({ found: false, format: "TD1", documentCodeFits: false });
    expect(read.family).toEqual({ family: "cni_biometric", valid: true });
  });

  it("tries both formats on a side that carries none, for the classification only", () => {
    const read = readServerMrz(td1({ issuing: "UTO", nationality: "UTO" }), null, "document_back", TODAY);
    expect(read).toEqual({ lines: null, check: null, family: { family: "foreign_card", valid: true }, anyRead: true });
    const front = readServerMrz(td1(), cniBack, "document_front", TODAY);
    expect(front).toMatchObject({ lines: null, check: null, family: { family: "cni_biometric" } });
  });

  it("reports nothing found when no candidate is an MRZ", () => {
    const read = readServerMrz(["REPUBLIQUE DU CAMEROUN", "<<<<"], cniBack, "document_back", TODAY);
    expect(read).toEqual({
      lines: null,
      family: null,
      anyRead: false,
      check: {
        outcome: "flag",
        details: {
          parserVersion: MRZ_PARSER_VERSION,
          found: false,
          format: null,
          checks: null,
          documentCodeFits: null,
          datesValid: null,
          corrections: 0,
          phone: "missing",
        },
      },
    });
    expect(readServerMrz([], null, "document_front", TODAY)).toEqual({ lines: null, check: null, family: null, anyRead: false });
  });
});

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------
describe("fields", () => {
  it("names the fields found, never their values and never the sub-type", () => {
    expect(fieldsCheck({ surname: "Doe", issueDate: "2025-03-01", subtype: "refugee" })).toEqual({
      outcome: "pass",
      details: { found: ["surname", "issueDate"], provisional: true },
    });
    expect(fieldsCheck({ subtype: "carte_de_sejour" })).toEqual({ outcome: "flag", details: { found: [], provisional: true } });
    expect(fieldsCheck({})).toEqual({ outcome: "flag", details: { found: [], provisional: true } });
  });

  it("stores the fields (sub-type included) as a JSON object in a fixed order", () => {
    expect(fieldsPlaintext({ subtype: "refugee", surname: "Doe", givenNames: "Jane" }))
      .toBe('{"surname":"Doe","givenNames":"Jane","subtype":"refugee"}');
    expect(fieldsPlaintext({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One photo
// ---------------------------------------------------------------------------
function result(overrides: Partial<WorkerResultRequest> = {}): WorkerResultRequest {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    engine: "worker-1/rapidocr-3.10.0/ppocrv6",
    quality: GOOD,
    mrzCandidates: [],
    classification: { rotation: 0, keywordHits: {}, qrPresent: false, orientation: "landscape" },
    fields: {},
    timing: { ms: 2100, cold: false },
    ...overrides,
  };
}

describe("decideCapture", () => {
  it("writes quality_server, mrz_server (MRZ side only) and ocr_fields, versioned", () => {
    const back = decideCapture(result({ mrzCandidates: td1() }), "document_back", "cni_biometric", TODAY);
    expect(back.checks.map((c) => [c.name, c.version, c.outcome])).toEqual([
      ["quality_server", SERVER_CHECKS_VERSION, "pass"],
      ["mrz_server", MRZ_PARSER_VERSION, "pass"],
      ["ocr_fields", SERVER_CHECKS_VERSION, "flag"],
    ]);
    expect(back.mrzLines).toBe(td1().join("\n"));
    expect(back.mrzFormat).toBe("TD1");
    expect(back.evidence).toEqual({
      mrz: { family: "cni_biometric", valid: true },
      expectedMrzFound: true,
      expectedMrzValid: true,
      keywordHits: {},
      qrPresent: false,
      orientation: "landscape",
    });
    const front = decideCapture(result(), "document_front", "cni_biometric", TODAY);
    expect(front.checks.map((c) => c.name)).toEqual(["quality_server", "ocr_fields"]);
    expect(front.evidence.expectedMrzFound).toBeNull();
    expect(front.evidence.expectedMrzValid).toBeNull();
    expect(front.mrzLines).toBeNull();
  });

  it("copies only the known metrics and keeps zero keyword counts out", () => {
    const decision = decideCapture(
      result({
        quality: { ...GOOD, extra: "x" } as unknown as WorkerQuality,
        classification: { rotation: 90, keywordHits: { passport: 2, residence: 0 }, qrPresent: true, orientation: "portrait" },
      }),
      "document_front",
      "passport",
      TODAY,
    );
    expect(decision.checks[0].details).toEqual({
      verdict: "ok",
      quality: GOOD,
      provisional: true,
      engine: "worker-1/rapidocr-3.10.0/ppocrv6",
      timing: { ms: 2100, cold: false },
    });
    expect(decision.evidence.keywordHits).toEqual({ passport: 2 });
  });

  it("an unreadable photo is unreadable, unless code lines were read", () => {
    expect(decideCapture(result({ quality: { ...GOOD, textLines: 1 } }), "document_back", "cni_biometric", TODAY).verdict)
      .toBe("unreadable");
    expect(decideCapture(result({ quality: { ...GOOD, textLines: 1 }, mrzCandidates: td1() }), "document_back", "cni_biometric", TODAY).verdict)
      .toBe("ok");
  });

  it("puts nothing read from the document into check details or evidence", () => {
    const refugee = td1({ code: "IR", nationality: "XXB" });
    const decision = decideCapture(
      result({
        mrzCandidates: refugee,
        fields: { surname: "Doe", givenNames: "Jane", expiryDate: "2031-01-01", subtype: "refugee" },
        classification: { rotation: 0, keywordHits: { residence: 1 }, qrPresent: true, orientation: null },
      }),
      "document_back",
      "residence_permit",
      TODAY,
    );
    const visible = JSON.stringify([decision.checks, decision.evidence]);
    for (const value of [...VALUES, "refugee", "XXB"]) expect(visible).not.toContain(value);
    // The values go only to the encrypted rows.
    expect(decision.mrzLines).toBe(refugee.join("\n"));
    expect(decision.fields).toContain("refugee");
  });
});

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------
function evidence(overrides: Partial<CaptureEvidence> = {}): CaptureEvidence {
  return {
    mrz: null,
    expectedMrzFound: null,
    expectedMrzValid: null,
    keywordHits: {},
    qrPresent: false,
    orientation: null,
    ...overrides,
  };
}

function side(kind: CaseSide["kind"], ev: CaptureEvidence | null): CaseSide {
  return { kind, captureId: `${kind}-id`, evidence: ev };
}

describe("decideCase", () => {
  it("decides nothing while no photo has a result", () => {
    expect(decideCase("passport", [side("document_front", null)])).toBeNull();
    expect(decideCase("passport", [])).toBeNull();
  });

  type Row = [string, DeclaredDocument, CaseSide[], { detected: string; basis: string; outcome: string }, PolicyReason[]];
  const firmCni = evidence({ mrz: { family: "cni_biometric", valid: true }, expectedMrzFound: true, expectedMrzValid: true });
  const rows: Row[] = [
    [
      "a new CNI, code lines on the back: firm and matching",
      "cni_biometric",
      [side("document_front", evidence({ orientation: "portrait" })), side("document_back", firmCni)],
      { detected: "cni_biometric", basis: "mrz", outcome: "pass" },
      [],
    ],
    [
      "a passport from another state",
      "passport",
      [side("document_front", evidence({ mrz: { family: "passport", valid: true }, expectedMrzFound: true, expectedMrzValid: true }))],
      { detected: "passport", basis: "mrz", outcome: "pass" },
      [],
    ],
    [
      "a passport whose check digits fail: still firm, confidence lower, and a person must look",
      "passport",
      [side("document_front", evidence({ mrz: { family: "passport", valid: false }, expectedMrzFound: true, expectedMrzValid: false }))],
      { detected: "passport", basis: "mrz", outcome: "pass" },
      ["mrz_invalid_server"],
    ],
    [
      "a new CNI whose code lines read with a wrong check digit (as the phone read them)",
      "cni_biometric",
      [
        side("document_front", evidence({ orientation: "portrait" })),
        side("document_back", evidence({ mrz: { family: "cni_biometric", valid: false }, expectedMrzFound: true, expectedMrzValid: false })),
      ],
      { detected: "cni_biometric", basis: "mrz", outcome: "pass" },
      ["mrz_invalid_server"],
    ],
    [
      "check digits right but a date or the document code wrong: invalid too",
      "passport",
      [side("document_front", evidence({ mrz: { family: "passport", valid: true }, expectedMrzFound: true, expectedMrzValid: false }))],
      { detected: "passport", basis: "mrz", outcome: "pass" },
      ["mrz_invalid_server"],
    ],
    [
      "wrong check digits on the side that does not carry the code lines: no reason (they are not the expected ones)",
      "cni_biometric",
      [side("document_front", evidence({ mrz: { family: "cni_biometric", valid: false } })), side("document_back", firmCni)],
      { detected: "cni_biometric", basis: "mrz", outcome: "pass" },
      [],
    ],
    [
      "a new CNI declared as an old one",
      "cni_legacy",
      [side("document_front", evidence()), side("document_back", evidence({ mrz: { family: "cni_biometric", valid: true } }))],
      { detected: "cni_biometric", basis: "mrz", outcome: "flag" },
      ["manual_review_document", "type_mismatch"],
    ],
    [
      "a foreigner's card (any sub-type gives the same answer)",
      "residence_permit",
      [
        side("document_front", evidence()),
        side("document_back", evidence({ mrz: { family: "residence_permit", valid: true }, expectedMrzFound: true, expectedMrzValid: true })),
      ],
      { detected: "residence_permit", basis: "mrz", outcome: "pass" },
      ["manual_review_document"],
    ],
    [
      "a TD1 card issued by another state",
      "cni_biometric",
      [
        side("document_front", evidence()),
        side("document_back", evidence({ mrz: { family: "foreign_card", valid: true }, expectedMrzFound: true, expectedMrzValid: true })),
      ],
      { detected: "unknown", basis: "mrz", outcome: "flag" },
      ["unsupported_document"],
    ],
    [
      "a new CNI whose code lines the server could not read",
      "cni_biometric",
      [
        side("document_front", evidence({ keywordHits: { national_id: 2, republic: 2 }, orientation: "portrait" })),
        side("document_back", evidence({ expectedMrzFound: false, qrPresent: true })),
      ],
      { detected: "cni_biometric", basis: "keywords", outcome: "flag" },
      ["mrz_unreadable_server", "provisional_classification"],
    ],
    [
      "an old CNI by keywords (landscape, no QR code)",
      "cni_legacy",
      [side("document_front", evidence({ keywordHits: { national_id: 2 }, orientation: "landscape" })), side("document_back", evidence())],
      { detected: "cni_legacy", basis: "keywords", outcome: "flag" },
      ["manual_review_document", "provisional_classification"],
    ],
    [
      "a driving licence by keywords",
      "driving_licence",
      [side("document_front", evidence({ keywordHits: { driving_licence: 2 } })), side("document_back", null)],
      { detected: "driving_licence", basis: "keywords", outcome: "flag" },
      ["manual_review_document", "provisional_classification"],
    ],
    [
      "a voter card shown for a passport: keywords never decide a mismatch",
      "passport",
      [side("document_front", evidence({ keywordHits: { voter_card: 3 }, expectedMrzFound: false }))],
      { detected: "voter_card", basis: "keywords", outcome: "flag" },
      ["manual_review_document", "mrz_unreadable_server", "provisional_classification"],
    ],
    [
      "a residence permit without code lines (an old blue card): not unreadable, it is optional",
      "residence_permit",
      [side("document_front", evidence({ keywordHits: { residence: 1 } })), side("document_back", evidence({ expectedMrzFound: false }))],
      { detected: "residence_permit", basis: "keywords", outcome: "flag" },
      ["manual_review_document", "provisional_classification"],
    ],
    [
      "tied keywords: not recognised (never called provisional)",
      "voter_card",
      [side("document_front", evidence({ keywordHits: { voter_card: 1, driving_licence: 1, specimen: 3 } }))],
      { detected: "unknown", basis: "none", outcome: "flag" },
      ["manual_review_document", "unrecognised_document"],
    ],
    [
      "supporting groups alone decide nothing",
      "voter_card",
      [side("document_front", evidence({ keywordHits: { republic: 2, field_labels: 5 } }))],
      { detected: "unknown", basis: "none", outcome: "flag" },
      ["manual_review_document", "unrecognised_document"],
    ],
    [
      "a new CNI's front alone, nothing recognised yet: the only reason says so",
      "cni_biometric",
      [side("document_front", evidence({ orientation: "portrait" })), side("document_back", null)],
      { detected: "unknown", basis: "none", outcome: "flag" },
      ["unrecognised_document"],
    ],
  ];

  it.each(rows)("%s", (_label, declared, sides, expected, reasons) => {
    const decision = decideCase(declared, sides)!;
    expect(decision.classification.details).toMatchObject({
      detected: expected.detected,
      basis: expected.basis,
      provisional: expected.basis !== "mrz",
    });
    expect(decision.classification.outcome).toBe(expected.outcome);
    expect(decision.reasons).toEqual(reasons);
  });

  it("prefers the code lines of the side that carries them, then valid ones", () => {
    const decision = decideCase("cni_biometric", [
      side("document_front", evidence({ mrz: { family: "passport", valid: true } })),
      side("document_back", evidence({ mrz: { family: "cni_biometric", valid: false }, expectedMrzFound: true })),
    ])!;
    expect(decision.classification.details).toMatchObject({ detected: "cni_biometric", confidence: 0.8, matchesDeclared: true });
  });

  it("adds keyword hits over the sides, reports a QR code on any side, and scores provisional reads lower", () => {
    const decision = decideCase("cni_biometric", [
      side("document_front", evidence({ keywordHits: { national_id: 1, republic: 1 }, orientation: "landscape" })),
      side("document_back", evidence({ keywordHits: { national_id: 1, passport: 1 }, qrPresent: true })),
    ])!;
    expect(decision.classification.details).toEqual({
      detected: "cni_biometric",
      basis: "keywords",
      provisional: true,
      matchesDeclared: true,
      confidence: 0.333,
      qrPresent: true,
    });
    expect(decision.classification.score).toBe(0.333);
  });

  it("never names a sub-type or a nationality", () => {
    const decision = decideCase("residence_permit", [
      side("document_back", evidence({ mrz: { family: "residence_permit", valid: true }, expectedMrzFound: true })),
    ]);
    const text = JSON.stringify(decision);
    for (const word of ["refugee", "sejour", "resident\"", "XXB", "nationality"]) expect(text).not.toContain(word);
  });

  it("writes exactly the contract's classification keys, the ones the database accepts", async () => {
    const decided = decideCase("passport", [side("document_front", evidence({ keywordHits: { republic: 2, passport: 2 } }))])!;
    expect(Object.keys(decided.classification.details)).toEqual([...CLASSIFICATION_DETAIL_KEYS]);
    // private.worker_apply_case refuses any other key: a key added here alone would refuse every result.
    // node:fs through a variable, so that type checkers without Node's types (deno check) skip it.
    const nodeFs = "node:fs";
    const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL, encoding: "utf8"): string };
    const migration = readFileSync(new URL("../../migrations/20261016000000_m3_worker.sql", import.meta.url), "utf8");
    const accepted = /where k not in \(([^)]*)\)/.exec(migration)?.[1] ?? "";
    expect([...accepted.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...CLASSIFICATION_DETAIL_KEYS]);
  });

  it("gives a Cameroonian passport and a foreign one the very same check results (admins read them)", () => {
    // The counts the real pipeline gives on the two specimen passports: only the Cameroonian page prints
    // "RÉPUBLIQUE DU CAMEROUN", and the two print different numbers of labels.
    const passport = (issuing: string, keywordHits: WorkerResultRequest["classification"]["keywordHits"]) =>
      result({
        mrzCandidates: td3({ issuing, nationality: issuing }),
        classification: { rotation: 0, keywordHits, qrPresent: false, orientation: "landscape" },
        fields: { surname: "SPECIMEN", givenNames: "TESTA", issueDate: "2025-03-01" },
      });
    const cmr = passport("CMR", { republic: 2, passport: 2, field_labels: 11, specimen: 1 });
    const foreign = passport("UTO", { republic: 0, passport: 2, field_labels: 7, specimen: 1 });
    // Everything that becomes a check_result row: the photo's checks and the case's two checks.
    const stored = (request: WorkerResultRequest) => {
      const photo = decideCapture(request, "document_front", "passport", TODAY);
      const decided = decideCase("passport", [side("document_front", photo.evidence)])!;
      return { photo: photo.checks, classification: decided.classification, reasons: decided.reasons };
    };
    expect(stored(cmr)).toEqual(stored(foreign));
    expect(JSON.stringify(stored(cmr))).not.toMatch(/keyword|republic|field_labels|CMR|UTO/);
    // The counts stay in the job's evidence, which staff cannot read.
    expect(decideCapture(cmr, "document_front", "passport", TODAY).evidence.keywordHits).toMatchObject({ republic: 2 });
  });

  it("never turns a poor photo into a reason: quality is provisional and only shown", () => {
    const poor = decideCapture(result({ quality: { ...GOOD, glareRatio: 0.05 }, mrzCandidates: td3() }), "document_front", "passport", TODAY);
    expect(poor.verdict).toBe("poor");
    expect(decideCase("passport", [side("document_front", poor.evidence)])!.reasons).toEqual([]);
  });

  it("turns lines the server read with a wrong check digit into a reason, end to end", () => {
    const broken = decideCapture(result({ mrzCandidates: breakCheck(td3(), "TD3") }), "document_front", "passport", TODAY);
    expect(broken.checks.find((c) => c.name === "mrz_server")?.outcome).toBe("flag");
    expect(broken.evidence).toMatchObject({ expectedMrzFound: true, expectedMrzValid: false });
    expect(decideCase("passport", [side("document_front", broken.evidence)])!.reasons).toEqual(["mrz_invalid_server"]);
  });
});

describe("M4: the sides that count", () => {
  it("ignores a photo of a side the declared document does not need (left from an earlier choice)", () => {
    // An expired-looking new CNI was photographed first; the rider then chose a passport.
    const oldBack = evidence({ mrz: { family: "cni_biometric", valid: true }, expectedMrzFound: true, expectedMrzValid: true });
    const page = evidence({ mrz: { family: "passport", valid: true }, expectedMrzFound: true, expectedMrzValid: true });
    const decision = decideCase("passport", [side("document_front", page), side("document_back", oldBack)])!;
    expect(decision.classification.details).toMatchObject({ detected: "passport", matchesDeclared: true });
    expect(decision.reasons).toEqual([]);
    // Only the leftover side has a result: nothing to decide yet.
    expect(decideCase("passport", [side("document_front", null), side("document_back", oldBack)])).toBeNull();
  });
});

describe("decideCaseChecks", () => {
  const page = evidence({ mrz: { family: "passport", valid: true }, expectedMrzFound: true, expectedMrzValid: true });
  const front = { kind: "document_front" as const, captureId: "document_front-id" };

  it("adds the consistency check, its flags joining the reasons (sorted)", () => {
    const lines = td3();
    const checks = decideCaseChecks({
      declaredDocument: "passport",
      sides: [side("document_front", page)],
      documentData: [{ ...front, mrzLines: lines, fields: { surname: "AUTRE" } }],
    }, TODAY)!;
    expect(checks.version).toBe(SERVER_CHECKS_VERSION);
    expect(checks.consistency).toEqual({
      outcome: "flag",
      details: { flags: ["mrz_print_mismatch"], provisional: [], basis: "mrz", mismatches: ["name"] },
    });
    expect(checks.reasons).toEqual(["mrz_print_mismatch"]);
  });

  it("decides nothing while no photo has a result, and compares nothing for a photo without values", () => {
    expect(decideCaseChecks({ declaredDocument: "passport", sides: [side("document_front", null)], documentData: [] }, TODAY)).toBeNull();
    const checks = decideCaseChecks({ declaredDocument: "passport", sides: [side("document_front", page)], documentData: [] }, TODAY)!;
    expect(checks.consistency).toEqual({ outcome: "skipped", details: { flags: [], provisional: [], basis: "none", mismatches: [] } });
  });

  it("uses no value of a photo that is not the side's newest, nor of a side the document does not need", () => {
    const checks = decideCaseChecks({
      declaredDocument: "passport",
      sides: [side("document_front", page), side("document_back", evidence())],
      documentData: [
        { kind: "document_front", captureId: "an-older-photo", mrzLines: null, fields: { surname: "X", expiryDate: "2001-01-01" } },
        { kind: "document_back", captureId: "document_back-id", mrzLines: td1(), fields: { expiryDate: "2001-01-01" } },
      ],
    }, TODAY)!;
    expect(checks.consistency?.details).toEqual({ flags: [], provisional: [], basis: "none", mismatches: [] });
  });
});

describe("parseEvidence", () => {
  it("reads back what decideCapture stored", () => {
    const stored = decideCapture(result({ mrzCandidates: td1(), classification: { rotation: 0, keywordHits: { national_id: 1 }, qrPresent: true, orientation: "portrait" } }), "document_back", "cni_biometric", TODAY).evidence;
    expect(parseEvidence(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it.each([
    null,
    [],
    { ...evidence(), mrz: { family: "refugee", valid: true } },
    { ...evidence(), mrz: { family: "passport" } },
    { ...evidence(), qrPresent: "yes" },
    { ...evidence(), orientation: "upside_down" },
    { ...evidence(), keywordHits: { refugee: 1 } },
    { ...evidence(), keywordHits: { passport: -1 } },
    { ...evidence(), expectedMrzFound: "no" },
    { ...evidence(), expectedMrzValid: "no" },
    (({ expectedMrzValid: _, ...rest }) => rest)(evidence()),
  ])("refuses %j", (value) => {
    expect(parseEvidence(value)).toBeNull();
  });
});
