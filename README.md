# Bulk Stage Move

A slice of a CRM's opportunities (deals) service, built around one hard operation: moving up to
50,000 deals to another stage as a background job that is idempotent, resumable and polite to
everything else running. [DESIGN.md](DESIGN.md) has the reasoning.

**Status:** Part 1, the CRM foundation, is done. Part 2, the bulk engine, is next.

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

## API

The `/opportunities` routes require an `X-Workspace-Id` header containing a UUID. There is no auth.

| Method  | Path                                            | Body / notes                                                |
| ------- | ----------------------------------------------- | ----------------------------------------------------------- |
| `GET`   | `/health`                                       | liveness and a database ping (503 if unreachable)           |
| `GET`   | `/stages`                                       | the fixed pipeline, in order                                |
| `POST`  | `/opportunities`                                | `{ name, valueCents, ownerId, stage?, status? }`            |
| `GET`   | `/opportunities?stage=&limit=&cursor=`          | one page of a stage; pass `nextCursor` back as `cursor`     |
| `GET`   | `/opportunities/:id`                            |                                                             |
| `GET`   | `/opportunities/:id/transitions?limit=&cursor=` | the deal's stage history, oldest first, paged like the list |
| `PATCH` | `/opportunities/:id/stage`                      | `{ stage, expectedVersion? }`; 409 if the version is stale  |

```bash
WS=00000000-0000-4000-8000-000000000002   # Small Co 1
curl -s "localhost:3000/opportunities?stage=qualified&limit=2" -H "x-workspace-id: $WS"

ID=$(curl -s "localhost:3000/opportunities?stage=qualified&limit=1" -H "x-workspace-id: $WS" | jq '.items[0].id')
curl -s -X PATCH "localhost:3000/opportunities/$ID/stage" -H "x-workspace-id: $WS" \
  -H 'content-type: application/json' -d '{"stage":"proposal_sent"}'

curl -s "localhost:3000/opportunities/$ID/transitions" -H "x-workspace-id: $WS"
```

## Configuration

| Variable                  | Default                                      | Notes                                        |
| ------------------------- | -------------------------------------------- | -------------------------------------------- |
| `PORT`                    | `3000`                                       |                                              |
| `DATABASE_URL`            | `postgres://crm:crm@localhost:5433/crm`      |                                              |
| `DB_POOL_MAX`             | `10`                                         |                                              |
| `DB_STATEMENT_TIMEOUT_MS` | `5000`                                       | `0` disables it                              |
| `TEST_DATABASE_URL`       | `postgres://crm:crm@localhost:5433/crm_test` | must end in `_test`: it is dropped every run |

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

**Not yet:** the bulk stage move (Part 2) and the benchmarks:

- job submission with idempotency keys
- a resumable worker
- a progress endpoint
- per-workspace isolation
- `BENCHMARKS.md`

**Deliberately not built:** rules on the transition sequence. Any stage can move to any other,
including backwards and reopening closed deals; see DESIGN.md, assumption 2.

**Out of scope by the brief:** auth, any UI, board views and rollups, custom fields,
automation events, deployment.

## Layout

```
src/crm/        pipeline (stages), opportunities controller / service / repository, DTOs
src/common/     workspace guard, id pipe
src/db/         pool, migration runner, transaction helper, pg error helpers
src/scripts/    seed
migrations/     plain SQL, applied in filename order
test/           end-to-end tests against Postgres
```

The stack is NestJS 11 on Node 22 with TypeScript 6.0, and PostgreSQL 17 is the only datastore.
NestJS 12 is ESM-only, and TypeScript 7 isn't supported by ts-jest or typescript-eslint yet, so
this is the newest combination the test and lint tools support.
