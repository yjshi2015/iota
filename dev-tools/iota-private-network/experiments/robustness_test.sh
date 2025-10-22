#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/robustness_results"
mkdir -p "$RESULTS_DIR"

PROMETHEUS_URL="http://localhost:9090"
TEST_DURATION=1800
BURN_IN_SECONDS=180
COOL_DOWN_SECONDS=180
SAMPLE_INTERVAL=10

SEED=42

log() {
    echo "[$(date -Iseconds)] $1" | tee -a "$RESULTS_DIR/live_robustness.log"
}

# === METRICS FUNCTIONS ===

get_tps() {
    local duration_minutes="${1:-1}"
    curl -s "$PROMETHEUS_URL/api/v1/query?query=rate(total_transaction_certificates[${duration_minutes}m])" | \
        jq -r '.data.result[0].value[1] // "0"'
}

get_bps() {
    curl -s "$PROMETHEUS_URL/api/v1/query?query=avg(irate(consensus_committed_messages[2m]))" | \
        jq -r '.data.result[0].value[1] // "0"'
}


get_block_latency_median() {
    curl -s "$PROMETHEUS_URL/api/v1/query?query=histogram_quantile(0.5,consensus_block_commit_latency_bucket)" | \
        jq -r '.data.result[0].value[1] // "0"'
}

get_block_latency_p99() {
    curl -s "$PROMETHEUS_URL/api/v1/query?query=histogram_quantile(0.99,consensus_block_commit_latency_bucket)" | \
        jq -r '.data.result[0].value[1] // "0"'
}

get_active_validators() {
    curl -s "$PROMETHEUS_URL/api/v1/query?query=consensus_committed_messages" | \
        jq -r '.data.result[].metric.instance' | sort -u | wc -l
}

# Get current log counts (live during experiment)
get_current_log_counts() {
    local warn_count=0
    local error_count=0

    if [ -d "logs" ]; then
        warn_count=$(grep -h "WARN" logs/exp-validator-*-latest.log 2>/dev/null | wc -l || echo "0")
        error_count=$(grep -h "ERROR" logs/exp-validator-*-latest.log 2>/dev/null | wc -l || echo "0")
    fi

    echo "$warn_count:$error_count"
}

# Collect single metrics sample
collect_sample() {
    local timestamp="$1"
    local tps=$(get_tps 1)
    local bps=$(get_bps)
    local block_lat_med=$(get_block_latency_median)
    local block_lat_p99=$(get_block_latency_p99)
    local active_val=$(get_active_validators)

    # Get current log counts
    local log_counts=$(get_current_log_counts)
    local warn_count=$(echo "$log_counts" | cut -d':' -f1)
    local error_count=$(echo "$log_counts" | cut -d':' -f2)

    echo "$timestamp,$tps,$bps,$block_lat_med,$block_lat_p99,$active_val,$warn_count,$error_count"
}

# Monitor experiment and collect metrics during execution
monitor_experiment() {
    local scenario_name="$1"
    local scenario_dir="$2"
    local run_all_pid="$3"

    local metrics_file="$scenario_dir/live_metrics.csv"
    echo "timestamp,tps,bps,block_latency_median,block_latency_p99,active_validators,warn_count,error_count" > "$metrics_file"

    log "Starting live metrics collection for $scenario_name"

    # Wait for burn-in period
    log "Burn-in period: waiting $BURN_IN_SECONDS seconds..."
    sleep "$BURN_IN_SECONDS"

    # Calculate monitoring period
    local monitoring_duration=$((TEST_DURATION - BURN_IN_SECONDS - COOL_DOWN_SECONDS))
    local end_time=$(($(date +%s) + monitoring_duration))
    local sample_count=0

    log "Monitoring for $monitoring_duration seconds (sampling every $SAMPLE_INTERVAL seconds)"

    # Collect metrics during stable period
    while [[ $(date +%s) -lt $end_time ]] && kill -0 "$run_all_pid" 2>/dev/null; do
        timestamp=$(date -Iseconds)
        sample=$(collect_sample "$timestamp")
        echo "$sample" >> "$metrics_file"

        # Parse for live display
        IFS=',' read -r ts tps bps block_med block_p99 active warn_count error_count <<< "$sample"
        log "Sample $((++sample_count)): TPS=$tps, BPS=$bps, Block_lat=${block_med}ms, Active=$active, WARN=$warn_count, ERROR=$error_count"

        sleep "$SAMPLE_INTERVAL"
    done

    log "Live metrics collection completed. Collected $sample_count samples."

    # Wait for run-all.sh to complete if still running
    if kill -0 "$run_all_pid" 2>/dev/null; then
        log "Waiting for run-all.sh to complete..."
        wait "$run_all_pid"
    fi
}

# Calculate statistics from collected samples with proper labels
calculate_statistics() {
    local metrics_file="$1"
    local stats_file="$2"
    local scenario_dir="$3"

    if [[ ! -f "$metrics_file" ]]; then
        log "ERROR: Metrics file $metrics_file not found"
        return 1
    fi

    # Check if we have data (more than just header)
    local sample_count=$(tail -n +2 "$metrics_file" | wc -l)
    if [[ "$sample_count" -eq 0 ]]; then
        log "WARNING: No metrics samples collected"
        echo "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0" > "$stats_file"
        return 0
    fi

    log "Calculating statistics from $sample_count samples"

    # Create detailed statistics report
    {
        echo "=== STATISTICS REPORT ==="
        echo "Samples collected: $sample_count"
        echo "Sampling interval: $SAMPLE_INTERVAL seconds"
        echo "Monitoring duration: $((sample_count * SAMPLE_INTERVAL)) seconds"
        echo ""
    } > "$scenario_dir/statistics_report.txt"

    # Use awk to calculate statistics for each metric column
    awk -F',' -v report_file="$scenario_dir/statistics_report.txt" '
    NR == 1 { next }  # Skip header
    NR == 2 {
        # Initialize arrays for first data row
        for(i=2; i<=8; i++) {
            sum[i] = $i
            min[i] = $i
            max[i] = $i
            values[i][1] = $i
            count[i] = 1
        }
        next
    }
    {
        # Process subsequent rows
        for(i=2; i<=8; i++) {
            if($i != "" && $i != "null") {
                sum[i] += $i
                if($i < min[i]) min[i] = $i
                if($i > max[i]) max[i] = $i
                values[i][++count[i]] = $i
            }
        }
    }
    END {
        # Calculate means
        for(i=2; i<=8; i++) {
            mean[i] = (count[i] > 0) ? sum[i]/count[i] : 0
        }

        # Calculate medians (simple approximation)
        for(i=2; i<=8; i++) {
            if(count[i] > 0) {
                mid = int(count[i]/2) + 1
                median[i] = values[i][mid]
            } else {
                median[i] = 0
            }
        }

        # Print detailed report
        print "PERFORMANCE METRICS:" >> report_file
        printf "TPS:              mean=%.3f, median=%.3f, min=%.3f, max=%.3f\n", mean[2], median[2], min[2], max[2] >> report_file
        printf "BPS:              mean=%.3f, median=%.3f, min=%.3f, max=%.3f\n", mean[3], median[3], min[3], max[3] >> report_file
        print "" >> report_file
        print "LATENCY METRICS:" >> report_file
        printf "Block lat (med):  mean=%.3f, median=%.3f, min=%.3f, max=%.3f ms\n", mean[4], median[4], min[4], max[4] >> report_file
        printf "Block lat (p99):  mean=%.3f, median=%.3f, min=%.3f, max=%.3f ms\n", mean[5], median[5], min[5], max[5] >> report_file
        print "" >> report_file
        print "SYSTEM HEALTH:" >> report_file
        printf "Active validators: mean=%.1f, median=%.1f, min=%.1f, max=%.1f\n", mean[6], median[6], min[6], max[6] >> report_file
        print "" >> report_file
        print "LOG ISSUES:" >> report_file
        printf "WARN count:       mean=%.1f, median=%.1f, min=%.1f, max=%.1f\n", mean[7], median[7], min[7], max[7] >> report_file
        printf "ERROR count:      mean=%.1f, median=%.1f, min=%.1f, max=%.1f\n", mean[8], median[8], min[8], max[8] >> report_file

        # Output CSV: mean_tps,median_tps,min_tps,max_tps,mean_bps,median_bps,min_bps,max_bps,mean_block_lat_med,median_block_lat_med,min_block_lat_med,max_block_lat_med,mean_active,median_active,min_active,max_active,final_warn,final_error
        printf "%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.1f,%.1f,%.1f,%.1f,%.0f,%.0f\n",
            mean[2], median[2], min[2], max[2],    # TPS
            mean[3], median[3], min[3], max[3],    # BPS
            mean[4], median[4], min[4], max[4],    # Block latency median
            mean[6], median[6], min[6], max[6],    # Active validators
            max[7], max[8]                         # Final WARN/ERROR counts
    }' "$metrics_file" > "$stats_file"

    # Log the statistics with labels
    if [[ -f "$stats_file" ]]; then
        stats=$(cat "$stats_file")
        IFS=',' read -r mean_tps median_tps min_tps max_tps mean_bps median_bps min_bps max_bps mean_block_lat median_block_lat min_block_lat max_block_lat mean_active median_active min_active max_active final_warn final_error <<< "$stats"

        log "=== CALCULATED STATISTICS ==="
        log "TPS:              mean=$mean_tps, median=$median_tps, range=[$min_tps-$max_tps]"
        log "BPS:              mean=$mean_bps, median=$median_bps, range=[$min_bps-$max_bps]"
        log "Block latency:    mean=${mean_block_lat}ms, median=${median_block_lat}ms, range=[${min_block_lat}-${max_block_lat}]ms"
        log "Active validators: mean=$mean_active, median=$median_active, range=[$min_active-$max_active]"
        log "Log issues:       WARN=$final_warn, ERROR=$final_error"
    fi
}

# === ROBUSTNESS TEST SCENARIOS ===

declare -a SCENARIOS=(
    "network_partition:10:45:20:20"
    "latency_fluctuation:10:25:15:10"
    "byzantine_behavior:10:30:20:25"
    "slow_recovery:10:40:10:15"
)

# === MAIN TEST EXECUTION ===

log "==== IOTA Network Live Robustness Test (Fixed) ===="
log "Starting test run at $(date)"
log "Test duration per scenario: $TEST_DURATION seconds"
log "Burn-in: $BURN_IN_SECONDS seconds, Cool-down: $COOL_DOWN_SECONDS seconds"
log "Monitoring duration per scenario: $((TEST_DURATION - BURN_IN_SECONDS - COOL_DOWN_SECONDS)) seconds"

# Create CSV header for final results (removed transaction latency columns)
echo "scenario,validators,block_pct,loss_pct,restart_pct,mean_tps,median_tps,min_tps,max_tps,mean_bps,median_bps,min_bps,max_bps,mean_block_lat,median_block_lat,min_block_lat,max_block_lat,mean_active,median_active,min_active,max_active,final_warn,final_error" > "$RESULTS_DIR/live_robustness_results.csv"

scenario_count=0
total_scenarios=${#SCENARIOS[@]}

for scenario in "${SCENARIOS[@]}"; do
    scenario_count=$((scenario_count + 1))
    IFS=':' read -r name n x l r <<< "$scenario"

    log "============================================="
    log "Starting scenario $scenario_count/$total_scenarios: $name"

    # Ensure 70% availability constraint
    min_online=$(awk "BEGIN {printf \"%.0f\", ($n * 0.7 + 0.5)}")
    max_restart=$(awk "BEGIN {printf \"%.0f\", (($n - $min_online) * 100 / $n)}")

    if [ "$r" -gt "$max_restart" ]; then
        log "Adjusting restart from $r% to $max_restart% for 70% availability"
        r=$max_restart
    fi

    # Create scenario directory
    timestamp=$(date +%Y%m%d-%H%M%S)
    scenario_dir="$RESULTS_DIR/${name}_${timestamp}"
    mkdir -p "$scenario_dir"

    log "Running experiment with live monitoring..."

    # Start run-all.sh in background
    ./run-all.sh \
        -n "$n" \
        -p "starfish" \
        -g true \
        -x "$x" \
        -l "$l" \
        -r "$r" \
        -t "$TEST_DURATION" \
        -S true \
        -C stress \
        -T 200 \
        -s "$SEED" \
        -m > "$scenario_dir/run_all_output.log" 2>&1 &

    run_all_pid=$!
    log "run-all.sh started with PID $run_all_pid"

    # Monitor experiment and collect live metrics
    monitor_experiment "$name" "$scenario_dir" "$run_all_pid"

    # Calculate statistics from collected samples
    log "Calculating statistics..."
    calculate_statistics "$scenario_dir/live_metrics.csv" "$scenario_dir/statistics.csv" "$scenario_dir"

    # Read and add calculated statistics to final results
    if [[ -f "$scenario_dir/statistics.csv" ]]; then
        stats=$(cat "$scenario_dir/statistics.csv")
        echo "$name,$n,$x,$l,$r,$stats" >> "$RESULTS_DIR/live_robustness_results.csv"
    else
        log "ERROR: Statistics calculation failed"
        echo "$name,$n,$x,$l,$r,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0" >> "$RESULTS_DIR/live_robustness_results.csv"
    fi

    # Copy logs
    if [ -d "logs" ]; then
        cp -r logs/* "$scenario_dir/" 2>/dev/null || true
    fi

    log "Scenario $name completed. Detailed report at $scenario_dir/statistics_report.txt"

    # Wait between scenarios
    if [ "$scenario_count" -lt "$total_scenarios" ]; then
        log "Waiting 60 seconds before next scenario..."
        sleep 60
    fi
done

log "============================================="
log "All scenarios completed!"
log "Results saved to $RESULTS_DIR/live_robustness_results.csv"

# Show detailed summary with proper labels
echo ""
log "=== DETAILED RESULTS SUMMARY ==="
echo ""
echo "Legend:"
echo "  TPS = Transactions Per Second"
echo "  BPS = Blocks Per Second (consensus messages)"
echo "  Block_lat = Block commit latency (ms)"
echo "  Active = Active validators count"
echo "  WARN/ERROR = Log message counts"
echo ""

printf "%-18s | %-25s | %-25s | %-20s | %-12s\n" \
    "Scenario" "TPS (mean/median/range)" "BPS (mean/median/range)" "Block Lat (mean/range)" "WARN/ERROR"
echo "-------------------|---------------------------|---------------------------|----------------------|------------"

tail -n +2 "$RESULTS_DIR/live_robustness_results.csv" | while IFS=',' read -r scenario validators block_pct loss_pct restart_pct mean_tps median_tps min_tps max_tps mean_bps median_bps min_bps max_bps mean_block_lat median_block_lat min_block_lat max_block_lat mean_active median_active min_active max_active final_warn final_error; do
    printf "%-18s | %.1f/%.1f/[%.1f-%.1f]     | %.2f/%.2f/[%.2f-%.2f]     | %.1f/[%.1f-%.1f]ms   | %s/%s\n" \
        "$scenario" "$mean_tps" "$median_tps" "$min_tps" "$max_tps" \
        "$mean_bps" "$median_bps" "$min_bps" "$max_bps" \
        "$mean_block_lat" "$min_block_lat" "$max_block_lat" \
        "$final_warn" "$final_error"
done

echo ""
log "Individual scenario reports available in $RESULTS_DIR/*/statistics_report.txt"
log "Test complete!"