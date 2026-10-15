# Shared settings of the MRZ training scripts. Sourced by every bin/*.sh; every value can be
# overridden from the environment, e.g. `MRZ_WORK=/data/mrz THREADS=8 bin/10-data.sh`.
set -euo pipefail
# A failing command stops the stage; say where, since set -e alone is silent.
trap 'echo "error: $(basename "$0") stopped at line $LINENO (exit $?)" >&2' ERR

MRZ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$MRZ_DIR/../.." && pwd)"
# Everything generated goes here (never committed; see .gitignore).
WORK="${MRZ_WORK:-$MRZ_DIR/work}"
# Pinned downloads, and the G2/G3 benchmark: shared by every work folder unless overridden.
INPUTS="${MRZ_INPUTS:-$WORK/inputs}"
GT="$WORK/data/gt"
TMPD="$WORK/data/tmp"
G1="$WORK/data/g1"
BENCH="${MRZ_BENCH:-$WORK/bench}"
TRAIN="$WORK/train"
RUNS="$WORK/runs"
MODELS="$WORK/models"
GATES="$WORK/gates"
LOGS="$WORK/logs"

# Parallel jobs for data generation and the gates, and OpenMP threads for lstmtraining (Tesseract's
# LSTM uses at most 4 usefully).
THREADS="${THREADS:-$(nproc)}"
TRAIN_THREADS="${TRAIN_THREADS:-$(( THREADS < 4 ? THREADS : 4 ))}"

FONT="$REPO/scripts/fonts/ocr-b/OCRB.otf"
DOUBANGO="$REPO/apps/rider/public/ocr/mrz-1"
PY="$MRZ_DIR/.venv/bin/python"
# Our scripts only: no bytecode written next to the repository's scripts (py/bench.py imports
# scripts/make-mrz-fixtures.py).
export PYTHONDONTWRITEBYTECODE=1

# Seeds. Training, the G1 line sets and the G2/G3 benchmark never share one.
SEED_REAL=1000
SEED_SYNTH=5000
SEED_G1=900000
SEED_BENCH=777

# The model's name inside Tesseract ("mrz", as the rider loads /ocr/mrz-N/mrz.traineddata.gz).
MODEL_NAME=mrz

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOGS/pipeline.log" >&2; }

node_ts() { # node_ts SCRIPT.ts ARGS...: runs a TypeScript script of node/ with the repo's code
  local script="$1"
  shift
  (cd "$REPO" && node "$MRZ_DIR/node/run.mjs" "$MRZ_DIR/node/$script" "$@")
}

need() { # need TOOL...: fails early with a clear message
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || { echo "error: '$t' is not installed (see training/mrz/README.md, Setup)" >&2; exit 1; }
  done
}

# Seconds since $1 (a `date +%s` value), as "Hh MMm SSs".
since() { local s=$(( $(date +%s) - $1 )); printf '%dh%02dm%02ds' $((s / 3600)) $((s % 3600 / 60)) $((s % 60)); }

mkdir -p "$WORK" "$LOGS"
