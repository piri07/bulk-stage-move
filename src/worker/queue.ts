import type { Pool } from 'pg';
import type { WorkerConfig } from '../config';
import type { Stage } from '../crm/pipeline';
import { isPgError, PgErrorCode } from '../db/pg-errors';
import { withTransaction } from '../db/transaction';

/** A job as the worker holding it sees it. */
export interface ClaimedJob {
  id: number;
  workspaceId: string;
  targetStage: Stage;
  total: number;
  processed: number;
  /** Which claim this is. Every write checks it, so a replaced worker's writes are refused. */
  leaseEpoch: number;
  attempts: number;
}

export type BatchSettings = Pick<WorkerConfig, 'batchSize' | 'leaseMs' | 'lockTimeoutMs'>;

export interface JobProgress {
  total: number;
  processed: number;
  moved: number;
  skipped: number;
  done: boolean;
}

export type BatchOutcome =
  | { kind: 'progressed'; progress: JobProgress }
  /** Another worker has claimed the job since; nothing was written. */
  | { kind: 'lost_lease' };

/** Lets tests stop a batch between its moves and its checkpoint, like a worker dying there. */
export interface BatchFaults {
  afterApply?: () => Promise<void>;
}

// The next job to run: a pending job whose workspace has none running, or a running job whose
// lease has lapsed (its worker died, failed, or handed it back). SKIP LOCKED means workers asking
// at the same moment take different jobs, and a job whose batch is mid-transaction can't be
// claimed. An expired lease that still names an owner was never handed back: that worker died,
// which counts as a failed attempt.
const CLAIM_NEXT_JOB = `
  WITH candidate AS (
    SELECT j.id
      FROM bulk_jobs j
     WHERE (j.status = 'pending'
            AND NOT EXISTS (SELECT 1 FROM bulk_jobs r
                             WHERE r.workspace_id = j.workspace_id AND r.status = 'running'))
        OR (j.status = 'running' AND j.lease_expires_at < now())
     ORDER BY j.id
     LIMIT 1
       FOR UPDATE SKIP LOCKED
  )
  UPDATE bulk_jobs j
     SET status = 'running',
         lease_owner = $1,
         lease_epoch = j.lease_epoch + 1,
         lease_expires_at = now() + make_interval(secs => $2),
         started_at = coalesce(j.started_at, now()),
         attempts = j.attempts + (j.status = 'running' AND j.lease_owner IS NOT NULL)::int,
         last_error = CASE WHEN j.status = 'running' AND j.lease_owner IS NOT NULL
                           THEN 'worker lost: its lease expired mid-run' ELSE j.last_error END
    FROM candidate c
   WHERE j.id = c.id
  RETURNING j.id, j.workspace_id AS "workspaceId", j.target_stage AS "targetStage", j.total,
            j.cursor_seq AS processed, j.lease_epoch AS "leaseEpoch", j.attempts`;

export async function claimNextJob(
  pool: Pool,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedJob | null> {
  try {
    const { rows } = await pool.query<ClaimedJob>(CLAIM_NEXT_JOB, [workerId, leaseMs / 1000]);
    return rows[0] ?? null;
  } catch (err) {
    // Two workers started two jobs of the same workspace at the same instant, and the
    // one-running-job-per-workspace index let only one through. Nothing changed for this worker;
    // it will try again on its next poll.
    if (isPgError(err, PgErrorCode.UniqueViolation, 'bulk_jobs_one_running_per_workspace')) {
      return null;
    }
    throw err;
  }
}

// One batch, in one statement. The version check in `moved` is the "person wins" rule: a deal
// changed since the click no longer has its snapshot version, so it isn't moved. If a person's
// move holds the row lock, this statement waits, then re-checks the condition against the row
// the person committed, and skips it. The snapshot's from_stage is exact, because an unchanged
// version means an unchanged stage.
const APPLY_BATCH = `
  WITH batch AS (
    SELECT seq, opportunity_id, expected_version, from_stage
      FROM bulk_job_items
     WHERE job_id = $1 AND seq > $4
     ORDER BY seq
     LIMIT $5
  ),
  moved AS (
    UPDATE opportunities o
       SET stage = $3, version = o.version + 1, updated_at = clock_timestamp()
      FROM batch b
     WHERE o.id = b.opportunity_id
       AND o.workspace_id = $2
       AND o.version = b.expected_version
    RETURNING b.seq, o.id, b.from_stage
  ),
  history AS (
    INSERT INTO stage_transitions
           (workspace_id, opportunity_id, from_stage, to_stage, source, bulk_job_id, created_at)
    SELECT $2, m.id, m.from_stage, $3, 'bulk', $1, clock_timestamp()
      FROM moved m
  ),
  outcomes AS (
    UPDATE bulk_job_items i
       SET outcome = CASE WHEN m.seq IS NULL THEN 'skipped_conflict' ELSE 'moved' END
      FROM batch b
      LEFT JOIN moved m ON m.seq = b.seq
     WHERE i.job_id = $1 AND i.seq = b.seq
  )
  SELECT count(*)::int AS size, count(m.seq)::int AS moved
    FROM batch b
    LEFT JOIN moved m ON m.seq = b.seq`;

// The checkpoint: the cursor and counters move in the same transaction as the deals, so they
// can't disagree. A crash before the commit undoes the whole batch; after it, the batch is done
// for good. The lease is renewed with every batch.
const CHECKPOINT = `
  UPDATE bulk_jobs
     SET cursor_seq = $2,
         moved_count = moved_count + $3,
         skipped_count = skipped_count + $4,
         last_progress_at = now(),
         status = CASE WHEN $5 THEN 'completed' ELSE status END,
         finished_at = CASE WHEN $5 THEN now() ELSE finished_at END,
         lease_owner = CASE WHEN $5 THEN NULL ELSE lease_owner END,
         lease_expires_at = CASE WHEN $5 THEN NULL ELSE now() + make_interval(secs => $6) END
   WHERE id = $1
  RETURNING total, cursor_seq AS processed, moved_count AS moved, skipped_count AS skipped`;

/**
 * Processes the next batch of the job and commits it with its checkpoint, or nothing at all.
 * Batches are idempotent in effect: a batch that didn't commit leaves no trace and is simply
 * redone, and one that did commit is past the cursor and never seen again.
 */
export async function runBatch(
  pool: Pool,
  job: ClaimedJob,
  settings: BatchSettings,
  faults: BatchFaults = {},
): Promise<BatchOutcome> {
  return withTransaction(pool, async (tx) => {
    // Don't queue for long behind a lock someone else holds. The batch is retried later instead.
    await tx.query(`SELECT set_config('lock_timeout', $1, true)`, [`${settings.lockTimeoutMs}ms`]);

    // The fence. Lock this job's row and check the lease is still ours. A worker that was
    // replaced stops here. The row lock also keeps a would-be claimant out until this batch has
    // committed or rolled back.
    const {
      rows: [state],
    } = await tx.query<{ cursor: number; total: number }>(
      `SELECT cursor_seq AS cursor, total
         FROM bulk_jobs
        WHERE id = $1 AND lease_epoch = $2 AND status = 'running'
          FOR UPDATE`,
      [job.id, job.leaseEpoch],
    );
    if (!state) return { kind: 'lost_lease' };

    const {
      rows: [applied],
    } = await tx.query<{ size: number; moved: number }>(APPLY_BATCH, [
      job.id,
      job.workspaceId,
      job.targetStage,
      state.cursor,
      settings.batchSize,
    ]);
    const size = applied?.size ?? 0;
    const moved = applied?.moved ?? 0;
    if (size === 0 && state.cursor < state.total) {
      throw new Error(`job ${job.id} has no items after seq ${state.cursor} of ${state.total}`);
    }

    await faults.afterApply?.();

    const processed = state.cursor + size;
    const done = processed >= state.total;
    const {
      rows: [progress],
    } = await tx.query<Omit<JobProgress, 'done'>>(CHECKPOINT, [
      job.id,
      processed,
      moved,
      size - moved,
      done,
      settings.leaseMs / 1000,
    ]);
    if (!progress) throw new Error(`job ${job.id} disappeared mid-batch`);
    return { kind: 'progressed', progress: { ...progress, done } };
  });
}

/**
 * Graceful handover on shutdown. The lease ends now and its owner is cleared, so another worker
 * can resume straight away, and the handover doesn't count as a failed attempt.
 */
export async function releaseLease(pool: Pool, job: ClaimedJob): Promise<void> {
  await pool.query(
    `UPDATE bulk_jobs SET lease_owner = NULL, lease_expires_at = now()
      WHERE id = $1 AND lease_epoch = $2 AND status = 'running'`,
    [job.id, job.leaseEpoch],
  );
}

/** A batch failed: count the attempt, and make the job claimable again after a backoff. */
export async function recordFailure(
  pool: Pool,
  job: ClaimedJob,
  error: string,
  retryAfterMs: number,
): Promise<void> {
  await pool.query(
    `UPDATE bulk_jobs
        SET attempts = attempts + 1, last_error = $3, lease_owner = NULL,
            lease_expires_at = now() + make_interval(secs => $4)
      WHERE id = $1 AND lease_epoch = $2 AND status = 'running'`,
    [job.id, job.leaseEpoch, error.slice(0, 1000), retryAfterMs / 1000],
  );
}

/** Gives up on the job. Deals already moved stay moved: batches are final once committed. */
export async function failJob(pool: Pool, job: ClaimedJob, reason: string): Promise<void> {
  await pool.query(
    `UPDATE bulk_jobs
        SET status = 'failed', finished_at = now(), last_error = $3,
            lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_epoch = $2 AND status = 'running'`,
    [job.id, job.leaseEpoch, reason],
  );
}
