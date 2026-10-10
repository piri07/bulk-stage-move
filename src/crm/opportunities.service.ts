import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
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
  updateOpportunityStage,
  type Opportunity,
} from './opportunities.repository';
import { INITIAL_STAGE } from './pipeline';

export interface OpportunityPage {
  items: Opportunity[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: number | null;
}

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

  async listInStage(workspaceId: string, query: ListOpportunitiesQuery): Promise<OpportunityPage> {
    // One extra row tells us whether another page exists, without a COUNT.
    const rows = await listOpportunitiesInStage(
      this.pool,
      workspaceId,
      query.stage,
      query.cursor ?? 0,
      query.limit + 1,
    );
    const items = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  }
}
