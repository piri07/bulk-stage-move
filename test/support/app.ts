import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, loadConfig, type AppConfig } from '../../src/config';
import { PG_POOL } from '../../src/db/database.module';
import { TEST_DATABASE_URL } from './database';

/** Boots the real AppModule (pipes, guards, pool) against the test database. */
export async function startApp(): Promise<{ app: INestApplication; pool: Pool }> {
  const config: AppConfig = {
    ...loadConfig(),
    database: { url: TEST_DATABASE_URL, poolMax: 20, statementTimeoutMs: 5000 },
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  // Listen once on an ephemeral loopback port; otherwise supertest starts a listener per request.
  await app.listen(0, '127.0.0.1');
  return { app, pool: app.get<Pool>(PG_POOL) };
}

/** A fresh tenant per test keeps tests independent without truncating tables. */
export async function createWorkspace(pool: Pool): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [id, `test ${id}`]);
  return id;
}
