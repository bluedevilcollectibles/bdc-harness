-- Taskmaster expectation registry (WO-HARNESS-TASKMASTER-EXPECTATION-REGISTRY-01).
--
-- ONE TRANSACTION for the whole migration. These are applied with
-- `psql $DATABASE_URL < migrations/NNN.sql` (see the database reference doc),
-- which is autocommit PER STATEMENT -- so without an explicit BEGIN, an
-- interruption between the backfill and the unique index would leave the
-- database with keys assigned and no constraint, exactly the partially-repaired
-- state this migration must never produce. Wrapping it means an interruption
-- rolls back to the pre-migration shape and the migration is simply re-run.
BEGIN;

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

-- Collision-free backfill, correct under ANY starting state: all-NULL, fully
-- populated, or PARTIALLY populated.
--
-- Ranking only the NULL-key rows was wrong: with a partially populated table it
-- could hand `dispatch_ref` to a NULL row while a sibling already owned that
-- exact key, and the duplicate then made the unique index below fail. Ranking
-- covers EVERY row per dispatch_ref, so a row takes the bare key only if it
-- wins its whole partition; everyone else takes `<dispatch_ref>:legacy:<id>`,
-- unique because id is the primary key. An existing key is kept only when it is
-- already unique -- a pre-existing duplicate is re-derived by the same rule
-- rather than preserved, which is what makes this converge instead of failing.
--
-- Duplicates are NOT folded away: each row owns its retry counter and terminal
-- state, and a migration must not destroy audit history. Deterministic, so
-- re-running writes nothing.
WITH ranked AS (
  SELECT id, dispatch_ref, registration_key,
         ROW_NUMBER() OVER (
           PARTITION BY dispatch_ref ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM tm_expectations
),
resolved AS (
  SELECT ranked.id,
         CASE
           WHEN ranked.registration_key IS NOT NULL
            AND NOT EXISTS (
                  SELECT 1 FROM tm_expectations other
                   WHERE other.registration_key = ranked.registration_key
                     AND other.id <> ranked.id
                )
             THEN ranked.registration_key
           WHEN ranked.rn = 1 THEN ranked.dispatch_ref
           ELSE ranked.dispatch_ref || ':legacy:' || ranked.id::text
         END AS resolved_key
    FROM ranked
)
UPDATE tm_expectations
   SET registration_key = resolved.resolved_key
  FROM resolved
 WHERE resolved.id = tm_expectations.id
   AND tm_expectations.registration_key IS DISTINCT FROM resolved.resolved_key;

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

COMMIT;