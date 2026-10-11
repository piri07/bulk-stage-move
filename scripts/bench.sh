#!/usr/bin/env bash
# Runs every benchmark, each from a fresh seed, and saves the raw output to bench/results/.
# Takes about six minutes. Leaves the stack running with default settings and the data moved
# around; run `make seed-full` afterwards for a clean dataset.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bench/results
OUT="bench/results/$(date +%Y-%m-%d-%H%M).txt"

# Drops docker compose's container status lines from the output.
quiet() { grep -v -E '^ ?(Container|Network|Volume|Image) ' || true; }
seed() { make -s seed-full 2>&1 | grep -E '^done' || true; }
worker() {
  WORKER_MAX_DEALS_PER_SECOND="$1" docker compose up -d --wait worker 2>&1 | quiet >/dev/null
}
bench() { docker compose run --rm -e BENCH_LABEL="$1" bench "${@:2}" 2>&1 | quiet; }

{
  echo "# Benchmark run, $(date -u +%Y-%m-%dT%H:%M:%SZ), commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo
  echo "## Machine"
  if [ "$(uname)" = "Darwin" ]; then
    echo "host: $(sysctl -n machdep.cpu.brand_string), $(sysctl -n hw.ncpu) cores," \
      "$(($(sysctl -n hw.memsize) / 1073741824)) GiB RAM, macOS $(sw_vers -productVersion)"
  else
    echo "host: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), $(nproc) cores," \
      "$(free -g | awk '/Mem:/ {print $2}') GiB RAM, $(uname -sr)"
  fi
  echo "docker: $(docker info --format '{{.OperatingSystem}} {{.ServerVersion}}, {{.NCPU}} CPUs and {{.MemTotal}} bytes for containers')"
  docker compose up -d --build --wait api worker 2>&1 | quiet >/dev/null
  echo "postgres: $(docker compose exec -T postgres psql -U crm -d crm -tAc 'SHOW server_version'), default settings"
  echo "app: one API process, one worker; batch 500, lease 15s, poll limit 2s"

  echo
  echo "## 1a. Bulk move of 50,000 deals, paced (10,000 deals/s, the default)"
  seed
  bench "paced at 10,000 deals/s" node dist/bench/throughput.js --runs 5

  echo
  echo "## 1b. Bulk move of 50,000 deals, unpaced"
  worker 0
  bench "unpaced" node dist/bench/throughput.js --runs 5
  worker 10000

  echo
  echo "## 2a. Interactive latency during bulk jobs, paced"
  seed
  bench "paced at 10,000 deals/s" node dist/bench/isolation.js --rate 200 --seconds 15 --rounds 2

  echo
  echo "## 2b. Interactive latency during bulk jobs, unpaced"
  seed
  worker 0
  bench "unpaced" node dist/bench/isolation.js --rate 200 --seconds 15 --rounds 2
  worker 10000

  echo
  echo "## 3. Kill and resume (worker SIGKILLed at 30,000 of 50,000)"
  seed
  ./scripts/bench-kill-resume.sh
} 2>&1 | tee "$OUT"

echo
echo "saved to $OUT"
