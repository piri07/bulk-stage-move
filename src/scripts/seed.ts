import type { PoolClient } from 'pg';
import { loadConfig } from '../config';
import { STAGES, type Stage } from '../crm/pipeline';
import { createPool } from '../db/pool';
import { withTransaction } from '../db/transaction';

/**
 * Deterministic seed data. Fixed workspace ids, a fixed random seed per workspace and a fixed time
 * anchor mean every run produces identical rows, so anyone reproducing the benchmarks measures the
 * same dataset.
 *
 *   node dist/scripts/seed.js [--small | --full] [--reset]
 */

export const LARGE_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

interface SeedWorkspace {
  id: string;
  name: string;
  deals: { small: number; full: number };
  owners: number;
}

export const SEED_WORKSPACES: readonly SeedWorkspace[] = [
  { id: LARGE_WORKSPACE_ID, name: 'Large Co', deals: { small: 25_000, full: 500_000 }, owners: 60 },
  { id: smallId(2), name: 'Small Co 1', deals: { small: 500, full: 2_000 }, owners: 6 },
  { id: smallId(3), name: 'Small Co 2', deals: { small: 500, full: 2_500 }, owners: 6 },
  { id: smallId(4), name: 'Small Co 3', deals: { small: 500, full: 3_000 }, owners: 6 },
  { id: smallId(5), name: 'Small Co 4', deals: { small: 500, full: 3_500 }, owners: 6 },
  { id: smallId(6), name: 'Small Co 5', deals: { small: 500, full: 4_000 }, owners: 6 },
];

function smallId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

// Share of deals per stage: a funnel that thins out, plus closed stages that pile up over time.
const STAGE_WEIGHTS: Record<Stage, number> = {
  new_lead: 18,
  contacted: 14,
  discovery: 11,
  qualified: 9,
  demo_scheduled: 7,
  demo_done: 6,
  proposal_sent: 5,
  negotiation: 4,
  contract_sent: 3,
  verbal_commit: 2,
  closed_won: 9,
  closed_lost: 12,
};

/** Deals are created over the ~18 months before this instant, skewed towards recent. */
const ANCHOR = '2026-10-01T00:00:00Z';
const HISTORY_DAYS = 548;

/** Lower bound of each stage's slice of [0, 1), in pipeline order, for width_bucket(). */
function stageLowerBounds(): number[] {
  const total = STAGES.reduce((sum, stage) => sum + STAGE_WEIGHTS[stage], 0);
  let cumulative = 0;
  return STAGES.map((stage) => {
    const bound = cumulative / total;
    cumulative += STAGE_WEIGHTS[stage];
    return bound;
  });
}

// One set-based statement per workspace. Every random draw happens in `draws`, which Postgres
// evaluates once per generate_series row in order, so setseed() makes the output deterministic.
const INSERT_OPPORTUNITIES = `
  WITH params AS (
    SELECT ARRAY(
             SELECT md5($1::text || ':owner:' || i)::uuid FROM generate_series(1, $3::int) AS i
           ) AS owners
  ),
  draws AS (
    SELECT g,
           random() AS r_stage, random() AS r_status, random() AS r_owner,
           random() AS r_company, random() AS r_kind, random() AS r_age, random() AS r_touch,
           random_normal(ln(500000), 1.1) AS log_value          -- median deal ~$5,000
      FROM generate_series(1, $2::int) AS g
  ),
  shaped AS (
    SELECT d.*,
           ($5::text[])[width_bucket(d.r_stage, $4::float8[])]::opportunity_stage AS stage,
           -- power() > 1 skews towards the first owners: a few reps carry most deals.
           p.owners[1 + floor(power(d.r_owner, 1.6) * cardinality(p.owners))::int] AS owner_id,
           $6::timestamptz - power(d.r_age, 1.4) * make_interval(days => $7::int) AS created_at
      FROM draws d CROSS JOIN params p
  )
  INSERT INTO opportunities
         (workspace_id, name, value_cents, stage, status, owner_id, created_at, updated_at)
  SELECT $1::uuid,
         (ARRAY['Northwind', 'Contoso', 'Fabrikam', 'Globex', 'Initech', 'Acme', 'Umbrella',
                'Vandelay', 'Tailspin', 'Litware', 'Proseware', 'Wingtip'])[1 + floor(r_company * 12)::int]
           || ' ' || (ARRAY['renewal', 'expansion', 'new business', 'pilot', 'upsell',
                            'migration'])[1 + floor(r_kind * 6)::int]
           || ' #' || g,
         LEAST(round(exp(log_value)), 500000000)::bigint,      -- capped at $5M
         stage,
         CASE
           WHEN stage = 'closed_won' THEN 'won'
           WHEN stage = 'closed_lost' THEN CASE WHEN r_status < 0.8 THEN 'lost' ELSE 'abandoned' END
           WHEN r_status < 0.04 THEN 'abandoned'
           ELSE 'open'
         END::opportunity_status,
         owner_id,
         created_at,
         created_at + r_touch * ($6::timestamptz - created_at)
    FROM shaped
   ORDER BY g`;

async function seedWorkspace(
  tx: PoolClient,
  workspace: SeedWorkspace,
  deals: number,
  seed: number,
): Promise<void> {
  await tx.query('SELECT setseed($1)', [seed]);
  await tx.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [
    workspace.id,
    workspace.name,
  ]);
  await tx.query(INSERT_OPPORTUNITIES, [
    workspace.id,
    deals,
    workspace.owners,
    stageLowerBounds(),
    [...STAGES],
    ANCHOR,
    HISTORY_DAYS,
  ]);
}

function parseArgs(argv: string[]): { size: 'small' | 'full'; reset: boolean } {
  const known = new Set(['--small', '--full', '--reset']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw new Error(
      `unknown argument(s): ${unknown.join(' ')}. Usage: seed [--small|--full] [--reset]`,
    );
  }
  if (argv.includes('--small') && argv.includes('--full')) {
    throw new Error('pass at most one of --small and --full');
  }
  return { size: argv.includes('--full') ? 'full' : 'small', reset: argv.includes('--reset') };
}

async function main(): Promise<void> {
  const { size, reset } = parseArgs(process.argv.slice(2));
  const pool = createPool(
    { ...loadConfig().database, statementTimeoutMs: 0, poolMax: 2 },
    'crm-seed',
  );
  const started = Date.now();
  try {
    if (reset) {
      // CASCADE also clears anything that references these tables (bulk jobs, later on).
      await pool.query(
        'TRUNCATE stage_transitions, opportunities, workspaces RESTART IDENTITY CASCADE',
      );
      console.log('reset: all workspaces, opportunities and transitions removed');
    }

    for (const [index, workspace] of SEED_WORKSPACES.entries()) {
      const {
        rows: [state],
      } = await pool.query<{ seeded: boolean; deals: number }>(
        `SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = $1) AS seeded,
                (SELECT count(*) FROM opportunities WHERE workspace_id = $1) AS deals`,
        [workspace.id],
      );
      if (state?.seeded) {
        console.log(
          `skip  ${workspace.name}: already seeded (${state.deals} deals); pass --reset to reseed`,
        );
        continue;
      }

      const deals = workspace.deals[size];
      const t0 = Date.now();
      await withTransaction(pool, (tx) => seedWorkspace(tx, workspace, deals, (index + 1) / 10));
      console.log(
        `seed  ${workspace.name} (${workspace.id}): ${deals.toLocaleString('en-US')} deals in ` +
          `${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    }

    // Fresh statistics so the planner sees the real distribution straight away.
    await pool.query('ANALYZE workspaces, opportunities');

    const { rows } = await pool.query<{ stage: Stage; deals: number }>(
      `SELECT stage, count(*) AS deals FROM opportunities WHERE workspace_id = $1
        GROUP BY stage ORDER BY stage`,
      [LARGE_WORKSPACE_ID],
    );
    const total = rows.reduce((sum, row) => sum + row.deals, 0);
    console.log(`\nLarge Co by stage (${total.toLocaleString('en-US')} deals):`);
    for (const row of rows) {
      const share = total > 0 ? ((100 * row.deals) / total).toFixed(1) : '0.0';
      console.log(`  ${row.stage.padEnd(15)} ${String(row.deals).padStart(8)}  ${share}%`);
    }
    console.log(`\ndone (${size}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
