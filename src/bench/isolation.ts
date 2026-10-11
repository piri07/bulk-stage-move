import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import { loadConfig } from '../config';
import { STAGES } from '../crm/pipeline';
import { createPool } from '../db/pool';
import { LARGE_WORKSPACE_ID, SEED_WORKSPACES } from '../scripts/seed';
import {
  API_URL,
  BULK_STAGES,
  bulkCutoff,
  machineLine,
  numberFlag,
  otherStage,
  submitBulkMove,
  waitForJob,
} from './common';

/**
 * How much does a running bulk move slow down interactive requests, in the same workspace and in
 * another one?
 *
 * Interactive traffic is open-loop. Requests go out on a fixed schedule whatever the responses do,
 * and latency counts from the scheduled send time. A closed loop (send, wait, send again) slows
 * down whenever the server does, which would hide exactly the stalls being measured.
 *
 *   node dist/bench/isolation.js [--rate 100] [--seconds 20] [--warmup 5] [--rounds 1]
 *
 * Needs the full seed (make seed-full) plus a running API and worker. It moves deals, so re-seed
 * afterwards.
 */

const SMALL_WORKSPACE_ID = SEED_WORKSPACES[1]?.id ?? '';

interface Group {
  name: string;
  workspaceId: string;
  dealIds: number[];
}

interface LoadResult {
  latencies: number[];
  errors: number;
}

interface BulkResult {
  jobs: number;
  moved: number;
  jobSeconds: number[];
}

interface Summary {
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface PhaseResult {
  name: string;
  groups: { name: string; summary: Summary }[];
  bulk?: BulkResult;
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

/** One interactive request: 60% list a stage, 20% read a deal, 20% move a deal by hand. */
async function interactiveRequest(group: Group): Promise<void> {
  const headers = { 'x-workspace-id': group.workspaceId, 'content-type': 'application/json' };
  const roll = Math.random();
  let res: Response;
  if (roll < 0.6) {
    res = await fetch(`${API_URL}/opportunities?stage=${pick(STAGES)}&limit=50`, { headers });
  } else if (roll < 0.8) {
    res = await fetch(`${API_URL}/opportunities/${pick(group.dealIds)}`, { headers });
  } else {
    res = await fetch(`${API_URL}/opportunities/${pick(group.dealIds)}/stage`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ stage: pick(STAGES) }),
    });
  }
  await res.arrayBuffer(); // drain the body so the keep-alive connection can be reused
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Sends `rate` requests per second for `seconds`, on schedule, and records their latencies. */
async function openLoop(
  rate: number,
  seconds: number,
  send: () => Promise<void>,
): Promise<LoadResult> {
  const result: LoadResult = { latencies: [], errors: 0 };
  const interval = 1000 / rate;
  const start = performance.now();
  const inflight: Promise<void>[] = [];
  for (let i = 0; i < rate * seconds; i += 1) {
    const scheduled = start + i * interval;
    const wait = scheduled - performance.now();
    if (wait > 0) await sleep(wait);
    inflight.push(
      send().then(
        () => {
          result.latencies.push(performance.now() - scheduled);
        },
        () => {
          result.errors += 1;
        },
      ),
    );
  }
  await Promise.all(inflight);
  return result;
}

/**
 * Keeps a bulk job running until `until`: the same ~50,000 Large Co deals alternate between two
 * stages, one job after another. Returns once the last job has finished.
 */
async function runBulkJobs(pool: Pool, until: number, createdTo: string): Promise<BulkResult> {
  const result: BulkResult = { jobs: 0, moved: 0, jobSeconds: [] };
  let target = BULK_STAGES[0];
  while (performance.now() < until) {
    const started = performance.now();
    const { id } = await submitBulkMove(createdTo, target);
    const job = await waitForJob(pool, id);
    result.jobs += 1;
    result.moved += job.moved;
    result.jobSeconds.push((performance.now() - started) / 1000);
    target = otherStage(target);
  }
  return result;
}

async function runPhase(
  name: string,
  groups: Group[],
  seconds: number,
  rate: number,
  bulk?: { pool: Pool; createdTo: string },
): Promise<PhaseResult> {
  const until = performance.now() + seconds * 1000;
  const bulkRun = bulk ? runBulkJobs(bulk.pool, until, bulk.createdTo) : Promise.resolve(undefined);
  const loads = await Promise.all(
    groups.map((group) => openLoop(rate, seconds, () => interactiveRequest(group))),
  );
  return {
    name,
    groups: groups.map((group, i) => ({
      name: group.name,
      summary: summarize(loads[i] ?? { latencies: [], errors: 0 }),
    })),
    bulk: await bulkRun,
  };
}

function summarize({ latencies, errors }: LoadResult): Summary {
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? NaN;
  return {
    count: sorted.length,
    errors,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? NaN,
  };
}

async function sampleDealIds(pool: Pool, workspaceId: string, count: number): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM opportunities WHERE workspace_id = $1 ORDER BY random() LIMIT $2',
    [workspaceId, count],
  );
  return rows.map((row) => row.id);
}

function parseArgs(argv: string[]): {
  rate: number;
  seconds: number;
  warmup: number;
  rounds: number;
} {
  return {
    rate: numberFlag(argv, '--rate', 100),
    seconds: numberFlag(argv, '--seconds', 20),
    warmup: numberFlag(argv, '--warmup', 5),
    rounds: numberFlag(argv, '--rounds', 1),
  };
}

function report(phases: PhaseResult[], rate: number): void {
  const ms = (value: number): string => `${value.toFixed(1)}ms`.padStart(9);
  console.log(
    `\n${'phase'.padEnd(30)} ${'workspace'.padEnd(28)} ${'reqs'.padStart(6)} ${'errors'.padStart(6)}` +
      `${'p50'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}`,
  );
  for (const phase of phases) {
    for (const { name, summary } of phase.groups) {
      console.log(
        `${phase.name.padEnd(30)} ${name.padEnd(28)} ${String(summary.count).padStart(6)} ` +
          `${String(summary.errors).padStart(6)}${ms(summary.p50)}${ms(summary.p95)}` +
          `${ms(summary.p99)}${ms(summary.max)}`,
      );
    }
    if (phase.bulk) {
      const active = phase.bulk.jobSeconds.reduce((sum, s) => sum + s, 0);
      console.log(
        `${''.padEnd(30)} bulk: ${phase.bulk.jobs} jobs, ${phase.bulk.moved.toLocaleString('en-US')} ` +
          `deals moved in ${active.toFixed(1)}s (${Math.round(phase.bulk.moved / active)} deals/s, ` +
          `${(active / phase.bulk.jobs).toFixed(1)}s per job incl. submit and polling)`,
      );
    }
  }
  console.log(`\ninteractive rate: ${rate} req/s per workspace; API at ${API_URL}`);
  const label = process.env.BENCH_LABEL;
  if (label) console.log(`run: ${label}`);
}

async function main(): Promise<void> {
  const { rate, seconds, warmup, rounds } = parseArgs(process.argv.slice(2));
  const pool = createPool({ ...loadConfig().database, poolMax: 2, statementTimeoutMs: 0 }, 'bench');
  try {
    const groups: Group[] = [
      {
        name: 'same (Large Co)',
        workspaceId: LARGE_WORKSPACE_ID,
        dealIds: await sampleDealIds(pool, LARGE_WORKSPACE_ID, 2000),
      },
      {
        name: 'other (Small Co 1)',
        workspaceId: SMALL_WORKSPACE_ID,
        dealIds: await sampleDealIds(pool, SMALL_WORKSPACE_ID, 2000),
      },
    ];
    const createdTo = await bulkCutoff(pool);
    console.log(machineLine());
    console.log(`bulk filter: Large Co deals created before ${createdTo} (50,000 deals)`);

    await runPhase('warm-up', groups, warmup, rate);
    // Rounds alternate which condition runs first, so warm-up and drift effects don't all land
    // on one side of the comparison.
    const phases: PhaseResult[] = [];
    for (let round = 1; round <= rounds; round += 1) {
      const baseline = (): Promise<PhaseResult> =>
        runPhase(`no bulk job #${round}`, groups, seconds, rate);
      const bulk = (): Promise<PhaseResult> =>
        runPhase(`bulk running #${round}`, groups, seconds, rate, { pool, createdTo });
      if (round % 2 === 1) phases.push(await baseline(), await bulk());
      else phases.push(await bulk(), await baseline());
    }
    report(phases, rate);
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
