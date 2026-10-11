import type { Stage } from '../crm/pipeline';
import { oneRow, type Queryable } from '../db/queryable';
import type { JobItemOutcome } from './dto';
import type { BulkFilter } from './filter';
import type { ProgressRow } from './progress';

export type BulkJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BulkJob {
  id: number;
  status: BulkJobStatus;
  targetStage: Stage;
  filter: BulkFilter;
  /** Deals in the snapshot. */
  total: number;
  /** Deals whose outcome is committed: the job's cursor. */
  processed: number;
  moved: number;
  /** Deals a person changed after the click, left where they put them. */
  skipped: number;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  lastProgressAt: Date | null;
  finishedAt: Date | null;
}

export interface BulkJobItem {
  seq: number;
  opportunityId: number;
  fromStage: Stage;
  /** null until the worker has processed the deal. */
  outcome: JobItemOutcome | null;
}

const JOB_COLUMNS = `
  id, status, target_stage AS "targetStage", filter, total,
  cursor_seq AS processed, moved_count AS moved, skipped_count AS skipped,
  attempts, last_error AS "lastError", created_at AS "createdAt", started_at AS "startedAt",
  last_progress_at AS "lastProgressAt", finished_at AS "finishedAt"`;

export interface NewBulkJob {
  workspaceId: string;
  idempotencyKey: string;
  requestHash: string;
  filter: BulkFilter;
  targetStage: Stage;
}

/**
 * Inserts the job and returns its id, or null when this workspace already used the key. A
 * concurrent insert of the same key waits on the unique constraint until the first transaction
 * ends, so exactly one of them creates the job.
 */
export async function insertJob(tx: Queryable, job: NewBulkJob): Promise<number | null> {
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO bulk_jobs (workspace_id, idempotency_key, request_hash, filter, target_stage)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [job.workspaceId, job.idempotencyKey, job.requestHash, job.filter, job.targetStage],
  );
  return rows[0]?.id ?? null;
}

export async function findJobByKey(
  db: Queryable,
  workspaceId: string,
  idempotencyKey: string,
): Promise<{ job: BulkJob; requestHash: string } | undefined> {
  const { rows } = await db.query<BulkJob & { requestHash: string }>(
    `SELECT ${JOB_COLUMNS}, request_hash AS "requestHash"
       FROM bulk_jobs
      WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, idempotencyKey],
  );
  const row = rows[0];
  if (!row) return undefined;
  const { requestHash, ...job } = row;
  return { job, requestHash };
}

export async function findJob(
  db: Queryable,
  workspaceId: string,
  id: number,
): Promise<BulkJob | undefined> {
  const { rows } = await db.query<BulkJob>(
    `SELECT ${JOB_COLUMNS} FROM bulk_jobs WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0];
}

/**
 * Writes the job's snapshot: every matching deal not already in the target stage, numbered in id
 * order, with its version and stage at this instant. A single statement, so it reads one
 * consistent moment. Returns how many deals it listed, at most `limit`.
 *
 * Only placeholders are added to the SQL text, never values, so the dynamic WHERE clause can't
 * be used for injection.
 */
export async function snapshotDeals(
  tx: Queryable,
  args: {
    jobId: number;
    workspaceId: string;
    filter: BulkFilter;
    targetStage: Stage;
    limit: number;
  },
): Promise<number> {
  const { filter } = args;
  const values: unknown[] = [args.jobId, args.workspaceId, args.targetStage];
  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const where = ['workspace_id = $2', 'stage <> $3'];
  if (filter.stages) where.push(`stage = ANY(${param(filter.stages)}::opportunity_stage[])`);
  if (filter.ownerIds) where.push(`owner_id = ANY(${param(filter.ownerIds)}::uuid[])`);
  if (filter.statuses) where.push(`status = ANY(${param(filter.statuses)}::opportunity_status[])`);
  if (filter.minValueCents !== undefined) {
    where.push(`value_cents >= ${param(filter.minValueCents)}`);
  }
  if (filter.maxValueCents !== undefined) {
    where.push(`value_cents <= ${param(filter.maxValueCents)}`);
  }
  if (filter.createdFrom) where.push(`created_at >= ${param(filter.createdFrom)}::timestamptz`);
  if (filter.createdTo) where.push(`created_at < ${param(filter.createdTo)}::timestamptz`);

  const result = await tx.query(
    `INSERT INTO bulk_job_items (job_id, seq, opportunity_id, expected_version, from_stage)
     SELECT $1, row_number() OVER (ORDER BY id), id, version, stage
       FROM opportunities
      WHERE ${where.join(' AND ')}
      ORDER BY id
      LIMIT ${param(args.limit)}`,
    values,
  );
  return result.rowCount ?? 0;
}

/** Records the snapshot's size. A job with nothing to move is complete straight away. */
export async function finalizeJob(tx: Queryable, id: number, total: number): Promise<BulkJob> {
  const { rows } = await tx.query<BulkJob>(
    `UPDATE bulk_jobs
        SET total = $2,
            status = CASE WHEN $2 = 0 THEN 'completed' ELSE 'pending' END,
            finished_at = CASE WHEN $2 = 0 THEN now() END
      WHERE id = $1
      RETURNING ${JOB_COLUMNS}`,
    [id, total],
  );
  return oneRow(rows);
}

/**
 * The job row plus the timings progress health needs. Every duration is computed by Postgres
 * against its own now(), the clock that wrote the timestamps, so API and database clocks can't
 * disagree.
 */
export async function findProgressRow(
  db: Queryable,
  workspaceId: string,
  id: number,
): Promise<ProgressRow | undefined> {
  const { rows } = await db.query<ProgressRow>(
    `SELECT j.id, j.status, j.total, j.cursor_seq AS processed, j.moved_count AS moved,
            j.skipped_count AS skipped, j.attempts, j.last_error AS "lastError",
            j.lease_owner AS "leaseOwner", j.last_progress_at AS "lastProgressAt",
            extract(epoch FROM now() - j.last_progress_at)::float8 AS "secondsSinceProgress",
            extract(epoch FROM j.lease_expires_at - now())::float8 AS "leaseSecondsLeft",
            extract(epoch FROM now() - coalesce(j.started_at, j.created_at))::float8
              AS "secondsSinceStart",
            extract(epoch FROM now() - j.created_at)::float8 AS "secondsSinceCreated",
            j.started_at IS NOT NULL AS started,
            (SELECT r.id FROM bulk_jobs r
              WHERE r.workspace_id = j.workspace_id AND r.status = 'running' AND r.id <> j.id
              LIMIT 1) AS "blockingJobId",
            EXISTS (SELECT 1 FROM bulk_jobs w
                     WHERE w.status = 'running' AND w.lease_owner IS NOT NULL
                       AND w.lease_expires_at > now()) AS "anyWorkerActive"
       FROM bulk_jobs j
      WHERE j.id = $1 AND j.workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0];
}

export async function listJobItems(
  db: Queryable,
  jobId: number,
  afterSeq: number,
  limit: number,
  outcome: JobItemOutcome | undefined,
): Promise<BulkJobItem[]> {
  const { rows } = await db.query<BulkJobItem>(
    `SELECT seq, opportunity_id AS "opportunityId", from_stage AS "fromStage", outcome
       FROM bulk_job_items
      WHERE job_id = $1 AND seq > $2 AND ($4::text IS NULL OR outcome = $4)
      ORDER BY seq
      LIMIT $3`,
    [jobId, afterSeq, limit, outcome ?? null],
  );
  return rows;
}
