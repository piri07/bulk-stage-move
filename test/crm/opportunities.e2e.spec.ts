import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { INITIAL_STAGE, STAGES, STATUSES, type Stage } from '../../src/crm/pipeline';
import { createWorkspace, startApp } from '../support/app';

const WS = 'x-workspace-id';
const OWNER = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4';
const VALID_BODY = { name: 'Acme renewal', valueCents: 125_000, ownerId: OWNER };

interface Deal {
  id: number;
  workspaceId: string;
  stage: Stage;
  status: string;
  valueCents: number;
  version: number;
}

describe('opportunities API', () => {
  let app: INestApplication;
  let pool: Pool;
  let workspace: string;

  beforeAll(async () => {
    ({ app, pool } = await startApp());
    workspace = await createWorkspace(pool);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());

  async function createDeal(workspaceId: string, overrides: object = {}): Promise<Deal> {
    const res = await api()
      .post('/opportunities')
      .set(WS, workspaceId)
      .send({ ...VALID_BODY, ...overrides })
      .expect(201);
    return res.body as Deal;
  }

  function move(workspaceId: string, id: number, body: object) {
    return api().patch(`/opportunities/${id}/stage`).set(WS, workspaceId).send(body);
  }

  async function transitionsOf(id: number): Promise<{ from_stage: Stage; to_stage: Stage }[]> {
    const { rows } = await pool.query<{ from_stage: Stage; to_stage: Stage }>(
      'SELECT from_stage, to_stage FROM stage_transitions WHERE opportunity_id = $1 ORDER BY id',
      [id],
    );
    return rows;
  }

  describe('tenancy', () => {
    it('rejects requests without a valid X-Workspace-Id', async () => {
      await api().get('/opportunities').query({ stage: 'qualified' }).expect(400);
      await api().get('/opportunities').set(WS, 'acme').query({ stage: 'qualified' }).expect(400);
    });

    it("hides another workspace's deals and never touches them", async () => {
      const [mine, theirs] = await Promise.all([createWorkspace(pool), createWorkspace(pool)]);
      const deal = await createDeal(mine, { stage: 'qualified' });

      await api().get(`/opportunities/${deal.id}`).set(WS, theirs).expect(404);
      await move(theirs, deal.id, { stage: 'contacted' }).expect(404);
      const list = await api()
        .get('/opportunities')
        .set(WS, theirs)
        .query({ stage: 'qualified' })
        .expect(200);
      expect(list.body).toEqual({ items: [], nextCursor: null });

      const own = await api().get(`/opportunities/${deal.id}`).set(WS, mine).expect(200);
      expect(own.body).toMatchObject({ stage: 'qualified', version: 1 });
      expect(await transitionsOf(deal.id)).toEqual([]);
    });

    it('returns 404 when creating in a workspace that does not exist', async () => {
      await api()
        .post('/opportunities')
        .set(WS, '00000000-0000-4000-8000-0000000000ff')
        .send(VALID_BODY)
        .expect(404);
    });
  });

  describe('create and list', () => {
    it('creates a deal in the first stage, open, at version 1', async () => {
      const deal = await createDeal(workspace);
      expect(deal).toMatchObject({
        workspaceId: workspace,
        stage: INITIAL_STAGE,
        status: 'open',
        valueCents: 125_000,
        version: 1,
      });
    });

    it.each([
      ['a negative value', { valueCents: -1 }],
      ['a fractional value', { valueCents: 10.5 }],
      ['a value sent as a string', { valueCents: '100' }],
      ['an empty name', { name: '' }],
      ['a malformed owner', { ownerId: 'bob' }],
      ['an unknown stage', { stage: 'archived' }],
      ['an unknown field', { isAdmin: true }],
    ])('rejects %s with 400', async (_label, override) => {
      await api()
        .post('/opportunities')
        .set(WS, workspace)
        .send({ ...VALID_BODY, ...override })
        .expect(400);
    });

    it('pages through a stage in id order without gaps or overlaps', async () => {
      const own = await createWorkspace(pool);
      const expected: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        expected.push((await createDeal(own, { stage: 'qualified' })).id);
      }
      await createDeal(own, { stage: 'contacted' });

      const seen: number[] = [];
      let cursor: number | null = null;
      let pages = 0;
      do {
        const res = await api()
          .get('/opportunities')
          .set(WS, own)
          .query({ stage: 'qualified', limit: 3, ...(cursor === null ? {} : { cursor }) })
          .expect(200);
        const page = res.body as { items: Deal[]; nextCursor: number | null };
        seen.push(...page.items.map((deal) => deal.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null);

      expect(pages).toBe(3);
      expect(seen).toEqual(expected);
    });

    it.each(['abc', '0', '99999999999999999999'])('rejects id %s with 400', async (id) => {
      await api().get(`/opportunities/${id}`).set(WS, workspace).expect(400);
    });
  });

  describe('single stage move', () => {
    it('moves the deal, bumps the version and records the transition', async () => {
      const deal = await createDeal(workspace);
      const res = await move(workspace, deal.id, { stage: 'qualified' }).expect(200);
      expect(res.body).toMatchObject({ id: deal.id, stage: 'qualified', version: 2 });
      expect(await transitionsOf(deal.id)).toEqual([
        { from_stage: 'new_lead', to_stage: 'qualified' },
      ]);
    });

    it('treats a move to the current stage as a no-op', async () => {
      const deal = await createDeal(workspace, { stage: 'qualified' });
      const res = await move(workspace, deal.id, { stage: 'qualified' }).expect(200);
      expect(res.body).toMatchObject({ stage: 'qualified', version: 1 });
      expect(await transitionsOf(deal.id)).toEqual([]);
    });

    it('rejects a stale expectedVersion with 409 and writes nothing', async () => {
      const deal = await createDeal(workspace);
      await move(workspace, deal.id, { stage: 'contacted' }).expect(200);

      const res = await move(workspace, deal.id, {
        stage: 'negotiation',
        expectedVersion: 1,
      }).expect(409);
      expect(res.body.current).toMatchObject({ stage: 'contacted', version: 2 });
      expect(await transitionsOf(deal.id)).toHaveLength(1);

      await move(workspace, deal.id, { stage: 'negotiation', expectedVersion: 2 }).expect(200);
    });

    // Without the row lock, concurrent movers read the same current stage and log the same
    // from_stage, breaking the chain. Removing FOR UPDATE makes this test fail.
    it('serialises concurrent moves of one deal into an unbroken transition chain', async () => {
      const deal = await createDeal(workspace);
      // Ten distinct targets, none of them the starting stage, so every move is a real change
      // whatever order the row lock is granted in.
      const targets = STAGES.filter((stage) => stage !== INITIAL_STAGE).slice(0, 10);

      const responses = await Promise.all(
        targets.map((stage) => move(workspace, deal.id, { stage })),
      );
      expect(responses.map((res) => res.status)).toEqual(targets.map(() => 200));

      const chain = await transitionsOf(deal.id);
      expect(chain).toHaveLength(targets.length);
      chain.forEach((transition, i) => {
        expect(transition.from_stage).toBe(i === 0 ? INITIAL_STAGE : chain[i - 1]?.to_stage);
      });
      const final = await api().get(`/opportunities/${deal.id}`).set(WS, workspace).expect(200);
      expect(final.body).toMatchObject({
        stage: chain.at(-1)?.to_stage,
        version: targets.length + 1,
      });
    });
  });

  it('keeps the database enums identical to the pipeline defined in code', async () => {
    const enumValues = async (type: string): Promise<string[]> => {
      const { rows } = await pool.query<{ value: string }>(
        `SELECT unnest(enum_range(NULL::${type}))::text AS value`,
      );
      return rows.map((row) => row.value);
    };
    expect(await enumValues('opportunity_stage')).toEqual([...STAGES]);
    expect(await enumValues('opportunity_status')).toEqual([...STATUSES]);
  });
});
