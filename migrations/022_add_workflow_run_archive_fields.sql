-- Add operator archive fields to workflow runs.
-- Backfill: none — existing rows remain visible (archived_at IS NULL = active).

ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN archived_at TIMESTAMP NULL;

ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN archived_by TEXT NULL;

ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN archive_reason TEXT NULL;

-- Default list view filters WHERE archived_at IS NULL; index makes this fast.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_archived_at
  ON remote_agent_workflow_runs (archived_at);
