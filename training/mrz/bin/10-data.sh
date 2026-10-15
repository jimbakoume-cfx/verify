#!/usr/bin/env bash
# Stage 1: renders the training lines and the held-out G1 line sets.
#
# Half the lines (REAL_SHARE) are "realistic": whole fictitious documents rendered by py/docs.py,
# then the rider's own locate and prepare steps and Tesseract's own line cutting
# (node/cutLines.ts), so the model learns exactly what the phone feeds it. The other half are
# single synthetic lines (py/make_lines.py, 15% random strings): 60% of them also go through the
# rider's prepare step, 40% keep their grey levels.
#
# Work is split into shards that run in parallel (THREADS) and are skipped once done, so an
# interrupted run picks up where it stopped: just run it again.
#
#   bin/10-data.sh                 LINES=80000 training lines, then the G1 sets
#   LINES=4000 bin/10-data.sh      a smaller set (the smoke test)
#   bin/10-data.sh --g1            only the G1 sets
# Duration on 4 vCPU: see README.md.
source "$(dirname "$0")/env.sh"

LINES="${LINES:-80000}"
REAL_SHARE="${REAL_SHARE:-0.5}"
PREPARED_SHARE="${PREPARED_SHARE:-0.6}"
STILLS_PER_SHARD="${STILLS_PER_SHARD:-250}"
LINES_PER_SHARD="${LINES_PER_SHARD:-500}"
# G1 set sizes (clean, degraded, low resolution), as in the research.
G1_CLEAN="${G1_CLEAN:-600}"
G1_DEGRADED="${G1_DEGRADED:-1000}"
G1_LOWRES="${G1_LOWRES:-1000}"
LAYOUT="$INPUTS/layout"

shard() { # shard KIND ID COUNT: one unit of work, skipped when already done
  local kind="$1" id="$2" count="$3"
  local tmp="$TMPD/$kind-$id" out
  case "$kind" in
    real | synth) out="$GT/$kind-$id" ;;
    g1-*) out="$G1/${kind#g1-}" ;;
  esac
  [ -f "$out/.done" ] && return 0
  rm -rf "$tmp" "$out"
  mkdir -p "$tmp" "$out"
  case "$kind" in
    real)
      "$PY" "$MRZ_DIR/py/docs.py" "$FONT" "$tmp" "$count" $((SEED_REAL + 10#$id)) "r$id" ;;
    synth)
      "$PY" "$MRZ_DIR/py/make_lines.py" --font "$FONT" --gt "$out" --jobs "$tmp" --count "$count" \
        --seed $((SEED_SYNTH + 10#$id)) --prefix "s$id" --prepared "$PREPARED_SHARE" ;;
    g1-*)
      local set="${kind#g1-}" offset
      case "$set" in clean) offset=1 ;; degraded) offset=2 ;; lowres) offset=3 ;; esac
      "$PY" "$MRZ_DIR/py/make_lines.py" --font "$FONT" --gt "$out" --jobs "$tmp" --count "$count" \
        --seed $((SEED_G1 + offset)) --prefix "$set" --preset "$set" --prepared 1 ;;
  esac
  node_ts cutLines.ts "$tmp" "$out" --tessdata "$LAYOUT" --lang eng >/dev/null
  rm -rf "$tmp"
  touch "$out/.done"
}

if [ "${1:-}" = "--shard" ]; then
  shard "$2" "$3" "$4"
  exit 0
fi

[ -f "$LAYOUT/eng.traineddata" ] || { echo "error: run bin/00-setup.sh first" >&2; exit 1; }
mkdir -p "$GT" "$TMPD" "$G1"
start=$(date +%s)

tasks=()
if [ "${1:-}" != "--g1" ]; then
  # About 2.1 lines per still: TD1 has 3 and TD3 2, but the rider's locate step finds no code
  # lines on about 15% of the stills (those are skipped, see cut-stats) and a few cuts fail checks.
  real_lines=$(awk -v n="$LINES" -v s="$REAL_SHARE" 'BEGIN { printf "%d", n * s }')
  stills=$(awk -v n="$real_lines" -v y="${LINES_PER_STILL:-2.1}" 'BEGIN { printf "%d", (n / y) + 0.999 }')
  synth=$((LINES - real_lines))
  i=0
  while [ "$stills" -gt 0 ]; do
    c=$(( stills < STILLS_PER_SHARD ? stills : STILLS_PER_SHARD ))
    tasks+=("real $(printf %04d $i) $c")
    stills=$((stills - c)); i=$((i + 1))
  done
  i=0
  while [ "$synth" -gt 0 ]; do
    c=$(( synth < LINES_PER_SHARD ? synth : LINES_PER_SHARD ))
    tasks+=("synth $(printf %04d $i) $c")
    synth=$((synth - c)); i=$((i + 1))
  done
  log "data: $LINES lines requested ($real_lines realistic), ${#tasks[@]} shards, $THREADS at a time"
fi
tasks+=("g1-clean 0000 $G1_CLEAN" "g1-degraded 0000 $G1_DEGRADED" "g1-lowres 0000 $G1_LOWRES")

printf '%s\n' "${tasks[@]}" | xargs -P "$THREADS" -L 1 bash "$0" --shard
rmdir "$TMPD" 2>/dev/null || true

# Summary: lines per kind and why stills or lines were skipped.
"$PY" - "$GT" "$G1" "$WORK/data/summary.json" <<'EOF'
import json, sys
from collections import Counter
from pathlib import Path
gt, g1, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
summary = {"lines": {}, "skipped": {}}
for kind, root in (("realistic", gt.glob("real-*")), ("synthetic", gt.glob("synth-*")), ("g1", g1.glob("*"))):
    stats = Counter()
    lines = 0
    for d in root:
        lines += sum(1 for _ in d.glob("*.gt.txt"))
        for f in d.glob("cut-stats-*.json"):
            stats.update({k: v for k, v in json.loads(f.read_text()).items() if isinstance(v, int)})
    summary["lines"][kind] = lines
    summary["skipped"][kind] = dict(stats)
out.write_text(json.dumps(summary, indent=1) + "\n")
print(json.dumps(summary))
EOF
log "data: done in $(since "$start")"
