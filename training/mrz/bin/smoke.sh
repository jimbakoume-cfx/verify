#!/usr/bin/env bash
# The whole pipeline, tiny, end to end: proves the plumbing (data, .lstmf, training from zero,
# resuming it, the fine-tune fallback, export, benchmark, gates) in work/smoke/, and records how long
# each stage took in work/smoke/timings.json. The models it trains are far too small to pass the gates; the
# gates must run and write their report, nothing more.
#
#   bin/smoke.sh          about 15 minutes on 4 vCPU (see README.md)
# Uses the shared work/inputs and work/bench (the first 200 benchmark stills). Delete work/smoke
# afterwards: `rm -rf training/mrz/work/smoke`.
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"
MRZ_DIR="$(cd "$BIN/.." && pwd)"
export MRZ_WORK="$MRZ_DIR/work/smoke"
export MRZ_INPUTS="$MRZ_DIR/work/inputs"
export MRZ_BENCH="$MRZ_DIR/work/bench"
export LINES="${SMOKE_LINES:-3000}" G1_CLEAN=100 G1_DEGRADED=100 G1_LOWRES=100
export PROGRESS_EVERY=30
source "$BIN/env.sh"

timings="$WORK/timings.json"
echo "{" >"$timings"
stage() { # stage NAME COMMAND...: runs a stage, records its wall time
  local name="$1" t0
  shift
  t0=$(date +%s)
  "$@"
  printf '  "%s": %d,\n' "$name" $(( $(date +%s) - t0 )) >>"$timings"
}

stage setup "$BIN/00-setup.sh" --finetune
stage data "$BIN/10-data.sh"
stage lstmf "$BIN/20-lstmf.sh"
stage train_scratch_300 env MAX_ITERATIONS=300 "$BIN/30-train.sh"
# Resuming: the same command with a higher limit continues from the checkpoint at 300.
stage train_scratch_resume_to_400 env MAX_ITERATIONS=400 "$BIN/30-train.sh"
grep -q '"resumed": "yes"' "$RUNS/scratch/run.json" || { echo "error: the scratch run did not resume" >&2; exit 1; }
grep -q 'At iteration 400/' "$RUNS/scratch/training.log" || { echo "error: the resumed run did not reach 400" >&2; exit 1; }
stage finetune_200 env MAX_ITERATIONS=200 "$BIN/31-finetune.sh"
grep -q 'Code range changed from 111 to 39' "$RUNS/finetune/training.log" || { echo "error: eng's output layer was not cut to 39" >&2; exit 1; }
scratch=$("$BIN/40-export.sh" scratch latest | tail -1)
finetune=$("$BIN/40-export.sh" finetune | tail -1)
stage bench_200 "$BIN/50-bench.sh" 200
for m in "$scratch" "$finetune"; do
  # Expected to fail the gates (a few hundred iterations); the report must exist.
  stage "gates_$(basename "$m" | cut -d- -f1)_20docs" bash -c '"$0" "$1" --docs 20 || [ -f "$2/report.json" ]' \
    "$BIN/60-gates.sh" "$m" "$GATES/$(basename "$m")"
done
printf '  "threads": %d, "trainThreads": %d, "lines": %d\n}\n' "$THREADS" "$TRAIN_THREADS" "$LINES" >>"$timings"
cat "$WORK/data/summary.json" "$TRAIN/summary.json" "$timings"
log "smoke: done; reports in $GATES/*/report.md"
