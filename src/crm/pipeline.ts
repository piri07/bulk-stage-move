// The pipeline is the same for every workspace (an assumption recorded in DESIGN.md). This list is
// the single source of truth in code; migrations/001_crm_schema.sql mirrors it as the
// opportunity_stage enum in the same order, and a test fails if the two drift apart.
export const STAGES = [
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
  'closed_lost',
] as const;

export type Stage = (typeof STAGES)[number];

export const INITIAL_STAGE: Stage = 'new_lead';

export const STATUSES = ['open', 'won', 'lost', 'abandoned'] as const;

export type Status = (typeof STATUSES)[number];
