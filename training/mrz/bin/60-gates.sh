#!/usr/bin/env bash
# Stage 6: measures a model and applies the gates (gates.json, py/gates.py).
#   G1  line CER on the held-out sets (tesseract.js, page segmentation 7), and native lstmeval of
#       the integer and float models (informational);
#   G2  wrong-but-valid reads on the document benchmark through the real rider pipeline;
#   G3  the same benchmark compared with Doubango's model;
#   the repository's own fixtures (6/6) and the gzipped size.
#
#   bin/60-gates.sh work/models/scratch-0.512_43210_150000   a candidate (from bin/40-export.sh)
#   bin/60-gates.sh --baseline                                Doubango's numbers (cached, reused)
#   ... --docs 200                                            only the benchmark's first 200 stills
# Doubango's numbers are measured once per benchmark size and kept in work/gates/doubango/. Writes
# work/gates/<model>/report.md and report.json; exit code 0 only when every automated gate passes.
# About 10 minutes for 1,000 documents on 4 vCPU (twice that the first time, for the baseline).
source "$(dirname "$0")/env.sh"

DOCS=1000
mode=candidate
model=""
while [ $# -gt 0 ]; do
  case "$1" in
    --docs) DOCS="$2"; shift 2 ;;
    --baseline) mode=baseline; shift ;;
    *) model="$(cd "$1" && pwd)"; shift ;;
  esac
done
base="$GATES/doubango"
if [ "$mode" = baseline ]; then
  model="$DOUBANGO"
  out="$base"
else
  [ -n "$model" ] && [ -f "$model/$MODEL_NAME.traineddata.gz" ] || { echo "error: give a model folder from bin/40-export.sh" >&2; exit 1; }
  out="$GATES/$(basename "$model")"
fi
[ -f "$BENCH/bench.json" ] || { echo "error: run bin/50-bench.sh first" >&2; exit 1; }
mkdir -p "$out" "$base"
start=$(date +%s)

g1() { # g1 MODEL_DIR OUT_DIR: line CER per held-out set
  local m="$1" o="$2" set
  for set in clean degraded lowres; do
    [ -d "$G1/$set" ] || continue
    node_ts lineCer.ts --set "$G1/$set" --model "$m" --out "$o/g1-$set.json" --workers "$THREADS" >/dev/null
  done
}
docs() { # docs MODEL_DIR OUT_FILE: the document benchmark, first DOCS stills
  node_ts docbench.ts --bench "$BENCH/bench.json" --model "$1" --out "$2" --limit "$DOCS" --workers "$THREADS"
}
fresh() { # fresh FILE: the cached baseline result exists and was made on the current sets
  [ -f "$1" ] && [ "$1" -nt "$BENCH/bench.json" ] && [ "$1" -nt "$G1" ]
}
g1_fresh() { # g1_fresh DIR: every held-out set has a fresh result there (an interrupted run leaves gaps)
  local set
  for set in clean degraded lowres; do
    [ -d "$G1/$set" ] || continue
    fresh "$1/g1-$set.json" || return 1
  done
}

# Doubango's numbers, once per benchmark size (the candidate is compared with them).
if ! g1_fresh "$base"; then log "gates: Doubango baseline, G1"; g1 "$DOUBANGO" "$base"; fi
if ! fresh "$base/docbench-$DOCS.json"; then
  log "gates: Doubango baseline, $DOCS documents"
  docs "$DOUBANGO" "$base/docbench-$DOCS.json" >/dev/null
fi

if [ "$mode" = candidate ]; then
  log "gates: $(basename "$model"): G1"
  g1 "$model" "$out"
  log "gates: $(basename "$model"): G2/G3, $DOCS documents"
  docs "$model" "$out/docbench.json"
else
  cp "$base/docbench-$DOCS.json" "$out/docbench.json"
fi
node_ts docbench.ts --fixtures --model "$model" --out "$out/fixtures.json" --workers 3 >/dev/null

# Native lstmeval on the G1 sets (character error rate, %), integer and float models.
lstm_int="$model/$MODEL_NAME.traineddata"
if [ ! -f "$lstm_int" ]; then
  lstm_int="$out/int.traineddata"
  gunzip -c "$model/$MODEL_NAME.traineddata.gz" >"$lstm_int"
fi
{
  printf '{'
  sep=""
  for kind in int float; do
    file="$lstm_int"
    [ "$kind" = float ] && file="$model/${MODEL_NAME}_float.traineddata"
    [ -f "$file" ] || continue
    for set in clean degraded lowres; do
      [ -s "$G1/$set.list" ] || continue
      cer=$(OMP_THREAD_LIMIT=1 lstmeval --model "$file" --eval_listfile "$G1/$set.list" 2>&1 | grep -o 'BCER eval=[0-9.]*' | tail -1 | cut -d= -f2)
      printf '%s"%s %s": %s' "$sep" "$kind" "$set" "${cer:-null}"
      sep=", "
    done
  done
  printf '}\n'
} >"$out/lstmeval.json"
rm -f "$out/int.traineddata"

model_json="-"
[ -f "$model/model.json" ] && model_json="$model/model.json"
status=0
"$PY" "$MRZ_DIR/py/gates.py" "$out" "$base" "$MRZ_DIR/gates.json" "$model_json" || status=$?
log "gates: $(basename "$out"): $([ $status -eq 0 ] && echo PASS || echo FAIL) in $(since "$start"), see $out/report.md"
exit $status
