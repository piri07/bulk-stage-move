import { Logger } from '@nestjs/common';
import { Pool, types } from 'pg';
import type { DatabaseConfig } from '../config';

// int8 (ids, counts, cents) arrives as a string by default. Parse it to a number, and fail the query
// rather than silently lose precision beyond 2^53.
types.setTypeParser(types.builtins.INT8, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`int8 value ${value} is outside the safe integer range`);
  }
  return parsed;
});

export interface PoolOptions {
  /**
   * Postgres ends a session that sits idle inside a transaction for this long. For the worker,
   * this means a process frozen mid-batch can't keep its rows and its job locked indefinitely.
   */
  idleInTransactionTimeoutMs?: number;
}

export function createPool(
  config: DatabaseConfig,
  applicationName: string,
  options: PoolOptions = {},
): Pool {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    // Shows up in pg_stat_activity, so API, worker and script connections can be told apart.
    application_name: applicationName,
    ...(config.statementTimeoutMs > 0 ? { statement_timeout: config.statementTimeoutMs } : {}),
    ...(options.idleInTransactionTimeoutMs
      ? { idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs }
      : {}),
  });
  // An idle connection can be closed underneath us: Postgres restarting, a network blip, an admin
  // ending sessions. pg reports that as an 'error' event on the pool, and with no listener Node
  // crashes the whole process. That once took the worker down; see docs/challenges.md. The pool
  // already discards the broken connection and opens a fresh one for the next query, so logging
  // is all that's needed here.
  pool.on('error', (err) => {
    Logger.warn(`${applicationName}: idle database connection lost (${err.message})`, 'Database');
  });
  return pool;
}
