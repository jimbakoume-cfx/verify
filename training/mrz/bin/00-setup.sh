#!/usr/bin/env bash
# Stage 0: checks the tools, installs the Python packages (Pillow and NumPy wheels from uv.lock) and
# fetches the pinned inputs into work/inputs, refusing any file whose SHA-256 differs.
#   bin/00-setup.sh               everything for run 1 (training from zero)
#   bin/00-setup.sh --finetune    also Google's tessdata_best eng, for the fallback run 2
# About a minute (15 MB more with --finetune).
source "$(dirname "$0")/env.sh"

need tesseract lstmtraining lstmeval combine_tessdata combine_lang_model unicharset_extractor make git curl node uv
version="$(tesseract --version 2>&1 | head -1 | awk '{print $2}')"
case "$version" in
  5.*) ;;
  *) echo "error: Tesseract 5 needed for training, found '$version'" >&2; exit 1 ;;
esac
make_version="$(make --version | head -1 | awk '{print $3}')"
if [ "$(printf '%s\n4.2\n' "$make_version" | sort -V | head -1)" != "4.2" ]; then
  echo "error: tesstrain needs GNU Make 4.2 or later, found $make_version" >&2
  exit 1
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "error: Node 22 or later needed" >&2; exit 1; }
[ -d "$REPO/node_modules/tesseract.js" ] || { echo "error: run 'npm ci' in the repository first" >&2; exit 1; }

log "setup: tesseract $version, make $make_version, node $(node --version)"
(cd "$MRZ_DIR" && uv sync --frozen --quiet)
"$PY" "$MRZ_DIR/py/mrztext.py"

optional=()
[ "${1:-}" = "--finetune" ] && optional=(--with-optional)
"$PY" "$MRZ_DIR/py/inputs.py" fetch "$REPO" "$INPUTS" "${optional[@]}"
log "setup: done"
