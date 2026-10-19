import { describe, expect, it } from "vitest";
import { checkDigit } from "../_shared/mrz.ts";
import { parseSnapshot } from "./repo.ts";

const VERIFICATION = "00000000-0000-4000-8000-0000000000aa";
const FRONT = "00000000-0000-4000-8000-000000000001";
const BACK = "00000000-0000-4000-8000-000000000002";

function td1(): string {
  const cd = (field: string) => String(checkDigit(field));
  const l1 = "IDCMR" + "AB1234567" + cd("AB1234567") + "<".repeat(15);
  const head = "900101" + cd("900101") + "F" + "350101" + cd("350101") + "CMR" + "<".repeat(11);
  return [l1, head + cd(l1.slice(5, 30) + head.slice(0, 7) + head.slice(8, 15) + head.slice(18, 29)), "SPECIMEN<<TESTA" + "<".repeat(15)]
    .join("\n");
}

/** worker_case_snapshot's JSON (M4: with documentData). */
function snapshot(documentData: unknown[]): Record<string, unknown> {
  return {
    verificationId: VERIFICATION,
    declaredDocument: "cni_biometric",
    fingerprint: "0123456789abcdef0123456789abcdef",
    sides: [
      { kind: "document_front", captureId: FRONT, evidence: null },
      { kind: "document_back", captureId: BACK, evidence: null },
    ],
    job: null,
    documentData,
  };
}

describe("parseSnapshot: documentData (M4)", () => {
  it("reads each photo's code lines and printed fields", () => {
    const parsed = parseSnapshot(snapshot([
      { captureId: FRONT, kind: "document_front", mrzLines: null, fields: { surname: "SPECIMEN", birthDate: "1990-01-01" } },
      { captureId: BACK, kind: "document_back", mrzLines: td1(), fields: null },
    ]));
    expect(parsed?.documentData).toEqual([
      { kind: "document_front", captureId: FRONT, mrzLines: null, fields: { surname: "SPECIMEN", birthDate: "1990-01-01" } },
      { kind: "document_back", captureId: BACK, mrzLines: td1().split("\n"), fields: null },
    ]);
  });

  it.each([
    ["a missing list", undefined],
    ["lines that are not code lines", [{ captureId: BACK, kind: "document_back", mrzLines: "SPECIMEN", fields: null }]],
    ["the card sub-type", [{ captureId: FRONT, kind: "document_front", mrzLines: null, fields: { subtype: "refugee" } }]],
    ["an unknown field", [{ captureId: FRONT, kind: "document_front", mrzLines: null, fields: { address: "RUE" } }]],
    ["a value that is not printable ASCII", [{ captureId: FRONT, kind: "document_front", mrzLines: null, fields: { surname: "HÉLÈNE" } }]],
    ["an over-long value", [{ captureId: FRONT, kind: "document_front", mrzLines: null, fields: { surname: "A".repeat(81) } }]],
    ["an unknown side", [{ captureId: FRONT, kind: "selfie", mrzLines: null, fields: null }]],
  ])("refuses %s, without repeating any value", (_label, documentData) => {
    let message = "";
    try {
      parseSnapshot({ ...snapshot([]), documentData });
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain("unexpected value");
    for (const value of ["SPECIMEN", "refugee", "RUE", "HÉLÈNE"]) expect(message).not.toContain(value);
  });
});
