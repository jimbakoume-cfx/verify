#!/usr/bin/env bash
# Stage 5: renders the G2/G3 document benchmark once (py/bench.py: the repository's fixture
# renderer, never used for training; its own seeds). Item i depends only on the seed and i, so the
# first 200 of a 1,000-still benchmark are the same 200 as a 200-still one.
#
#   bin/50-bench.sh            1,000 stills (about 10 minutes on 4 vCPU; 400 MB)
#   bin/50-bench.sh 200        the first 200 (the baseline subset)
source "$(dirname "$0")/env.sh"

COUNT="${1:-1000}"
mkdir -p "$BENCH"
if [ -f "$BENCH/bench.json" ] && [ "$("$PY" -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$BENCH/bench.json")" -ge "$COUNT" ]; then
  log "bench: $BENCH already holds $COUNT stills or more"
  exit 0
fi
start=$(date +%s)
# Ranges of 50 stills, THREADS at a time; a range already listed is not drawn again.
for ((s = 0; s < COUNT; s += 50)); do
  e=$(( s + 50 < COUNT ? s + 50 : COUNT ))
  list="$BENCH/items-$(printf %05d "$s").jsonl"
  if [ -f "$list" ] && [ "$(grep -c '' "$list")" -eq $((e - s)) ]; then continue; fi
  echo "$s $e $SEED_BENCH"
done | xargs -r -P "$THREADS" -L 1 sh -c '"$0" "$1/py/bench.py" "$2" "$3" "$4" "$5" "$6"' "$PY" "$MRZ_DIR" "$REPO" "$BENCH"
# Keep only the ranges this benchmark size covers, then join them.
for f in "$BENCH"/items-*.jsonl; do
  n=$((10#$(basename "$f" .jsonl | cut -d- -f2)))
  [ "$n" -lt "$COUNT" ] || rm -f "$f"
done
"$PY" "$MRZ_DIR/py/bench.py" --merge "$BENCH" --count "$COUNT"
log "bench: $COUNT stills in $(since "$start")"
