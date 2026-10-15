// Runs the worker Edge Function's own case-level decision (supabase/functions/worker: the code lines
// read as readServerMrz reads them, then decideCaseChecks with its consistency checks) on what the
// worker read from whole specimen documents (M4). Used by tests/test_specimens_ocr.py:
//   deno run server_consistency.ts < { today, cases: [{ declaredDocument, sides: [{ kind, mrzCandidates, fields }] }] }
// Prints, per case, the consistency check and the reasons. The specimens are fictitious.
import type { CaptureSide, DeclaredDocument, WorkerFields } from "../../../supabase/functions/_shared/contract.ts";
import { MRZ_EXPECTATION } from "../../../supabase/functions/_shared/contract.ts";
import { decideCaseChecks } from "../../../supabase/functions/worker/case.ts";
import { type CaptureEvidence, readServerMrz } from "../../../supabase/functions/worker/decide.ts";

type Side = { kind: CaptureSide; mrzCandidates: string[]; fields: WorkerFields };
type Input = { today: string; cases: { declaredDocument: DeclaredDocument; sides: Side[] }[] };

const input = JSON.parse(await new Response(Deno.stdin.readable).text()) as Input;
const now = new Date(input.today);
// Evidence only marks the photo as checked here: the consistency checks use the values.
const evidence: CaptureEvidence = {
  mrz: null,
  expectedMrzFound: null,
  expectedMrzValid: null,
  keywordHits: {},
  qrPresent: false,
  orientation: null,
};
const out = input.cases.map(({ declaredDocument, sides }) => {
  const expectation = MRZ_EXPECTATION[declaredDocument];
  const photos = sides.map((side, i) => {
    const read = readServerMrz(side.mrzCandidates, expectation, side.kind, now);
    const { subtype: _subtype, ...fields } = side.fields;
    return { kind: side.kind, captureId: `capture-${i}`, mrzLines: read.lines, fields: Object.keys(fields).length > 0 ? fields : null };
  });
  const checks = decideCaseChecks({
    declaredDocument,
    sides: photos.map((p) => ({ kind: p.kind, captureId: p.captureId, evidence })),
    documentData: photos,
  }, now);
  return { consistency: checks?.consistency ?? null, reasons: checks?.reasons ?? [] };
});
console.log(JSON.stringify(out));
