-- Migration 050: durable keyset cursor for the Overseer stale-verdict sweep
-- (bdc-harness #782 part 3; Overseer review finding on PR #786 @45aa739e).
--
-- WHY THIS IS IN THE DATABASE. The sweep walks completed review work items
-- looking for a standing CHANGES_REQUESTED whose check has since gone green.
-- `listMessages` hard-caps its page at 500 rows with no offset or cursor, and
-- the live store holds ~4,900 dispatch rows (the review recipient alone already
-- holds ~494), so a sweep that paged with an in-memory array index re-fetched
-- the same capped page on every heartbeat: once its index passed the candidates
-- inside that page it rewound, and any completed review beyond row 500 was
-- permanently unreachable. The backstop silently covered only the head of the
-- store.
--
-- A process-local cursor does not fix that on its own: archon-app-1 is rebuilt
-- regularly, so every restart would rewind the walk to the beginning and the
-- far end of the store would still never be reached in practice. The cursor has
-- to outlive the process, exactly as the required-contexts attempt counters had
-- to (migration 048, same root cause).
--
-- KEYSET, NOT OFFSET. `after_seq` holds the database-assigned `seq` of the last
-- row the sweep consumed, and the next page resumes strictly after it. An
-- OFFSET would skip or repeat rows as the table grows underneath the walk;
-- `seq` is assigned at the single serialization point every writer shares
-- (migration 047), so it is stable regardless of insert rate or clock skew.
--
-- ONE ROW. The sweep is a single logical walk, so the table is keyed by a
-- constant `sweep` discriminator rather than carrying a synthetic id. The CHECK
-- makes a second row impossible rather than merely unlikely.
--
-- SQLITE MIRROR: packages/core/src/db/adapters/sqlite.ts createSchema(). That
-- mirror is hand-maintained and is NOT derived from this file. Production runs
-- SQLite by default (DATABASE_URL unset), so the mirror is the load-bearing half.
BEGIN;

CREATE TABLE IF NOT EXISTS overseer_sweep_cursor (
  sweep TEXT PRIMARY KEY CHECK (sweep = 'stale_verdict'),
  after_seq BIGINT NOT NULL DEFAULT 0 CHECK (after_seq >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
