import { Logger, type LoggerService } from '@nestjs/common';
import type { Pool } from 'pg';
import type { WorkerConfig } from '../config';
import {
  claimNextJob,
  failJob,
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
      else await this.idle();
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
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.settings.pollMs);
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
