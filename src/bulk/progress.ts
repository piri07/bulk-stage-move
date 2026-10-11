import type { BulkJobStatus } from './bulk-jobs.repository';

/**
 * What a user watching a job needs to know: moving, slow, stuck or failed. Everything here is
 * derived from the job's committed row, so a restart can't make it lie. Durations are computed
 * by Postgres with its own clock (see findProgressRow), so API and database clocks can't
 * disagree either.
 */
export type JobHealth =
  | 'queued' // waiting for a worker
  | 'active' // a worker holds it and batches keep committing
  | 'slow' // a worker holds it, but no batch has committed for a while
  | 'retrying' // a batch failed; the job is waiting out its backoff
  | 'stalled' // its worker stopped renewing the lease; another worker will take over
  | 'stuck' // waiting or stalled for a long time with no worker active anywhere
  | 'failed'
  | 'completed';

/** The job row plus timings computed in the database. */
export interface ProgressRow {
  id: number;
  status: BulkJobStatus;
  total: number;
  processed: number;
  moved: number;
  skipped: number;
  attempts: number;
  lastError: string | null;
  leaseOwner: string | null;
  lastProgressAt: Date | null;
  /** null until the first batch commits. */
  secondsSinceProgress: number | null;
  /** Negative once the lease has expired; null when there is no lease. */
  leaseSecondsLeft: number | null;
  /**
   * How long the job has been running: from its start (or creation, if it hasn't started) until
   * it finished, or until now while it hasn't. A finished job's rate must not keep falling as
   * time passes.
   */
  elapsedSeconds: number;
  secondsSinceCreated: number;
  started: boolean;
  /** Another running job of the same workspace, which this one is queued behind. */
  blockingJobId: number | null;
  /** Whether any worker currently holds a valid lease on any job. */
  anyWorkerActive: boolean;
}

export interface ProgressSettings {
  /** A held job with no committed batch for this long is "slow". */
  slowAfterSeconds: number;
  /** Waiting or stalled this long, with no worker active anywhere, is "stuck". */
  stuckAfterSeconds: number;
  maxAttempts: number;
  pollIntervalMs: number;
}

export interface JobProgress {
  jobId: number;
  status: BulkJobStatus;
  health: JobHealth;
  /** A plain-language explanation of the health. */
  detail: string;
  total: number;
  processed: number;
  moved: number;
  skipped: number;
  remaining: number;
  percent: number;
  /** Average since the job started, waits included; null before any progress. */
  dealsPerSecond: number | null;
  etaSeconds: number | null;
  lastProgressAt: Date | null;
  secondsSinceProgress: number | null;
  attempts: number;
  lastError: string | null;
  /** When retrying: seconds until the next attempt may start. */
  retryInSeconds: number | null;
  /** How long to wait before polling again; null once the job is finished. */
  pollAfterMs: number | null;
}

export function describeProgress(row: ProgressRow, settings: ProgressSettings): JobProgress {
  const remaining = row.total - row.processed;
  const finished = row.status === 'completed' || row.status === 'failed';
  const { health, detail, retryInSeconds = null } = classify(row, settings);
  const rate =
    row.started && row.processed > 0 && row.elapsedSeconds > 0
      ? row.processed / row.elapsedSeconds
      : null;
  return {
    jobId: row.id,
    status: row.status,
    health,
    detail,
    total: row.total,
    processed: row.processed,
    moved: row.moved,
    skipped: row.skipped,
    remaining,
    percent: row.total === 0 ? 100 : round1((100 * row.processed) / row.total),
    dealsPerSecond: rate === null ? null : Math.round(rate),
    etaSeconds: finished ? 0 : rate === null ? null : round1(remaining / rate),
    lastProgressAt: row.lastProgressAt,
    secondsSinceProgress:
      row.secondsSinceProgress === null ? null : round1(row.secondsSinceProgress),
    attempts: row.attempts,
    lastError: row.lastError,
    retryInSeconds,
    pollAfterMs: finished ? null : settings.pollIntervalMs,
  };
}

interface Classification {
  health: JobHealth;
  detail: string;
  retryInSeconds?: number;
}

function classify(row: ProgressRow, s: ProgressSettings): Classification {
  const progress = `${row.processed} of ${row.total}`;
  switch (row.status) {
    case 'completed':
      return {
        health: 'completed',
        detail:
          `done: ${row.moved} moved, ${row.skipped} skipped because a person changed them ` +
          'after the move was submitted',
      };
    case 'failed':
      return {
        health: 'failed',
        detail:
          `gave up after ${row.attempts} failed attempts (${row.lastError ?? 'unknown error'}); ` +
          `${progress} deals were processed and stay as they are`,
      };
    case 'pending':
      return waiting(
        row,
        s,
        row.secondsSinceCreated,
        row.blockingJobId !== null
          ? `waiting for this workspace's job ${row.blockingJobId} to finish ` +
              '(one job runs per workspace at a time)'
          : 'waiting for a free worker',
      );
    case 'running':
      break;
  }

  const leaseLeft = row.leaseSecondsLeft ?? 0;
  if (row.leaseOwner === null) {
    if (leaseLeft > 0 && row.lastError !== null) {
      const retryInSeconds = Math.ceil(leaseLeft);
      return {
        health: 'retrying',
        detail:
          `a batch failed (${row.lastError}); retrying in ${retryInSeconds}s, ` +
          `attempt ${row.attempts + 1} of ${s.maxAttempts}`,
        retryInSeconds,
      };
    }
    return waiting(
      row,
      s,
      Math.max(0, -leaseLeft),
      `paused at ${progress} to give another workspace a turn; it resumes when a worker is free`,
    );
  }

  if (leaseLeft > 0) {
    if (row.secondsSinceProgress === null || row.secondsSinceProgress < s.slowAfterSeconds) {
      return { health: 'active', detail: `moving: ${progress} deals processed` };
    }
    return {
      health: 'slow',
      detail:
        `no batch has committed for ${Math.round(row.secondsSinceProgress)}s while its worker ` +
        'still holds it: batches are waiting on locks or a busy database',
    };
  }

  const silentFor = Math.round(-leaseLeft);
  if (-leaseLeft > s.stuckAfterSeconds && !row.anyWorkerActive) {
    return {
      health: 'stuck',
      detail:
        `its worker stopped ${silentFor}s ago and no worker is active to take it over: ` +
        'is a worker running?',
    };
  }
  return {
    health: 'stalled',
    detail:
      `its worker stopped responding ${silentFor}s ago; another worker will resume it from ` +
      progress,
  };
}

/** Queued, unless it has waited long while no worker is active anywhere. */
function waiting(
  row: ProgressRow,
  s: ProgressSettings,
  waitedSeconds: number,
  reason: string,
): Classification {
  if (waitedSeconds > s.stuckAfterSeconds && !row.anyWorkerActive) {
    return {
      health: 'stuck',
      detail: `${reason}, but no worker has been active for a while: is a worker running?`,
    };
  }
  return { health: 'queued', detail: reason };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
