#!/usr/bin/env bash
# Stage 2: Tesseract's training files, with tesstrain (pinned in inputs.json):
#   - one .lstmf per line image (`tesseract X.png X --psm 13 lstm.train`), THREADS at a time;
#   - the unicharset (37 characters: A-Z, 0-9 and <) and the proto model (combine_lang_model);
#   - list.train / list.eval (96% / 4%, shuffled with a fixed seed);
#   - .lstmf files and lists for the held-out G1 sets (for lstmeval in the gates).
# Resumable: make only builds what is missing. Duration on 4 vCPU: see README.md.
#   bin/20-lstmf.sh          everything
#   bin/20-lstmf.sh --g1     only the G1 sets (after `bin/10-data.sh --g1`)
source "$(dirname "$0")/env.sh"

[ -f "$INPUTS/tesstrain/Makefile" ] || { echo "error: run bin/00-setup.sh first" >&2; exit 1; }
start=$(date +%s)
export OMP_THREAD_LIMIT=1

if [ "${1:-}" != "--g1" ]; then
  [ -d "$GT" ] || { echo "error: run bin/10-data.sh first" >&2; exit 1; }
  mkdir -p "$TRAIN"
  log "lstmf: training files (tesstrain, $THREADS jobs)"
  # TESSERACT_SCRIPTS=Latin: the proto model needs only the Latin script's character properties
  # (tesstrain would otherwise want all 32 script files). RATIO_TRAIN 0.96 keeps about 3k lines for
  # lstmtraining's own evaluation.
  make -C "$INPUTS/tesstrain" -j "$THREADS" \
    MODEL_NAME="$MODEL_NAME" DATA_DIR="$TRAIN" GROUND_TRUTH_DIR="$GT" LANGDATA_DIR="$INPUTS/langdata" \
    TESSERACT_SCRIPTS=Latin RATIO_TRAIN=0.96 RANDOM_SEED=0 PSM=13 PY_CMD="$PY" \
    unicharset lists proto-model >"$LOGS/tesstrain-make.log" 2>&1 \
    || { tail -20 "$LOGS/tesstrain-make.log" >&2; exit 1; }
fi

log "lstmf: held-out G1 sets"
for set in clean degraded lowres; do
  dir="$G1/$set"
  [ -d "$dir" ] || continue
  find "$dir" -name '*.png' | sed 's/\.png$//' | sort | while read -r base; do
    [ -f "$base.lstmf" ] || echo "$base"
  done | xargs -r -P "$THREADS" -I{} tesseract {}.png {} --psm 13 lstm.train 2>/dev/null >/dev/null
  find "$dir" -name '*.lstmf' | sort >"$G1/$set.list"
done

if [ "${1:-}" = "--g1" ]; then
  log "lstmf: G1 sets done in $(since "$start")"
  exit 0
fi
out="$TRAIN/$MODEL_NAME"
# (tesstrain writes the lists without a final newline: grep -c counts the last line too.)
summary=$(printf '{"train": %d, "eval": %d, "unicharset": %d, "protoModelSha256": "%s"}' \
  "$(grep -c '' "$out/list.train")" "$(grep -c '' "$out/list.eval")" "$(head -1 "$out/unicharset")" \
  "$(sha256sum "$out/$MODEL_NAME.traineddata" | cut -d' ' -f1)")
echo "$summary" >"$TRAIN/summary.json"
log "lstmf: done in $(since "$start"): $summary"
