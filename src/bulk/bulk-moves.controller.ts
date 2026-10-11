import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Page } from '../common/pagination';
import { ParseIdPipe } from '../common/parse-id.pipe';
import { WorkspaceGuard, WorkspaceId } from '../common/workspace';
import type { BulkJob, BulkJobItem } from './bulk-jobs.repository';
import { BulkMovesService } from './bulk-moves.service';
// DTOs must be value imports: ValidationPipe finds them through emitted decorator metadata.
import { ListJobItemsQuery, SubmitBulkMoveDto } from './dto';
import { parseIdempotencyKey } from './idempotency-key';
import { PollLimitGuard } from './poll-limit.guard';
import type { JobProgress } from './progress';

@Controller('bulk-moves')
@UseGuards(WorkspaceGuard)
export class BulkMovesController {
  constructor(private readonly bulkMoves: BulkMovesService) {}

  /**
   * 202 with the job, which the worker then runs. A repeated key returns the existing job, with
   * an Idempotent-Replayed header.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @WorkspaceId() workspaceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitBulkMoveDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BulkJob> {
    const { job, replayed } = await this.bulkMoves.submit(
      workspaceId,
      parseIdempotencyKey(idempotencyKey),
      dto,
    );
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return job;
  }

  // Both reads of a job's state share one poll limit (per job), so alternating between them
  // doesn't get around it.
  @Get(':id')
  @UseGuards(PollLimitGuard)
  get(@WorkspaceId() workspaceId: string, @Param('id', ParseIdPipe) id: number): Promise<BulkJob> {
    return this.bulkMoves.get(workspaceId, id);
  }

  /**
   * The endpoint to poll while a job runs: health (queued, active, slow, retrying, stalled,
   * stuck, failed or completed) with a plain-language detail, counts, throughput, ETA, and when
   * to poll next. At most one read per job every 2s; faster polls get 429 with Retry-After.
   */
  @Get(':id/progress')
  @UseGuards(PollLimitGuard)
  progress(
    @WorkspaceId() workspaceId: string,
    @Param('id', ParseIdPipe) id: number,
  ): Promise<JobProgress> {
    return this.bulkMoves.progress(workspaceId, id);
  }

  /** The job's deals and what happened to each, e.g. ?outcome=skipped_conflict. */
  @Get(':id/items')
  listItems(
    @WorkspaceId() workspaceId: string,
    @Param('id', ParseIdPipe) id: number,
    @Query() query: ListJobItemsQuery,
  ): Promise<Page<BulkJobItem>> {
    return this.bulkMoves.listItems(workspaceId, id, query);
  }
}
