import { Logger, type LoggerService } from '@nestjs/common';
import type { Pool } from 'pg';
import type { WorkerConfig } from '../config';
import {
  claimNextJob,
  failJob,
  hasWaitingJobs,
  recordFailure,
  releaseLease,
  runBatch,
  type BatchFaults,
  type BatchOutcome,
  type ClaimedJob,
} from './queue';

const MAX_RETRY_BACKOFF_MS = 60_000;
const LOG_EVERY_BATCHES = 20;

export interface BulkWorkerOptions {
  logger?: LoggerService;
  /** Test hook, passed to every batch. */
  faults?: BatchFaults;
}

/**
 * Claims bulk jobs from the bulk_jobs table and runs them batch by batch until stopped. Any
 * number of workers can run side by side: claims never overlap, and every write is fenced by the
 * lease epoch.
 */
export class BulkWorker {
  private stopping = false;
  private wakeUp: (() => void) | undefined;
  private readonly logger: LoggerService;

  constructor(
    private readonly pool: Pool,
    private readonly settings: WorkerConfig,
    private readonly options: BulkWorkerOptions = {},
  ) {
    this.logger = options.logger ?? new Logger('BulkWorker');
  }

  /** Runs until stop() is called. */
  async run(): Promise<void> {
    this.logger.log(`worker ${this.settings.id} started`);
    while (!this.stopping) {
      const job = await this.claim();
      if (job) await this.process(job);
      else await this.sleep(this.settings.pollMs);
    }
    this.logger.log(`worker ${this.settings.id} stopped`);
  }

  /** Finishes the batch in flight, hands its job back, then lets run() return. */
  stop(): void {
    this.stopping = true;
    this.wakeUp?.();
  }

  private async claim(): Promise<ClaimedJob | null> {
    try {
      return await claimNextJob(this.pool, this.settings.id, this.settings.leaseMs);
    } catch (err) {
      this.logger.error(`claim failed: ${describe(err)}`);
      return null;
    }
  }

  private async process(job: ClaimedJob): Promise<void> {
    if (job.attempts >= this.settings.maxAttempts) {
      await failJob(this.pool, job, `gave up after ${job.attempts} failed attempts`);
      this.logger.warn(`job ${job.id}: failed after ${job.attempts} attempts`);
      return;
    }
    this.logger.log(
      `job ${job.id}: claimed (epoch ${job.leaseEpoch}, ${job.processed}/${job.total} done)`,
    );
    const startedAt = Date.now();
    const startedFrom = job.processed;

    for (let batches = 1; ; batches += 1) {
      if (this.stopping) {
        await releaseLease(this.pool, job);
        this.logger.log(`job ${job.id}: handed back for another worker to resume`);
        return;
      }

      const batchStartedAt = Date.now();
      let outcome: BatchOutcome;
      try {
        outcome = await runBatch(this.pool, job, this.settings, this.options.faults);
      } catch (err) {
        const retryAfterMs = Math.min(
          this.settings.retryBackoffMs * 2 ** job.attempts,
          MAX_RETRY_BACKOFF_MS,
        );
        this.logger.error(
          `job ${job.id}: batch failed (${describe(err)}); retry in ${retryAfterMs}ms`,
        );
        try {
          await recordFailure(this.pool, job, describe(err), retryAfterMs);
        } catch (cause) {
          // The lease still lapses on its own, so the job is retried either way.
          this.logger.error(`job ${job.id}: could not record the failure: ${describe(cause)}`);
        }
        return;
      }

      if (outcome.kind === 'lost_lease') {
        this.logger.warn(`job ${job.id}: another worker has taken it over; stopping`);
        return;
      }
      const { progress } = outcome;
      if (progress.done) {
        const seconds = (Date.now() - startedAt) / 1000;
        const rate = Math.round((progress.processed - startedFrom) / Math.max(seconds, 0.001));
        this.logger.log(
          `job ${job.id}: completed, ${progress.moved} moved, ${progress.skipped} skipped ` +
            `(${seconds.toFixed(1)}s in this run, ${rate} deals/s)`,
        );
        return;
      }
      if (batches % LOG_EVERY_BATCHES === 0) {
        this.logger.log(`job ${job.id}: ${progress.processed}/${progress.total}`);
      }
      if (await this.sliceUsedUp(job, startedAt)) {
        await releaseLease(this.pool, job);
        this.logger.log(
          `job ${job.id}: time slice used up and other workspaces are waiting; handed back at ` +
            `${progress.processed}/${progress.total}`,
        );
        return;
      }
      await this.pace(batchStartedAt);
    }
  }

  /**
   * Fairness between workspaces. A worker keeps a job for at most one slice while another
   * workspace's job is waiting. Then it hands the job back: the job resumes later from its cursor,
   * and the round-robin claim gives the waiting workspace its turn. Alone, a job runs to the end.
   */
  private async sliceUsedUp(job: ClaimedJob, startedAt: number): Promise<boolean> {
    const { sliceMs } = this.settings;
    if (sliceMs <= 0 || Date.now() - startedAt < sliceMs) return false;
    try {
      return await hasWaitingJobs(this.pool, job.workspaceId);
    } catch (err) {
      // If the check fails, keep going: fairness is an optimisation, finishing the job is not.
      this.logger.warn(`job ${job.id}: could not check for waiting jobs: ${describe(err)}`);
      return false;
    }
  }

  /**
   * Holds the job to its speed limit: a batch of N deals takes at least N / limit seconds, and
   * the worker sleeps away whatever the batch itself didn't use. Spacing batches out keeps the
   * database's write bursts small, which is where other workspaces' latency spikes came from.
   */
  private async pace(batchStartedAt: number): Promise<void> {
    const { batchSize, maxDealsPerSecond } = this.settings;
    if (maxDealsPerSecond <= 0) return;
    const remaining = (batchSize / maxDealsPerSecond) * 1000 - (Date.now() - batchStartedAt);
    if (remaining > 0) await this.sleep(remaining);
  }

  /** A sleep that stop() cuts short, so shutdown never waits out a poll interval or a pace. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
