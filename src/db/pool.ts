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
  return new Pool({
    connectionString: config.url,
    max: config.poolMax,
    // Shows up in pg_stat_activity, so API, worker and script connections can be told apart.
    application_name: applicationName,
    ...(config.statementTimeoutMs > 0 ? { statement_timeout: config.statementTimeoutMs } : {}),
    ...(options.idleInTransactionTimeoutMs
      ? { idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs }
      : {}),
  });
}
