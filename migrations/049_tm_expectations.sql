-- Taskmaster expectation registry (WO-HARNESS-TASKMASTER-EXPECTATION-REGISTRY-01).
CREATE TABLE IF NOT EXISTS tm_expectations (
  id UUID PRIMARY KEY,
  -- Stable identity for the work that caused this expectation, normally
  -- "<journal action id>:<dispatch_ref>". UNIQUE so that replaying an action
  -- after a crash between the dispatch and the journal finalization cannot
  -- register a second expectation for the same dispatch: a duplicate would
  -- carry a different id, and therefore different retry and escalation
  -- idempotency keys, producing duplicate external work.
  -- Uniqueness is enforced by idx_tm_expectations_registration_key at the foot
  -- of this file rather than inline, so the fresh-install and the
  -- repair-an-existing-table paths converge on ONE named constraint instead of
  -- an inline auto-named one plus a redundant index.
  registration_key TEXT NOT NULL,
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

-- Idempotent repair for a database that already carries an EARLIER shape of
-- tm_expectations. CREATE TABLE IF NOT EXISTS above is a no-op on such a
-- database, so without this block the table would keep the old schema, lack
-- registration_key entirely, and every registerExpectation using
-- ON CONFLICT (registration_key) would fail with "column does not exist" --
-- registration disabled, silently. This mirrors the sqlite adapter repair.
ALTER TABLE tm_expectations ADD COLUMN IF NOT EXISTS registration_key TEXT;

-- Collision-free backfill. A legacy table can hold two rows sharing a
-- dispatch_ref (the replayed-registration bug this WO fixes), so assigning the
-- bare dispatch_ref to every row would make the unique index below fail.
-- Duplicates are NOT folded -- each row owns its retry counter and terminal
-- state, and a migration must not destroy audit history. The OLDEST row per
-- dispatch_ref keeps the clean key so future registrations reuse it; later
-- duplicates get a suffixed key, preserved but out of the way.
UPDATE tm_expectations SET registration_key = dispatch_ref
 WHERE registration_key IS NULL
   AND id IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (
         PARTITION BY dispatch_ref ORDER BY created_at ASC, id ASC
       ) AS rn
       FROM tm_expectations WHERE registration_key IS NULL
     ) ranked WHERE rn = 1
   );

UPDATE tm_expectations
   SET registration_key = dispatch_ref || ':legacy:' || id::text
 WHERE registration_key IS NULL;

ALTER TABLE tm_expectations ALTER COLUMN registration_key SET NOT NULL;

-- The write path depends on this constraint; creating it must not be optional.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_expectations_registration_key
  ON tm_expectations(registration_key);
