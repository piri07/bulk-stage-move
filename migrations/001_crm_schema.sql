-- CRM foundation: tenants, deals and their stage history.
--
-- The pipeline is fixed for every workspace. Its stages are defined once in src/crm/pipeline.ts
-- and mirrored here, in pipeline order, so the database rejects unknown stages on its own.

CREATE TYPE opportunity_stage AS ENUM (
  'new_lead',
  'contacted',
  'discovery',
  'qualified',
  'demo_scheduled',
  'demo_done',
  'proposal_sent',
  'negotiation',
  'contract_sent',
  'verbal_commit',
  'closed_won',
  'closed_lost'
);

CREATE TYPE opportunity_status AS ENUM ('open', 'won', 'lost', 'abandoned');

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE opportunities (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  name         text NOT NULL CHECK (name <> ''),
  value_cents  bigint NOT NULL CHECK (value_cents >= 0),
  stage        opportunity_stage NOT NULL,
  status       opportunity_status NOT NULL DEFAULT 'open',
  owner_id     uuid NOT NULL,
  -- Bumped on every stage change: the optimistic-concurrency token for single moves and, later,
  -- the compare-and-set guard the bulk job uses to never overwrite a newer manual edit.
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Serves "list a stage" keyset pagination: workspace + stage, id > cursor, ORDER BY id.
-- Kept deliberately alone: a stage change is never a HOT update (stage is indexed), so every
-- extra index on this table is rewritten on every move.
CREATE INDEX opportunities_workspace_stage_id_idx ON opportunities (workspace_id, stage, id);

CREATE TABLE stage_transitions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id),
  opportunity_id bigint NOT NULL REFERENCES opportunities (id),
  from_stage     opportunity_stage NOT NULL,
  to_stage       opportunity_stage NOT NULL,
  source         text NOT NULL DEFAULT 'manual',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_transitions_changes_stage CHECK (to_stage <> from_stage),
  CONSTRAINT stage_transitions_source_check CHECK (source IN ('manual'))
);

-- A deal's history in order.
CREATE INDEX stage_transitions_opportunity_id_idx ON stage_transitions (opportunity_id, id);
