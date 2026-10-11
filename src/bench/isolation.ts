import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import { loadConfig } from '../config';
import { STAGES, type Stage } from '../crm/pipeline';
import { createPool } from '../db/pool';
import { LARGE_WORKSPACE_ID, SEED_WORKSPACES } from '../scripts/seed';

/**
 * How much does a running bulk move slow down interactive requests, in the same workspace and in
 * another one?
 *
 * Interactive traffic is open-loop. Requests go out on a fixed schedule whatever the responses do,
 * and latency counts from the scheduled send time. A closed loop (send, wait, send again) slows
 * down whenever the server does, which would hide exactly the stalls being measured.
 *
 *   node dist/bench/isolation.js [--rate 100] [--seconds 20] [--warmup 5]
 *
 * Needs the full seed (make seed-full) plus a running API and worker. It moves deals, so re-seed
 * afterwards.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const SMALL_WORKSPACE_ID = SEED_WORKSPACES[1]?.id ?? '';
const BULK_STAGES: [Stage, Stage] = ['contract_sent', 'verbal_commit'];
const JOB_TIMEOUT_MS = 120_000;

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
  const headers = { 'x-workspace-id': LARGE_WORKSPACE_ID, 'content-type': 'application/json' };
  const result: BulkResult = { jobs: 0, moved: 0, jobSeconds: [] };
  let target = BULK_STAGES[0];
  while (performance.now() < until) {
    const started = performance.now();
    const submitted = await fetch(`${API_URL}/bulk-moves`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ filter: { createdTo }, targetStage: target }),
    });
    if (submitted.status !== 202) {
      throw new Error(`bulk submit failed: HTTP ${submitted.status} ${await submitted.text()}`);
    }
    const { id } = (await submitted.json()) as { id: number };
    // Without a deadline, a run with no live worker would poll forever (it once did).
    const deadline = performance.now() + JOB_TIMEOUT_MS;
    let job = { status: 'pending', moved: 0 };
    while (job.status === 'pending' || job.status === 'running') {
      if (performance.now() > deadline) {
        throw new Error(
          `bulk job ${id} is still ${job.status} after ${JOB_TIMEOUT_MS / 1000}s: is a worker running?`,
        );
      }
      await sleep(100);
      // Read straight from the database: the API allows one poll per job every 2s, too coarse
      // to time a job that finishes in a few seconds.
      const { rows } = await pool.query<{ status: string; moved: number }>(
        'SELECT status, moved_count AS moved FROM bulk_jobs WHERE id = $1',
        [id],
      );
      job = rows[0] ?? job;
    }
    if (job.status !== 'completed') throw new Error(`bulk job ${id} ended as ${job.status}`);

    result.jobs += 1;
    result.moved += job.moved;
    result.jobSeconds.push((performance.now() - started) / 1000);
    target = target === BULK_STAGES[0] ? BULK_STAGES[1] : BULK_STAGES[0];
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

/** A created_at cut-off that selects just under 50,000 Large Co deals: the bulk filter. */
async function bulkCutoff(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM opportunities WHERE workspace_id = $1
      ORDER BY created_at OFFSET 50000 LIMIT 1`,
    [LARGE_WORKSPACE_ID],
  );
  const cutoff = rows[0]?.created_at;
  if (!cutoff) throw new Error('Large Co has fewer than 50,000 deals: run `make seed-full` first');
  return cutoff.toISOString();
}

function parseArgs(argv: string[]): {
  rate: number;
  seconds: number;
  warmup: number;
  rounds: number;
} {
  const value = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    const raw = index >= 0 ? argv[index + 1] : undefined;
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${flag} must be a positive number`);
    }
    return parsed;
  };
  return {
    rate: value('--rate', 100),
    seconds: value('--seconds', 20),
    warmup: value('--warmup', 5),
    rounds: value('--rounds', 1),
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
    console.log(
      `machine: ${cpus().length} CPUs (${cpus()[0]?.model ?? 'unknown'}), ` +
        `${(totalmem() / 2 ** 30).toFixed(1)} GiB; node ${process.version}`,
    );
    console.log(`bulk filter: Large Co deals created before ${createdTo} (just under 50,000)`);

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
