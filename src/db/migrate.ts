import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { loadConfig } from '../config';
import { createPool } from './pool';

export const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');

// Arbitrary constant. Migrators started at the same time (api and test containers) serialise on it.
const MIGRATION_LOCK_ID = 727_001;

/**
 * Applies every migrations/*.sql file not yet recorded in schema_migrations, in filename order.
 * Each file runs in its own transaction together with its bookkeeping row, so a failed migration
 * leaves no trace and is retried on the next run.
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    const pending = (await readdir(dir))
      .filter((file) => file.endsWith('.sql') && !applied.has(file))
      .sort();

    for (const file of pending) {
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return pending;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = createPool({ ...loadConfig().database, statementTimeoutMs: 0 }, 'crm-migrate');
  try {
    const applied = await migrate(pool);
    console.log(applied.length > 0 ? `applied: ${applied.join(', ')}` : 'schema up to date');
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
