import { describeProgress, type ProgressRow, type ProgressSettings } from '../../src/bulk/progress';

const SETTINGS: ProgressSettings = {
  slowAfterSeconds: 2,
  stuckAfterSeconds: 30,
  maxAttempts: 5,
  pollIntervalMs: 2000,
};

/** A job mid-run with a healthy worker; each case changes only what it is about. */
function row(overrides: Partial<ProgressRow> = {}): ProgressRow {
  return {
    id: 1,
    status: 'running',
    total: 1000,
    processed: 400,
    moved: 390,
    skipped: 10,
    attempts: 0,
    lastError: null,
    leaseOwner: 'worker-a',
    lastProgressAt: new Date(),
    secondsSinceProgress: 0.1,
    leaseSecondsLeft: 14,
    elapsedSeconds: 4,
    secondsSinceCreated: 5,
    started: true,
    blockingJobId: null,
    anyWorkerActive: true,
    ...overrides,
  };
}

const PENDING: Partial<ProgressRow> = {
  status: 'pending',
  processed: 0,
  moved: 0,
  skipped: 0,
  leaseOwner: null,
  lastProgressAt: null,
  secondsSinceProgress: null,
  leaseSecondsLeft: null,
  started: false,
};

describe('progress health', () => {
  it('reports a job whose worker keeps committing batches as active, with rate and ETA', () => {
    expect(describeProgress(row(), SETTINGS)).toMatchObject({
      health: 'active',
      remaining: 600,
      percent: 40,
      dealsPerSecond: 100,
      etaSeconds: 6,
      pollAfterMs: 2000,
    });
  });

  it.each<[string, Partial<ProgressRow>, string, RegExp]>([
    ['held but quiet', { secondsSinceProgress: 5 }, 'slow', /no batch has committed for 5s/],
    ['lease expired', { leaseSecondsLeft: -3 }, 'stalled', /another worker will resume it/],
    [
      'lease expired long ago, workers busy elsewhere',
      { leaseSecondsLeft: -40, anyWorkerActive: true },
      'stalled',
      /stopped responding 40s ago/,
    ],
    [
      'lease expired long ago, no worker active',
      { leaseSecondsLeft: -40, anyWorkerActive: false },
      'stuck',
      /is a worker running\?/,
    ],
    [
      'a batch failed and is waiting out its backoff',
      { leaseOwner: null, leaseSecondsLeft: 4, lastError: 'lock timeout', attempts: 1 },
      'retrying',
      /lock timeout.*retrying in 4s, attempt 2 of 5/,
    ],
    [
      'handed back at a time slice',
      { leaseOwner: null, leaseSecondsLeft: -1 },
      'queued',
      /paused at 400 of 1000 to give another workspace a turn/,
    ],
    [
      'pending behind its workspace',
      { ...PENDING, blockingJobId: 7 },
      'queued',
      /waiting for this workspace's job 7/,
    ],
    ['pending, workers busy', { ...PENDING }, 'queued', /waiting for a free worker/],
    [
      'pending a long time with no worker active',
      { ...PENDING, secondsSinceCreated: 45, anyWorkerActive: false },
      'stuck',
      /no worker has been active/,
    ],
  ])('%s → %s', (_label, overrides, health, detail) => {
    const progress = describeProgress(row(overrides), SETTINGS);
    expect(progress.health).toBe(health);
    expect(progress.detail).toMatch(detail);
  });

  it('gives a retrying job the time until its next attempt', () => {
    const progress = describeProgress(
      row({ leaseOwner: null, leaseSecondsLeft: 3.2, lastError: 'boom' }),
      SETTINGS,
    );
    expect(progress.retryInSeconds).toBe(4);
  });

  it('has no rate or ETA before a job has made progress', () => {
    expect(describeProgress(row(PENDING), SETTINGS)).toMatchObject({
      dealsPerSecond: null,
      etaSeconds: null,
      percent: 0,
    });
  });

  it('stops asking to be polled once a job has finished', () => {
    const completed = describeProgress(
      row({ status: 'completed', processed: 1000, moved: 990, skipped: 10 }),
      SETTINGS,
    );
    expect(completed).toMatchObject({ health: 'completed', etaSeconds: 0, pollAfterMs: null });
    expect(completed.detail).toMatch(/990 moved, 10 skipped/);

    const failed = describeProgress(
      row({ status: 'failed', attempts: 5, lastError: 'database unreachable' }),
      SETTINGS,
    );
    expect(failed).toMatchObject({ health: 'failed', pollAfterMs: null });
    expect(failed.detail).toMatch(/after 5 failed attempts \(database unreachable\)/);
  });

  it('counts an empty job as fully done', () => {
    const progress = describeProgress(
      row({ status: 'completed', total: 0, processed: 0, moved: 0, skipped: 0 }),
      SETTINGS,
    );
    expect(progress.percent).toBe(100);
  });
});
