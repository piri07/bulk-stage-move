export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  port: number;
  database: DatabaseConfig;
}

export interface DatabaseConfig {
  url: string;
  poolMax: number;
  /** 0 disables the timeout (used by one-off scripts such as migrate and seed). */
  statementTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: intFromEnv(env, 'PORT', 3000),
    database: {
      url: nonEmpty(env.DATABASE_URL) ?? 'postgres://crm:crm@localhost:5433/crm',
      poolMax: intFromEnv(env, 'DB_POOL_MAX', 10),
      statementTimeoutMs: intFromEnv(env, 'DB_STATEMENT_TIMEOUT_MS', 5000),
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
