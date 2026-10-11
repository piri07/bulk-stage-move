import { performance } from 'node:perf_hooks';
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import {
  BULK_STAGES,
  bulkCutoff,
  machineLine,
  numberFlag,
  otherStage,
  submitBulkMove,
  waitForJob,
} from './common';

/**
 * How long does a bulk move of 50,000 deals take, and how fast does it run?
 *
 *   node dist/bench/throughput.js [--runs 5]
 *
 * Every run moves the same 50,000 Large Co deals (a created-date cut-off) to the other of two
 * stages, so each run moves all of them. One unreported warm-up run comes first, which also puts
 * every deal in the same stage. Nothing else runs meanwhile. Reported per run:
 *
 * - submit: the POST /bulk-moves round trip, which includes taking the snapshot
 * - queued: from creation until a worker claimed the job (workers look for work once a second)
 * - running: from the claim until the last batch committed, the worker's own time
 * - wall-clock: from sending the POST until the job was seen completed (polled every 50ms)
 * - throughput: deals per second of running time (sustained) and of wall-clock (end to end)
 *
 * Needs the full seed (make seed-full) plus a running API and worker. It moves deals.
 */

interface Run {
  deals: number;
  submitMs: number;
  queuedSeconds: number;
  runSeconds: number;
  wallSeconds: number;
}

async function main(): Promise<void> {
  const runs = numberFlag(process.argv.slice(2), '--runs', 5);
  const pool = createPool({ ...loadConfig().database, poolMax: 2, statementTimeoutMs: 0 }, 'bench');
  try {
    const createdTo = await bulkCutoff(pool);
    console.log(machineLine());
    console.log(`bulk filter: Large Co deals created before ${createdTo}`);
    if (process.env.BENCH_LABEL) console.log(`run: ${process.env.BENCH_LABEL}`);

    let target = BULK_STAGES[0];
    const warmUp = await submitBulkMove(createdTo, target);
    await waitForJob(pool, warmUp.id);

    const results: Run[] = [];
    for (let i = 0; i < runs; i += 1) {
      target = otherStage(target);
      const started = performance.now();
      const submitted = await submitBulkMove(createdTo, target);
      const job = await waitForJob(pool, submitted.id);
      results.push({
        deals: job.total,
        submitMs: submitted.submitMs,
        queuedSeconds: job.queuedSeconds,
        runSeconds: job.runSeconds,
        wallSeconds: (performance.now() - started) / 1000,
      });
    }
    report(results);
  } finally {
    await pool.end();
  }
}

function report(results: Run[]): void {
  const row = (cells: string[]): string =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(8) : cell.padStart(14))).join('');
  console.log(
    `\n${row(['run', 'deals', 'submit', 'queued', 'running', 'wall-clock', 'sustained/s', 'end-to-end/s'])}`,
  );
  results.forEach((r, i) => {
    console.log(
      row([
        `#${i + 1}`,
        r.deals.toLocaleString('en-US'),
        `${Math.round(r.submitMs)}ms`,
        `${r.queuedSeconds.toFixed(2)}s`,
        `${r.runSeconds.toFixed(2)}s`,
        `${r.wallSeconds.toFixed(2)}s`,
        Math.round(r.deals / r.runSeconds).toLocaleString('en-US'),
        Math.round(r.deals / r.wallSeconds).toLocaleString('en-US'),
      ]),
    );
  });

  const stats = (values: number[]): { median: number; min: number; max: number } => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? (sorted[mid] ?? NaN)
        : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
    return { median, min: sorted[0] ?? NaN, max: sorted.at(-1) ?? NaN };
  };
  const line = (label: string, values: number[], format: (v: number) => string): void => {
    const { median, min, max } = stats(values);
    console.log(
      `${label.padEnd(26)} median ${format(median)} (min ${format(min)}, max ${format(max)})`,
    );
  };
  console.log('');
  line(
    'submit (snapshot)',
    results.map((r) => r.submitMs),
    (v) => `${Math.round(v)}ms`,
  );
  line(
    'wall-clock',
    results.map((r) => r.wallSeconds),
    (v) => `${v.toFixed(2)}s`,
  );
  line(
    'running',
    results.map((r) => r.runSeconds),
    (v) => `${v.toFixed(2)}s`,
  );
  line(
    'sustained throughput',
    results.map((r) => r.deals / r.runSeconds),
    (v) => `${Math.round(v).toLocaleString('en-US')} deals/s`,
  );
  line(
    'end-to-end throughput',
    results.map((r) => r.deals / r.wallSeconds),
    (v) => `${Math.round(v).toLocaleString('en-US')} deals/s`,
  );
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
