import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import request from 'supertest';
import { claimNextJob, runBatch, type BatchSettings } from '../../src/worker/queue';
import { createWorkspace, startApp } from '../support/app';
import { insertDeals } from '../support/deals';

const WS = 'x-workspace-id';
const POLL_INTERVAL_MS = 300;
const SETTINGS: BatchSettings = { batchSize: 3, leaseMs: 15_000, lockTimeoutMs: 2000 };

describe('bulk move progress', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await startApp({ bulk: { pollIntervalMs: POLL_INTERVAL_MS } }));
  });

  afterAll(async () => {
    await app.close();
  });

  // Claims take the oldest claimable job in the database; park any job other tests left behind.
  beforeEach(async () => {
    await pool.query(
      `UPDATE bulk_jobs SET status = 'failed', lease_owner = NULL, last_error = 'parked by test'
        WHERE status IN ('pending', 'running')`,
    );
  });

  const api = () => request(app.getHttpServer());
  const progress = (workspaceId: string, jobId: number) =>
    api().get(`/bulk-moves/${jobId}/progress`).set(WS, workspaceId);
  /** Waits out the poll limit before reading the same job again. */
  const nextPoll = () => sleep(POLL_INTERVAL_MS + 20);

  async function submitJob(workspaceId: string, deals: number): Promise<number> {
    await insertDeals(pool, workspaceId, deals);
    const res = await api()
      .post('/bulk-moves')
      .set(WS, workspaceId)
      .set('idempotency-key', randomUUID())
      .send({ filter: { stages: ['qualified'] }, targetStage: 'proposal_sent' })
      .expect(202);
    return res.body.id as number;
  }

  async function claim() {
    const job = await claimNextJob(pool, 'progress-test-worker', SETTINGS.leaseMs);
    if (!job) throw new Error('expected a job to claim');
    return job;
  }

  it('follows a job from queued, to active, to stalled, to completed', async () => {
    const ws = await createWorkspace(pool);
    const jobId = await submitJob(ws, 6);

    const queued = await progress(ws, jobId).expect(200);
    expect(queued.body).toMatchObject({
      jobId,
      status: 'pending',
      health: 'queued',
      total: 6,
      processed: 0,
      pollAfterMs: POLL_INTERVAL_MS,
    });
    expect(queued.body.detail).toMatch(/waiting for a free worker/);

    const job = await claim();
    await runBatch(pool, job, SETTINGS);
    await nextPoll();
    const active = await progress(ws, jobId).expect(200);
    expect(active.body).toMatchObject({
      health: 'active',
      processed: 3,
      remaining: 3,
      percent: 50,
    });
    expect(active.body.dealsPerSecond).toBeGreaterThan(0);
    expect(active.body.secondsSinceProgress).toBeLessThan(2);

    // What a dead worker leaves: a lease nobody renews.
    await pool.query(
      `UPDATE bulk_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
    await nextPoll();
    const stalled = await progress(ws, jobId).expect(200);
    expect(stalled.body.health).toBe('stalled');
    expect(stalled.body.detail).toMatch(/another worker will resume it from 3 of 6/);

    const successor = await claim();
    await runBatch(pool, successor, SETTINGS);
    await nextPoll();
    const completed = await progress(ws, jobId).expect(200);
    expect(completed.body).toMatchObject({
      status: 'completed',
      health: 'completed',
      processed: 6,
      moved: 6,
      etaSeconds: 0,
      pollAfterMs: null,
    });

    // A finished job's rate is measured up to when it finished, so it doesn't keep falling.
    await nextPoll();
    const later = await progress(ws, jobId).expect(200);
    expect(later.body.dealsPerSecond).toBe(completed.body.dealsPerSecond);
  });

  describe('the poll limit', () => {
    it('allows one read per job per interval, and says when to come back', async () => {
      const ws = await createWorkspace(pool);
      const jobId = await submitJob(ws, 3);

      await progress(ws, jobId).expect(200);
      const tooSoon = await progress(ws, jobId).expect(429);
      expect(tooSoon.headers['retry-after']).toBe('1');
      expect(tooSoon.body.retryAfterMs).toBeGreaterThan(0);
      expect(tooSoon.body.retryAfterMs).toBeLessThanOrEqual(POLL_INTERVAL_MS);

      await nextPoll();
      await progress(ws, jobId).expect(200);
    });

    it('shares the limit between the job and progress endpoints', async () => {
      const ws = await createWorkspace(pool);
      const jobId = await submitJob(ws, 3);

      await api().get(`/bulk-moves/${jobId}`).set(WS, ws).expect(200);
      await progress(ws, jobId).expect(429);
    });

    it("limits each job separately, so polling one job never blocks another's", async () => {
      const ws = await createWorkspace(pool);
      const first = await submitJob(ws, 3);
      const second = await submitJob(ws, 3);

      await progress(ws, first).expect(200);
      await progress(ws, first).expect(429);
      await progress(ws, second).expect(200);
    });

    it("doesn't let a request naming another workspace use up the owner's allowance", async () => {
      const [owner, other] = await Promise.all([createWorkspace(pool), createWorkspace(pool)]);
      const jobId = await submitJob(owner, 3);

      await progress(other, jobId).expect(404);
      await progress(owner, jobId).expect(200);
    });
  });
});
