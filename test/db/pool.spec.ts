import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool';
import { TEST_DATABASE_URL } from '../support/database';

describe('database pool', () => {
  let pool: Pool;
  let admin: Pool;

  beforeAll(() => {
    const config = { url: TEST_DATABASE_URL, statementTimeoutMs: 0 };
    pool = createPool({ ...config, poolMax: 3 }, 'pool-resilience-test');
    admin = createPool({ ...config, poolMax: 1 }, 'pool-resilience-admin');
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  // A Postgres restart, or an admin ending sessions, closes idle connections underneath the app.
  // pg reports that as an 'error' event on the pool. Unhandled, that event crashed the whole
  // worker once (docs/challenges.md). The pool must log it and keep working.
  it('survives the database closing its idle connections', async () => {
    await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 1'), pool.query('SELECT 1')]);

    const { rows } = await admin.query<{ closed: number }>(
      `SELECT count(pg_terminate_backend(pid))::int AS closed
         FROM pg_stat_activity WHERE application_name = 'pool-resilience-test'`,
    );
    expect(rows[0]?.closed).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(after.rows).toEqual([{ ok: 1 }]);
  });
});
