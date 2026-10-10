import type { Pool } from 'pg';
import type { Stage, Status } from '../../src/crm/pipeline';

export const OWNER = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4';

interface DealShape {
  stage?: Stage;
  status?: Status;
  ownerId?: string;
  valueCents?: number;
  createdAt?: string;
}

/** Inserts `count` identical deals in one statement and returns their ids, ascending. */
export async function insertDeals(
  pool: Pool,
  workspaceId: string,
  count: number,
  shape: DealShape = {},
): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO opportunities
            (workspace_id, name, value_cents, stage, status, owner_id, created_at, updated_at)
     SELECT $1, 'Deal ' || g, $3, $4, $5, $6, $7, $7
       FROM generate_series(1, $2) AS g
     RETURNING id`,
    [
      workspaceId,
      count,
      shape.valueCents ?? 1000,
      shape.stage ?? 'qualified',
      shape.status ?? 'open',
      shape.ownerId ?? OWNER,
      shape.createdAt ?? new Date().toISOString(),
    ],
  );
  return rows.map((row) => row.id).sort((a, b) => a - b);
}
