/**
 * Durability of the required-contexts deferral bound (#777 review, [major]).
 *
 * The bound that turns "defer and retry" into "block visibly" was first held in
 * a module-scoped Map. That made its central promise false in production:
 * archon-app-1 is rebuilt regularly and the review worker may run in more than
 * one process, so the count reset on every restart and was split across workers.
 * It therefore never reached the bound, and a PR whose contexts were permanently
 * unreadable still deferred forever -- the exact 2026-09-07 incident.
 *
 * These tests run against a REAL SqliteAdapter, because production runs SQLite
 * (DATABASE_URL unset) and the schema mirror in the adapter -- not the migration
 * file -- is the load-bearing half there. A mocked store would prove nothing
 * about either.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';

let db: import('@archon/core/db/adapters/sqlite').SqliteAdapter;
let currentDbPath = '';

// mock.module() patches the PROCESS-GLOBAL registry, so spread the real module
// and restore in afterAll or every later-loaded test file inherits this stub.
import * as realConnection from '@archon/core/db/connection';
mock.module('@archon/core/db/connection', () => ({ ...realConnection, getDatabase: () => db }));
afterAll(() => {
  mock.restore();
});

// Dynamic imports AFTER mock.module so they bind the mocked connection.
const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
const requiredContextsDb = await import('@archon/core/db/overseer-required-contexts');
const { createDurableAttemptCounterStore } = await import('../adapters/required-contexts-store.ts');
const { NO_BASE_REF_SENTINEL, REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV, resolveRequiredContexts } =
  await import('../adapters/required-contexts.ts');

const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const BASE = 'dev';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

/** The exact error the container logged on every tick during the incident. */
function appPermissionError(): Error {
  return Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
}

/**
 * A store instance bound to the shared test database. Building a NEW one is how
 * these tests simulate a restart: the instance is fresh, the database is not.
 */
function freshStore() {
  return createDurableAttemptCounterStore({
    loadDb: () => Promise.resolve(requiredContextsDb),
  });
}

function failingInput(overrides: Record<string, unknown> = {}) {
  return {
    owner: OWNER,
    repo: REPO,
    baseRef: BASE,
    headSha: HEAD,
    fetchWithAppClient: async () => {
      throw appPermissionError();
    },
    attemptStore: freshStore(),
    ...overrides,
  } as Parameters<typeof resolveRequiredContexts>[0];
}

beforeEach(() => {
  currentDbPath = join(
    import.meta.dir,
    `.test-required-contexts-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  db = new SqliteAdapter(currentDbPath);
});

afterEach(async () => {
  await db.close();
  cleanupDb(currentDbPath);
});

describe('durable attempt counters -- the count outlives the process', () => {
  test('D1 the table exists in the SQLite mirror, not only in migration 048', async () => {
    // Production runs SQLite and applies no migration files, so a table that
    // exists only in migrations/048 would be absent exactly where it matters.
    const result = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1",
      ['overseer_required_contexts_attempts']
    );
    expect(result.rows[0]?.name).toBe('overseer_required_contexts_attempts');
  });

  test('D2 a count written by one store instance is read by a brand new one', async () => {
    await freshStore().increment({ owner: OWNER, repo: REPO, baseRef: BASE, headSha: HEAD }, 1000);
    await freshStore().increment({ owner: OWNER, repo: REPO, baseRef: BASE, headSha: HEAD }, 2000);
    // A third, entirely separate instance -- the post-restart process.
    const attempts = await freshStore().increment(
      { owner: OWNER, repo: REPO, baseRef: BASE, headSha: HEAD },
      3000
    );
    expect(attempts).toBe(3);
  });

  test('D3 the bound is REACHED across simulated restarts, not restarted by them', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '3' };
    // Every call builds a NEW store instance, exactly as a container rebuild
    // between ticks would. Under the process-local Map each of these read 1 and
    // the bound never arrived, which is the forever-defer this fix ends.
    expect((await resolveRequiredContexts(failingInput(), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(failingInput(), env)).state).toBe('unknown');

    const exhausted = await resolveRequiredContexts(failingInput(), env);
    expect(exhausted.state).toBe('exhausted');
    if (exhausted.state === 'exhausted') {
      expect(exhausted.attempts).toBe(3);
      expect(exhausted.reason).toBe('required_contexts_unavailable_blocked');
    }
  });

  test('D4 concurrent workers produce distinct counts, never a held-still total', async () => {
    // Two worker processes ticking the same PR at once. A read-then-write store
    // would have both read N and both write N+1, holding the total below the
    // bound indefinitely -- the same never-arrives failure in a new disguise.
    const key = { owner: OWNER, repo: REPO, baseRef: BASE, headSha: HEAD };
    const results = await Promise.all([
      freshStore().increment(key, 1000),
      freshStore().increment(key, 1000),
      freshStore().increment(key, 1000),
      freshStore().increment(key, 1000),
    ]);
    expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(await requiredContextsDb.readRequiredContextsAttempts(key)).toBe(4);
  });

  test('D5 a success clears ONLY that owner/repo/base/head row', async () => {
    const dev = { owner: OWNER, repo: REPO, baseRef: BASE, headSha: HEAD };
    const main = { owner: OWNER, repo: REPO, baseRef: 'main', headSha: HEAD };
    const fork = { owner: OWNER, repo: 'bdc-harness-fork', baseRef: BASE, headSha: HEAD };
    const sibling = { owner: OWNER, repo: REPO, baseRef: BASE, headSha: OTHER_HEAD };
    const noBase = { owner: OWNER, repo: REPO, baseRef: NO_BASE_REF_SENTINEL, headSha: HEAD };
    for (const key of [dev, main, fork, sibling, noBase]) {
      await freshStore().increment(key, 1000);
    }

    await freshStore().clear(dev);

    expect(await requiredContextsDb.readRequiredContextsAttempts(dev)).toBe(0);
    // Every one of these was wiped by the head-scoped / repo-scoped clears the
    // review flagged. Each is a different question and keeps its own progress.
    expect(await requiredContextsDb.readRequiredContextsAttempts(main)).toBe(1);
    expect(await requiredContextsDb.readRequiredContextsAttempts(fork)).toBe(1);
    expect(await requiredContextsDb.readRequiredContextsAttempts(sibling)).toBe(1);
    expect(await requiredContextsDb.readRequiredContextsAttempts(noBase)).toBe(1);
  });

  test('D6 a success on one base leaves the other base able to reach its own bound', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '3' };
    await resolveRequiredContexts(failingInput({ baseRef: 'main' }), env);
    await resolveRequiredContexts(failingInput({ baseRef: 'main' }), env);

    // Repeated healthy ticks on `dev` for the same commit, each in its own
    // simulated process. None of them may touch `main`'s progress.
    for (let tick = 0; tick < 3; tick += 1) {
      const answered = await resolveRequiredContexts(
        failingInput({ fetchWithAppClient: async () => ({ data: ['docker-build'] }) }),
        env
      );
      expect(answered.state).toBe('known');
    }

    const exhausted = await resolveRequiredContexts(failingInput({ baseRef: 'main' }), env);
    expect(exhausted.state).toBe('exhausted');
    if (exhausted.state === 'exhausted') expect(exhausted.attempts).toBe(3);
  });

  test('D7 an answered lookup clears the durable row so a later blip defers again', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '3' };
    const key = { owner: OWNER, repo: REPO, baseRef: BASE, headSha: HEAD };
    await resolveRequiredContexts(failingInput(), env);
    await resolveRequiredContexts(failingInput(), env);
    expect(await requiredContextsDb.readRequiredContextsAttempts(key)).toBe(2);

    await resolveRequiredContexts(
      failingInput({ fetchWithAppClient: async () => ({ data: ['docker-build'] }) }),
      env
    );
    expect(await requiredContextsDb.readRequiredContextsAttempts(key)).toBe(0);

    // And the next failure starts the bound over rather than blocking at once.
    expect((await resolveRequiredContexts(failingInput(), env)).state).toBe('unknown');
  });

  test('D8 stale rows are retired by AGE, never by another key arriving', async () => {
    const stale = { owner: OWNER, repo: REPO, baseRef: BASE, headSha: HEAD };
    const live = { owner: OWNER, repo: REPO, baseRef: BASE, headSha: OTHER_HEAD };
    const ttlMs = 60_000;
    const t0 = Date.parse('2026-09-07T00:00:00.000Z');
    await requiredContextsDb.incrementRequiredContextsAttempt(stale, new Date(t0));
    await requiredContextsDb.incrementRequiredContextsAttempt(live, new Date(t0 + ttlMs * 2));

    const removed = await requiredContextsDb.pruneRequiredContextsAttempts(
      ttlMs,
      new Date(t0 + ttlMs * 2)
    );
    expect(removed).toBe(1);
    expect(await requiredContextsDb.readRequiredContextsAttempts(stale)).toBe(0);
    // The live key is untouched: it was never abandoned, only unlucky enough to
    // share a table with one that was.
    expect(await requiredContextsDb.readRequiredContextsAttempts(live)).toBe(1);
  });

  test('D9 a database fault DEFERS, it never blocks a PR on infrastructure', async () => {
    // Fail-soft is the whole safety argument: a db outage must not manufacture a
    // terminal BLOCK on someone's PR, and must not throw out of evidence
    // collection and fail the review for an unrelated reason.
    const brokenStore = createDurableAttemptCounterStore({
      loadDb: () => Promise.reject(new Error('database unavailable')),
    });
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '1' };
    const resolution = await resolveRequiredContexts(
      failingInput({ attemptStore: brokenStore }),
      env
    );
    // maxAttempts is 1, so a count of 1 would EXHAUST. The fault reports the
    // DEFER branch instead, leaving the reviewer retrying as it did before any
    // bound existed.
    expect(resolution.state).toBe('unknown');
  });

  test('D10 the sweep runs at most once per interval, not on every reviewer tick', async () => {
    let pruneCalls = 0;
    const store = createDurableAttemptCounterStore({
      loadDb: () =>
        Promise.resolve({
          ...requiredContextsDb,
          pruneRequiredContextsAttempts: async (ttlMs: number, now: Date) => {
            pruneCalls += 1;
            return requiredContextsDb.pruneRequiredContextsAttempts(ttlMs, now);
          },
        } as typeof requiredContextsDb),
      pruneIntervalMs: 10_000,
    });
    const key = { owner: OWNER, repo: REPO, baseRef: BASE, headSha: HEAD };
    await store.increment(key, 1_000);
    await store.increment(key, 2_000);
    await store.increment(key, 3_000);
    expect(pruneCalls).toBe(1);

    // Past the interval it sweeps once more, and only once more.
    await store.increment(key, 20_000);
    await store.increment(key, 21_000);
    expect(pruneCalls).toBe(2);
  });
});
