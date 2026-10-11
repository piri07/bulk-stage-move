import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { Stage } from '../crm/pipeline';
import { LARGE_WORKSPACE_ID } from '../scripts/seed';

/** Shared by the benchmarks in this folder. */

export const API_URL = process.env.API_URL ?? 'http://localhost:3000';

/** The benchmarks move the same ~50,000 Large Co deals back and forth between these stages. */
export const BULK_STAGES: [Stage, Stage] = ['contract_sent', 'verbal_commit'];

const JOB_TIMEOUT_MS = 120_000;

export function otherStage(stage: Stage): Stage {
  return stage === BULK_STAGES[0] ? BULK_STAGES[1] : BULK_STAGES[0];
}

/**
 * The benchmarks' bulk filter: a created_at cut-off that selects 50,000 Large Co deals (fewer only
 * if timestamps tie at the boundary).
 */
export async function bulkCutoff(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM opportunities WHERE workspace_id = $1
      ORDER BY created_at OFFSET 50000 LIMIT 1`,
    [LARGE_WORKSPACE_ID],
  );
  const cutoff = rows[0]?.created_at;
  if (!cutoff) throw new Error('Large Co has fewer than 50,000 deals: run `make seed-full` first');
  return cutoff.toISOString();
}

export interface SubmittedJob {
  id: number;
  total: number;
  /** The POST round trip, which includes taking the snapshot. */
  submitMs: number;
}

/** Submits the benchmark move: every deal created before `createdTo` goes to `targetStage`. */
export async function submitBulkMove(createdTo: string, targetStage: Stage): Promise<SubmittedJob> {
  const started = performance.now();
  const res = await fetch(`${API_URL}/bulk-moves`, {
    method: 'POST',
    headers: {
      'x-workspace-id': LARGE_WORKSPACE_ID,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ filter: { createdTo }, targetStage }),
  });
  const submitMs = performance.now() - started;
  if (res.status !== 202) {
    throw new Error(`bulk submit failed: HTTP ${res.status} ${await res.text()}`);
  }
  const { id, total } = (await res.json()) as { id: number; total: number };
  return { id, total, submitMs };
}

export interface FinishedJob {
  total: number;
  moved: number;
  skipped: number;
  /** From creation until a worker first claimed it. */
  queuedSeconds: number;
  /** From the claim until the last batch committed: the worker's own time. */
  runSeconds: number;
}

/**
 * Waits for a job to finish, reading the database directly. The API allows one poll per job every
 * 2s, which is too coarse to time a job that runs for a few seconds. Fails rather than waiting
 * forever when no worker is running.
 */
export async function waitForJob(pool: Pool, id: number): Promise<FinishedJob> {
  const deadline = performance.now() + JOB_TIMEOUT_MS;
  for (;;) {
    const { rows } = await pool.query<FinishedJob & { status: string }>(
      `SELECT status, total, moved_count AS moved, skipped_count AS skipped,
              coalesce(extract(epoch FROM started_at - created_at), 0)::float8 AS "queuedSeconds",
              coalesce(extract(epoch FROM finished_at - started_at), 0)::float8 AS "runSeconds"
         FROM bulk_jobs WHERE id = $1`,
      [id],
    );
    const job = rows[0];
    if (job && job.status !== 'pending' && job.status !== 'running') {
      if (job.status !== 'completed') throw new Error(`bulk job ${id} ended as ${job.status}`);
      return job;
    }
    if (performance.now() > deadline) {
      throw new Error(
        `bulk job ${id} is still ${job?.status ?? 'missing'} after ${JOB_TIMEOUT_MS / 1000}s: ` +
          'is a worker running?',
      );
    }
    await sleep(50);
  }
}

/** Reads a positive number flag such as `--runs 5`. */
export function numberFlag(argv: string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
  return parsed;
}

/** The container's view of the machine. Inside Docker Desktop, that is the VM's CPUs and memory. */
export function machineLine(): string {
  return (
    `machine: ${cpus().length} CPUs, ${(totalmem() / 2 ** 30).toFixed(1)} GiB; ` +
    `node ${process.version}; API at ${API_URL}`
  );
}
