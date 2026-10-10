import { Logger } from '@nestjs/common';
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { BulkWorker } from './bulk-worker';

async function main(): Promise<void> {
  const config = loadConfig();
  // The worker's own small pool: it can never take connections from the API. A worker that
  // freezes mid-batch has its session ended by Postgres within one lease, which releases its locks.
  const pool = createPool({ ...config.database, poolMax: 2 }, 'bulk-worker', {
    idleInTransactionTimeoutMs: config.worker.leaseMs,
  });
  const worker = new BulkWorker(pool, config.worker);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      Logger.log(`${signal}: finishing the current batch, then stopping`, 'BulkWorker');
      worker.stop();
    });
  }
  try {
    await worker.run();
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
