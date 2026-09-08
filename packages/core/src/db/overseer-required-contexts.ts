/**
 * Durable consecutive-UNKNOWN counters for the PR reviewer's required
 * status-check-context lookup (migration 048).
 *
 * WHY THIS IS IN THE DATABASE AT ALL (#777 review, [major]). The bound that
 * turns "defer and retry" into "block visibly" was first written against a
 * process-local Map. That made its central promise false in production:
 * archon-app-1 is rebuilt regularly and the review worker may run in more than
 * one process, so the count reset before it could ever reach the bound. A PR
 * whose contexts were permanently unreadable therefore still deferred forever --
 * the exact 2026-09-07 incident the bound exists to end. A bound that only holds
 * inside one process lifetime is not a bound.
 *
 * KEY. (owner, repo, base_ref, head_sha), every part load-bearing:
 *   owner/repo -- identical commits exist across forks and mirrors.
 *   base_ref   -- required contexts are BASE-specific: the same commit against
 *                 two bases is two different questions with two different
 *                 answers, and one resolving says nothing about the other.
 *   head_sha   -- a new push is a new question, and a sibling PR on the same
 *                 base must not share (and therefore reset) this head's slot.
 *
 * ATOMICITY. The increment is a single `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING` so two workers ticking the same PR concurrently produce two
 * distinct counts rather than both reading N and both writing N+1. Read-then-
 * write would let concurrent workers hold the count still, which is the same
 * never-reaches-the-bound failure in a different disguise. The SQLite adapter
 * routes INSERT-with-RETURNING through `.all()` precisely for this shape;
 * UPDATE/DELETE ... RETURNING is rejected by that adapter and is avoided here.
 */
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';

const log = createLogger('db/overseer-required-contexts');

/** Identifies one lookup question: this head, on this base, in this repository. */
export interface RequiredContextsAttemptKey {
  owner: string;
  repo: string;
  baseRef: string;
  headSha: string;
}

/**
 * Record one more consecutive UNKNOWN for this key and return the new total.
 *
 * `touched_at` is refreshed on every increment so the staleness sweep only ever
 * retires keys nothing is still counting.
 */
export async function incrementRequiredContextsAttempt(
  key: RequiredContextsAttemptKey,
  now: Date = new Date()
): Promise<number> {
  const db = getDatabase();
  const result = await db.query<{ attempts: number }>(
    `INSERT INTO overseer_required_contexts_attempts
       (owner, repo, base_ref, head_sha, attempts, touched_at)
     VALUES ($1, $2, $3, $4, 1, $5)
     ON CONFLICT (owner, repo, base_ref, head_sha) DO UPDATE
       SET attempts = overseer_required_contexts_attempts.attempts + 1,
           touched_at = $5
     RETURNING attempts`,
    [key.owner, key.repo, key.baseRef, key.headSha, now.toISOString()]
  );
  const attempts = result.rows[0]?.attempts;
  // No RETURNING row means the write cannot be confirmed, so the count is not
  // known. Report 0 -- "not counted" -- which the caller treats as a DEFER. Any
  // positive guess here could satisfy a low bound and block a PR on nothing.
  if (typeof attempts !== 'number') {
    log.warn({ ...key }, 'overseer.required_contexts.attempt_increment_returned_no_row');
    return 0;
  }
  return attempts;
}

/** The current count for one key, or 0 when no failure is being tracked. */
export async function readRequiredContextsAttempts(
  key: RequiredContextsAttemptKey
): Promise<number> {
  const db = getDatabase();
  const result = await db.query<{ attempts: number }>(
    `SELECT attempts FROM overseer_required_contexts_attempts
     WHERE owner = $1 AND repo = $2 AND base_ref = $3 AND head_sha = $4`,
    [key.owner, key.repo, key.baseRef, key.headSha]
  );
  return result.rows[0]?.attempts ?? 0;
}

/**
 * Forget the counter for exactly one key, after a lookup finally answers.
 *
 * Scoped to all four key parts on purpose (#777 review [major]). Clearing by
 * head across a repository's bases reset sibling questions that had not been
 * answered: a base whose lookup keeps succeeding would hold a base whose lookup
 * never succeeds permanently below its bound, restoring the forever-deferral.
 */
export async function clearRequiredContextsAttempts(
  key: RequiredContextsAttemptKey
): Promise<void> {
  const db = getDatabase();
  await db.query(
    `DELETE FROM overseer_required_contexts_attempts
     WHERE owner = $1 AND repo = $2 AND base_ref = $3 AND head_sha = $4`,
    [key.owner, key.repo, key.baseRef, key.headSha]
  );
}

/**
 * Retire counters untouched for longer than `ttlMs`.
 *
 * A head that stops being reviewed -- merged, closed, or force-pushed away --
 * never clears its own counter, so age is the only thing that can retire it.
 * Deliberately driven by staleness and never by another key arriving: expiry by
 * overwrite is what let one question erase another's progress.
 */
export async function pruneRequiredContextsAttempts(
  ttlMs: number,
  now: Date = new Date()
): Promise<number> {
  const db = getDatabase();
  const cutoff = new Date(now.getTime() - ttlMs).toISOString();
  const result = await db.query(
    'DELETE FROM overseer_required_contexts_attempts WHERE touched_at < $1',
    [cutoff]
  );
  return result.rowCount;
}

/** How many counters are currently retained. Diagnostics and tests. */
export async function countRequiredContextsAttempts(): Promise<number> {
  const db = getDatabase();
  // `unknown`, not `number`: Postgres returns COUNT(*) as a BIGINT that the
  // driver hands back as a string, while SQLite returns a JS number. Declaring
  // it a number would make the coercion below look redundant when it is not.
  const result = await db.query<{ total: unknown }>(
    'SELECT COUNT(*) AS total FROM overseer_required_contexts_attempts'
  );
  return Number(result.rows[0]?.total ?? 0);
}
