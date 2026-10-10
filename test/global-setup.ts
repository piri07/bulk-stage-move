import { Client } from 'pg';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { TEST_DATABASE_URL } from './support/database';

/**
 * Recreates the test database from the current migrations before every run. Tests then isolate
 * themselves by creating their own workspaces, so nothing needs truncating between tests.
 */
export default async function globalSetup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const database = url.pathname.slice(1);
  // This drops the database, so refuse anything that isn't obviously a test database.
  if (!/^[a-z0-9_]+_test$/.test(database)) {
    throw new Error(`refusing to recreate "${database}": test database names must end in _test`);
  }

  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }

  const pool = createPool(
    { url: TEST_DATABASE_URL, poolMax: 1, statementTimeoutMs: 0 },
    'crm-test-setup',
  );
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
