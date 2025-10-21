#!/bin/bash
# robust_network_test.sh - Systematic robustness testing with Prometheus metrics

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/robustness_results"
mkdir -p "$RESULTS_DIR"

PROMETHEUS_URL="http://localhost:9090"

# Default test duration in seconds (can be overridden with -d)
d=1800

# Log function with timestamps
log() {
  echo "[$(date -Iseconds)] $1" | tee -a "$RESULTS_DIR/robustness_test.log"
}

# Get metric from Prometheus with error handling
get_prometheus_metric() {
  local query="$1"
  local default_value="$2"

  result=$(curl -s "$PROMETHEUS_URL/api/v1/query?query=$query" | \
           jq -r '.data.result[0].value[1] // "'"$default_value"'"' 2>/dev/null || echo "$default_value")
  echo "$result"
}

# Calculate TPS using Prometheus rate function
calculate_tps() {
  local duration_minutes="$1"

  # Use rate() to get transactions per second over the specified duration
  tps=$(get_prometheus_metric "rate(total_transaction_certificates[${duration_minutes}m])" "0")
  echo "$tps"
}

# Get validator availability percentage
get_validator_availability() {
  local expected_validators="$1"

  available_count=$(curl -s "$PROMETHEUS_URL/api/v1/query?query=count(up{job=~\"Validator.*\"}==1)" | \
                    jq -r '.data.result[0].value[1] // "0"')

  if [[ "$available_count" != "0" ]]; then
    availability=$(echo "scale=4; $available_count * 100 / $expected_validators" | bc -l)
    echo "$availability"
  else
    echo "0"
  fi
}

# Count WARN and ERROR messages from validator logs
count_log_issues() {
  local warn_count=0
  local error_count=0

  # Check the logs that are actually created by run-all.sh
  for log_file in "$SCRIPT_DIR/logs"/exp-validator-*-latest.log; do
    if [[ -f "$log_file" ]]; then
      validator_name=$(basename "$log_file" .log | sed 's/exp-//')

      # Count WARN messages
      warn=$(grep -c "WARN" "$log_file" 2>/dev/null || echo "0")
      warn_count=$((warn_count + warn))

      # Count ERROR messages
      error=$(grep -c "ERROR" "$log_file" 2>/dev/null || echo "0")
      error_count=$((error_count + error))

      log "  $validator_name: WARN=$warn, ERROR=$error"
    fi
  done

  # Return total counts (WARN:ERROR format)
  echo "$warn_count:$error_count"
}

log "==== IOTA Network Robustness Test ===="
log "Starting test run at $(date)"

# Parse optional duration flag (-d <seconds>)
while getopts ":d:" opt; do
  case $opt in
    d) d="$OPTARG" ;;
    \?) echo "Usage: $0 [-d duration_seconds]"; exit 1 ;;
  esac
done
shift $((OPTIND - 1))

# Define the four challenging scenarios with 70% minimum uptime constraint
declare -a SCENARIOS=(
  # name:validators:block_conn:packet_loss:restart_percent
  "network_partition:10:45:20:20"     # Near-partition with connectivity maintained
  "latency_fluctuation:10:25:15:10"    # Moderate disruptions with transaction load
  "byzantine_behavior:10:30:20:25"    # Recovery from multiple simultaneous restarts
  "slow_recovery:10:40:10:15"         # Network recovery under load
)

# Create CSV header for results
echo "scenario,validators,block_pct,loss_pct,restart_pct,avg_tps,validator_availability,warn_count,error_count,test_duration_min" > "$RESULTS_DIR/test_results.csv"

# Run each scenario in sequence
for scenario in "${SCENARIOS[@]}"; do
  IFS=':' read -r name n x l r <<< "$scenario"

  log "============================================="
  log "Starting scenario: $name"
  log "Validators: $n, Block connections: $x%, Packet loss: $l%, Restart: $r%"


  # Ensure at least 70% of validators will remain online
  min_online=$(echo "scale=0; ($n * 0.7 + 0.5)/1" | bc)
  max_restart=$(echo "scale=0; (($n - $min_online) * 100 / $n)/1" | bc)

  if [ "$r" -gt "$max_restart" ]; then
    log "WARNING: Adjusting restart percentage from $r% to $max_restart% to ensure 70% uptime"
    r=$max_restart
  fi

  log "Running with parameters: -n $n -p starfish -g true -x $x -l $l -r $r -t $d -S true -C stress -T 500"

  # Create scenario-specific directory for this run
  timestamp=$(date +%Y%m%d-%H%M%S)
  scenario_dir="$RESULTS_DIR/${name}_${timestamp}"
  mkdir -p "$scenario_dir"

  # Record start time and baseline metrics
  start_time=$(date +%s)
  log "Test start time: $(date -d @$start_time)"

  # Run the actual test using run-all.sh
  log "Executing run-all.sh..."
  ./run-all.sh \
    -n "$n" \
    -p "starfish" \
    -g true \
    -x "$x" \
    -l "$l" \
    -r "$r" \
    -t "$d" \
    -S true \
    -C stress \
    -T 200 \
    -m > "$scenario_dir/run_all_output.log" 2>&1

  # Wait a moment for final metrics to stabilize
  sleep 30

  # Collect final metrics
  log "Collecting final metrics for scenario: $name"

  # Calculate average TPS over the test duration
  avg_tps=$(calculate_tps 30)
  log "Average TPS over last 30 minutes: $avg_tps"

  # Get validator availability
  validator_availability=$(get_validator_availability "$n")
  log "Validator availability: $validator_availability%"

  # Count WARN and ERROR messages from logs
  log_issues=$(count_log_issues)
  warn_count=$(echo "$log_issues" | cut -d':' -f1)
  error_count=$(echo "$log_issues" | cut -d':' -f2)
  log "Log issues detected - WARN: $warn_count, ERROR: $error_count"

  # Save individual metrics
  echo "$avg_tps" > "$scenario_dir/avg_tps.txt"
  echo "$validator_availability" > "$scenario_dir/validator_availability.txt"
  echo "$warn_count" > "$scenario_dir/warn_count.txt"
  echo "$error_count" > "$scenario_dir/error_count.txt"

  # Copy all logs for this scenario
  cp -r "$SCRIPT_DIR/logs"/* "$scenario_dir/" 2>/dev/null || true

  # Add results to CSV
  echo "$name,$n,$x,$l,$r,$avg_tps,$validator_availability,$warn_count,$error_count,30" >> "$RESULTS_DIR/test_results.csv"

  log "Scenario $name completed. Results saved to $scenario_dir"
  log "TPS: $avg_tps, Availability: $validator_availability%, WARN: $warn_count, ERROR: $error_count"

  log "Waiting 60 seconds before next scenario..."
  sleep 60
done

log "All robustness test scenarios completed successfully"
log "Results available in $RESULTS_DIR"

# Generate comprehensive summary report
{
  echo "# IOTA Network Robustness Test Results"
  echo "Test completed on $(date)"
  echo ""
  echo "## Test Scenarios Summary"
  echo ""
  echo "| Scenario | Validators | Block % | Loss % | Restart % | Avg TPS | Availability % | WARN | ERROR |"
  echo "|----------|------------|---------|--------|-----------|---------|----------------|------|-------|"

  # Read CSV and format results
  tail -n +2 "$RESULTS_DIR/test_results.csv" | while IFS=',' read -r scenario validators block_pct loss_pct restart_pct avg_tps availability warn_count error_count duration; do
    echo "| $scenario | $validators | $block_pct% | $loss_pct% | $restart_pct% | $avg_tps | $availability% | $warn_count | $error_count |"
  done

  echo ""
  echo "## Key Findings"
  echo ""

  # Find worst performing scenario
  worst_tps=$(tail -n +2 "$RESULTS_DIR/test_results.csv" | cut -d',' -f6 | sort -n | head -1)
  worst_scenario=$(tail -n +2 "$RESULTS_DIR/test_results.csv" | awk -F',' -v min="$worst_tps" '$6==min {print $1}')

  echo "- **Worst TPS Performance:** $worst_scenario with $worst_tps TPS"

  # Find scenario with most errors
  max_errors=$(tail -n +2 "$RESULTS_DIR/test_results.csv" | cut -d',' -f9 | sort -nr | head -1)
  if [[ "$max_errors" != "0" ]]; then
    error_scenario=$(tail -n +2 "$RESULTS_DIR/test_results.csv" | awk -F',' -v max="$max_errors" '$9==max {print $1}')
    echo "- **Most Errors:** $error_scenario with $max_errors errors"
  else
    echo "- **Error-Free:** No ERROR messages detected in any scenario"
  fi

  # Check availability constraint
  min_availability=$(tail -n +2 "$RESULTS_DIR/test_results.csv" | cut -d',' -f7 | sort -n | head -1)
  if (( $(echo "$min_availability < 70" | bc -l) )); then
    availability_scenario=$(tail -n +2 "$RESULTS_DIR/test_results.csv" | awk -F',' -v min="$min_availability" '$7==min {print $1}')
    echo "- **⚠️  Availability Violation:** $availability_scenario had only $min_availability% availability"
  else
    echo "- **✅ Availability Constraint:** All scenarios maintained >70% validator availability"
  fi

} > "$RESULTS_DIR/summary.md"

log "Summary report generated at $RESULTS_DIR/summary.md"
log "To run the test: chmod +x robust_network_test.sh && ./robust_network_test.sh"