-- Taskmaster expectation registry (WO-HARNESS-TASKMASTER-EXPECTATION-REGISTRY-01).
CREATE TABLE IF NOT EXISTS tm_expectations (
  id UUID PRIMARY KEY,
  dispatch_ref TEXT NOT NULL,
  recipient TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  on_absence TEXT NOT NULL CHECK (on_absence IN ('redispatch', 'escalate', 'give_up')),
  max_retries INTEGER NOT NULL DEFAULT 0 CHECK (max_retries >= 0),
  retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'met', 'failed', 'escalating', 'escalated', 'given_up')
  ),
  evidence_pointer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tm_expectations_due ON tm_expectations(status, due_at);
CREATE INDEX IF NOT EXISTS idx_tm_expectations_dispatch_ref ON tm_expectations(dispatch_ref);
