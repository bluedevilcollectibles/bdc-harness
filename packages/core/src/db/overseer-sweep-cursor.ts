/**
 * Durable keyset cursor for the Overseer stale-verdict sweep (migration 050).
 *
 * WHY THIS IS IN THE DATABASE (Overseer review finding, PR #786 @45aa739e).
 * The sweep walks completed review work items looking for a standing
 * CHANGES_REQUESTED whose check has since gone green. `listMessages` hard-caps
 * its page at 500 rows with no offset or cursor, and the live store holds
 * ~4,900 dispatch rows, so a sweep paging with an in-memory array index
 * re-fetched the same capped page every heartbeat and rewound once it passed
 * the candidates inside it. Rows beyond the first page were unreachable.
 *
 * Making the cursor process-local was not sufficient either: archon-app-1 is
 * rebuilt regularly, so each restart rewound the walk to the head of the store
 * and the far end still never got swept. This is the same lesson migration 048
 * recorded for the required-contexts attempt counters -- a bound (or here, a
 * position) that only holds inside one process lifetime does not hold.
 *
 * `after_seq` is the database-assigned `seq` of the last row the sweep
 * consumed; the next page resumes strictly after it. Never an OFFSET, which
 * would skip or repeat rows as the table grows underneath a walk.
 */
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';

const log = createLogger('db/overseer-sweep-cursor');

/** The only sweep this table tracks. Enforced by a CHECK in both dialects. */
const SWEEP_KEY = 'stale_verdict';

/**
 * The seq to resume strictly after, or 0 when the sweep has never run.
 *
 * FAIL-SOFT: a read that throws reports 0, which restarts the walk at the head
 * of the store. That re-examines rows already seen -- wasteful but never wrong,
 * and bounded by the same per-heartbeat GitHub-read budget as any other pass.
 * The alternative (throwing) would take down the review worker heartbeat that
 * carries the primary review path, to protect a backstop.
 */
export async function readStaleSweepCursor(): Promise<number> {
  try {
    const db = getDatabase();
    const result = await db.query<{ after_seq: unknown }>(
      'SELECT after_seq FROM overseer_sweep_cursor WHERE sweep = $1',
      [SWEEP_KEY]
    );
    // `unknown`, not `number`: Postgres hands a BIGINT back as a string while
    // SQLite returns a JS number.
    const value = Number(result.rows[0]?.after_seq ?? 0);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch (error) {
    log.warn({ err: error }, 'overseer.stale_sweep.cursor_read_failed_restarting_walk');
    return 0;
  }
}

/**
 * Record how far the walk has reached.
 *
 * FAIL-SOFT for the same reason as the read: a cursor that cannot be persisted
 * leaves the sweep repeating a page, which the next successful write corrects.
 * Losing a backstop's place must never fail the heartbeat.
 */
export async function writeStaleSweepCursor(
  afterSeq: number,
  now: Date = new Date()
): Promise<void> {
  if (!Number.isFinite(afterSeq) || afterSeq < 0) return;
  try {
    const db = getDatabase();
    await db.query(
      `INSERT INTO overseer_sweep_cursor (sweep, after_seq, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (sweep) DO UPDATE
         SET after_seq = $2, updated_at = $3`,
      [SWEEP_KEY, Math.floor(afterSeq), now.toISOString()]
    );
  } catch (error) {
    log.warn({ err: error, afterSeq }, 'overseer.stale_sweep.cursor_write_failed');
  }
}
