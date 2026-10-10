import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { isPgError, PgErrorCode } from '../db/pg-errors';
import type { CreateOpportunityDto, ListOpportunitiesQuery } from './dto';
import {
  findOpportunity,
  insertOpportunity,
  listOpportunitiesInStage,
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
