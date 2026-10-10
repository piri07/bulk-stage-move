import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { toPage, type Page } from '../common/pagination';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { isPgError, PgErrorCode } from '../db/pg-errors';
import { withTransaction } from '../db/transaction';
import {
  finalizeJob,
  findJob,
  findJobByKey,
  insertJob,
  listJobItems,
  snapshotDeals,
  type BulkJob,
  type BulkJobItem,
} from './bulk-jobs.repository';
import type { ListJobItemsQuery, SubmitBulkMoveDto } from './dto';
import { hashRequest, normalizeFilter } from './filter';

export interface SubmitResult {
  job: BulkJob;
  /** True when the key had been seen before and the existing job was returned. */
  replayed: boolean;
}

@Injectable()
export class BulkMovesService {
  private readonly maxDeals: number;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.maxDeals = config.bulk.maxDeals;
  }

  /**
   * Creates the job, its idempotency record and its snapshot in one transaction: they exist
   * together or not at all. The worker does the moving later.
   */
  async submit(
    workspaceId: string,
    idempotencyKey: string,
    dto: SubmitBulkMoveDto,
  ): Promise<SubmitResult> {
    const filter = normalizeFilter(dto.filter);
    const requestHash = hashRequest(filter, dto.targetStage);
    try {
      return await withTransaction(this.pool, async (tx) => {
        const jobId = await insertJob(tx, {
          workspaceId,
          idempotencyKey,
          requestHash,
          filter,
          targetStage: dto.targetStage,
        });
        if (jobId === null) return this.replay(tx, workspaceId, idempotencyKey, requestHash);

        // One row past the cap is enough to know the filter is too broad.
        const total = await snapshotDeals(tx, {
          jobId,
          workspaceId,
          filter,
          targetStage: dto.targetStage,
          limit: this.maxDeals + 1,
        });
        if (total > this.maxDeals) {
          // Throwing rolls back the job and its key too: nothing of this request remains, and a
          // retry with a narrower filter may reuse the key.
          throw new UnprocessableEntityException(
            `the filter matches more than ${this.maxDeals.toLocaleString('en-US')} deals; narrow it`,
          );
        }
        return { job: await finalizeJob(tx, jobId, total), replayed: false };
      });
    } catch (err) {
      if (isPgError(err, PgErrorCode.ForeignKeyViolation, 'bulk_jobs_workspace_id_fkey')) {
        throw new NotFoundException('workspace not found');
      }
      throw err;
    }
  }

  async get(workspaceId: string, id: number): Promise<BulkJob> {
    const job = await findJob(this.pool, workspaceId, id);
    if (!job) throw new NotFoundException('bulk move not found');
    return job;
  }

  async listItems(
    workspaceId: string,
    id: number,
    query: ListJobItemsQuery,
  ): Promise<Page<BulkJobItem>> {
    await this.get(workspaceId, id);
    const rows = await listJobItems(
      this.pool,
      id,
      query.cursor ?? 0,
      query.limit + 1,
      query.outcome,
    );
    return toPage(rows, query.limit, (item) => item.seq);
  }

  /** The key was used before: the same request gets the existing job, a different one a 422. */
  private async replay(
    tx: PoolClient,
    workspaceId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<SubmitResult> {
    const existing = await findJobByKey(tx, workspaceId, idempotencyKey);
    if (!existing) {
      // The insert just found a committed row with this key, and jobs are never deleted.
      throw new Error(`job for idempotency key ${idempotencyKey} vanished`);
    }
    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'this Idempotency-Key was already used for a different bulk move',
      );
    }
    return { job: existing.job, replayed: true };
  }
}
