#!/usr/bin/env bash
# progressive-fuzz.sh — run 5 gradually harsher experiments (Mysticeti + Starfish per step)
set -euo pipefail
IFS=$'\n\t'

FUZZ_ROUND_SPAN=300       # 5 minutes between topology reshuffles
NUM_VALIDATORS=10
TOPOLOGY="non-triangle"
DURATION=1800              # 30 minutes
SPAMMER=true
SPAMMER_TPS=100
SPAMMER_TYPE="stress"
PAUSE_BETWEEN_PROTOCOLS=60
PAUSE_BETWEEN_STEPS=180

# parameter sequences
R_LIST=(20 25 30 35 40)   # percent restarts
X_LIST=(20 25 30 35 40)   # percent block
L_LIST=(5 10 15 20 25)    # percent nodes with loss

run_experiment() {
  local PROTO="$1" R="$2" X="$3" L="$4"
  local ts; ts=$(date +%Y%m%d-%H%M%S)
  echo "=== ${ts}: starting ${PROTO} (r=${R} x=${X} l=${L}) ==="
  sudo -E FUZZ_ROUND_SPAN="${FUZZ_ROUND_SPAN}" \
    ./run-all.sh \
      -n "${NUM_VALIDATORS}" \
      -p "${PROTO}" \
      -t "${TOPOLOGY}" \
      -b false \
      -r "${R}" \
      -x "${X}" \
      -l "${L}" \
      -d "${DURATION}" \
      -S "${SPAMMER}" \
      -T "${SPAMMER_TPS}" \
      -C "${SPAMMER_TYPE}"
  echo "=== finished ${PROTO} (r=${R} x=${X} l=${L}) ==="
}

for i in "${!R_LIST[@]}"; do
  R=${R_LIST[$i]}
  X=${X_LIST[$i]}
  L=${L_LIST[$i]}
  echo
  echo ">>> Step $((i+1)): r=${R}, x=${X}, l=${L} — $(date +%Y%m%d-%H%M%S)"

  run_experiment "mysticeti" "$R" "$X" "$L"
  echo "Sleeping ${PAUSE_BETWEEN_PROTOCOLS}s before starfish..."
  sleep "${PAUSE_BETWEEN_PROTOCOLS}"

  run_experiment "starfish" "$R" "$X" "$L"
  echo "Step $((i+1)) complete. Sleeping ${PAUSE_BETWEEN_STEPS}s before next step..."
  sleep "${PAUSE_BETWEEN_STEPS}"
done

echo "All progressive fuzz runs completed."