# Design

This document grows with the code. The bulk stage move is the point of the exercise: its decisions
are recorded below as they are made, and its mechanics (chunking, the cursor, idempotency,
isolation) follow as they are built. The CRM foundation it builds on comes last.

## Assumptions

1. **One pipeline, shared by every workspace.** The brief gives each workspace its own ordered
   stages; I fixed a single 12-stage pipeline instead (the 500k seed needs 12 stages).
   - Stages are defined once in `src/crm/pipeline.ts` and mirrored by the Postgres enum
     `opportunity_stage`. A test fails if the two drift apart.
   - Per-workspace pipelines would need a `stages(workspace_id, id, position)` table, with a
     composite foreign key `(workspace_id, stage_id)` replacing the enum.
   - The bulk engine only ever writes a stage value, so it would not change.
2. **No rules on the transition sequence: any stage can move to any other.**
   - Forward moves, backward moves and skipped stages are all allowed (`new_lead → negotiation`,
     `proposal_sent → contacted`), and so is reopening a closed deal (`closed_won → new_lead`).
   - The only special case is moving a deal to the stage it is already in, which is a no-op.
   - This is deliberate. The brief defines no sequence, and real pipelines are often worked out
     of order.
   - The bulk engine applies moves in set-based SQL, so every rule would also need a SQL version
     of the TypeScript check. With no rules, there is nothing to keep in sync.
   - To add rules later, define the allowed `(from, to)` pairs once, for example in an
     `allowed_transitions` table. The single move would reject a forbidden move with 422. The
     bulk job would filter on the same table in its `UPDATE … WHERE` and report those deals as
     skipped.
3. **Stage and status are independent.** Moving a deal to `closed_won` does not set
   `status = won`. That would be downstream automation, which the brief rules out. The seed keeps
   stage and status consistent anyway.
4. **Money is integer cents** (`value_cents bigint`) in a single currency. The API caps it at
   10^15, well inside 2^53.
5. **Owners are opaque UUIDs.** There is no users table.
6. **Deals are never deleted.** Nothing in scope removes one.
7. **Tenancy comes from the `X-Workspace-Id` header**, with no auth, as the brief allows.

## Bulk stage move

A user picks a filter (stage, owner, status, value range, date range) and a target stage, and
moves up to 50,000 matching deals in one action. The API answers at once with a job id, a
background worker does the moving, and the user polls for progress.

### Which deals: the snapshot, not the live set

When the user clicks, the filter matches a set of deals. The job then takes a while, and meanwhile
people keep editing: some deals start matching the filter, others stop. The job works on the
**snapshot**: the deals that matched at the moment of the click, frozen into a list.

The alternative, the **live set**, re-evaluates the filter as the job goes. That makes the job
non-deterministic:

- It walks the deals in id order. A deal that starts matching mid-job is moved only if its id
  happens to be ahead of the job's position, so two identical runs can produce different results.
- The total keeps changing, so progress can't honestly be shown as "x of N", and the 50,000 cap
  stops meaning anything.

The snapshot gives:

- exactly the deals the user was shown ("12,345 deals will be moved"), no more and no fewer
- a fixed total, so progress is honest and the cap is checked once, at submission
- an auditable result: every deal on the list ends with a recorded outcome
- a simple resume after a crash: a list, plus a position in it

The consequences, accepted:

- A deal that starts matching after the click is not moved. Running the same move again picks it
  up. That is safe, because deals already in the target stage are not selected.
- The list has to be stored: about 50,000 small rows per job.

### Collisions: the person always wins

While the job runs, people keep moving deals by hand, including deals on the job's list.
Permissions (RBAC) would make this rarer but not impossible: the deal's owner and the manager
running the job are both allowed to move it. RBAC decides _who may_ edit a deal, not _what
happens_ when two permitted people edit it at the same time. (Auth is out of scope here anyway.)

An example:

- **10:00** A manager starts "move Alice's `negotiation` deals → `contract_sent`". Deal X is on
  the list.
- **10:01** The customer signs, and Alice marks deal X `closed_won`.
- **10:02** The job reaches deal X.

| Option                                    | Deal X ends up                                  | Why not                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The job overwrites                        | `contract_sent`: Alice's win is silently undone | A lost update. A decision made on 10:00 information erases a 10:01 decision, and nobody is told.                                                                                                          |
| Block manual edits until the job finishes | Alice's 10:01 move is rejected                  | It defeats the purpose: if people must wait anyway, the job might as well be a loop. It also means errors for the whole run, locks left behind if a worker dies, and an extra check on every manual move. |
| **The person wins** (chosen)              | `closed_won`; the job skips X and reports it    |                                                                                                                                                                                                           |

How it works:

- When the list is taken, each deal's `version` is recorded with it.
- The job moves a deal only if its `version` is still the same. The check happens inside the same
  `UPDATE` that moves the deal (a compare-and-set), so nothing can slip in between checking and
  writing.
- If a person moved the deal after the click, its version has changed. The job skips it and
  records it as skipped because of a newer manual change. The user sees those deals in the job's
  result, and can run the move again if they still want them moved.
- If the job moves a deal first and a person moves it afterwards, the person's move simply applies
  on top. In either order, the deal ends where the person put it.
- Manual moves are never rejected because a job is running.
- A same-stage click doesn't bump the version (see "Single move" below), so it can't make the job
  skip a deal for no reason.

### Idempotency: one request, one job

A bulk move changes more than stages. Each move writes a history row, bumps the deal's version and
adds to the job's counters. A duplicate therefore leaves double history, wrong counts and twice the
database load. Worse, a retry usually arrives _later_, after people have changed things, so it
re-applies an old intent on top of newer decisions.

The version check can't catch that on its own. A duplicate job takes a fresh snapshot, which
already includes the changes people made in between, so its version checks pass. Take the Alice
example again: the manager's request at 10:00 loses its response, Alice wins deal X at 10:03, and
the client retries at 10:05. Without dedupe, the retry's new job moves X back. Only recognising
the request stops that.

- The client sends an `Idempotency-Key` header: a UUID created when the user clicks, and reused by
  every retry of that click. A request without one is rejected with 400, because without it a
  retry can't be told apart from a deliberate second move.
- The key is stored on the job row, under `UNIQUE (workspace_id, idempotency_key)`, in the same
  transaction that creates the job and its snapshot. The job and its key exist together or not at
  all, and the key survives restarts because it is a committed Postgres row.
- **Seen key, same request** (compared by a hash of the filter and target stage): the existing job
  is returned and nothing new is created.
- **Seen key, different request:** rejected with 422. That is a client bug, and the server won't
  guess which request was meant.
- **Two copies at the same instant:** the unique constraint lets one insert win. The other waits
  for it, then returns the winning job.

Where a retry can still slip through:

- A client that makes a new key for every retry. Each retry then looks like a new click.
- Two genuine clicks have two keys and run as two jobs. That is by design: the second click is a
  newer decision.

The other half of idempotency, applying each batch exactly once even when a worker crashes or two
workers collide, belongs to the batch mechanics described with the worker.

### The job queue is a Postgres table, not Redis or BullMQ

The `bulk_jobs` table _is_ the queue:

- Workers claim a job with `FOR UPDATE SKIP LOCKED`, so two workers asking at once never get the
  same job.
- A claim is a lease, renewed after every batch. If a worker dies, its lease expires and another
  worker takes the job over. A lease epoch that rises on every takeover fences off a stalled
  worker that wakes up late: its writes are rejected.
- Each batch moves its deals and saves the job's position and counters in one transaction.

Why not BullMQ on Redis:

1. **It doesn't give us resume.** BullMQ sees a 50,000-deal job as one unit. If the worker dies
   at 30,000, the job is redelivered whole and starts again from zero. Resuming mid-job needs a
   checkpoint committed _together with_ the deal updates, which only a Postgres transaction can
   do. A checkpoint kept in Redis either repeats a batch or skips it, depending on which of the two
   writes a crash interrupts.
2. **Creating a job would be two writes to two stores**: the snapshot and key in Postgres, and the
   message in Redis. A crash between them leaves a job that never runs, or a message with no
   snapshot behind it.
3. **It can deliver a job twice anyway.** A worker frozen past its lock (a long garbage-collection
   pause, say) has its job handed to another worker. The duplicate protection has to live in
   Postgres regardless.
4. **Dedupe and progress would be only as durable as Redis's configuration.** Redis can lose its
   most recent writes in a crash, and BullMQ needs key eviction disabled. In Postgres they are
   committed rows.
5. **Per-tenant limits aren't built in.** Open-source BullMQ limits concurrency per worker or per
   queue. "One running job per workspace" needs BullMQ Pro's groups, a queue per workspace, or
   custom locks. In Postgres it is one partial unique index.
6. **It is one more service** to run, size, persist and monitor, and the brief asks for every
   addition to be justified.

What we give up:

- Millisecond dispatch. That doesn't matter for jobs that run for tens of seconds; workers poll
  once a second.
- Built-in retries, replaced by an `attempts` column and lease expiry.
- A ready-made dashboard, replaced by the progress endpoint, which reads the true state.

A Redis queue is the right tool for large numbers of small, independent tasks that are safe to
retry on their own and don't commit together with database rows, such as emails and webhooks.
Bulk stage moves are the opposite: few, heavy jobs whose progress is database data. At larger
scale the queue isn't what breaks first. If dispatching ever did become a bottleneck, a broker
could carry the "work on job X" signal while the job's state stays in Postgres.

### Isolation: polite to everything else

The brief: a bulk move must not starve interactive requests in its own workspace, and must not
affect other workspaces at all. Every workspace shares one Postgres, so the real question is how
much of that database one job may take.

**Why the rate matters, even though a move is "just one column".** The application does almost
nothing per deal, but Postgres does a lot:

- It writes a new version of the deal row, since it never updates a row in place.
- It adds new entries to every index on `opportunities`. `stage` is indexed, so the update can't
  take Postgres's cheap in-place (HOT) path.
- It inserts a history row, with its own index entries.
- It updates the item's outcome.
- It writes all of the above to the write-ahead log and flushes it at commit.
- Later, autovacuum has to clean up the dead row versions.

Unpaced, a job moved about 30,000 deals/s, which is well over 100,000 physical writes a second.

**What I measured.** The setup:

- An open-loop load generator at 200 requests/s per workspace.
- A traffic mix of 60% listing a stage, 20% reading a deal and 20% moving a deal by hand.
- Rounds that alternate which condition runs first.

Full numbers are in BENCHMARKS.md.

|                                      | Unpaced job                    | Paced at 10,000 deals/s                          |
| ------------------------------------ | ------------------------------ | ------------------------------------------------ |
| Bulk throughput                      | ~23,500 deals/s (50k job ≈ 2s) | ~8,000 deals/s incl. submit and polling (≈ 5–6s) |
| Users' p99 during jobs (worst round) | 21ms                           | 9ms                                              |
| Users' p99 just after jobs           | 43–45ms                        | 11–14ms                                          |
| Users' p99 with no job (baseline)    | 4–6ms                          | 5–6ms                                            |
| Worst single request                 | 58–124ms                       | 37–112ms                                         |

Both workspaces moved together: Small Co, which had no job running, suffered as much as Large
Co. At 100 requests/s per workspace there was no measurable effect at all. The damage appears only
once the database has less headroom, and it's in the tail (p99 and the worst requests), not the
median.

**The mechanisms, and what each one costs:**

| Mechanism                                              | What it protects                                                                                             | Trade-off                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 50,000-deal cap per job                                | Bounds one job's size                                                                                        | Doesn't bound its intensity. A broader filter is rejected rather than split automatically           |
| A separate pool for the worker (2 connections)         | Users never wait for a free connection                                                                       | Isolates connections only. CPU, disk, the write-ahead log, the cache and row locks are still shared |
| One running job per workspace (a partial unique index) | One tenant never holds more than one worker. With one multi-row writer per workspace, deadlocks can't happen | A tenant's jobs run one after another, with no parallelism inside a tenant                          |
| Pacing at 10,000 deals/s per job                       | Spreads writes out: p99 impact roughly halved, the after-effect about 3× smaller                             | A 50k job takes about 5s instead of 2s                                                              |
| Batches of 500, and a 2s lock timeout                  | A user editing a deal in a batch waits milliseconds. A job blocked by a user's lock gives way and retries    | More transactions than larger batches would need                                                    |

**Concurrency versus rate.**

- Limiting how many jobs run at once barely helps on its own: a single unpaced job saturated the
  database's write path by itself.
- The rate is the lever that matters.
- Concurrency (one job per workspace, a fixed number of workers) only bounds the total, to at most
  workers × 10,000 deals/s.

**Why 10,000 deals/s.** I measured the two ends first:

- Full speed hurt users' tail latency in every workspace.
- At 10,000/s, p99 during a job stayed within a few milliseconds of normal, and a 50k job still
  finishes in about five seconds.

A lower limit would cut the impact further, at the cost of slower jobs. The limit is one
environment variable, `WORKER_MAX_DEALS_PER_SECOND`.

**Considered and not built:**

- **Adaptive slow-down.** Back off when the database gets slower, whoever's load is causing it.
  Jobs would then run faster when the database is quiet and slower when it's busy, instead of at a
  fixed rate. Today's limit is a timer, not a measurement: a 500-deal batch is allowed one 50ms
  window, and the worker sleeps whatever the batch didn't use. The adaptive version would work like
  TCP congestion control:
  1. Measure each batch's duration, smoothed over the last few batches.
  2. Halve the current speed when a batch runs slower than a target (say 50ms against a normal
     15ms), down to a floor.
  3. Raise it a little after every healthy batch, up to the 10,000/s ceiling.

  The current speed would be saved on the job row inside the checkpoint that already runs for
  every batch, so it costs no extra query. A resumed or handed-back job would then keep the speed
  it had learned, and the progress endpoint could report "throttled to 3,000/s because the database
  is busy". Its limits: batch time is a noisy proxy for users' latency, and checkpoint and vacuum
  spikes arrive after the writes that cause them, so it would shorten them rather than prevent
  them. A fixed limit is simpler to reason about and to measure, so adaptive pacing is on the "next
  week" list.

- **A global rate limit across all workers.** An exact total budget would need coordination
  between workers, such as a shared token bucket. The number of workers bounds the total instead.

**The hole it still leaves.**

- Every workspace still shares one database. Pacing reduces how much of it a job takes, but it
  can't bring the effect on other workspaces to zero.
- Even paced, single requests occasionally took 37–112ms during or after a job. That comes from
  database-wide work such as checkpoints and vacuum, which no per-job limit controls.
- N workers running N tenants' jobs add up.

Real isolation needs separate databases: shard workspaces across clusters, with the largest
tenants on shards of their own (see Scaling).

### Fairness between workspaces

Pacing decides how hard a job hits the database. Fairness decides which tenant gets a worker next.

- **Already fair:** one running job per workspace means a tenant never holds more than one
  worker. With several workers, several tenants always progress side by side.
- **The gap:** when every worker was busy, the next job was simply the oldest one. Take one
  worker, where A queues ten jobs and then B queues one. B waited behind A's entire backlog,
  because A's queued jobs are always older.

Two mechanisms close the gap, and they only work together:

1. **Round-robin turns.** `bulk_workspace_turns` records when each workspace last got a worker. A
   free worker takes the next job from the workspace whose turn came longest ago (never served
   goes first), oldest job first within that workspace. The turn is recorded in the same
   statement as the claim. One worker now runs A1, B1, A2, … instead of A1, A2, … A10, B1.
2. **Time slicing.** After `WORKER_SLICE_MS` (5s), if another workspace's job is waiting, a worker
   hands its job back. The job resumes later from its cursor, and the hand-back doesn't count as a
   failure. A job running alone is never interrupted.

Why both are needed:

- **Without round-robin, slicing achieves nothing.** The handed-back job is still the oldest, so
  it is claimed straight back. Removing round-robin made the slicing test fail too.
- **Without slicing, round-robin acts only when a job ends**, so one long job still holds its
  worker.

A live check, with one worker and a 1s slice:

1. A Large Co job of 50,000 deals was handed back at 9,500.
2. A 179-deal Small Co job ran within about a second, instead of waiting the ~5 seconds the
   Large Co job needed.
3. Large Co then resumed and finished, with every deal moved once.

Trade-offs:

- **Slice length.** A shorter slice is fairer, but means more hand-backs and claims. At 5s the
  overhead is negligible, and no tenant waits behind any one job for more than one slice plus a
  batch.
- **Turns are counted, not timed.** Each claim is one turn, however long it runs. A workspace
  whose turns are 5-second slices and one whose jobs finish in 0.1s get the same number of turns,
  not the same worker time. The slice caps the imbalance per round. Weighted fair queuing would
  account for time used, which isn't worth its complexity at this scale.
- **A handed-back job may continue on another worker.** That's harmless: every batch is fenced by
  the lease epoch and resumes from the committed cursor.

### Scaling

One rule decides the architecture at every size: a job's progress must be committed together
with the deal updates it describes, so the job lives in the same database as the deals. Whatever
hands out the work, the work itself is writes to that database. So scaling means making each move
cheaper, then adding databases. The queue design doesn't change.

"1 billion stage changes" is not one job; jobs stay at 50,000 deals (500,000 in the 10× case). It
is the total across all tenants, and the period decides everything:

| 1B changes per | Average rate                    | One Postgres server? |
| -------------- | ------------------------------- | -------------------- |
| year           | ~32/s                           | Easily               |
| month          | ~385/s                          | Yes, if well sized   |
| day            | ~11,600/s, with peaks ~35–60k/s | No                   |

The order to scale in, cheapest first:

1. **Measure** the per-server ceiling (BENCHMARKS.md).
2. **Make each move cheaper.** Use larger batches written in one statement, and keep the fewest
   indexes possible on `opportunities`, since a stage change rewrites every one of them. Tune
   autovacuum for the busy tables.
3. **Use a bigger server.**
4. **Partition** `stage_transitions` by month and `bulk_job_items` by day. Old partitions are
   dropped or archived instead of being deleted row by row.
5. **Add read replicas** for read traffic, and use change-data-capture for downstream systems
   (see below).
6. **Shard by workspace**, putting the largest tenants on shards of their own.
7. **Possibly move to distributed SQL** (CockroachDB, YugabyteDB, Spanner). It shards
   automatically, at the price of slower writes and new trade-offs.

**Sharding by workspace:**

- A directory maps each workspace to a shard. Every shard has the full schema, including its own
  `bulk_jobs` and `bulk_job_items` tables, and its own pool of workers.
- A bulk move never leaves its workspace, and a workspace never spans shards. So creating a job,
  running each batch and reading progress are all single-shard transactions. Idempotency keys,
  batch checkpoints, the version check and "one running job per workspace" keep working unchanged,
  with no distributed transactions.
- The code change is small: the API picks a connection pool by workspace, and each worker is
  started for one shard.
- Isolation improves: a large tenant's jobs load only its own shard.
- To move a workspace to another shard:
  1. Stop new jobs for it.
  2. Pause its running jobs at a batch boundary.
  3. Copy its data with logical replication.
  4. Switch the directory entry.
  5. Resume the jobs on the new shard. A paused job's cursor is just a row, so it travels with the
     workspace.
- Sharding has limits. It can't make one tenant faster than its shard allows. A single job far
  beyond the cap (say, 100M deals) would need a different approach: splitting one job across
  workers, or an offline migration.

**Kafka stays out of the write path.** Downstream systems such as analytics, automation and search
should learn about stage changes through change-data-capture:

- A tool such as Debezium reads committed rows from Postgres's write-ahead log and publishes them
  to Kafka. `stage_transitions` already has one row per move.
- Only committed changes get published.
- Nothing is lost when the reader restarts: it resumes from its position in the log.
- The CRM's requests never wait on Kafka.
- At scale, it also takes polling load off the database.

The alternative, having the app write to both Postgres and Kafka, loses or invents events whenever
a crash falls between the two writes. All of this is out of scope here, since the brief rules out
downstream consumers.

The brief's own 10× case (a 500,000-deal move in a workspace of 20M deals, and what fails first)
will be answered with measurements once the job is built.

## CRM foundation

### Tenancy

- Every query carries `workspace_id`.
- Another tenant's deal returns 404 rather than 403, so its existence doesn't leak.
- The guard validates the header's format but does not look the workspace up:
  - For reads, filtering by `workspace_id` simply returns nothing for an unknown workspace.
  - For creates, the foreign key rejects it, and the API maps that to 404.
  - This keeps a round trip off every interactive request, which matters once we measure their
    p99 latency during a bulk job.

### Single move

The move is one short transaction:

1. `SELECT … FOR UPDATE` locks the row.
2. Check the preconditions.
3. `UPDATE … version = version + 1`.
4. Insert the transition.

The details:

- **The row lock serialises concurrent movers**, so each transition records the stage the deal
  really left. Without it, two movers can both read stage A and both log `A → x`. The concurrency
  test fails in 5 of 5 runs when `FOR UPDATE` is removed.
- **`version` is the optimistic-concurrency token.**
  - A client may send `expectedVersion`. A mismatch returns 409 with the current state, and nothing
    is written.
  - The version check runs before the no-op check, so a client with stale data is told so even if
    the deal happens to be where it wanted.
- **A same-stage move writes nothing**: no transition and no version bump. The bulk job will
  compare-and-set on `version`, so a bump without a change would make it skip that deal for no
  reason.
- **Timestamps use `clock_timestamp()`.** `now()` returns the transaction's start time. For a mover
  that queued on the row lock, that can be earlier than the write it waited behind, so ordering
  history by time could contradict ordering it by id.

### Pagination

- Keyset pagination on `(workspace_id, stage, id)`: `id > cursor ORDER BY id LIMIT n + 1`.
- Cost doesn't grow with depth: pages at `id > 250000` in the 500k workspace run in under 0.1ms.
- Deals entering or leaving the stage between requests don't shift later pages, as they would with
  `OFFSET`.
- The extra row tells us whether another page exists, without a `COUNT`.
- A deal's history (`GET /opportunities/:id/transitions`) uses the same contract on
  `stage_transitions(opportunity_id, id)`. It is ordered by `id` rather than by time because id
  order is the order the row lock granted the moves. A deal outside the caller's workspace returns
  404, not an empty history.
- There is deliberately no workspace-wide history feed. It would need another index on a table
  the bulk job writes 50,000 rows to per run.

### Indexes, and why there are so few

Besides the primary keys there is only `opportunities(workspace_id, stage, id)`.

- Because `stage` is indexed, a stage change can never be a HOT update (an update Postgres can
  apply in place without touching indexes).
- So every index on the table gets a new entry on every move, and the bulk job pays for each extra
  index 50,000 times per run.
- The indexes the bulk filter needs (owner, dates) will be added with the bulk engine, and
  measured.

### Migrations

- Migrations are plain SQL files applied in filename order.
- Each file runs in one transaction together with its bookkeeping row.
- An advisory lock serialises migrators across processes, because compose can start several at
  once.
- Stages are written out in the migration instead of being generated from code. A migration is a
  snapshot and must not change when the code does; the drift test keeps them linked.

### Seed data

- There is one `INSERT … SELECT generate_series` per workspace.
- All random draws happen in a single CTE, with a fixed `setseed()` per workspace and a fixed time
  anchor (2026-10-01).
- Two runs produce byte-identical tables (checked with an md5 over the ordered rows), so benchmark
  numbers can be reproduced exactly.
- The full seed takes about 5s for 500k rows.
