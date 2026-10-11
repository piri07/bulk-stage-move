#!/usr/bin/env bash
# Kill and resume: a 50,000-deal bulk move whose worker is SIGKILLed at 30,000 deals, then
# restarted at once. Reports how long the job took to finish after the kill, and proves the result
# is correct: every deal moved exactly once, nothing outside the snapshot touched.
#
# Needs the full seed (make seed-full) and the compose stack running. Moves deals. Every time is
# taken from Postgres's clock, so nothing depends on the host's tools.
set -euo pipefail
cd "$(dirname "$0")/.."

API="${API_URL:-http://localhost:3000}"
LARGE=00000000-0000-4000-8000-000000000001
KILL_AT="${KILL_AT:-30000}"

sql() { docker compose exec -T postgres psql -U crm -d crm -tA -c "$1"; }
uuid() { uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid; }

# Prints the new job's id.
submit() {
  curl -sf -X POST "$API/bulk-moves" \
    -H "x-workspace-id: $LARGE" -H "idempotency-key: $(uuid)" -H 'content-type: application/json' \
    -d "{\"filter\":{\"createdTo\":\"$CUTOFF\"},\"targetStage\":\"$1\"}" |
    sed -E 's/.*"id":([0-9]+).*/\1/'
}

# Waits until the given SQL returns "t", or gives up after $2 seconds.
wait_for() {
  local deadline=$((SECONDS + $2))
  until [ "$(sql "$1")" = "t" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "gave up after $2s waiting for: $1" >&2
      exit 1
    fi
    sleep 0.05
  done
}

docker compose up -d --wait worker >/dev/null 2>&1

# The same 50,000 deals the other benchmarks use. A first move puts them all in one stage, so the
# measured job moves every one of them.
CUTOFF=$(sql "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
                FROM opportunities WHERE workspace_id = '$LARGE' ORDER BY created_at OFFSET 50000 LIMIT 1")
PREPARE=$(submit verbal_commit)
wait_for "SELECT status = 'completed' FROM bulk_jobs WHERE id = $PREPARE" 120

JOB=$(submit contract_sent)
echo "job $JOB: $(sql "SELECT total FROM bulk_jobs WHERE id = $JOB") deals; the worker will be killed at $KILL_AT"
wait_for "SELECT cursor_seq >= $KILL_AT FROM bulk_jobs WHERE id = $JOB" 120

docker compose kill -s SIGKILL worker >/dev/null 2>&1
KILLED_AT=$(sql "SELECT clock_timestamp()")
echo "SIGKILL sent; deals committed at that moment: $(sql "SELECT cursor_seq FROM bulk_jobs WHERE id = $JOB")"

# Restart at once, as a supervisor would. The new worker can't claim the job until the dead
# worker's lease (WORKER_LEASE_MS, 15s by default) runs out.
docker compose start worker >/dev/null 2>&1
wait_for "SELECT lease_epoch >= 2 FROM bulk_jobs WHERE id = $JOB" 120
TAKEN_OVER_AT=$(sql "SELECT clock_timestamp()")
wait_for "SELECT status NOT IN ('pending', 'running') FROM bulk_jobs WHERE id = $JOB" 120

echo
echo "timings (Postgres clock):"
sql "SELECT format('  kill -> another worker took over:  %ss (the dead worker''s lease running out)',
                    round(extract(epoch FROM '$TAKEN_OVER_AT'::timestamptz - '$KILLED_AT'::timestamptz)::numeric, 1))
     UNION ALL
     SELECT format('  kill -> job completed:            %ss', round(extract(epoch FROM finished_at - '$KILLED_AT'::timestamptz)::numeric, 1))
       FROM bulk_jobs WHERE id = $JOB
     UNION ALL
     SELECT format('  whole job, start to finish:       %ss', round(extract(epoch FROM finished_at - started_at)::numeric, 1))
       FROM bulk_jobs WHERE id = $JOB"

PROOF="
  WITH j AS (SELECT * FROM bulk_jobs WHERE id = $JOB),
  checks AS (
    SELECT j.status, j.total, j.cursor_seq AS processed, j.moved_count AS moved,
           j.skipped_count AS skipped, j.attempts, j.lease_epoch AS claims, j.last_error,
           (SELECT count(*) FROM bulk_job_items i WHERE i.job_id = j.id AND i.outcome IS NULL)
             AS items_without_outcome,
           (SELECT count(*) FROM stage_transitions t WHERE t.bulk_job_id = j.id) AS history_rows,
           (SELECT count(*) FROM (SELECT 1 FROM stage_transitions t WHERE t.bulk_job_id = j.id
                                   GROUP BY t.opportunity_id HAVING count(*) > 1) d)
             AS deals_moved_twice,
           (SELECT count(*) FROM bulk_job_items i JOIN opportunities o ON o.id = i.opportunity_id
             WHERE i.job_id = j.id AND i.outcome = 'moved' AND o.stage <> j.target_stage)
             AS moved_but_not_in_target,
           (SELECT count(*) FROM stage_transitions t
             WHERE t.bulk_job_id = j.id
               AND NOT EXISTS (SELECT 1 FROM bulk_job_items i
                                WHERE i.job_id = j.id AND i.opportunity_id = t.opportunity_id))
             AS moves_outside_snapshot
      FROM j)"

echo
echo "proof:"
docker compose exec -T postgres psql -U crm -d crm -x -c "$PROOF SELECT * FROM checks"

OK=$(sql "$PROOF SELECT status = 'completed' AND processed = total AND history_rows = moved
                    AND items_without_outcome = 0 AND deals_moved_twice = 0
                    AND moved_but_not_in_target = 0 AND moves_outside_snapshot = 0
               FROM checks")
if [ "$OK" = "t" ]; then
  echo "PROOF: OK. Every deal has exactly one outcome, every moved deal has exactly one history row"
  echo "       from this job, and no deal outside the snapshot was touched."
else
  echo "PROOF: FAILED"
  exit 1
fi
