import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { toPage, type Page, type PageQuery } from '../common/pagination';
import { PG_POOL } from '../db/database.module';
import { isPgError, PgErrorCode } from '../db/pg-errors';
import { withTransaction } from '../db/transaction';
import type { CreateOpportunityDto, ListOpportunitiesQuery, MoveStageDto } from './dto';
import {
  findOpportunity,
  findOpportunityForUpdate,
  insertOpportunity,
  insertStageTransition,
  listOpportunitiesInStage,
  listStageTransitions,
  updateOpportunityStage,
  type Opportunity,
  type StageTransition,
} from './opportunities.repository';
import { INITIAL_STAGE } from './pipeline';

@Injectable()
export class OpportunitiesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(workspaceId: string, dto: CreateOpportunityDto): Promise<Opportunity> {
    try {
      return await insertOpportunity(this.pool, workspaceId, {
        name: dto.name,
        valueCents: dto.valueCents,
        ownerId: dto.ownerId,
        stage: dto.stage ?? INITIAL_STAGE,
        status: dto.status ?? 'open',
      });
    } catch (err) {
      if (isPgError(err, PgErrorCode.ForeignKeyViolation, 'opportunities_workspace_id_fkey')) {
        throw new NotFoundException('workspace not found');
      }
      throw err;
    }
  }

  async get(workspaceId: string, id: number): Promise<Opportunity> {
    const opportunity = await findOpportunity(this.pool, workspaceId, id);
    if (!opportunity) throw new NotFoundException('opportunity not found');
    return opportunity;
  }

  async moveStage(workspaceId: string, id: number, dto: MoveStageDto): Promise<Opportunity> {
    return withTransaction(this.pool, async (tx) => {
      // The row lock serialises concurrent moves of one deal, so each transition records the
      // stage the deal really left. Without it, two movers can both log the same from_stage.
      const current = await findOpportunityForUpdate(tx, workspaceId, id);
      if (!current) throw new NotFoundException('opportunity not found');

      if (dto.expectedVersion !== undefined && dto.expectedVersion !== current.version) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `expected version ${dto.expectedVersion}, opportunity is at ${current.version}`,
          current,
        });
      }

      // A no-op writes nothing: no transition, and no version bump that would make an in-flight
      // bulk job treat the deal as manually edited and skip it.
      if (current.stage === dto.stage) return current;

      const moved = await updateOpportunityStage(tx, workspaceId, id, dto.stage);
      await insertStageTransition(tx, {
        workspaceId,
        opportunityId: id,
        fromStage: current.stage,
        toStage: dto.stage,
        source: 'manual',
      });
      return moved;
    });
  }

  async listInStage(
    workspaceId: string,
    query: ListOpportunitiesQuery,
  ): Promise<Page<Opportunity>> {
    const rows = await listOpportunitiesInStage(
      this.pool,
      workspaceId,
      query.stage,
      query.cursor ?? 0,
      query.limit + 1,
    );
    return toPage(rows, query.limit);
  }

  async listTransitions(
    workspaceId: string,
    id: number,
    query: PageQuery,
  ): Promise<Page<StageTransition>> {
    // A deal outside this workspace is a 404, not an empty (and misleading) history.
    await this.get(workspaceId, id);
    const rows = await listStageTransitions(
      this.pool,
      workspaceId,
      id,
      query.cursor ?? 0,
      query.limit + 1,
    );
    return toPage(rows, query.limit);
  }
}
