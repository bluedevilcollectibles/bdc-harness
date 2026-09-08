/**
 * Durable `AttemptCounterStore` for the required-contexts bound.
 *
 * The in-memory default in `required-contexts.ts` is correct for tests and for
 * any single-shot use, but it cannot bound the LONG-RUNNING reviewer: the count
 * lives in one process, archon-app-1 is rebuilt regularly, and the review worker
 * may run in more than one process. Each restart and each extra worker reset or
 * split the count, so it never reached the bound and an unreadable lookup still
 * deferred forever -- the very outcome the bound was added to end (#777 review
 * [major]). This store puts the count in the database instead
 * (`overseer_required_contexts_attempts`, migration 048), keyed by exactly
 * owner/repo/base_ref/head_sha.
 *
 * FAIL-SOFT ON DB ERRORS, deliberately. A database fault must not turn a routine
 * deferral into a spurious BLOCK on someone's PR, and must not throw out of the
 * evidence fetcher and fail the review for an unrelated reason. An increment
 * that cannot be recorded reports `UNCOUNTED_ATTEMPT` (0): the tick genuinely
 * was not counted, and 0 can never satisfy a bound (`resolveMaxAttempts` floors
 * at 1), so the resolver DEFERS however the bound is configured. Reporting 1
 * instead would block immediately whenever the bound is 1 -- an outage
 * manufacturing the terminal verdict, which is precisely what fail-soft is here
 * to prevent. A clear that cannot be recorded is likewise only ever
 * conservative: it leaves a stale count that the next success clears and the TTL
 * sweep eventually retires.
 *
 * The lazy import of the db module is on purpose: it keeps `@archon/core`'s
 * connection machinery (and with it a sqlite handle) out of pure test paths that
 * import the adapter module but never construct this store.
 */
import { createLogger } from '@archon/paths';
import {
  ATTEMPT_COUNTER_TTL_MS,
  type AttemptCounterKey,
  type AttemptCounterStore,
} from './required-contexts';

const log = createLogger('overseer/required-contexts-store');

/**
 * How often the staleness sweep may run, per process. The sweep only retires
 * counters nothing is still touching, so it is pure housekeeping -- running it
 * on every increment would add a table scan to every reviewer tick for no gain.
 */
export const ATTEMPT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Reported when an attempt could not be recorded at all. Zero is not "no
 * failures so far" here -- it is "this tick is not counted", and because
 * `resolveMaxAttempts` never returns less than 1 it can never reach a bound. The
 * resolver therefore defers, which is the correct answer when the counter itself
 * is the thing that is broken.
 */
export const UNCOUNTED_ATTEMPT = 0;

type RequiredContextsDbModule = typeof import('@archon/core/db/overseer-required-contexts');

export interface DurableAttemptCounterStoreOptions {
  /** Test seam: supply the db module directly instead of importing it. */
  loadDb?: () => Promise<RequiredContextsDbModule>;
  /** Test seam: override the sweep cadence. */
  pruneIntervalMs?: number;
  /** Test seam: override how long an untouched counter survives. */
  ttlMs?: number;
}

/**
 * Build a database-backed attempt counter store.
 *
 * Each store instance keeps its own sweep clock, so a fresh instance (a restart,
 * or a per-message rebuild of the reviewer deps) sweeps once early and then
 * settles into the interval. The COUNTS themselves are in the database and are
 * unaffected by instance lifetime -- that is the entire point.
 */
export function createDurableAttemptCounterStore(
  options: DurableAttemptCounterStoreOptions = {}
): AttemptCounterStore {
  const loadDb =
    options.loadDb ??
    ((): Promise<RequiredContextsDbModule> => import('@archon/core/db/overseer-required-contexts'));
  const pruneIntervalMs = options.pruneIntervalMs ?? ATTEMPT_PRUNE_INTERVAL_MS;
  const ttlMs = options.ttlMs ?? ATTEMPT_COUNTER_TTL_MS;
  // `null` means "never swept by this instance". Deliberately not 0: `now` is a
  // clock the caller supplies, and against 0 the first sweep would be gated on
  // that clock happening to exceed the interval -- so a test clock, or a process
  // started near epoch, would skip the one sweep a fresh instance should do.
  let lastPrunedAt: number | null = null;

  async function maybePrune(db: RequiredContextsDbModule, now: number): Promise<void> {
    if (lastPrunedAt !== null && now - lastPrunedAt < pruneIntervalMs) return;
    // Stamp BEFORE awaiting so two concurrent ticks cannot both start a sweep.
    lastPrunedAt = now;
    try {
      const removed = await db.pruneRequiredContextsAttempts(ttlMs, new Date(now));
      if (removed > 0) {
        log.info({ removed, ttlMs }, 'overseer.required_contexts.attempt_counters_pruned');
      }
    } catch (error) {
      // Housekeeping only. A failed sweep leaves stale rows, never a wrong count.
      log.warn({ err: error }, 'overseer.required_contexts.attempt_counter_prune_failed');
    }
  }

  return {
    async increment(key: AttemptCounterKey, now: number): Promise<number> {
      try {
        const db = await loadDb();
        const attempts = await db.incrementRequiredContextsAttempt(key, new Date(now));
        await maybePrune(db, now);
        return attempts;
      } catch (error) {
        // Report the DEFER branch, never the BLOCK branch: a database fault is
        // not evidence that GitHub cannot answer, and must not block a PR. 0 --
        // not 1 -- because a bound of 1 would make 1 exhaust immediately, so an
        // outage would manufacture the terminal verdict.
        log.error(
          { err: error, ...key },
          'overseer.required_contexts.attempt_increment_failed_deferring'
        );
        return UNCOUNTED_ATTEMPT;
      }
    },

    async clear(key: AttemptCounterKey): Promise<void> {
      try {
        const db = await loadDb();
        await db.clearRequiredContextsAttempts(key);
      } catch (error) {
        // A stale count is self-correcting: the next success clears it and the
        // TTL sweep retires it. Never let it fail the review that just answered.
        log.warn({ err: error, ...key }, 'overseer.required_contexts.attempt_clear_failed');
      }
    },
  };
}
