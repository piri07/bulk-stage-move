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
