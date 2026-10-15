#!/usr/bin/env bash
# Stage 3, fallback run 2 (only if run 1 fails the gates): fine-tunes Google's tessdata_best eng
# model (Apache-2.0) on the same data, its output layer cut down to our characters (111 codes to
# 39). Converges much faster than training from zero, at the cost of inheriting eng's provenance
# (Google's synthetic renders in about 4,500 fonts, many commercial: the lawyer's list, see
# README.md). Needs `bin/00-setup.sh --finetune` first.
#
#   bin/31-finetune.sh                          30,000 iterations (about 2.5-3 h on 4 vCPU)
#   MAX_ITERATIONS=40000 bin/31-finetune.sh     continue further from the last checkpoint
#
# The same loop, logs, pruning and resuming as bin/30-train.sh (folder work/runs/finetune).
MODE=finetune exec "$(dirname "$0")/30-train.sh" "$@"
