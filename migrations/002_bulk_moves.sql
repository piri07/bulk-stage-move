-- Bulk stage moves: the job queue (bulk_jobs), each job's snapshot (bulk_job_items), and a link
-- from a deal's history back to the job that moved it. DESIGN.md explains the choices.

CREATE TABLE bulk_jobs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces (id),
  -- Idempotency: the client's key, and a hash of the request it was first used with.
  idempotency_key  text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  request_hash     text NOT NULL,
  filter           jsonb NOT NULL,
  target_stage     opportunity_stage NOT NULL,
  -- text + CHECK rather than an enum, so adding a status later is a plain constraint change.
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  -- Progress, committed in the same transaction as each batch of moves.
  total            integer NOT NULL DEFAULT 0,
  cursor_seq       integer NOT NULL DEFAULT 0,  -- the last bulk_job_items.seq with a committed outcome
  moved_count      integer NOT NULL DEFAULT 0,
  skipped_count    integer NOT NULL DEFAULT 0,
  -- Lease: which worker holds the job and until when. The epoch rises on every claim, so a
  -- worker that was replaced can tell, and its writes are refused.
  lease_owner      text,
  lease_epoch      integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  attempts         integer NOT NULL DEFAULT 0,  -- failed runs: errors and workers that died
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  last_progress_at timestamptz,
  finished_at      timestamptz,
  CONSTRAINT bulk_jobs_idempotency UNIQUE (workspace_id, idempotency_key),
  -- Every deal up to the cursor has exactly one counted outcome. The database refuses any
  -- checkpoint that would break this.
  CONSTRAINT bulk_jobs_progress CHECK (
    cursor_seq BETWEEN 0 AND total AND moved_count + skipped_count = cursor_seq
  )
);

-- One running job per workspace: one tenant can't occupy every worker, and the only
-- multi-row writer on a workspace's deals is a single job, which rules out deadlocks.
CREATE UNIQUE INDEX bulk_jobs_one_running_per_workspace ON bulk_jobs (workspace_id)
  WHERE status = 'running';

-- Keeps the claim query cheap however many finished jobs accumulate.
CREATE INDEX bulk_jobs_claimable_idx ON bulk_jobs (id) WHERE status IN ('pending', 'running');

-- The snapshot: the deals that matched at the click, in id order, with each one's version and
-- stage at that moment.
CREATE TABLE bulk_job_items (
  job_id           bigint NOT NULL REFERENCES bulk_jobs (id),
  seq              integer NOT NULL,             -- 1..total; the worker's cursor walks this
  -- No foreign key: the rows were just read from opportunities, deals are never deleted, and a
  -- check per row would slow the snapshot.
  opportunity_id   bigint NOT NULL,
  expected_version integer NOT NULL,             -- the deal's version at the click
  from_stage       opportunity_stage NOT NULL,   -- its stage at the click
  outcome          text CHECK (outcome IN ('moved', 'skipped_conflict')),  -- null until processed
  PRIMARY KEY (job_id, seq)
);

ALTER TABLE stage_transitions
  ADD COLUMN bulk_job_id bigint REFERENCES bulk_jobs (id),
  DROP CONSTRAINT stage_transitions_source_check,
  ADD CONSTRAINT stage_transitions_source_check CHECK (
    (source = 'manual' AND bulk_job_id IS NULL) OR (source = 'bulk' AND bulk_job_id IS NOT NULL)
  );

-- A job can never record two moves of the same deal. This is the last line of defence, should
-- every other safeguard (checkpoints, fencing, the version check) somehow fail.
CREATE UNIQUE INDEX stage_transitions_one_per_job_and_deal
  ON stage_transitions (bulk_job_id, opportunity_id)
  WHERE bulk_job_id IS NOT NULL;
