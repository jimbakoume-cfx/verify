// Runs the Edge Function's own corrector and parser (supabase/functions/_shared) on the worker's
// candidate lines, exactly as readServerMrz does: candidates joined by newlines, then correctMrz and
// parseMrz. Used by tests/test_specimens_ocr.py:  deno run server_mrz.ts < [{ format, candidates }]
import { correctMrz } from "../../../supabase/functions/_shared/mrzCorrect.ts";
import { parseMrz } from "../../../supabase/functions/_shared/mrz.ts";

type Input = { format: "TD1" | "TD3"; candidates: string[] };
const input = JSON.parse(await new Response(Deno.stdin.readable).text()) as Input[];
const today = new Date("2026-10-14T00:00:00Z");
const out = input.map(({ format, candidates }) => {
  const corrected = correctMrz(candidates.join("\n"), format);
  const parsed = corrected.lines ? parseMrz(corrected.lines, today) : null;
  return { lines: corrected.lines, valid: parsed?.valid ?? false, corrections: corrected.corrections };
});
console.log(JSON.stringify(out));
