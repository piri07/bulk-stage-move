-- Fairness between workspaces: when each workspace last got a worker.
--
-- A worker that frees up takes the next job from the workspace whose turn came longest ago
-- (never served goes first), not simply the oldest job. A tenant with a backlog of jobs therefore
-- takes turns with everyone else instead of making them wait behind the whole backlog.
CREATE TABLE bulk_workspace_turns (
  workspace_id   uuid PRIMARY KEY REFERENCES workspaces (id),
  last_served_at timestamptz NOT NULL
);
