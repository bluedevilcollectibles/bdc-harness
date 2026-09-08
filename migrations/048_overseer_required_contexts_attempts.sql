-- Migration 048: durable consecutive-UNKNOWN counters for the PR reviewer's
-- required-status-check-context lookup (bdc-harness #777 review, [major]).
--
-- The bound added in #775/#777 lived only in a process-local Map. That made the
-- "boundedness" it advertised untrue in production: archon-app-1 restarts on
-- every rebuild, and the review worker can run in more than one process, so the
-- consecutive-failure count reset before it could ever reach the bound. A PR
-- whose contexts were permanently unreadable therefore still deferred forever --
-- the exact 2026-09-07 incident the bound was written to end.
--
-- The key is (owner, repo, base_ref, head_sha), all four parts load-bearing:
--   owner/repo -- identical commits exist across forks and mirrors, so a sha
--                 alone would let one repository's success clear another's count.
--   base_ref   -- required contexts are BASE-SPECIFIC. Two PRs carrying the same
--                 commit against different bases are two different questions,
--                 and one answering must not reset the other.
--   head_sha   -- a new push is a new question; its predecessor's failures say
--                 nothing about it, and a sibling PR on the same base must not
--                 share (and therefore reset) this head's slot.
--
-- A row is deleted the moment a lookup succeeds, so this table holds only
-- in-flight failures. touched_at exists purely so abandoned rows (a head that is
-- merged, closed, or force-pushed away never clears its own counter) can be
-- retired by age; it is indexed because that sweep is the only scan of the table.
--
-- SQLITE MIRROR: packages/core/src/db/adapters/sqlite.ts createSchema(). That
-- mirror is hand-maintained and is NOT derived from this file. Production runs
-- SQLite by default (DATABASE_URL unset), so the mirror is the load-bearing half.
BEGIN;

CREATE TABLE IF NOT EXISTS overseer_required_contexts_attempts (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner, repo, base_ref, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_overseer_required_contexts_attempts_touched
  ON overseer_required_contexts_attempts(touched_at);

COMMIT;
