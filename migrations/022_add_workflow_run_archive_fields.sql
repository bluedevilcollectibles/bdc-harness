-- Add operator archive fields to workflow runs (WO-HARNESS-MC-ARCHIVE-DELETE-FAILED-01)
-- Allows runs to be soft-archived (hidden from default view) before permanent deletion.
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS archived_by TEXT;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

-- Partial index for efficient archived-only queries
CREATE INDEX IF NOT EXISTS idx_workflow_runs_archived
  ON remote_agent_workflow_runs(archived_at)
  WHERE archived_at IS NOT NULL;
