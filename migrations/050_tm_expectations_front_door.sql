-- Taskmaster expectation FRONT DOOR (bdc-xo#2007).
--
-- Migration 049 shipped the registry; this migration makes it registerable from
-- OUTSIDE the Taskmaster loop. Two additive columns, no data rewrite:
--
--   registered_by -- WHO asked for this supervision. Every row 049 created was
--     registered by the loop itself, so backfilling those to 'taskmaster' is not
--     a guess: it is the only possible registrant at the time they were written.
--     Nullable-then-backfilled rather than NOT NULL DEFAULT, so a future row that
--     somehow arrives without a registrant is VISIBLE as null instead of being
--     silently relabelled as the loop's own work.
--
--   self_supervised -- 1 when the registrant named ITSELF as the recipient. The
--     API refuses that combination for on_absence='escalate' (a seat cannot be
--     the only thing that would notice its own silence), so this column exists to
--     make the permitted cases auditable rather than to gate them. See
--     docs/doctrine/taskmaster-expectation-registration.md.
--
-- ONE TRANSACTION, per the 049 convention: these are applied with
-- `psql $DATABASE_URL < migrations/NNN.sql`, which is autocommit PER STATEMENT,
-- so an interruption between the ADD COLUMN and the backfill would otherwise
-- leave a column present and unpopulated.
BEGIN;

ALTER TABLE tm_expectations ADD COLUMN IF NOT EXISTS registered_by TEXT;
ALTER TABLE tm_expectations
  ADD COLUMN IF NOT EXISTS self_supervised INTEGER NOT NULL DEFAULT 0
  CHECK (self_supervised IN (0, 1));

-- Every pre-existing row was written by the loop; see the note above.
UPDATE tm_expectations SET registered_by = 'taskmaster' WHERE registered_by IS NULL;

-- Registrant-scoped rate accounting reads (registered_by, created_at); the
-- index keeps that count from scanning the whole table as the registry grows.
CREATE INDEX IF NOT EXISTS idx_tm_expectations_registered_by
  ON tm_expectations(registered_by, created_at);

COMMIT;
