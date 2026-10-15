#!/usr/bin/env bash
# Stage 4: exports a checkpoint as the models Tesseract loads.
#   - mrz.traineddata: the INTEGER model (--convert_to_int), the one tesseract.js 7.0.0 can run (it
#     aborts on float models); mrz.traineddata.gz is what the rider site would serve as
#     /ocr/mrz-2/mrz.traineddata.gz (gzip -9n: byte-for-byte reproducible).
#   - mrz_float.traineddata: the float model from the same checkpoint, for native Tesseract
#     (lstmeval in the gates); never shipped to phones.
#
#   bin/40-export.sh scratch                 the run's best checkpoint (lowest training error)
#   bin/40-export.sh scratch latest          the run's last checkpoint (mrz_checkpoint)
#   bin/40-export.sh scratch PATH.checkpoint a given one
# Writes work/models/<run>-<checkpoint>/ with model.json (sizes and SHA-256). A few seconds.
source "$(dirname "$0")/env.sh"

RUN="${1:?usage: 40-export.sh RUN [best|latest|CHECKPOINT]}"
which="${2:-best}"
CK="$RUNS/$RUN/checkpoints"
PROTO="$TRAIN/$MODEL_NAME/$MODEL_NAME.traineddata"
case "$which" in
  best)
    # Best-model files are named mrz_<training error %>_<learning iteration>_<iteration>.checkpoint.
    name=$(find "$CK" -name "${MODEL_NAME}_*_*_*.checkpoint" -printf '%f\n' | sort -t_ -k2,2g -k4,4nr | head -1)
    checkpoint="$CK/${name:-${MODEL_NAME}_checkpoint}" ;;
  latest) checkpoint="$CK/${MODEL_NAME}_checkpoint" ;;
  *) checkpoint="$which" ;;
esac
[ -f "$checkpoint" ] || { echo "error: no checkpoint $checkpoint" >&2; exit 1; }
label=$(basename "$checkpoint" .checkpoint)
label="${label#"${MODEL_NAME}"_}"
out="$MODELS/$RUN-$label"
mkdir -p "$out"

lstmtraining --stop_training --convert_to_int --continue_from "$checkpoint" --traineddata "$PROTO" \
  --model_output "$out/$MODEL_NAME.traineddata" >"$out/export.log" 2>&1
lstmtraining --stop_training --continue_from "$checkpoint" --traineddata "$PROTO" \
  --model_output "$out/${MODEL_NAME}_float.traineddata" >>"$out/export.log" 2>&1
gzip -9n -c "$out/$MODEL_NAME.traineddata" >"$out/$MODEL_NAME.traineddata.gz"
# The integer model must load in native Tesseract (a broken export fails here, not in the gates).
combine_tessdata -d "$out/$MODEL_NAME.traineddata" >>"$out/export.log" 2>&1

size() { stat -c %s "$1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
cat >"$out/model.json" <<EOF
{"run": "$RUN", "checkpoint": "$(basename "$checkpoint")", "exported": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "integer": {"file": "$MODEL_NAME.traineddata", "bytes": $(size "$out/$MODEL_NAME.traineddata"), "sha256": "$(sha "$out/$MODEL_NAME.traineddata")"},
 "integerGz": {"file": "$MODEL_NAME.traineddata.gz", "bytes": $(size "$out/$MODEL_NAME.traineddata.gz"), "sha256": "$(sha "$out/$MODEL_NAME.traineddata.gz")"},
 "float": {"file": "${MODEL_NAME}_float.traineddata", "bytes": $(size "$out/${MODEL_NAME}_float.traineddata"), "sha256": "$(sha "$out/${MODEL_NAME}_float.traineddata")"},
 "protoModelSha256": "$(sha "$PROTO")", "training": $(cat "$RUNS/$RUN/run.json" 2>/dev/null || echo null)}
EOF
log "export: $out ($(size "$out/$MODEL_NAME.traineddata.gz") bytes gzipped)"
echo "$out"
