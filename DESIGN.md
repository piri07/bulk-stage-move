# Design

This document grows with the code. The bulk stage move is the point of the exercise and gets its
own sections when it lands. This first version records the assumptions, and the decisions in the
CRM foundation that the bulk engine builds on.

## Assumptions

1. **One pipeline, shared by every workspace.** The brief gives each workspace its own ordered
   stages; I fixed a single 12-stage pipeline instead (the 500k seed needs 12 stages).
   - Stages are defined once in `src/crm/pipeline.ts` and mirrored by the Postgres enum
     `opportunity_stage`. A test fails if the two drift apart.
   - Per-workspace pipelines would need a `stages(workspace_id, id, position)` table, with a
     composite foreign key `(workspace_id, stage_id)` replacing the enum.
   - The bulk engine only ever writes a stage value, so it would not change.
2. **Any stage can move to any other.** There are no transition rules.
   - The bulk engine applies moves in set-based SQL, so every rule would also need a SQL version
     of the TypeScript check. With no rules, there is nothing to keep in sync.
   - Moving a deal to the stage it is already in is a no-op.
3. **Stage and status are independent.** Moving a deal to `closed_won` does not set
   `status = won`. That would be downstream automation, which the brief rules out. The seed keeps
   stage and status consistent anyway.
4. **Money is integer cents** (`value_cents bigint`) in a single currency. The API caps it at
   10^15, well inside 2^53.
5. **Owners are opaque UUIDs.** There is no users table.
6. **Deals are never deleted.** Nothing in scope removes one.
7. **Tenancy comes from the `X-Workspace-Id` header**, with no auth, as the brief allows.

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
