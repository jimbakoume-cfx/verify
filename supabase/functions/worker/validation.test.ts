import { describe, expect, it } from "vitest";
import { WORKER_LIMITS } from "../_shared/contract.ts";
import { validateClaimBody, validateImageRequest, validateResultRequest } from "./validation.ts";

const JOB = "11111111-1111-4111-8111-111111111111";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: JOB,
    attempt: 1,
    engine: "worker-1/rapidocr-3.10.0/ppocrv6",
    quality: {
      sharpness: 41.5,
      glareRatio: 0.002,
      meanLuma: 133.3,
      documentFound: true,
      documentConfidence: 0.91,
      longSide: 1600,
      textLines: 14,
    },
    mrzCandidates: ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<"],
    classification: { rotation: 90, keywordHits: { passport: 1, republic: 0 }, qrPresent: false, orientation: "portrait" },
    fields: { surname: "Eriksson", issueDate: "2025-03-01" },
    timing: { ms: 2100, cold: true },
    ...overrides,
  };
}

function withQuality(overrides: Record<string, unknown>) {
  return body({ quality: { ...(body().quality as object), ...overrides } });
}

function withClassification(overrides: Record<string, unknown>) {
  return body({ classification: { ...(body().classification as object), ...overrides } });
}

describe("validateResultRequest", () => {
  it("accepts a complete result and returns a fresh copy", () => {
    const input = body();
    const check = validateResultRequest(input);
    expect(check).toEqual({ ok: true, value: input });
    if (check.ok) expect(check.value.quality).not.toBe(input.quality);
  });

  it("accepts the limits exactly", () => {
    const check = validateResultRequest(body({
      attempt: 3,
      engine: "e".repeat(WORKER_LIMITS.maxEngineLength),
      mrzCandidates: Array(WORKER_LIMITS.maxMrzCandidates).fill("<".repeat(WORKER_LIMITS.maxCandidateLength)),
      fields: { surname: "A".repeat(WORKER_LIMITS.maxFieldLength) },
      timing: { ms: 300_000, cold: false },
    }));
    expect(check.ok).toBe(true);
  });

  it("lower-cases the job id, trims field values and drops empty ones", () => {
    const check = validateResultRequest(body({ jobId: JOB.toUpperCase(), fields: { surname: "  Doe ", givenNames: "   " } }));
    expect(check).toMatchObject({ ok: true, value: { jobId: JOB, fields: { surname: "Doe" } } });
    if (check.ok) expect(check.value.fields).not.toHaveProperty("givenNames");
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown top-level field", body({ rawText: "ERIKSSON" })],
    ["a missing jobId", body({ jobId: undefined })],
    ["a jobId that is not a UUID", body({ jobId: "job-1" })],
    ["attempt 0", body({ attempt: 0 })],
    ["attempt 4", body({ attempt: 4 })],
    ["attempt 1.5", body({ attempt: 1.5 })],
    ["an engine with a space", body({ engine: "worker 1" })],
    ["an engine too long", body({ engine: "e".repeat(WORKER_LIMITS.maxEngineLength + 1) })],
    ["quality missing", body({ quality: undefined })],
    ["an unknown quality field", withQuality({ rawText: "x" })],
    ["a negative sharpness", withQuality({ sharpness: -1 })],
    ["sharpness Infinity", withQuality({ sharpness: Infinity })],
    ["sharpness NaN", withQuality({ sharpness: NaN })],
    ["a glare ratio above 1", withQuality({ glareRatio: 1.5 })],
    ["a mean luma above 255", withQuality({ meanLuma: 256 })],
    ["documentFound as a string", withQuality({ documentFound: "true" })],
    ["a confidence above 1", withQuality({ documentConfidence: 2 })],
    ["a fractional long side", withQuality({ longSide: 1600.5 })],
    ["negative text lines", withQuality({ textLines: -1 })],
    ["mrzCandidates not an array", body({ mrzCandidates: "P<UTO" })],
    ["too many candidates", body({ mrzCandidates: Array(WORKER_LIMITS.maxMrzCandidates + 1).fill("<") })],
    ["a candidate too long", body({ mrzCandidates: ["<".repeat(WORKER_LIMITS.maxCandidateLength + 1)] })],
    ["a lower-case candidate", body({ mrzCandidates: ["p<uto"] })],
    ["a candidate with a space", body({ mrzCandidates: ["P< UTO"] })],
    ["a candidate that is not a string", body({ mrzCandidates: [12] })],
    ["a rotation of 45", withClassification({ rotation: 45 })],
    ["an unknown keyword group", withClassification({ keywordHits: { refugee: 1 } })],
    ["a fractional keyword count", withClassification({ keywordHits: { passport: 0.5 } })],
    ["a negative keyword count", withClassification({ keywordHits: { passport: -1 } })],
    ["keyword hits as an array", withClassification({ keywordHits: [1] })],
    ["qrPresent missing", withClassification({ qrPresent: undefined })],
    ["an unknown orientation", withClassification({ orientation: "square" })],
    ["an unknown classification field", withClassification({ text: "x" })],
    ["an unknown field name", body({ fields: { address: "Rue 1" } })],
    ["a parent's name", body({ fields: { fatherName: "X" } })],
    ["a field that is not a string", body({ fields: { surname: 12 } })],
    ["a field too long", body({ fields: { surname: "A".repeat(WORKER_LIMITS.maxFieldLength + 1) } })],
    ["a field with a control character", body({ fields: { surname: "Doe\nX" } })],
    ["a field with a non-ASCII character", body({ fields: { surname: "Éric" } })],
    ["a sub-type that is not a code", body({ fields: { subtype: "Carte de séjour" } })],
    ["timing missing", body({ timing: undefined })],
    ["timing beyond Vercel's limit", body({ timing: { ms: 300_001, cold: false } })],
    ["timing with an extra field", body({ timing: { ms: 1, cold: false, cpu: 1 } })],
    ["cold as a number", body({ timing: { ms: 1, cold: 1 } })],
  ])("refuses %s, without repeating a value", (_label, input) => {
    const check = validateResultRequest(JSON.parse(JSON.stringify(input, (_k, v) => (Number.isNaN(v) ? "NaN" : v))));
    // JSON cannot carry NaN or Infinity; check those directly too.
    const direct = validateResultRequest(input);
    for (const c of [check, direct]) {
      expect(c.ok).toBe(false);
      if (!c.ok) {
        for (const value of ["ERIKSSON", "Eriksson", "Rue 1", "Doe", "Éric", "séjour"]) expect(c.message).not.toContain(value);
      }
    }
  });

  it(`refuses more than ${WORKER_LIMITS.maxKeywordGroups} keyword groups`, () => {
    const many = Object.fromEntries(Array.from({ length: WORKER_LIMITS.maxKeywordGroups + 1 }, (_, i) => [`g${i}`, 1]));
    expect(validateResultRequest(withClassification({ keywordHits: many })).ok).toBe(false);
  });
});

describe("validateImageRequest", () => {
  it("accepts a job reference only", () => {
    expect(validateImageRequest({ jobId: JOB, attempt: 2 })).toEqual({ ok: true, value: { jobId: JOB, attempt: 2 } });
    expect(validateImageRequest({ jobId: JOB, attempt: 2, path: "x" }).ok).toBe(false);
    expect(validateImageRequest({ jobId: "../x", attempt: 2 }).ok).toBe(false);
    expect(validateImageRequest({ jobId: JOB }).ok).toBe(false);
  });
});

describe("validateClaimBody", () => {
  it("accepts an empty body or {}", () => {
    expect(validateClaimBody(null).ok).toBe(true);
    expect(validateClaimBody({}).ok).toBe(true);
    expect(validateClaimBody({ kind: "document_front" }).ok).toBe(false);
  });
});
