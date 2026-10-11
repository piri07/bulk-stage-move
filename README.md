# Bulk Stage Move

A slice of a CRM's opportunities (deals) service, built around one hard operation: moving up to
50,000 deals to another stage as a background job that is idempotent, resumable and polite to
everything else running. [DESIGN.md](DESIGN.md) has the reasoning.

**Status:**

- Part 1, the CRM foundation, is done.
- Part 2, the bulk engine, is done:
  - idempotent submission
  - the resumable Postgres worker
  - pacing and fairness between workspaces
  - a rate-limited progress endpoint that tells slow, stuck and failed apart
  - benchmarks ([BENCHMARKS.md](BENCHMARKS.md))

## Run it

The only requirement is Docker with Compose v2.

```bash
docker compose up --build
```

That one command:

1. starts Postgres 17
2. applies the migrations
3. seeds a small dataset
4. runs the test suite once (see the `test-1` lines in the output)
5. serves the API on http://localhost:3000
6. starts the bulk-move worker, a separate process that runs submitted jobs

```bash
curl localhost:3000/health    # {"status":"ok","db":"ok"}
```

`make down` stops everything and deletes the database volume. `make help` lists the other targets.

## Seed data

| Workspace    | Id                                           | Deals `--small` | Deals `--full`   |
| ------------ | -------------------------------------------- | --------------- | ---------------- |
| Large Co     | `00000000-0000-4000-8000-000000000001`       | 25,000          | 500,000          |
| Small Co 1–5 | `00000000-0000-4000-8000-000000000002` … `6` | 500 each        | 2,000–4,000 each |

- `make seed`: the small dataset (what `up` runs). Workspaces that already exist are skipped.
- `make seed-full`: wipes everything and seeds the full dataset. Takes about 5s on an M4.

Deals spread unevenly over 12 stages (18% in `new_lead` down to 2% in `verbal_commit`) and were
created over the 18 months before 2026-10-01. The seed is deterministic: a fixed random seed and a
fixed time anchor give identical rows on every run.

## Tests

```bash
make test                          # in a container
make db && npm ci && npm test      # or on the host (Node >= 22.12)
```

The tests run against real Postgres, in a `crm_test` database that is dropped and re-migrated at
the start of every run. Each test creates its own workspace, so nothing needs truncating. Coverage
is concentrated where behaviour is subtle:

- tenant isolation
- input validation
- keyset paging
- the stage-move rules: transition plus version bump, same-stage no-op, and 409 on a stale
  `expectedVersion`
- a deal's stage history, read oldest first and page by page
- 10 concurrent moves of one deal. They must leave an unbroken transition chain, so this test
  fails if the row lock is removed.
- bulk submission: the snapshot, every filter criterion, the 50,000 cap, and idempotency (repeated
  keys, a key reused for a different request, and a duplicate arriving while the original is
  still in flight)
- the worker: every deal moved exactly once; deals a person moved after the click are skipped,
  including when that move commits while a batch waits for the row; resuming after a crash
  mid-batch; refusing writes from a replaced worker; one running job per workspace; retries,
  graceful handover and giving up
- isolation: the speed limit, round-robin turns between workspaces, and a long job handed back
  after its time slice so another workspace's job runs
- the database pool surviving Postgres closing its connections
- progress: every health state (unit tests on the rules, plus a real job followed from queued to
  active to stalled to completed), a finished job's rate staying fixed, and the per-job poll limit

Each safety mechanism was checked by removing it: the version check, the lease-epoch fence, the
idempotency unique constraint, the pool's error handler, pacing, round-robin turns, time slicing
and the poll limit. Every removal makes its test fail.

## Benchmarks

```bash
make bench
```

This runs every benchmark, each from a fresh full seed, in about six minutes, and saves the raw
output to `bench/results/`:

1. a bulk move of 50,000 deals, paced and unpaced
2. users' latency in the same and in another workspace while bulk jobs run
3. a worker killed at 30,000 of 50,000 and resumed, with a correctness proof

[BENCHMARKS.md](BENCHMARKS.md) has the numbers, the hardware and the method. Each benchmark also
runs on its own: `docker compose run --rm bench node dist/bench/throughput.js`,
`docker compose run --rm bench node dist/bench/isolation.js --rate 200 --seconds 15 --rounds 2`,
and `make bench-kill-resume`.

## API

The `/opportunities` and `/bulk-moves` routes require an `X-Workspace-Id` header containing a
UUID. There is no auth.

| Method  | Path                                            | Body / notes                                                                 |
| ------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET`   | `/health`                                       | liveness and a database ping (503 if unreachable)                            |
| `GET`   | `/stages`                                       | the fixed pipeline, in order                                                 |
| `POST`  | `/opportunities`                                | `{ name, valueCents, ownerId, stage?, status? }`                             |
| `GET`   | `/opportunities?stage=&limit=&cursor=`          | one page of a stage; pass `nextCursor` back as `cursor`                      |
| `GET`   | `/opportunities/:id`                            |                                                                              |
| `GET`   | `/opportunities/:id/transitions?limit=&cursor=` | the deal's stage history, oldest first, paged like the list                  |
| `PATCH` | `/opportunities/:id/stage`                      | `{ stage, expectedVersion? }`; 409 if the version is stale                   |
| `POST`  | `/bulk-moves`                                   | `{ filter, targetStage }` plus an `Idempotency-Key` header; 202 with the job |
| `GET`   | `/bulk-moves/:id`                               | the job: status, total, processed, moved, skipped                            |
| `GET`   | `/bulk-moves/:id/progress`                      | the one to poll: health, detail, counts, rate, ETA, `pollAfterMs`            |
| `GET`   | `/bulk-moves/:id/items?outcome=&limit=&cursor=` | the job's deals and what happened to each                                    |

A bulk move's `filter` takes any combination of these criteria; `{}` means the whole workspace:

- `stages`, `ownerIds` and `statuses` are lists, and a deal matches any value in a list.
- `minValueCents` and `maxValueCents` are inclusive.
- `createdFrom` is inclusive and `createdTo` is exclusive.

Deals already in the target stage are left out. A filter matching more than 50,000 deals is a 422. A repeated `Idempotency-Key` returns the original job with an `Idempotent-Replayed: true`
header, while the same key with a different request is a 422.

**Progress** reports a job's `health`, always with a plain-language `detail`:

| `health`    | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `queued`    | waiting for a worker (and why)                                    |
| `active`    | moving                                                            |
| `slow`      | its worker holds it, but no batch has committed for 2s or more    |
| `retrying`  | a batch failed; it shows when the next attempt is due             |
| `stalled`   | its worker stopped; another will take over                        |
| `stuck`     | waiting or stalled for a long time with no worker active anywhere |
| `failed`    | gave up; the error, and how far it got                            |
| `completed` | done                                                              |

A job's state can be read once every 2 seconds, whoever asks. A faster poll gets `429` with
`Retry-After`, and the limit is shared by `/bulk-moves/:id` and `/bulk-moves/:id/progress`.

```bash
WS=00000000-0000-4000-8000-000000000002   # Small Co 1
curl -s "localhost:3000/opportunities?stage=qualified&limit=2" -H "x-workspace-id: $WS"

ID=$(curl -s "localhost:3000/opportunities?stage=qualified&limit=1" -H "x-workspace-id: $WS" | jq '.items[0].id')
curl -s -X PATCH "localhost:3000/opportunities/$ID/stage" -H "x-workspace-id: $WS" \
  -H 'content-type: application/json' -d '{"stage":"proposal_sent"}'

curl -s "localhost:3000/opportunities/$ID/transitions" -H "x-workspace-id: $WS"

# Bulk move: every qualified deal to proposal_sent, then watch the job.
JOB=$(curl -s -X POST localhost:3000/bulk-moves -H "x-workspace-id: $WS" \
  -H "idempotency-key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"filter":{"stages":["qualified"]},"targetStage":"proposal_sent"}' | jq .id)
curl -s "localhost:3000/bulk-moves/$JOB" -H "x-workspace-id: $WS"
curl -s "localhost:3000/bulk-moves/$JOB/items?outcome=skipped_conflict" -H "x-workspace-id: $WS"
```

## Configuration

| Variable                      | Default                                      | Notes                                                     |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| `PORT`                        | `3000`                                       |                                                           |
| `DATABASE_URL`                | `postgres://crm:crm@localhost:5433/crm`      |                                                           |
| `DB_POOL_MAX`                 | `10`                                         |                                                           |
| `DB_STATEMENT_TIMEOUT_MS`     | `5000`                                       | `0` disables it                                           |
| `TEST_DATABASE_URL`           | `postgres://crm:crm@localhost:5433/crm_test` | must end in `_test`: it is dropped every run              |
| `BULK_MAX_DEALS`              | `50000`                                      | the most deals one bulk move may cover                    |
| `BULK_POLL_INTERVAL_MS`       | `2000`                                       | a job's state can be read once per interval               |
| `WORKER_BATCH_SIZE`           | `500`                                        | deals per batch (one transaction)                         |
| `WORKER_LEASE_MS`             | `15000`                                      | how soon a dead worker's job is taken over                |
| `WORKER_POLL_MS`              | `1000`                                       | how often an idle worker looks for a job                  |
| `WORKER_MAX_ATTEMPTS`         | `5`                                          | failed runs before a job is marked failed                 |
| `WORKER_RETRY_BACKOFF_MS`     | `2000`                                       | first retry delay; doubles each failure                   |
| `WORKER_LOCK_TIMEOUT_MS`      | `2000`                                       | how long a batch waits for a row lock                     |
| `WORKER_MAX_DEALS_PER_SECOND` | `10000`                                      | speed limit per job (and so per workspace); `0` = unpaced |
| `WORKER_SLICE_MS`             | `5000`                                       | time slice while other workspaces wait; `0` = no slicing  |
| `WORKER_ID`                   | `hostname:pid`                               | shown as the job's lease owner                            |

Compose publishes Postgres on host port 5433 (`PG_PORT`) and the API on 3000 (`API_PORT`).

## What is and isn't implemented

**Done:** the CRM foundation (Part 1):

- create a deal, get a deal, and list a stage with keyset pagination
- single stage move with a row lock, optimistic `version`, and a recorded transition
- each deal's stage history, readable through the API
- workspace scoping
- migrations and the deterministic seeder
- tests
- the one-command compose setup

**Done:** the bulk stage move (Part 2) so far:

- submission with an idempotency key, a hash of the request and a 50,000-deal cap, creating the
  job and its snapshot in one transaction
- a separate worker process that claims jobs with `FOR UPDATE SKIP LOCKED` and holds a lease
  fenced by an epoch
- each batch's moves, outcomes and checkpoint committed in one transaction
- the "person wins" version check
- one running job per workspace
- retries with backoff, graceful handover on `SIGTERM`, and giving up after repeated failures
- a job's status and its per-deal outcomes, readable through the API
- a progress endpoint with derived health (slow, stuck and failed told apart), throughput and
  ETA, limited to one read per job every 2 seconds
- isolation:
  - a separate connection pool for the worker
  - pacing at 10,000 deals/s per job (and so per workspace)
  - round-robin turns between workspaces
  - time slicing, so a long job hands its worker back while other workspaces wait

**Measured:** [BENCHMARKS.md](BENCHMARKS.md), reproducible with `make bench`.

**Deliberately not built:** rules on the transition sequence. Any stage can move to any other,
including backwards and reopening closed deals; see DESIGN.md, assumption 2.

**Out of scope by the brief:** auth, any UI, board views and rollups, custom fields,
automation events, deployment.

## Layout

```
src/crm/        pipeline (stages), opportunities controller / service / repository, DTOs
src/bulk/       bulk-move submission: idempotency, filter, snapshot, job and item reads
src/worker/     the worker process: claiming, leases, batches and checkpoints
src/common/     workspace guard, id pipe, pagination
src/db/         pool, migration runner, transaction helper, pg error helpers
src/scripts/    seed
src/bench/      load generator: interactive latency with and without bulk jobs
migrations/     plain SQL, applied in filename order
test/           end-to-end tests against Postgres
docs/           challenges.md: problems hit while building this, and how each was solved
```

The stack is NestJS 11 on Node 22 with TypeScript 6.0, and PostgreSQL 17 is the only datastore.
NestJS 12 is ESM-only, and TypeScript 7 isn't supported by ts-jest or typescript-eslint yet, so
this is the newest combination the test and lint tools support.
