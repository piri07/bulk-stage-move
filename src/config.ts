import { hostname } from 'node:os';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  port: number;
  database: DatabaseConfig;
  bulk: BulkConfig;
  worker: WorkerConfig;
}

export interface DatabaseConfig {
  url: string;
  poolMax: number;
  /** 0 disables the timeout (used by one-off scripts such as migrate and seed). */
  statementTimeoutMs: number;
}

export interface BulkConfig {
  /** The most deals one bulk move may cover; a broader filter is rejected at submission. */
  maxDeals: number;
}

export interface WorkerConfig {
  id: string;
  /** Deals per batch: each batch is one transaction, so this bounds how long rows stay locked. */
  batchSize: number;
  /** How long a claim lasts without renewal; also how soon a dead worker's job is taken over. */
  leaseMs: number;
  /** How often an idle worker looks for a job. */
  pollMs: number;
  /** Failed runs (errors, or workers that died) after which a job is marked failed. */
  maxAttempts: number;
  /** First retry delay after a failed run; doubles with every further failure. */
  retryBackoffMs: number;
  /** How long a batch waits for a row lock before giving up and retrying later. */
  lockTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: intFromEnv(env, 'PORT', 3000),
    database: {
      url: nonEmpty(env.DATABASE_URL) ?? 'postgres://crm:crm@localhost:5433/crm',
      poolMax: intFromEnv(env, 'DB_POOL_MAX', 10),
      statementTimeoutMs: intFromEnv(env, 'DB_STATEMENT_TIMEOUT_MS', 5000),
    },
    bulk: {
      maxDeals: intFromEnv(env, 'BULK_MAX_DEALS', 50_000),
    },
    worker: {
      id: nonEmpty(env.WORKER_ID) ?? `${hostname()}:${process.pid}`,
      batchSize: intFromEnv(env, 'WORKER_BATCH_SIZE', 500),
      leaseMs: intFromEnv(env, 'WORKER_LEASE_MS', 15_000),
      pollMs: intFromEnv(env, 'WORKER_POLL_MS', 1000),
      maxAttempts: intFromEnv(env, 'WORKER_MAX_ATTEMPTS', 5),
      retryBackoffMs: intFromEnv(env, 'WORKER_RETRY_BACKOFF_MS', 2000),
      lockTimeoutMs: intFromEnv(env, 'WORKER_LOCK_TIMEOUT_MS', 2000),
    },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}
