#!/usr/bin/env bash
# Stage 3, run 1: trains the MRZ model FROM ZERO on our own data only (cleanest provenance).
#
#   bin/30-train.sh                         150,000 iterations (about 4.5 h on 4 vCPU, see README.md)
#   MAX_ITERATIONS=200000 bin/30-train.sh   go further: the same command continues a stopped or
#                                           finished run from its last checkpoint
#   nohup bin/30-train.sh >work/logs/train-scratch.out 2>&1 &     overnight, detached
#
# Resumable: lstmtraining saves <run>/checkpoints/mrz_checkpoint every 100 iterations and, when
# started again with the same output name, continues from it (a stop loses at most 100
# iterations). Progress: <run>/progress.log (one line every PROGRESS_EVERY seconds: iteration,
# training error, last evaluation error); full output: <run>/training.log. Best-model checkpoints
# are pruned as training goes (the KEEP_BEST lowest error and KEEP_LATEST newest stay).
#
# Settings (environment): MAX_ITERATIONS, LEARNING_RATE, NET_SPEC, TRAIN_THREADS (OpenMP threads,
# default min(4, cores)), TARGET_ERROR_RATE (percent; training stops below it), RUN (folder name).
# bin/31-finetune.sh runs the same loop from Google's eng model instead (fallback run 2).
source "$(dirname "$0")/env.sh"

MODE="${MODE:-scratch}"
RUN="${RUN:-$MODE}"
if [ "$MODE" = "finetune" ]; then
  MAX_ITERATIONS="${MAX_ITERATIONS:-30000}"
  LEARNING_RATE="${LEARNING_RATE:-0.0001}"
else
  MAX_ITERATIONS="${MAX_ITERATIONS:-150000}"
  # tesstrain's default for a model trained from zero.
  LEARNING_RATE="${LEARNING_RATE:-0.002}"
fi
# tesstrain's default network (about 372k weights, 0.35 MB gzipped as an integer model): input 36 px
# high, a 3x3 convolution, max-pooling, then LSTM layers (vertical summarising, forward, reverse,
# forward). Plenty for 37 characters of one font; the output size is the unicharset's.
NET_SPEC="${NET_SPEC:-[1,36,0,1 Ct3,3,16 Mp3,3 Lfys48 Lfx96 Lrx96 Lfx192 O1c###]}"
TARGET_ERROR_RATE="${TARGET_ERROR_RATE:-0.01}"
PROGRESS_EVERY="${PROGRESS_EVERY:-300}"
KEEP_BEST="${KEEP_BEST:-3}"
KEEP_LATEST="${KEEP_LATEST:-2}"

OUT="$TRAIN/$MODEL_NAME"
PROTO="$OUT/$MODEL_NAME.traineddata"
DIR="$RUNS/$RUN"
CK="$DIR/checkpoints"
[ -f "$PROTO" ] && [ -f "$OUT/list.train" ] || { echo "error: run bin/20-lstmf.sh first" >&2; exit 1; }
mkdir -p "$CK"

prune() { # keeps mrz_checkpoint (to resume), the KEEP_BEST lowest-error and KEEP_LATEST newest best models
  local all keep
  all=$(find "$CK" -name "${MODEL_NAME}_*_*_*.checkpoint" -printf '%f\n')
  [ -n "$all" ] || return 0
  keep=$( { echo "$all" | sort -t_ -k2,2g -k4,4nr | head -n "$KEEP_BEST"
            echo "$all" | sort -t_ -k4,4nr | head -n "$KEEP_LATEST"; } | sort -u) || return 0
  echo "$all" | grep -vxF "$keep" | while read -r f; do rm -f "$CK/$f"; done || true
}

progress() { # one line: time, iteration, training error, last evaluation error
  local it ev
  it=$(grep -a 'At iteration .*BCER train' "$DIR/training.log" | tail -1 | sed -E 's/.*At iteration ([0-9]+)\/([0-9]+)\/([0-9]+).*BCER train=([0-9.]+)%.*/learning=\1 training=\3 bcer_train=\4%/' || true)
  ev=$(grep -a 'BCER eval' "$DIR/training.log" | tail -1 | sed -E 's/.*At iteration ([0-9]+).*BCER eval=([0-9.]+).*/eval_at=\1 bcer_eval=\2%/' || true)
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${it:-starting}" "$ev" >>"$DIR/progress.log"
}

if [ "$MODE" = "finetune" ]; then
  ENG="$INPUTS/tessdata_best/eng.traineddata"
  [ -f "$ENG" ] || { echo "error: run bin/00-setup.sh --finetune first" >&2; exit 1; }
  [ -f "$DIR/eng.lstm" ] || combine_tessdata -e "$ENG" "$DIR/eng.lstm" >/dev/null
  # Start from eng's network; --old_traineddata maps its 111 outputs to our characters, so the
  # output layer is cut down (the log says "Code range changed from 111 to 39").
  start_args=(--old_traineddata "$ENG" --continue_from "$DIR/eng.lstm")
else
  start_args=(--net_spec "${NET_SPEC/c###/c$(head -1 "$OUT/unicharset")}")
fi

resumed=no
[ -f "$CK/${MODEL_NAME}_checkpoint" ] && resumed=yes
cat >"$DIR/run.json" <<EOF
{"mode": "$MODE", "maxIterations": $MAX_ITERATIONS, "learningRate": $LEARNING_RATE, "netSpec": "$NET_SPEC",
 "threads": $TRAIN_THREADS, "targetErrorRate": $TARGET_ERROR_RATE, "resumed": "$resumed",
 "started": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "repoCommit": "$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)",
 "data": $(cat "$TRAIN/summary.json" 2>/dev/null || echo null), "tesseract": "$(tesseract --version 2>&1 | head -1)"}
EOF
log "train[$RUN]: $MODE, up to $MAX_ITERATIONS iterations, $TRAIN_THREADS threads, resume=$resumed"
start=$(date +%s)

# A checkpoint, when there is one, takes priority over --continue_from and --net_spec: this is
# what makes the same command resume.
OMP_THREAD_LIMIT="$TRAIN_THREADS" lstmtraining \
  --debug_interval 0 \
  --traineddata "$PROTO" \
  "${start_args[@]}" \
  --learning_rate "$LEARNING_RATE" \
  --model_output "$CK/$MODEL_NAME" \
  --train_listfile "$OUT/list.train" \
  --eval_listfile "$OUT/list.eval" \
  --max_iterations "$MAX_ITERATIONS" \
  --target_error_rate "$TARGET_ERROR_RATE" \
  >>"$DIR/training.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; progress; prune; exit 130' INT TERM

while kill -0 "$pid" 2>/dev/null; do
  for _ in $(seq "$PROGRESS_EVERY"); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  progress
  prune
done
status=0
wait "$pid" || status=$?
prune
trap - INT TERM
[ "$status" -eq 0 ] || { log "train[$RUN]: lstmtraining failed ($status), see $DIR/training.log"; tail -5 "$DIR/training.log" >&2; exit "$status"; }
log "train[$RUN]: stopped after $(since "$start"); $(tail -1 "$DIR/progress.log")"
