import { oneRow, type Queryable } from '../db/queryable';
import type { Stage, Status } from './pipeline';

export interface Opportunity {
  id: number;
  workspaceId: string;
  name: string;
  valueCents: number;
  stage: Stage;
  status: Status;
  ownerId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOpportunity {
  name: string;
  valueCents: number;
  stage: Stage;
  status: Status;
  ownerId: string;
}

// Aliased to the API's camelCase shape; shared by every statement that returns a deal.
const OPPORTUNITY_COLUMNS = `
  id, workspace_id AS "workspaceId", name, value_cents AS "valueCents", stage, status,
  owner_id AS "ownerId", version, created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function insertOpportunity(
  db: Queryable,
  workspaceId: string,
  input: NewOpportunity,
): Promise<Opportunity> {
  const { rows } = await db.query<Opportunity>(
    `INSERT INTO opportunities (workspace_id, name, value_cents, stage, status, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${OPPORTUNITY_COLUMNS}`,
    [workspaceId, input.name, input.valueCents, input.stage, input.status, input.ownerId],
  );
  return oneRow(rows);
}

export async function findOpportunity(
  db: Queryable,
  workspaceId: string,
  id: number,
): Promise<Opportunity | undefined> {
  const { rows } = await db.query<Opportunity>(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0];
}

/** Row-locks the deal until the surrounding transaction ends; concurrent movers queue here. */
export async function findOpportunityForUpdate(
  tx: Queryable,
  workspaceId: string,
  id: number,
): Promise<Opportunity | undefined> {
  const { rows } = await tx.query<Opportunity>(
    `SELECT ${OPPORTUNITY_COLUMNS}
       FROM opportunities
      WHERE id = $1 AND workspace_id = $2
        FOR UPDATE`,
    [id, workspaceId],
  );
  return rows[0];
}

// clock_timestamp(), not now(): now() is the transaction's start time, which for a transaction that
// queued on the row lock can be earlier than the write it waited behind.
export async function updateOpportunityStage(
  tx: Queryable,
  workspaceId: string,
  id: number,
  stage: Stage,
): Promise<Opportunity> {
  const { rows } = await tx.query<Opportunity>(
    `UPDATE opportunities
        SET stage = $3, version = version + 1, updated_at = clock_timestamp()
      WHERE id = $1 AND workspace_id = $2
      RETURNING ${OPPORTUNITY_COLUMNS}`,
    [id, workspaceId, stage],
  );
  return oneRow(rows);
}

export type TransitionSource = 'manual' | 'bulk';

export interface NewStageTransition {
  workspaceId: string;
  opportunityId: number;
  fromStage: Stage;
  toStage: Stage;
  source: 'manual';
}

export interface StageTransition {
  id: number;
  fromStage: Stage;
  toStage: Stage;
  source: TransitionSource;
  /** The bulk job that made this move; null for a manual move. */
  bulkJobId: number | null;
  createdAt: Date;
}

export async function insertStageTransition(
  tx: Queryable,
  transition: NewStageTransition,
): Promise<void> {
  await tx.query(
    `INSERT INTO stage_transitions (workspace_id, opportunity_id, from_stage, to_stage, source, created_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
    [
      transition.workspaceId,
      transition.opportunityId,
      transition.fromStage,
      transition.toStage,
      transition.source,
    ],
  );
}

/**
 * One page of a deal's history, oldest first. Id order is the order the row lock granted the
 * moves, so it is the true sequence; served by the (opportunity_id, id) index.
 */
export async function listStageTransitions(
  db: Queryable,
  workspaceId: string,
  opportunityId: number,
  afterId: number,
  limit: number,
): Promise<StageTransition[]> {
  const { rows } = await db.query<StageTransition>(
    `SELECT id, from_stage AS "fromStage", to_stage AS "toStage", source,
            bulk_job_id AS "bulkJobId", created_at AS "createdAt"
       FROM stage_transitions
      WHERE opportunity_id = $1 AND workspace_id = $2 AND id > $3
      ORDER BY id
      LIMIT $4`,
    [opportunityId, workspaceId, afterId, limit],
  );
  return rows;
}

/**
 * One page of a stage in id order. Keyset pagination on (workspace_id, stage, id): each page is an
 * index range scan whose cost does not grow with page depth, and rows moving in or out of the
 * stage between requests never shift later pages the way OFFSET would.
 */
export async function listOpportunitiesInStage(
  db: Queryable,
  workspaceId: string,
  stage: Stage,
  afterId: number,
  limit: number,
): Promise<Opportunity[]> {
  const { rows } = await db.query<Opportunity>(
    `SELECT ${OPPORTUNITY_COLUMNS}
       FROM opportunities
      WHERE workspace_id = $1 AND stage = $2 AND id > $3
      ORDER BY id
      LIMIT $4`,
    [workspaceId, stage, afterId, limit],
  );
  return rows;
}
