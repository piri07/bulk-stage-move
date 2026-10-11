import type { INestApplication, LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { loadConfig, type WorkerConfig } from '../../src/config';
import { BulkWorker } from '../../src/worker/bulk-worker';
import {
  claimNextJob,
  runBatch,
  type BatchOutcome,
  type BatchSettings,
  type ClaimedJob,
} from '../../src/worker/queue';
import { createWorkspace, startApp } from '../support/app';
import { insertDeals } from '../support/deals';
import { waitFor } from '../support/wait';

const WS = 'x-workspace-id';
const SETTINGS: BatchSettings = { batchSize: 3, leaseMs: 15_000, lockTimeoutMs: 2000 };
const SILENT: LoggerService = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface JobRow {
  status: string;
  cursor_seq: number;
  moved_count: number;
  skipped_count: number;
  attempts: number;
  lease_epoch: number;
  lease_owner: string | null;
  last_error: string | null;
}

describe('bulk worker', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  // Claims take the oldest claimable job in the database, so park any job another test left
  // behind. Each test then sees only its own jobs.
  beforeEach(async () => {
    await pool.query(
      `UPDATE bulk_jobs SET status = 'failed', lease_owner = NULL, last_error = 'parked by test'
        WHERE status IN ('pending', 'running')`,
    );
  });

  const api = () => request(app.getHttpServer());

  async function submitJob(
    workspaceId: string,
    body: object = { filter: { stages: ['qualified'] }, targetStage: 'proposal_sent' },
  ): Promise<number> {
    const res = await api()
      .post('/bulk-moves')
      .set(WS, workspaceId)
      .set('idempotency-key', randomUUID())
      .send(body)
      .expect(202);
    return res.body.id as number;
  }

  async function claim(workerId = 'worker-a'): Promise<ClaimedJob> {
    const job = await claimNextJob(pool, workerId, SETTINGS.leaseMs);
    if (!job) throw new Error('expected a job to claim');
    return job;
  }

  async function drain(job: ClaimedJob): Promise<BatchOutcome> {
    let outcome: BatchOutcome;
    do {
      outcome = await runBatch(pool, job, SETTINGS);
    } while (outcome.kind === 'progressed' && !outcome.progress.done);
    return outcome;
  }

  /** What a dead worker leaves behind: nobody renews its lease, so it lapses. */
  async function expireLease(jobId: number): Promise<void> {
    await pool.query(
      `UPDATE bulk_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
  }

  async function jobRow(jobId: number): Promise<JobRow> {
    const { rows } = await pool.query<JobRow>('SELECT * FROM bulk_jobs WHERE id = $1', [jobId]);
    if (!rows[0]) throw new Error(`job ${jobId} not found`);
    return rows[0];
  }

  async function deals(ids: number[]): Promise<{ id: number; stage: string; version: number }[]> {
    const { rows } = await pool.query<{ id: number; stage: string; version: number }>(
      'SELECT id, stage, version FROM opportunities WHERE id = ANY($1) ORDER BY id',
      [ids],
    );
    return rows;
  }

  /** How many times the job recorded a move of each deal. Must be at most once. */
  async function bulkMovesPerDeal(jobId: number): Promise<Map<number, number>> {
    const { rows } = await pool.query<{ opportunity_id: number; moves: number }>(
      `SELECT opportunity_id, count(*) AS moves FROM stage_transitions
        WHERE bulk_job_id = $1 GROUP BY opportunity_id`,
      [jobId],
    );
    return new Map(rows.map((row) => [row.opportunity_id, row.moves]));
  }

  it('moves every listed deal exactly once and completes the job', async () => {
    const ws = await createWorkspace(pool);
    const ids = await insertDeals(pool, ws, 10);
    const jobId = await submitJob(ws);

    const outcome = await drain(await claim());

    expect(outcome).toEqual({
      kind: 'progressed',
      progress: { total: 10, processed: 10, moved: 10, skipped: 0, done: true },
    });
    expect(await deals(ids)).toEqual(ids.map((id) => ({ id, stage: 'proposal_sent', version: 2 })));
    expect([...(await bulkMovesPerDeal(jobId)).values()]).toEqual(Array(10).fill(1));
    expect(await jobRow(jobId)).toMatchObject({
      status: 'completed',
      cursor_seq: 10,
      moved_count: 10,
      lease_owner: null,
    });
    const history = await api().get(`/opportunities/${ids[0]}/transitions`).set(WS, ws).expect(200);
    expect(history.body.items).toMatchObject([
      { fromStage: 'qualified', toStage: 'proposal_sent', source: 'bulk', bulkJobId: jobId },
    ]);
  });

  describe('the person wins', () => {
    it('skips a deal a person moved after the click, and leaves it where they put it', async () => {
      const ws = await createWorkspace(pool);
      const ids = await insertDeals(pool, ws, 6);
      const jobId = await submitJob(ws);
      const edited = ids[2] as number;

      await api()
        .patch(`/opportunities/${edited}/stage`)
        .set(WS, ws)
        .send({ stage: 'negotiation' })
        .expect(200);
      const outcome = await drain(await claim());

      expect(outcome).toMatchObject({ progress: { moved: 5, skipped: 1, done: true } });
      expect(await deals([edited])).toEqual([{ id: edited, stage: 'negotiation', version: 2 }]);
      expect((await bulkMovesPerDeal(jobId)).has(edited)).toBe(false);
      const skipped = await api()
        .get(`/bulk-moves/${jobId}/items`)
        .set(WS, ws)
        .query({ outcome: 'skipped_conflict' })
        .expect(200);
      expect(skipped.body.items).toMatchObject([
        { opportunityId: edited, outcome: 'skipped_conflict' },
      ]);
    });

    // The race the version check exists for: the person's move commits while the batch is
    // already waiting for that deal's row lock. Postgres then re-checks the batch's condition
    // against the committed row, finds a newer version, and skips it.
    it('skips a deal whose manual move commits while the batch waits for its row', async () => {
      const ws = await createWorkspace(pool);
      const ids = await insertDeals(pool, ws, 3);
      await submitJob(ws);
      const job = await claim();
      const contested = ids[0] as number;

      const person = await pool.connect();
      try {
        await person.query('BEGIN');
        await person.query(
          `UPDATE opportunities SET stage = 'negotiation', version = version + 1 WHERE id = $1`,
          [contested],
        );
        const batch = runBatch(pool, job, SETTINGS);
        await waitFor(async () => {
          const { rows } = await pool.query<{ n: number }>(
            'SELECT count(*) AS n FROM pg_locks WHERE NOT granted',
          );
          return (rows[0]?.n ?? 0) > 0;
        });
        await person.query('COMMIT');

        expect(await batch).toMatchObject({ progress: { moved: 2, skipped: 1, done: true } });
      } finally {
        person.release();
      }
      expect(await deals([contested])).toEqual([
        { id: contested, stage: 'negotiation', version: 2 },
      ]);
    });
  });

  describe('crashes and takeovers', () => {
    it('resumes after a crash mid-batch, losing and repeating nothing', async () => {
      const ws = await createWorkspace(pool);
      const ids = await insertDeals(pool, ws, 10);
      const jobId = await submitJob(ws);
      const first = await claim('worker-a');
      await runBatch(pool, first, SETTINGS);
      await runBatch(pool, first, SETTINGS);

      // The worker dies after moving the third batch's deals, before its checkpoint commits.
      await expect(
        runBatch(pool, first, SETTINGS, {
          afterApply: () => Promise.reject(new Error('worker killed')),
        }),
      ).rejects.toThrow('worker killed');
      expect(await jobRow(jobId)).toMatchObject({ cursor_seq: 6, moved_count: 6 });
      expect(await deals(ids.slice(6, 9))).toEqual(
        ids.slice(6, 9).map((id) => ({ id, stage: 'qualified', version: 1 })),
      );

      await expireLease(jobId);
      const second = await claim('worker-b');
      expect(second).toMatchObject({
        id: jobId,
        processed: 6,
        leaseEpoch: first.leaseEpoch + 1,
        attempts: 1,
      });
      expect(await drain(second)).toMatchObject({ progress: { moved: 10, done: true } });

      expect(await deals(ids)).toEqual(
        ids.map((id) => ({ id, stage: 'proposal_sent', version: 2 })),
      );
      expect([...(await bulkMovesPerDeal(jobId)).values()]).toEqual(Array(10).fill(1));
    });

    // Without the epoch check, the replaced worker's batch would land on top of its successor's.
    it("refuses a replaced worker's writes", async () => {
      const ws = await createWorkspace(pool);
      const ids = await insertDeals(pool, ws, 9);
      const jobId = await submitJob(ws);
      const stale = await claim('worker-a');
      await runBatch(pool, stale, SETTINGS);

      await expireLease(jobId);
      const successor = await claim('worker-b');

      expect(await runBatch(pool, stale, SETTINGS)).toEqual({ kind: 'lost_lease' });
      expect(await jobRow(jobId)).toMatchObject({ cursor_seq: 3 });

      expect(await drain(successor)).toMatchObject({ progress: { moved: 9, done: true } });
      expect([...(await bulkMovesPerDeal(jobId)).values()]).toEqual(Array(ids.length).fill(1));
    });
  });

  it('runs one job per workspace at a time while other workspaces proceed', async () => {
    const [busy, other] = await Promise.all([createWorkspace(pool), createWorkspace(pool)]);
    await insertDeals(pool, busy, 3, { stage: 'qualified' });
    await insertDeals(pool, busy, 3, { stage: 'contacted' });
    await insertDeals(pool, other, 3);
    const firstInBusy = await submitJob(busy);
    const secondInBusy = await submitJob(busy, {
      filter: { stages: ['contacted'] },
      targetStage: 'negotiation',
    });
    const inOther = await submitJob(other);

    const a = await claim();
    const b = await claim();
    expect([a.id, b.id]).toEqual([firstInBusy, inOther]);
    expect(await claimNextJob(pool, 'worker-c', SETTINGS.leaseMs)).toBeNull();

    await drain(a);
    expect((await claim()).id).toBe(secondInBusy);
  });

  describe('fairness between workspaces', () => {
    // Oldest-job-first would run A's whole backlog before B's single job: a1, a2, b1.
    it('gives the next turn to the workspace served least recently', async () => {
      const [a, b] = await Promise.all([createWorkspace(pool), createWorkspace(pool)]);
      await insertDeals(pool, a, 3, { stage: 'qualified' });
      await insertDeals(pool, a, 3, { stage: 'contacted' });
      await insertDeals(pool, b, 3);
      const a1 = await submitJob(a);
      const a2 = await submitJob(a, {
        filter: { stages: ['contacted'] },
        targetStage: 'negotiation',
      });
      const b1 = await submitJob(b);

      const order: number[] = [];
      for (let turn = 0; turn < 3; turn += 1) {
        const job = await claim();
        order.push(job.id);
        await drain(job);
      }

      expect(order).toEqual([a1, b1, a2]);
    });
  });

  describe('the worker loop', () => {
    const settings = (overrides: Partial<WorkerConfig> = {}): WorkerConfig => ({
      ...loadConfig().worker,
      ...SETTINGS,
      id: 'loop-worker',
      pollMs: 20,
      retryBackoffMs: 10,
      ...overrides,
    });

    /**
     * Runs the worker until `done` holds, then stops it. The stop happens even when the wait
     * fails, so a failing test can't leave a worker polling and keep Jest from exiting.
     */
    async function runUntil(worker: BulkWorker, done: () => Promise<boolean>): Promise<void> {
      const running = worker.run();
      try {
        await waitFor(done);
      } finally {
        worker.stop();
        await running;
      }
    }

    it('retries a failed batch and finishes the job', async () => {
      const ws = await createWorkspace(pool);
      await insertDeals(pool, ws, 7);
      const jobId = await submitJob(ws);
      let failures = 0;
      const worker = new BulkWorker(pool, settings(), {
        logger: SILENT,
        faults: {
          // The first batch fails once; every later one goes through.
          afterApply: () => {
            if (failures > 0) return Promise.resolve();
            failures += 1;
            return Promise.reject(new Error('transient failure'));
          },
        },
      });

      await runUntil(worker, async () => (await jobRow(jobId)).status === 'completed');

      expect(await jobRow(jobId)).toMatchObject({
        moved_count: 7,
        attempts: 1,
        last_error: 'transient failure',
      });
    });

    it('hands the job back on stop, without counting it as a failure', async () => {
      const ws = await createWorkspace(pool);
      await insertDeals(pool, ws, 9);
      const jobId = await submitJob(ws);
      const worker: BulkWorker = new BulkWorker(pool, settings(), {
        logger: SILENT,
        // Ask the worker to stop during its first batch: that batch still commits, then the
        // worker hands the job back.
        faults: { afterApply: () => Promise.resolve(worker.stop()) },
      });

      await runUntil(worker, async () => {
        const job = await jobRow(jobId);
        return job.cursor_seq > 0 && job.lease_owner === null;
      });

      expect(await jobRow(jobId)).toMatchObject({
        status: 'running',
        cursor_seq: 3,
        lease_owner: null,
        attempts: 0,
      });
      const next = await claim('worker-b');
      expect(next).toMatchObject({ id: jobId, processed: 3, attempts: 0 });
    });

    it('marks a job failed once it has used up its attempts', async () => {
      const ws = await createWorkspace(pool);
      await insertDeals(pool, ws, 3);
      const jobId = await submitJob(ws);
      await pool.query('UPDATE bulk_jobs SET attempts = 2 WHERE id = $1', [jobId]);
      const worker = new BulkWorker(pool, settings({ maxAttempts: 2 }), { logger: SILENT });

      await runUntil(worker, async () => (await jobRow(jobId)).status === 'failed');

      expect(await jobRow(jobId)).toMatchObject({ cursor_seq: 0, lease_owner: null });
      expect((await jobRow(jobId)).last_error).toMatch(/gave up after 2 failed attempts/);
    });

    // With one worker and no slicing, A's long job would hold the worker to the end while B's job
    // waited. With slicing, A is handed back after its slice, B gets its turn, and A resumes.
    it("hands a long job back after its time slice so another workspace's job runs", async () => {
      const [a, b] = await Promise.all([createWorkspace(pool), createWorkspace(pool)]);
      await insertDeals(pool, a, 9);
      await insertDeals(pool, b, 3);
      const long = await submitJob(a);
      const short = await submitJob(b);
      const worker = new BulkWorker(pool, settings({ sliceMs: 1 }), { logger: SILENT });

      await runUntil(worker, async () => {
        const { rows } = await pool.query<{ done: number }>(
          `SELECT count(*) AS done FROM bulk_jobs WHERE id = ANY($1) AND status = 'completed'`,
          [[long, short]],
        );
        return rows[0]?.done === 2;
      });

      const { rows } = await pool.query<{ id: number }>(
        'SELECT id FROM bulk_jobs WHERE id = ANY($1) ORDER BY finished_at',
        [[long, short]],
      );
      expect(rows.map((row) => row.id)).toEqual([short, long]);
      // Handed back and claimed again, and the hand-back didn't count as a failure.
      expect(await jobRow(long)).toMatchObject({ moved_count: 9, attempts: 0 });
      expect((await jobRow(long)).lease_epoch).toBeGreaterThanOrEqual(2);
    });

    // The speed limit is a lower bound on how long a job takes. 30 deals at 100 deals/s, in
    // batches of 3, means at least 9 paced gaps of ~30ms (the last batch isn't followed by one).
    // Unpaced, the same job finishes in a few milliseconds. Only the lower bound is asserted, so a
    // slow machine can't make this flaky.
    it('holds a job to its speed limit', async () => {
      const ws = await createWorkspace(pool);
      await insertDeals(pool, ws, 30);
      const jobId = await submitJob(ws);
      const worker = new BulkWorker(pool, settings({ maxDealsPerSecond: 100 }), {
        logger: SILENT,
      });

      const startedAt = Date.now();
      await runUntil(worker, async () => (await jobRow(jobId)).status === 'completed');

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(240);
      expect(await jobRow(jobId)).toMatchObject({ moved_count: 30 });
    });
  });
});
