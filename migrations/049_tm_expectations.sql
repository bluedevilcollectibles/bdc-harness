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

-- Upgrade the status CHECK so it permits the intermediate 'escalating' state.
-- Adding a column cannot change a CHECK, so a table created from an earlier
-- shape of this migration would reject claimEscalation at runtime with a
-- constraint violation -- the two-phase escalation would be dead on arrival.
--
-- The CHECK in the CREATE TABLE above is inline and therefore auto-named
-- (tm_expectations_status_check by PostgreSQL's convention, but that is not
-- guaranteed), so the old constraint is discovered from the catalogue rather
-- than assumed, dropped, and replaced with an explicitly named one. Idempotent:
-- re-running finds tm_expectations_status_allowed already present and skips.
DO $$
DECLARE
  existing_name TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'tm_expectations'::regclass
       AND conname = 'tm_expectations_status_allowed'
  ) THEN
    RETURN;
  END IF;

  FOR existing_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'tm_expectations'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE tm_expectations DROP CONSTRAINT IF EXISTS %I', existing_name);
  END LOOP;

  ALTER TABLE tm_expectations
    ADD CONSTRAINT tm_expectations_status_allowed CHECK (
      status IN ('pending', 'met', 'failed', 'escalating', 'escalated', 'given_up')
    );
END
$$;
