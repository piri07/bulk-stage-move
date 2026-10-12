# Design

This answers the brief's seven questions, in its order. The reasoning behind each choice and the
alternatives considered are in [docs/decisions.md](docs/decisions.md), along with the CRM
foundation. The measurements are in [BENCHMARKS.md](BENCHMARKS.md).

## How it works

```
POST /bulk-moves     one transaction: job + idempotency key + list of matching deals → 202 {id}
worker process       claims the job (15s lease), then batches of 500, one transaction each:
                       fence → move deals, write history, record outcomes → advance cursor
                     paced at 10,000 deals/s; hands the job back after 5s if another workspace waits
GET …/:id/progress   reads the job row: counts, health, rate, ETA
```

Postgres is the only datastore, and the `bulk_jobs` table is the queue. A job's progress has to
commit in the same transaction as the moves it records, which only the database holding the deals
can do. A Redis queue such as BullMQ would redeliver a 50,000-deal job whole after a crash, and
would still need its duplicate protection in Postgres.

## Assumptions

1. One 12-stage pipeline for every workspace, where the brief gives each its own. The bulk engine
   only writes a stage value, so per-workspace pipelines wouldn't change it.
2. No rules on the transition sequence: any stage may move to any other. A move to the current
   stage is a no-op.
3. Stage and status are independent: moving to `closed_won` doesn't set `status = won`.
4. Money is integer cents, in one currency.
5. Owners are opaque UUIDs.
6. Deals are never deleted.
7. The workspace comes from the `X-Workspace-Id` header, with no auth.
8. The filter's date range is the deal's creation date.
9. A filter matching more than 50,000 deals is refused with 422, not split into several jobs.

## 1. Chunking, the cursor and the index

The transaction that creates the job also copies every matching deal into `bulk_job_items`,
numbered `seq` 1…N in id order, with each deal's `version` and stage at that moment. The worker
walks this list in batches of 500, one transaction each:

1. **Fence:** lock the job row and check the lease epoch is still this worker's.
2. **Apply,** in one statement: move each deal whose version still matches, write its history row,
   and set every item's outcome to `moved` or `skipped_conflict`.
3. **Checkpoint:** advance `cursor_seq` and the counters, renew the lease, and commit.

**The cursor survives a restart** because it commits together with the moves it counts. A crash
before the commit undoes the whole batch, which is simply redone; after it, the batch is final. A
CHECK constraint (moved + skipped = cursor) makes Postgres refuse an inconsistent checkpoint.

**The index** is the list's primary key, `(job_id, seq)`. Each batch is a range read of exactly the
next 500 entries, so the last batch costs what the first did: no OFFSET, and the filter is never
re-run. The statement is written so the planner can't turn a batch into a scan of the whole list,
which once made batches take 2.6s instead of 16ms ([docs/challenges.md](docs/challenges.md)).

Batch size and speed are separate settings. 500 deals per transaction keeps row locks to about 10ms
and caps what a crash can undo; the pace of 10,000 deals/s gives each batch a 50ms slot (section 5).

**Retries.** A failed batch rolls back and is retried whole, and later batches wait, because the
cursor hasn't moved. The worker records the failure and releases the job for a backoff of 2s,
doubling up to 60s. After five failures the job is `failed`, and deals already moved stay moved.

**Lost workers.** A claim is a 15s lease, renewed by every batch, and it raises the lease epoch.

- A worker that dies stops renewing. Postgres rolls back its open batch, and once the lease lapses
  another worker resumes from the cursor.
- A worker that freezes mid-batch keeps the job row locked, so nobody can claim the job, until
  Postgres ends its idle session after 15s and rolls the batch back.
- A frozen worker that wakes after a takeover fails its next fence check, and its other writes
  check the epoch too, so it changes nothing.
- A planned stop (a deploy, or a used-up time slice) finishes its batch and releases the lease at
  once.

**What "correct" means after a kill.** When the job completes:

- every deal on the list has exactly one outcome
- every moved deal was moved once, with one history row from this job, which a unique index on
  `(bulk_job_id, opportunity_id)` enforces
- no deal outside the list was touched
- deals people changed meanwhile are where they left them

It doesn't mean "identical to an uninterrupted run": people kept working during the delay, and the
job respects their edits. The kill benchmark checks all four after a SIGKILL at 31,500 of 50,000.

**What a half-applied job looks like.** Progress reads `31,500 / 50,000`, and health goes from
`slow` (no batch for 2s, lease still valid) to `stalled` (lease lapsed) to `active` after the
takeover, about 15s later. Each deal is either fully moved (stage, version, history, outcome) or
untouched, and `GET /bulk-moves/:id/items` shows which. A failed job stays visibly partial, and
running the move again finishes it, since deals already in the target stage are left out.

## 2. Idempotency

- **The key** is the `Idempotency-Key` header: a UUID the client creates once per user action, not
  per click, and resends with every retry of it. It's required (400 without it), because otherwise
  a retry can't be told apart from a second move.
- **It's stored** on the job row under `UNIQUE (workspace_id, idempotency_key)`, with a hash of the
  normalised request, in the transaction that creates the job and its list. It survives restarts
  because it's a committed row.
- **It protects** against the retry after a lost response, which the client can't resolve on its
  own:
  - same key and request: the original job comes back (202, `Idempotent-Replayed: true`) and no new
    list is taken
  - same key, different request: 422
  - two copies at once: the unique index makes the second wait, then return the first's job

  A duplicate isn't harmless: it would take a fresh list that already includes people's later
  edits, pass its version checks, and re-apply an old decision over newer ones.

- **Inside the job,** each batch applies once even when workers crash or overlap: the checkpoint
  commits with the batch, the epoch fences replaced workers, and history allows one move per deal
  per job.
- **A retry still slips through** when a client makes a new key for each retry. That duplicate
  moves nothing the first job moved, but it does move deals people changed between the two
  requests.

## 3. Concurrency on a single deal

A **manual move** is one short transaction: `SELECT … FOR UPDATE`, an `UPDATE` that bumps
`version`, and the transition row. The row lock serialises movers, so each transition records the
stage the deal really left; the concurrency test fails without it. A stale `expectedVersion` gets
409 and the current state. A same-stage move writes nothing, so it can't make a job skip the deal.

The **job** takes no lock up front. Its `UPDATE` is a compare-and-set: a deal moves only if its
version still equals the one in the list. When a person and the job hit the same deal, **the person
wins**:

- **Person first:** the version has changed, so the job skips the deal and reports it as
  `skipped_conflict`.
- **Job first:** the person's move applies on top, or gets 409 if they sent the old version.
- **Same instant:** if the batch waits on the person's row lock, Postgres re-checks the version once
  the person commits, and the job skips the deal. If the person waits on the batch, it's for
  milliseconds. A test forces this race by waiting until `pg_locks` shows the batch blocked.
- A batch waits at most 2s for a lock, then is retried later.

Overwriting would silently undo a newer human decision with one made on older information. Blocking
manual edits during a job would defeat the point of running it in the background. So manual moves
are never refused because a job is running, and skipped deals are listed so the user can rerun the
move.

## 4. Snapshot vs live

The job works on the **snapshot**: the deals that matched at the click. A **live** set would
re-check the filter as the job goes, and that is non-deterministic. The job walks deals in id
order, so a deal that starts matching mid-run is moved only if its id is still ahead of the cursor.
The total keeps changing too, so progress can't say "x of N" and the cap stops meaning anything.
The snapshot moves exactly what the user was shown, with a fixed total, an outcome for every deal,
and a resume that is just a list and a position.

The consequences:

- **Deals that join the set after the click aren't moved,** new deals included. Rerunning the move
  picks them up safely, since deals already in the target stage are left out.
- **Deals that leave the set aren't moved either:** any change bumps the version, so the job skips
  them.
- **The list is stored:** about 9 MB per 50,000-deal job, kept forever today (section 6).

## 5. Isolation, and the hole

Every workspace shares one Postgres, so isolation means limiting how much of it a job takes. To the
application a move is one column; to Postgres it's a new row version, a new entry in every index on
`opportunities`, a history row, an item update and the log writes for all of them. Unpaced, one job
moved about 47,000 deals/s and doubled every workspace's p99.

| Mechanism                                              | What it does                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Pacing at 10,000 deals/s per job                       | Each 500-deal batch gets a 50ms slot. The main lever                                                                                 |
| One running job per workspace (a partial unique index) | A tenant holds at most one worker, so the pace is also a per-workspace limit                                                         |
| Round-robin turns and 5s time slices                   | A free worker serves the workspace served longest ago, and a long job hands its worker back after 5s if another workspace is waiting |
| A separate 2-connection pool for the worker            | Users never wait for a database connection                                                                                           |
| 500-deal batches and a 2s lock timeout                 | A person waits milliseconds behind a batch; a batch blocked by a person gives way                                                    |

**Measured** at 200 requests/s per workspace: with paced jobs running, p99 was 4.5ms in the job's
workspace and 4.3ms in another, against 4.1–4.6ms with no job. Unpaced, it was 7.1 and 9.0ms.

**The hole** is that the database is still shared:

- Checkpoints, vacuum and log flushes are database-wide, and no per-job limit controls them. Even
  paced, single requests reached 36ms during jobs and 91ms just after.
- The limit is per job, so N workers running N tenants' jobs add up.
- The pace is fixed: it doesn't back off when the database is busy for other reasons.

Real isolation needs separate databases, with the largest tenants on shards of their own. Adaptive
pacing would narrow the hole on one database.

## 6. What breaks at 10×

That is a 500,000-deal move in a workspace of 20M deals. The job's own mechanics hold: a batch
still reads 500 entries through `(job_id, seq)`, a resume loses at most one batch, and progress and
idempotency touch one row. What gives way is the work around them. Measured on the 500k seed and
extrapolated, not yet measured at 20M:

|                                | Measured                       | At 10×                                              |
| ------------------------------ | ------------------------------ | --------------------------------------------------- |
| Deals table, with indexes      | 263 bytes per deal             | 20M deals ≈ 5.3 GB, against a 160 MB Postgres cache |
| The list and its history       | 189 + 180 bytes per deal moved | ≈ 185 MB per job, never deleted                     |
| Write-ahead log                | 1,234 bytes per deal moved     | ≈ 600 MB per job, with a checkpoint every ~1 GB     |
| Submission, including the list | 0.16–0.2s for 50,000 deals     | ≈ 2s just to write 500,000 items                    |
| A narrow filter with no index  | ≈ 30ms across 500k deals       | ≈ 1s across 20M in memory, more from disk           |

**The first thing to fail is submission.** The list is built inside the POST, in one statement,
under the API's 5s statement timeout, on one of its 10 connections. At 10× that statement scans up
to 20M deals and writes 500,000 rows: about 3–5s in memory, more once the table no longer fits. The
request times out and no job is created. It's the only step whose cost grows with the job while it
runs under a hard limit, and even before it fails, a few large submissions at once would tie up the
pool that interactive requests use.

**The fix:** build the list in the worker. The API saves the job as `preparing` and returns at
once; the worker fills the list in chunks of about 10,000 ids, with no request timeout, and
progress reports it. The list then takes seconds to build rather than an instant, which the
version check makes safe. Then measure whether an index on owner is worth the extra write it adds
to every move.

**What degrades next:**

1. **The fixed pace.** Once the table no longer fits in memory, every batch reads from disk and
   10,000 deals/s costs everyone more. → Adaptive pacing.
2. **Checkpoints.** About one forced checkpoint per job, so more latency spikes in every workspace.
   → A larger `max_wal_size`.
3. **Vacuum.** Each job leaves 500,000 dead row versions. At the default 20% threshold, autovacuum
   makes one long pass over 5 GB every eight jobs. → Per-table autovacuum at about 1%, in small
   passes.
4. **Growth.** About 185 MB of list and history per job, forever. → Delete a finished job's `moved`
   items, since history records them, and partition history by month.
5. **Queueing.** A job now takes about 50s, and a workspace runs one at a time.

## 7. Another week, ranked

1. **Four small fixes found while writing this.**
   - After the fifth failure, a job waits out one more backoff, showing "attempt 6 of 5", before
     it's marked failed.
   - The lease is renewed from the batch's start time, so a batch that commits more than 15s after
     it started can be taken over needlessly. `clock_timestamp()` fixes it.
   - A job handed back on shutdown, or after a retry wait, is described as "paused to give another
     workspace a turn".
   - `stuck` is judged by whether any worker holds a lease, which idle workers don't; a worker
     heartbeat would make it exact.
2. **Build the list in the worker** (section 6).
3. **Cancel, then undo.** Cancelling at a batch boundary is safe thanks to the fence. Undo is a
   reverse job built from each item's `from_stage`, with the same person-wins check.
4. **Adaptive pacing.** Halve the rate when batches slow down, raise it gently while they're
   healthy, and keep it in the checkpoint so it survives a takeover.
5. **Retention.** Delete finished jobs' `moved` items, and partition history by month.
6. **Poison batches.** A batch that always fails stops the whole job. Split it until the bad deal is
   isolated, mark that one failed, and carry on.
7. **Faster start and takeover.** `LISTEN/NOTIFY` removes the ~1s polling delay before a job
   starts, and a shorter lease shortens the 15s takeover.
8. **Measure with several workers and API processes, and at 20M deals.** Every number here comes
   from one of each, on one machine.
