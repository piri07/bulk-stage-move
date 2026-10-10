import type { Pool, PoolClient } from 'pg';

/**
 * Runs fn between BEGIN and COMMIT on one pooled connection and rolls back if it throws. A
 * connection whose ROLLBACK also fails is destroyed rather than returned to the pool in an
 * unknown state.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
