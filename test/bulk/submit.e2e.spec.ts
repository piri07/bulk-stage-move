import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { insertJob } from '../../src/bulk/bulk-jobs.repository';
import { hashRequest, normalizeFilter, type BulkFilter } from '../../src/bulk/filter';
import { createWorkspace, startApp } from '../support/app';
import { insertDeals } from '../support/deals';
import { waitFor } from '../support/wait';

const WS = 'x-workspace-id';
const KEY = 'idempotency-key';
const MAX_DEALS = 20;
const MOVE_QUALIFIED = { filter: { stages: ['qualified'] }, targetStage: 'proposal_sent' };

interface ItemRow {
  seq: number;
  opportunity_id: number;
  expected_version: number;
  from_stage: string;
  outcome: string | null;
}

describe('submitting a bulk move', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await startApp({ bulk: { maxDeals: MAX_DEALS } }));
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());

  function submit(workspaceId: string, body: object, key: string | null = randomUUID()) {
    const req = api().post('/bulk-moves').set(WS, workspaceId);
    return (key === null ? req : req.set(KEY, key)).send(body);
  }

  async function itemsOf(jobId: number): Promise<ItemRow[]> {
    const { rows } = await pool.query<ItemRow>(
      'SELECT * FROM bulk_job_items WHERE job_id = $1 ORDER BY seq',
      [jobId],
    );
    return rows;
  }

  async function jobCount(workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*) AS n FROM bulk_jobs WHERE workspace_id = $1',
      [workspaceId],
    );
    return rows[0]?.n ?? 0;
  }

  describe('the snapshot', () => {
    it('lists exactly the matching deals, in id order, with their version at the click', async () => {
      const ws = await createWorkspace(pool);
      const qualified = await insertDeals(pool, ws, 5, { stage: 'qualified' });
      await insertDeals(pool, ws, 3, { stage: 'contacted' });

      const res = await submit(ws, MOVE_QUALIFIED).expect(202);
      expect(res.body).toMatchObject({
        status: 'pending',
        targetStage: 'proposal_sent',
        filter: { stages: ['qualified'] },
        total: 5,
        processed: 0,
        moved: 0,
        skipped: 0,
      });

      const items = await itemsOf(res.body.id);
      expect(items.map((item) => item.opportunity_id)).toEqual(qualified);
      expect(items.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(items.every((item) => item.expected_version === 1 && item.outcome === null)).toBe(
        true,
      );
    });

    it('applies every filter criterion together', async () => {
      const ws = await createWorkspace(pool);
      const alice = randomUUID();
      const march = '2026-03-15T00:00:00.000Z';
      const matching = await insertDeals(pool, ws, 2, {
        ownerId: alice,
        valueCents: 5000,
        createdAt: march,
      });
      await insertDeals(pool, ws, 1, { ownerId: randomUUID(), valueCents: 5000, createdAt: march });
      await insertDeals(pool, ws, 1, { ownerId: alice, valueCents: 50_000, createdAt: march });
      await insertDeals(pool, ws, 1, {
        ownerId: alice,
        valueCents: 5000,
        status: 'lost',
        createdAt: march,
      });
      // createdTo is exclusive: a deal created exactly at it is outside the range.
      await insertDeals(pool, ws, 1, {
        ownerId: alice,
        valueCents: 5000,
        createdAt: '2026-04-01T00:00:00.000Z',
      });

      const res = await submit(ws, {
        filter: {
          stages: ['qualified'],
          ownerIds: [alice],
          statuses: ['open'],
          minValueCents: 1000,
          maxValueCents: 10_000,
          createdFrom: '2026-03-01T00:00:00Z',
          createdTo: '2026-04-01T00:00:00Z',
        },
        targetStage: 'negotiation',
      }).expect(202);

      expect(res.body.total).toBe(2);
      expect((await itemsOf(res.body.id)).map((item) => item.opportunity_id)).toEqual(matching);
    });

    it('leaves out deals that are already in the target stage', async () => {
      const ws = await createWorkspace(pool);
      await insertDeals(pool, ws, 3, { stage: 'qualified' });
      const others = await insertDeals(pool, ws, 2, { stage: 'contacted' });

      const res = await submit(ws, { filter: {}, targetStage: 'qualified' }).expect(202);
      expect(res.body.total).toBe(2);
      expect((await itemsOf(res.body.id)).map((item) => item.opportunity_id)).toEqual(others);
    });

    it('completes at once when nothing matches', async () => {
      const ws = await createWorkspace(pool);
      const res = await submit(ws, MOVE_QUALIFIED).expect(202);
      expect(res.body).toMatchObject({ status: 'completed', total: 0 });
      expect(res.body.finishedAt).not.toBeNull();
    });

    it('rejects a filter broader than the cap with 422 and keeps nothing of the request', async () => {
      const ws = await createWorkspace(pool);
      await insertDeals(pool, ws, 15, { valueCents: 1000 });
      await insertDeals(pool, ws, MAX_DEALS - 14, { valueCents: 9000 });
      const key = randomUUID();

      await submit(ws, MOVE_QUALIFIED, key).expect(422);
      expect(await jobCount(ws)).toBe(0);

      // Nothing was stored, so the same key can carry a narrower filter.
      const narrowed = await submit(
        ws,
        { filter: { stages: ['qualified'], maxValueCents: 5000 }, targetStage: 'proposal_sent' },
        key,
      ).expect(202);
      expect(narrowed.body.total).toBe(15);
    });
  });

  describe('idempotency', () => {
    it('returns the same job for a repeated key, without taking a second snapshot', async () => {
      const ws = await createWorkspace(pool);
      await insertDeals(pool, ws, 3);
      const key = randomUUID();

      const first = await submit(ws, MOVE_QUALIFIED, key).expect(202);
      const again = await submit(ws, MOVE_QUALIFIED, key).expect(202);

      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.id).toBe(first.body.id);
      expect(await jobCount(ws)).toBe(1);
      expect(await itemsOf(first.body.id)).toHaveLength(3);
    });

    it('recognises the same request written differently', async () => {
      const ws = await createWorkspace(pool);
      const key = randomUUID();
      const first = await submit(
        ws,
        { filter: { stages: ['qualified', 'contacted'] }, targetStage: 'negotiation' },
        key,
      ).expect(202);
      const reordered = await submit(
        ws,
        { filter: { stages: ['contacted', 'qualified', 'qualified'] }, targetStage: 'negotiation' },
        key,
      ).expect(202);
      expect(reordered.body.id).toBe(first.body.id);
    });

    it('creates exactly one job when the same request arrives many times at once', async () => {
      const ws = await createWorkspace(pool);
      await insertDeals(pool, ws, 5);
      const key = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => submit(ws, MOVE_QUALIFIED, key)),
      );

      expect(responses.map((res) => res.status)).toEqual(Array(10).fill(202));
      expect(new Set(responses.map((res) => res.body.id as number)).size).toBe(1);
      expect(await jobCount(ws)).toBe(1);
      expect(await itemsOf(responses[0]?.body.id)).toHaveLength(5);
    });

    // The race the unique constraint exists for, forced every time rather than left to timing:
    // the original request's transaction is still open when the duplicate arrives. The duplicate
    // must wait on the original's key and then get its job. A "check, then insert" without the
    // constraint would see no committed row yet and create a second job.
    it('makes a duplicate wait for the in-flight original, then returns its job', async () => {
      const ws = await createWorkspace(pool);
      await insertDeals(pool, ws, 2);
      const key = randomUUID();
      const filter = normalizeFilter(MOVE_QUALIFIED.filter as BulkFilter);

      const original = await pool.connect();
      try {
        await original.query('BEGIN');
        const originalId = await insertJob(original, {
          workspaceId: ws,
          idempotencyKey: key,
          requestHash: hashRequest(filter, 'proposal_sent'),
          filter,
          targetStage: 'proposal_sent',
        });
        const duplicate = submit(ws, MOVE_QUALIFIED, key).then((res) => res);
        await waitFor(async () => {
          const { rows } = await pool.query<{ n: number }>(
            'SELECT count(*) AS n FROM pg_locks WHERE NOT granted',
          );
          return (rows[0]?.n ?? 0) > 0;
        });
        await original.query('COMMIT');

        const res = await duplicate;
        expect(res.status).toBe(202);
        expect(res.headers['idempotent-replayed']).toBe('true');
        expect(res.body.id).toBe(originalId);
      } finally {
        original.release();
      }
      expect(await jobCount(ws)).toBe(1);
    });

    it('rejects a key reused for a different request with 422', async () => {
      const ws = await createWorkspace(pool);
      const key = randomUUID();
      const first = await submit(ws, MOVE_QUALIFIED, key).expect(202);

      await submit(ws, { ...MOVE_QUALIFIED, targetStage: 'negotiation' }, key).expect(422);

      expect(await jobCount(ws)).toBe(1);
      const job = await api().get(`/bulk-moves/${first.body.id}`).set(WS, ws).expect(200);
      expect(job.body.targetStage).toBe('proposal_sent');
    });

    it('scopes keys to the workspace', async () => {
      const [mine, theirs] = await Promise.all([createWorkspace(pool), createWorkspace(pool)]);
      const key = randomUUID();
      const a = await submit(mine, MOVE_QUALIFIED, key).expect(202);
      const b = await submit(theirs, MOVE_QUALIFIED, key).expect(202);
      expect(b.headers['idempotent-replayed']).toBeUndefined();
      expect(b.body.id).not.toBe(a.body.id);
    });

    it('requires a well-formed Idempotency-Key', async () => {
      const ws = await createWorkspace(pool);
      await submit(ws, MOVE_QUALIFIED, null).expect(400);
      await submit(ws, MOVE_QUALIFIED, 'x'.repeat(256)).expect(400);
      await submit(ws, MOVE_QUALIFIED, 'has spaces').expect(400);
      expect(await jobCount(ws)).toBe(0);
    });
  });

  describe('validation and access', () => {
    it.each([
      ['an unknown target stage', { filter: {}, targetStage: 'archived' }],
      ['a missing filter', { targetStage: 'qualified' }],
      ['an unknown filter field', { filter: { region: 'EU' }, targetStage: 'qualified' }],
      ['an empty stage list', { filter: { stages: [] }, targetStage: 'qualified' }],
      ['a malformed owner id', { filter: { ownerIds: ['bob'] }, targetStage: 'qualified' }],
      [
        'an inverted value range',
        { filter: { minValueCents: 10, maxValueCents: 5 }, targetStage: 'qualified' },
      ],
      [
        'an inverted date range',
        {
          filter: { createdFrom: '2026-05-01T00:00:00Z', createdTo: '2026-04-01T00:00:00Z' },
          targetStage: 'qualified',
        },
      ],
      ['an invalid date', { filter: { createdFrom: '2026-02-30' }, targetStage: 'qualified' }],
    ])('rejects %s with 400', async (_label, body) => {
      const ws = await createWorkspace(pool);
      await submit(ws, body).expect(400);
      expect(await jobCount(ws)).toBe(0);
    });

    it('returns 404 for a workspace that does not exist', async () => {
      await submit('00000000-0000-4000-8000-0000000000ff', MOVE_QUALIFIED).expect(404);
    });

    it('hides a job and its deals from other workspaces', async () => {
      const [mine, theirs] = await Promise.all([createWorkspace(pool), createWorkspace(pool)]);
      await insertDeals(pool, mine, 2);
      const job = await submit(mine, MOVE_QUALIFIED).expect(202);

      await api().get(`/bulk-moves/${job.body.id}`).set(WS, mine).expect(200);
      await api().get(`/bulk-moves/${job.body.id}`).set(WS, theirs).expect(404);
      await api().get(`/bulk-moves/${job.body.id}/items`).set(WS, theirs).expect(404);
    });

    it("pages through a job's deals", async () => {
      const ws = await createWorkspace(pool);
      const ids = await insertDeals(pool, ws, 3);
      const job = await submit(ws, MOVE_QUALIFIED).expect(202);

      const first = await api()
        .get(`/bulk-moves/${job.body.id}/items`)
        .set(WS, ws)
        .query({ limit: 2 })
        .expect(200);
      expect(first.body).toMatchObject({
        items: [
          { seq: 1, opportunityId: ids[0], fromStage: 'qualified', outcome: null },
          { seq: 2, opportunityId: ids[1] },
        ],
        nextCursor: 2,
      });
      const rest = await api()
        .get(`/bulk-moves/${job.body.id}/items`)
        .set(WS, ws)
        .query({ limit: 2, cursor: 2 })
        .expect(200);
      expect(rest.body).toMatchObject({ items: [{ seq: 3 }], nextCursor: null });
    });
  });
});
