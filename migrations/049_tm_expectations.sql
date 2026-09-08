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

-- Shape check for a database that already carries an EARLIER tm_expectations.
-- CREATE TABLE IF NOT EXISTS above is a no-op on such a database, so it would
-- otherwise keep the old schema and every registerExpectation using
-- ON CONFLICT (registration_key) would fail.
--
-- DESIGN NOTE -- why there is no automatic key backfill here.
--
-- tm_expectations ships for the FIRST TIME in this WO: it exists in no commit
-- on origin/dev, and the live archon.db reports the table absent. No deployed
-- database can hold an outdated shape, so a backfill deriving registration_key
-- values for pre-existing rows is surface with no caller -- and any scheme that
-- mixes preserved keys with derived ones can collide, which fails the unique
-- index and blocks startup anyway.
--
-- So: recreate an EMPTY mismatched table, and RAISE on a non-empty one so a
-- human inspects the rows with scripts/db/repair-tm-expectations.ts instead of
-- a migration guessing at identities. This mirrors the sqlite adapter exactly.
DO $$
DECLARE
  has_key BOOLEAN;
  has_escalating BOOLEAN;
  has_unique_index BOOLEAN;
  row_count BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'tm_expectations' AND column_name = 'registration_key'
  ) INTO has_key;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'tm_expectations'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%escalating%'
  ) INTO has_escalating;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'tm_expectations'
       AND indexname = 'idx_tm_expectations_registration_key'
  ) INTO has_unique_index;

  IF has_key AND has_escalating AND has_unique_index THEN
    RETURN;  -- already current
  END IF;

  EXECUTE 'SELECT COUNT(*) FROM tm_expectations' INTO row_count;

  IF row_count > 0 THEN
    RAISE EXCEPTION
      'tm_expectations has an outdated schema and % row(s); refusing to guess registration_key values. Run: bun scripts/db/repair-tm-expectations.ts <db> --apply',
      row_count;
  END IF;

  -- Empty and mismatched: recreating is lossless.
  DROP TABLE tm_expectations;
  CREATE TABLE tm_expectations (
    id UUID PRIMARY KEY,
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
  CREATE INDEX idx_tm_expectations_due ON tm_expectations(status, due_at);
  CREATE INDEX idx_tm_expectations_dispatch_ref ON tm_expectations(dispatch_ref);
END
$$;

-- The write path depends on this constraint; creating it must not be optional.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_expectations_registration_key
  ON tm_expectations(registration_key);

COMMIT;
