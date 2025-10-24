#!/bin/bash
# network-fuzz.sh — deterministic network fuzzing for validator clusters (bidirectional blocks, no guarantees)
# SPDX-License-Identifier: Apache-2.0
#
# What this version does:
# - Blocks are BIDIRECTIONAL: if {i,j} is chosen, both i->j and j->i are dropped.
# - Exactly X% of unordered pairs are blocked (rounded to nearest), where X = PERCENT_BLOCK.
# - No backbone or connectivity guarantees (the network can partition).
# - Deterministic PRNG; optional round-based re-randomization with a derived per-round seed.
# - Latencies (<400ms cap) are per-node (average of peers) for tc simplicity (same as before).
# - Optional TTL unblock via ipset or user-space timer.
# - Quiet, idempotent iptables changes; watcher only re-applies existing plan.
# - Flock to serialize rule mutations; STOPFILE for clean shutdown.

set -euo pipefail
IFS=$'\n\t'

# -------------------- Timestamped log default --------------------
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="logs/fuzz_script_${TIMESTAMP}.log"
echo "Log file will be: $LOG_FILE"

# -------------------- Defaults --------------------
NUMBER_VALIDATORS=4
SEED=42
PERCENT_BLOCK=0       # percent of unordered pairs to block (bidirectional)
PERCENT_LOSS=0        # percent of nodes to apply 10–40% packet loss
PERCENT_RESTART=0     # percent of nodes to concurrently restart per round
RESTART_DURATION=120  # seconds stopped per restart
BLOCK_TTL=0           # seconds; 0 disables auto-unblock. If >0 uses ipset if available, else timer loop.
TOPOLOGY="random"     # random | geo-high | geo-low | ring | star | non-triangle
ROUND_SPAN=0          # seconds; 0 -> defaults to 2*RESTART_DURATION

# -------------------- Args --------------------
while (( "$#" )); do
  case "${1:-}" in
    -n) NUMBER_VALIDATORS="$2"; shift 2;;
    -s) SEED="$2"; shift 2;;
    -b) PERCENT_BLOCK="$2"; shift 2;;
    -l) PERCENT_LOSS="$2"; shift 2;;
    -r) PERCENT_RESTART="$2"; shift 2;;
    -d) RESTART_DURATION="$2"; shift 2;;
    -o) LOG_FILE="$2"; shift 2;;
    --ttl) BLOCK_TTL="$2"; shift 2;;
    -t|--topology) TOPOLOGY="$2"; shift 2;;
    --round-span) ROUND_SPAN="$2"; shift 2;;
    -h|--help)
      echo "Usage: $0 [-n N] [-s SEED] [-b %block_bidirectional] [-l %loss_nodes] [-r %restart] [-d restart_secs] [-o logfile] [--ttl secs] [-t topology] [--round-span secs]"
      echo "Topologies: random | geo-high | geo-low | ring | star | non-triangle"
      exit 0;;
    *) break;;
  esac
done

mkdir -p "$(dirname "$LOG_FILE")"
log(){ echo "$(date -Iseconds) $1" | tee -a "$LOG_FILE" >/dev/null; }

# -------------------- Global lock & stopfile --------------------
exec {LOCKFD}>/tmp/network-fuzz.lock
STOPFILE="/tmp/network-fuzz.stop"

# Single-instance guard
exec {FUZZ_LOCKFD}>/tmp/network-fuzz-single.lock
if ! flock -n "$FUZZ_LOCKFD"; then
  echo "Another network-fuzz.sh is already running. Exiting."
  exit 1
fi

# -------------------- Deterministic PRNG --------------------
PRNG_STATE=$(( (SEED ^ 0x9E3779B9) & 0xFFFFFFFF ))
prng_next_u32(){ local x=$PRNG_STATE; x=$(( (x ^ (x << 13)) & 0xFFFFFFFF )); x=$(( (x ^ (x >> 17)) & 0xFFFFFFFF )); x=$(( (x ^ (x << 5)) & 0xFFFFFFFF )); PRNG_STATE=$x; echo $x; }
rand_int(){ local max=$1; echo $(( $(prng_next_u32) % (max + 1) )); }
rand_range(){ local lo=$1 hi=$2; echo $(( lo + ($(prng_next_u32) % (hi - lo + 1)) )); }
det_shuffle(){ local -a a=("$@"); local n=${#a[@]}; for ((i=n-1;i>0;i--)); do j=$(rand_range 0 "$i"); tmp=${a[i]}; a[i]=${a[j]}; a[j]=$tmp; done; printf '%s\n' "${a[@]}"; }
derive_round_seed(){ local r=$1; echo $(( (SEED + r * 2654435761) & 0xFFFFFFFF )); } # Knuth

# -------------------- Validators --------------------
validators=(); for i in $(seq 1 "$NUMBER_VALIDATORS"); do validators+=(validator-"$i"); done
all_idx=($(seq 0 $((NUMBER_VALIDATORS-1))))

# -------------------- Fixed 10x10 RTT tables (ms) --------------------
RTT_GEO=(
  "1 14 104 112 198 65 68 110 201 146"
  "14 1 106 122 196 78 67 103 189 142"
  "104 106 1 215 281 163 29 50 143 238"
  "112 122 215 1 309 175 176 220 299 254"
  "198 196 281 309 1 137 254 268 150 101"
  "65 78 163 175 137 1 127 172 226 108"
  "68 67 29 176 254 127 1 38 125 199"
  "110 103 50 220 268 172 38 1 148 245"
  "201 189 143 299 150 226 125 148 1 140"
  "146 142 238 254 101 108 199 245 140 1"
)
RTT_RING=(
  "0 15 30 60 120 240 120 60 30 15"
  "15 0 15 30 60 120 240 120 60 30"
  "30 15 0 15 30 60 120 240 120 60"
  "60 30 15 0 15 30 60 120 240 120"
  "120 60 30 15 0 15 30 60 120 240"
  "240 120 60 30 15 0 15 30 60 120"
  "120 240 120 60 30 15 0 15 30 60"
  "60 120 240 120 60 30 15 0 15 30"
  "30 60 120 240 120 60 30 15 0 15"
  "15 30 60 120 240 120 60 30 15 0"
)
RTT_STAR=(
  "0 25 25 25 25 25 25 25 25 25"
  "25 0 200 200 200 200 200 200 200 200"
  "25 200 0 200 200 200 200 200 200 200"
  "25 200 200 0 200 200 200 200 200 200"
  "25 200 200 200 0 200 200 200 200 200"
  "25 200 200 200 200 0 200 200 200 200"
  "25 200 200 200 200 200 0 200 200 200"
  "25 200 200 200 200 200 200 0 200 200"
  "25 200 200 200 200 200 200 200 0 200"
  "25 200 200 200 200 200 200 200 200 0"
)
RTT_NONTRI=(
  "0 500 20 25 450 30 470 35 460 40"
  "500 0 25 460 30 450 35 440 40 430"
  "20 25 0 510 30 490 35 480 40 470"
  "25 460 510 0 20 480 25 470 30 460"
  "450 30 30 20 0 520 25 510 30 500"
  "30 450 490 480 520 0 20 490 25 480"
  "470 35 35 25 25 20 0 530 20 520"
  "35 440 480 470 510 490 530 0 15 510"
  "460 40 40 30 30 25 20 15 0 540"
  "40 430 470 460 500 480 520 510 540 0"
)

rtt_lookup(){ local i=$1 j=$2; local -n tab=$3; local size=${#tab[@]}; local ii=$(( i % size )); local jj=$(( j % size )); IFS=' ' read -r -a row <<< "${tab[$ii]}"; echo "${row[$jj]}"; }

# -------------------- Authoritative State --------------------
declare -A BLOCK_EDGE      # "i|j" -> 0/1 (drop A=i -> B=j)
declare -A LAT_MS          # "i|j" -> latency ms (<400)
declare -A JIT_MS          # "i|j" -> jitter ms [0..4]
declare -A LOSS_PCT_NODE   # "i"   -> 0 or [10..40]
declare -A FUZZ_BLOCK_TARGETS  # "validator-name" -> newline-separated peers

# -------------------- Latencies (per-node tc) --------------------
build_latencies(){
  local mode="$1" MAX_LAT=399 base raw jitter
  for i in "${all_idx[@]}"; do
    for j in "${all_idx[@]}"; do
      if [[ $i -eq $j ]]; then LAT_MS["$i|$j"]=0; JIT_MS["$i|$j"]=0; continue; fi
      case "$mode" in
        geo-high)      base=$(rtt_lookup "$i" "$j" RTT_GEO) ;;
        geo-low)       raw=$(rtt_lookup "$i" "$j" RTT_GEO); base=$(( raw / 8 )); (( base < 1 )) && base=1 ;;
        ring)          base=$(rtt_lookup "$i" "$j" RTT_RING) ;;
        star)          base=$(rtt_lookup "$i" "$j" RTT_STAR) ;;
        non-triangle)  base=$(rtt_lookup "$i" "$j" RTT_NONTRI) ;;
        random|*)      base=$(rand_range 20 "$MAX_LAT") ;;
      esac
      (( base > MAX_LAT )) && base=$MAX_LAT
      jitter=$(rand_range 0 4)
      LAT_MS["$i|$j"]=$base
      JIT_MS["$i|$j"]=$jitter
    done
  done
}

# -------------------- Loss selection (deterministic per-node) --------------------
select_losses(){
  local NUM_LOSS=$(( (NUMBER_VALIDATORS * PERCENT_LOSS + 50) / 100 ))
  local loss_candidates=($(det_shuffle "${all_idx[@]}"))
  for k in "${all_idx[@]}"; do LOSS_PCT_NODE["$k"]=0; done
  for ((t=0; t<NUM_LOSS; t++)); do node=${loss_candidates[$t]}; LOSS_PCT_NODE["$node"]=$(rand_range 10 40); done
}

# -------------------- Build EXACT X% bidirectional blocks --------------------
build_blocks_bidir_exact(){
  # zero all edges
  for i in "${all_idx[@]}"; do
    for j in "${all_idx[@]}"; do
      BLOCK_EDGE["$i|$j"]=0
    done
  done

  # list all unordered pairs i<j
  local -a pairs=()
  for ((i=0;i<NUMBER_VALIDATORS;i++)); do
    for ((j=i+1;j<NUMBER_VALIDATORS;j++)); do
      pairs+=("$i|$j")
    done
  done

  local M=${#pairs[@]}  # number of unordered pairs = N*(N-1)/2
  local NUM_BLOCKS=$(( (M * PERCENT_BLOCK + 50) / 100 ))  # round to nearest int

  # deterministically shuffle and take first NUM_BLOCKS
  local -a shuffled
  mapfile -t shuffled < <(det_shuffle "${pairs[@]}")

  for ((k=0; k<NUM_BLOCKS && k<M; k++)); do
    local p="${shuffled[$k]}"
    local i="${p%%|*}"
    local j="${p##*|}"
    # set BOTH directions
    BLOCK_EDGE["$i|$j"]=1
    BLOCK_EDGE["$j|$i"]=1
  done

  log "Built bidirectional block set: ${NUM_BLOCKS}/${M} pairs (~${PERCENT_BLOCK}%)"
}

# -------------------- Docker helpers --------------------
container_pid(){ docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null; }
ip_of(){ docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1" 2>/dev/null; }
ip_of_wait(){
  local name=$1; local tries=${2:-50}; local sleep_ms=${3:-100}
  local ip=""
  for ((t=0; t<tries; t++)); do
    ip=$(ip_of "$name" 2>/dev/null || true)
    if [[ -n "$ip" ]]; then echo "$ip"; return 0; fi
    sleep "$(awk "BEGIN{print $sleep_ms/1000}")"
  done
  return 1
}

# -------------------- Optional ipset TTL --------------------
HAVE_IPSET=0
if (( BLOCK_TTL > 0 )); then
  if command -v ipset >/dev/null 2>&1; then HAVE_IPSET=1; fi
fi
ensure_ipset_rule(){
  local v=$1 pid; pid=$(container_pid "$v") || return 0
  nsenter -t "$pid" -n ipset create fuzz_block hash:ip timeout 0 -exist || true
  if ! nsenter -t "$pid" -n iptables -C OUTPUT -m set --match-set fuzz_block dst -j DROP 2>/dev/null; then
    nsenter -t "$pid" -n iptables -A OUTPUT -m set --match-set fuzz_block dst -j DROP 2>/dev/null || true
  fi
}

# -------------------- Apply state (tc + blocks) --------------------
apply_node_qdisc(){
  local v_idx="${1:-0}"
  local A="${validators[$v_idx]}"
  local pidA avg jitter loss sum cnt
  pidA=$(container_pid "$A") || return 0
  nsenter -t "$pidA" -n tc qdisc del dev eth0 root 2>/dev/null || true
  sum=0; cnt=0
  for j in "${all_idx[@]}"; do
    [[ $v_idx -eq $j ]] && continue
    sum=$((sum + LAT_MS["$v_idx|$j"])); cnt=$((cnt+1))
  done
  if (( cnt > 0 )); then avg=$(( sum / cnt )); else avg=0; fi
  (( avg < 0 )) && avg=0
  jitter=$(( (avg>5) ? 3 : 1 ))
  loss=${LOSS_PCT_NODE["$v_idx"]:-0}
  if (( loss > 0 )); then
    nsenter -t "$pidA" -n tc qdisc replace dev eth0 root netem delay "${avg}ms" "${jitter}ms" loss "${loss}%" 2>/dev/null || true
  else
    nsenter -t "$pidA" -n tc qdisc replace dev eth0 root netem delay "${avg}ms" "${jitter}ms" 2>/dev/null || true
  fi
}

apply_all_latencies_and_loss_once(){
  log "Applying node-level latencies (<400ms cap) and loss (if any)"
  for i in "${all_idx[@]}"; do apply_node_qdisc "$i"; done
}

apply_all_blocks_once(){
  log "Applying bidirectional block set to iptables/ipset"
  flock -x "$LOCKFD"
  for i in "${all_idx[@]}"; do
    local A=${validators[$i]} pidA
    pidA=$(container_pid "$A") || continue
    FUZZ_BLOCK_TARGETS["$A"]=""
    if (( BLOCK_TTL > 0 && HAVE_IPSET == 1 )); then ensure_ipset_rule "$A"; fi
    for j in "${all_idx[@]}"; do
      [[ $i -eq $j ]] && continue
      if [[ ${BLOCK_EDGE["$i|$j"]} -eq 1 ]]; then
        local B=${validators[$j]} ipB
        if ! ipB=$(ip_of_wait "$B"); then
          log "Warning: could not resolve IP for $B when applying block from $A; skipping A->$B"
          continue
        fi
        if (( BLOCK_TTL > 0 && HAVE_IPSET == 1 )); then
          nsenter -t "$pidA" -n ipset add fuzz_block "$ipB" timeout "$BLOCK_TTL" 2>/dev/null || true
        else
          if ! nsenter -t "$pidA" -n iptables -C OUTPUT -d "$ipB" -j DROP -m comment --comment "fuzzdrop:$A->$B" 2>/dev/null; then
            nsenter -t "$pidA" -n iptables -A OUTPUT -d "$ipB" -j DROP -m comment --comment "fuzzdrop:$A->$B" 2>/dev/null || true
          fi
        fi
        FUZZ_BLOCK_TARGETS["$A"]+="${B}"$'\n'
      fi
    done
  done
  flock -u "$LOCKFD"
}

# -------------------- Watcher (reapply exact state after restarts) --------------------
reapply_latencies_and_fuzz_loop(){
  log "Starting deterministic reapply watcher"
  while true; do
    [[ -f "$STOPFILE" ]] && { log "Watcher stopping (stopfile present)"; return; }
    for i in "${all_idx[@]}"; do
      local v=${validators[$i]}
      docker ps --format '{{.Names}}' | grep -qx "$v" || continue
      local pid; pid=$(container_pid "$v")
      if ! nsenter -t "$pid" -n tc qdisc show dev eth0 | grep -q "netem"; then
        apply_node_qdisc "$i"
        log "Reapplied tc for $v"
      fi
      flock -x "$LOCKFD"
      if (( BLOCK_TTL > 0 && HAVE_IPSET == 1 )); then
        ensure_ipset_rule "$v"
        while IFS= read -r B; do
          [[ -z "${B:-}" ]] && continue
          local ipB; if ! ipB=$(ip_of_wait "$B"); then
            log "Warning: watcher could not resolve IP for $B when reapplying to $v"
            continue
          fi
          nsenter -t "$pid" -n ipset add fuzz_block "$ipB" timeout "$BLOCK_TTL" 2>/dev/null || true
        done <<< "${FUZZ_BLOCK_TARGETS["$v"]:-}"
      else
        while IFS= read -r B; do
          [[ -z "${B:-}" ]] && continue
          local ipB; if ! ipB=$(ip_of_wait "$B"); then
            log "Warning: watcher could not resolve IP for $B when reapplying to $v"
            continue
          fi
          if ! nsenter -t "$pid" -n iptables -C OUTPUT -d "$ipB" -j DROP -m comment --comment "fuzzdrop:$v->$B" 2>/dev/null; then
            nsenter -t "$pid" -n iptables -A OUTPUT -d "$ipB" -j DROP -m comment --comment "fuzzdrop:$v->$B" 2>/dev/null || true
          fi
        done <<< "${FUZZ_BLOCK_TARGETS["$v"]:-}"
      fi
      flock -u "$LOCKFD"
    done
    sleep 1
  done
}

# -------------------- Optional user-space unblock loop (if no ipset) --------------------
declare -A BLOCK_EXPIRY  # key="A|B" -> epoch
unblock_expired_loop(){
  (( BLOCK_TTL > 0 )) || return 0
  (( HAVE_IPSET == 0 )) || return 0
  log "Starting user-space unblock timer loop (TTL=${BLOCK_TTL}s)"
  local now; now=$(date +%s)
  for A in "${validators[@]}"; do
    while IFS= read -r B; do
      [[ -z "${B:-}" ]] && continue
      BLOCK_EXPIRY["$A|$B"]=$(( now + BLOCK_TTL ))
    done <<< "${FUZZ_BLOCK_TARGETS["$A"]:-}"
  done
  while true; do
    [[ -f "$STOPFILE" ]] && { log "Unblock loop stopping (stopfile present)"; return; }
    now=$(date +%s)
    for key in "${!BLOCK_EXPIRY[@]}"; do
      local A="${key%%|*}" B="${key##*|}" exp=${BLOCK_EXPIRY[$key]}
      if (( now >= exp )); then
        local pid; pid=$(container_pid "$A") || { unset BLOCK_EXPIRY["$key"]; continue; }
        nsenter -t "$pid" -n iptables -S OUTPUT 2>/dev/null | grep "fuzzdrop:$A->$B" | while read -r rule; do
          nsenter -t "$pid" -n iptables $(echo "$rule" | sed 's/^-A /-D /') 2>/dev/null || true
        done
        log "Auto-unblocked expired $A -> $B"
        unset BLOCK_EXPIRY["$key"]
        FUZZ_BLOCK_TARGETS["$A"]=$(printf '%s' "${FUZZ_BLOCK_TARGETS["$A"]:-}" | grep -Fxv "$B" || true)
      fi
    done
    sleep 1
  done
}

# -------------------- Deterministic restart plan --------------------
ROUNDS=1000
declare -a RESTART_BATCH
BATCH_SIZE=$(( (NUMBER_VALIDATORS * PERCENT_RESTART + 50) / 100 ))
for r in $(seq 0 $((ROUNDS-1))); do
  pick=($(det_shuffle "${all_idx[@]}"))
  line=""
  for ((t=0; t<BATCH_SIZE; t++)); do line+="${pick[$t]}"$'\n'; done
  RESTART_BATCH[$r]="$line"
done

restart_validator(){
  local v=$1 d=$2
  log "Stopping $v for ${d}s..."
  docker stop "$v" >/dev/null 2>&1 || true
  sleep "$d"
  docker start "$v" >/dev/null 2>&1 || true
  log "Restarted $v"
}

restart_loop(){
  sleep "$RESTART_DURATION"
  (( PERCENT_RESTART > 0 )) || { log "PERCENT_RESTART=0, skipping restarts"; return; }
  local r=0
  while true; do
    [[ -f "$STOPFILE" ]] && { log "Restart loop stopping (stopfile present)"; return; }
    local batch="${RESTART_BATCH[$(( r % ROUNDS ))]}"
    local n_batch; n_batch=$(printf '%s' "$batch" | grep -cve '^[[:space:]]*$' || true)
    log "Restart round r=$r: ${n_batch} validators (duration=$RESTART_DURATION)"
    while IFS= read -r idx; do
      [[ -z "${idx:-}" ]] && continue
      v=${validators[$idx]}
      restart_validator "$v" "$RESTART_DURATION" &
    done <<< "$batch"
    r=$((r+1))
    sleep $(( 2 * RESTART_DURATION ))
  done
}

# -------------------- Round-based re-randomization (no guarantees) --------------------
clear_all_blocks(){
  for A in "${validators[@]}"; do
    local pidA; pidA=$(container_pid "$A") || continue
    if (( BLOCK_TTL > 0 && HAVE_IPSET == 1 )); then
      nsenter -t "$pidA" -n ipset flush fuzz_block 2>/dev/null || true
    else
      nsenter -t "$pidA" -n iptables -S OUTPUT 2>/dev/null | grep 'fuzzdrop:' | \
        sed 's/^-A /-D /' | while read -r del; do nsenter -t "$pidA" -n iptables $del 2>/dev/null || true; done
    fi
    FUZZ_BLOCK_TARGETS["$A"]=""
  done
}

apply_all_blocks_for_current_state(){
  for i in "${all_idx[@]}"; do
    local A=${validators[$i]} pidA
    pidA=$(container_pid "$A") || continue
    if (( BLOCK_TTL > 0 && HAVE_IPSET == 1 )); then ensure_ipset_rule "$A"; fi
    for j in "${all_idx[@]}"; do
      [[ $i -eq $j ]] && continue
      if [[ ${BLOCK_EDGE["$i|$j"]} -eq 1 ]]; then
        local B=${validators[$j]} ipB
        if ! ipB=$(ip_of_wait "$B"); then
          log "Warning: could not resolve IP for $B when applying block from $A; skipping A->$B (rebalance)"
          continue
        fi
        if (( BLOCK_TTL > 0 && HAVE_IPSET == 1 )); then
          nsenter -t "$pidA" -n ipset add fuzz_block "$ipB" timeout "$BLOCK_TTL" 2>/dev/null || true
        else
          if ! nsenter -t "$pidA" -n iptables -C OUTPUT -d "$ipB" -j DROP -m comment --comment "fuzzdrop:$A->$B" 2>/dev/null; then
            nsenter -t "$pidA" -n iptables -A OUTPUT -d "$ipB" -j DROP -m comment --comment "fuzzdrop:$A->$B" 2>/dev/null || true
          fi
        fi
        FUZZ_BLOCK_TARGETS["$A"]+="${B}"$'\n'
      fi
    done
  done
}

rebalance_blocks_loop(){
  if (( ROUND_SPAN <= 0 )); then
    ROUND_SPAN=$(( 2 * RESTART_DURATION ))
  fi
  local r=0
  sleep "$ROUND_SPAN"
  while true; do
    [[ -f "$STOPFILE" ]] && { log "Rebalance loop stopping (stopfile present)"; return; }
    flock -x "$LOCKFD"
    # per-round deterministic seed
    local old_state=$PRNG_STATE
    PRNG_STATE=$(derive_round_seed "$r")
    # rebuild exact-percent bidirectional blocks for this round
    build_blocks_bidir_exact
    # atomically replace all rules to match this round
    clear_all_blocks
    apply_all_blocks_for_current_state
    # restore PRNG state
    PRNG_STATE=$old_state
    flock -u "$LOCKFD"
    log "Rebalanced bidirectional blocks for round r=$r"
    r=$((r+1))
    sleep "$ROUND_SPAN"
  done
}

# -------------------- Cleanup on exit --------------------
cleanup() {
  log "Cleanup: removing tc qdiscs and fuzz iptables/ipset rules"
  for v in "${validators[@]}"; do
    pid=$(container_pid "$v") || continue
    nsenter -t "$pid" -n tc qdisc del dev eth0 root 2>/dev/null || true
    nsenter -t "$pid" -n iptables -S OUTPUT 2>/dev/null | grep 'fuzzdrop:' | \
      sed 's/^-A /-D /' | while read -r del; do
        nsenter -t "$pid" -n iptables $del >/dev/null 2>&1 || true
      done
    nsenter -t "$pid" -n ipset destroy fuzz_block >/dev/null 2>&1 || true
  done
  log "Cleanup complete"
}
trap cleanup INT TERM

# -------------------- Build deterministic state (initial) --------------------
log "Starting deterministic fuzz (N=$NUMBER_VALIDATORS, seed=$SEED, ttl=$BLOCK_TTL, topology=$TOPOLOGY, round_span=${ROUND_SPAN}, p_block=${PERCENT_BLOCK}%)"
build_latencies "$TOPOLOGY"
select_losses
build_blocks_bidir_exact

# -------------------- Check ipset availability --------------------
HAVE_IPSET=0
if (( BLOCK_TTL > 0 )); then
  if command -v ipset >/dev/null 2>&1; then HAVE_IPSET=1; fi
fi

# -------------------- Apply and run loops --------------------
apply_all_latencies_and_loss_once
apply_all_blocks_once
reapply_latencies_and_fuzz_loop &
unblock_expired_loop &
restart_loop &
rebalance_blocks_loop &
wait