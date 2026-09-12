import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';
import { Database } from 'bun:sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

import { createAuthenticatedMessage } from './dispatch';
import {
  abandonAdoptionSnapshot,
  beginAdoptionSnapshot,
  clearSuppression,
  commitAdoptionSnapshot,
  expireParkedActions,
  getSuppression,
  setSuppression,
  getActionByIdempotencyKey,
  getActionsSince,
  getAdoption,
  getAdoptionCount,
  getAdoptionMeta,
  getAdoptionPartialCount,
  getHealthSample,
  getRecentUsageSamples,
  getPauseState,
  gradeAction,
  recordAction,
  recordResetAudit,
  resetTaskmaster,
  recordUsageSample,
  registerExpectation,
  registerExpectationReportingCreation,
  listExpectations,
  countExternalExpectationsSince,
  expectationKeyExists,
  listDueExpectations,
  markMet,
  markFailed,
  claimRedispatchAttempt,
  claimRecoveryReplay,
  claimEscalation,
  markEscalated,
  markGivenUp,
  getExpectationCounts,
  setPauseState,
  updateActionOutcome,
  upsertAdoptionRow,
  upsertHealthSample,
  type TmAdoptionRow,
} from './taskmaster';

describe('tm_expectations DAL', () => {
  test('a fresh database creates tm_expectations with the unique index and escalating', async () => {
    // The path that actually matters: tm_expectations ships for the first time
    // in this WO, so every real database takes this one.
    const createSql = await db.query<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_expectations'"
    );
    expect(createSql.rows[0]?.sql).toContain('registration_key');
    expect(createSql.rows[0]?.sql).toContain('escalating');
    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = $1",
      ['idx_tm_expectations_registration_key']
    );
    expect(indexes.rows).toHaveLength(1);
    // And the intermediate state the CHECK exists for is actually usable.
    const id = await registerExpectation({
      action_ref: 'fresh-db',
      dispatch_ref: 'fresh-dispatch',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'escalate',
      max_retries: 0,
    });
    expect(await claimEscalation(id, 'tm:expectation:fresh:escalate')).toBe(true);
  });

  test('an EMPTY legacy-shaped table is recreated and registration works', async () => {
    // Recreating an empty table is lossless, so the adapter just does it.
    const legacyPath = join(tmpdir(), `taskmaster-empty-${Date.now()}-${Math.random()}.db`);
    const seed = new Database(legacyPath);
    // Outdated on all three counts: no registration_key, CHECK without
    // 'escalating', no unique index.
    seed.run(`CREATE TABLE tm_expectations (
      id TEXT PRIMARY KEY,
      dispatch_ref TEXT NOT NULL,
      recipient TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      due_at TEXT NOT NULL,
      on_absence TEXT NOT NULL CHECK (on_absence IN ('redispatch', 'escalate', 'give_up')),
      max_retries INTEGER NOT NULL DEFAULT 0 CHECK (max_retries >= 0),
      retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'met', 'failed', 'escalated', 'given_up')
      ),
      evidence_pointer TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    seed.close();

    const upgraded = new SqliteAdapter(legacyPath);
    try {
      const previous = db;
      db = upgraded;
      try {
        const createSql = await upgraded.query<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_expectations'"
        );
        expect(createSql.rows[0]?.sql).toContain('escalating');
        expect(createSql.rows[0]?.sql).toContain('registration_key');
        const indexes = await upgraded.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = $1",
          ['idx_tm_expectations_registration_key']
        );
        expect(indexes.rows).toHaveLength(1);

        const id = await registerExpectation({
          action_ref: 'after-recreate',
          dispatch_ref: 'recreated',
          recipient: 'xo',
          evidence_json: '{}',
          due_at: new Date(0).toISOString(),
          on_absence: 'escalate',
          max_retries: 0,
        });
        expect(await claimEscalation(id, 'tm:expectation:recreated:escalate')).toBe(true);
      } finally {
        db = previous;
      }
    } finally {
      await upgraded.close();
      cleanupDb(legacyPath);
    }
  });

  test('a NON-EMPTY legacy-shaped table refuses startup and leaves rows untouched', async () => {
    // THE DESIGN DECISION. Rather than deriving registration_key values -- every
    // scheme that mixes preserved and derived keys can collide, and a collision
    // fails the unique index and blocks startup anyway -- the adapter refuses
    // loudly and names the one-off operator script. A human inspects the rows;
    // a startup path does not guess at identities.
    const legacyPath = join(tmpdir(), `taskmaster-nonempty-${Date.now()}-${Math.random()}.db`);
    const seed = new Database(legacyPath);
    seed.run(`CREATE TABLE tm_expectations (
      id TEXT PRIMARY KEY,
      dispatch_ref TEXT NOT NULL,
      recipient TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      due_at TEXT NOT NULL,
      on_absence TEXT NOT NULL CHECK (on_absence IN ('redispatch', 'escalate', 'give_up')),
      max_retries INTEGER NOT NULL DEFAULT 0 CHECK (max_retries >= 0),
      retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'met', 'failed', 'escalated', 'given_up')
      ),
      evidence_pointer TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    seed.run(
      `INSERT INTO tm_expectations
       (id, dispatch_ref, recipient, evidence_json, due_at, on_absence, max_retries, retries, status, created_at, updated_at)
       VALUES ('older','dup','xo','{}','1970-01-01T00:00:00.000Z','escalate',0,0,'pending','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
              ('newer','dup','xo','{}','1970-01-01T00:00:00.000Z','escalate',0,0,'pending','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`
    );
    seed.close();

    // Startup fails, and the message is ACTIONABLE: table, row count, script.
    expect(() => new SqliteAdapter(legacyPath)).toThrow(/tm_expectations/);
    expect(() => new SqliteAdapter(legacyPath)).toThrow(/2 row\(s\)/);
    expect(() => new SqliteAdapter(legacyPath)).toThrow(/repair-tm-expectations/);

    // THE ROWS ARE UNTOUCHED -- refusing must not mutate anything.
    const check = new Database(legacyPath);
    try {
      const rows = check
        .query<{ id: string }, []>('SELECT id FROM tm_expectations ORDER BY id')
        .all();
      expect(rows.map(r => r.id)).toEqual(['newer', 'older']);
      const sql = check
        .query<
          { sql: string },
          []
        >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_expectations'")
        .get();
      // Still the ORIGINAL schema: no silent partial migration happened.
      expect(sql?.sql).not.toContain('registration_key');
    } finally {
      check.close();
    }
    cleanupDb(legacyPath);
  });

  test('a second startup on a correct table is a no-op', async () => {
    const path = join(tmpdir(), `taskmaster-noop-${Date.now()}-${Math.random()}.db`);
    const first = new SqliteAdapter(path);
    let firstSql: string | undefined;
    try {
      const previous = db;
      db = first;
      try {
        await registerExpectation({
          action_ref: 'noop-check',
          dispatch_ref: 'noop-dispatch',
          recipient: 'xo',
          evidence_json: '{}',
          due_at: new Date(0).toISOString(),
          on_absence: 'escalate',
          max_retries: 0,
        });
        firstSql = (
          await first.query<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_expectations'"
          )
        ).rows[0]?.sql;
      } finally {
        db = previous;
      }
    } finally {
      await first.close();
    }

    // Reopening must neither recreate the table nor drop the row.
    const second = new SqliteAdapter(path);
    try {
      const rows = await second.query<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM tm_expectations'
      );
      expect(Number(rows.rows[0]?.cnt)).toBe(1);
      const secondSql = (
        await second.query<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_expectations'"
        )
      ).rows[0]?.sql;
      expect(secondSql).toBe(firstSql);
    } finally {
      await second.close();
      cleanupDb(path);
    }
  });

  test('registering twice for the same dispatch yields one row and the same id', async () => {
    // REGRESSION. registerExpectation generated a random UUID per call and the
    // schema had no uniqueness on the identity, so replaying an action after a
    // crash between the dispatch and updateActionOutcome registered a SECOND
    // expectation for the same dispatch -- different id, therefore different
    // retry and escalation idempotency keys, therefore duplicate external work.
    //
    // Real sqlite, not a double.
    const registration = {
      action_ref: 'journal-action-1',
      dispatch_ref: 'dispatch-abc',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch' as const,
      max_retries: 2,
    };
    const first = await registerExpectation(registration);
    // The replay: same journal action, same dispatch, called again verbatim.
    const second = await registerExpectation(registration);
    expect(second).toBe(first);

    const rows = await db.query<{ cnt: number | string }>(
      'SELECT COUNT(*) AS cnt FROM tm_expectations WHERE dispatch_ref = $1',
      ['dispatch-abc']
    );
    expect(Number(rows.rows[0]?.cnt)).toBe(1);

    // The retry/escalation keys the supervisor derives are therefore identical
    // across the replay -- which is the whole point of the fix.
    expect(`tm:expectation:${second}:retry:1`).toBe(`tm:expectation:${first}:retry:1`);
    expect(`tm:expectation:${second}:escalate`).toBe(`tm:expectation:${first}:escalate`);

    // The replay must not resurrect a closed expectation either.
    expect(await markMet(first, 'https://example/proof')).toBe(true);
    const third = await registerExpectation(registration);
    expect(third).toBe(first);
    const after = await db.query<{ cnt: number | string }>(
      'SELECT COUNT(*) AS cnt FROM tm_expectations WHERE dispatch_ref = $1',
      ['dispatch-abc']
    );
    expect(Number(after.rows[0]?.cnt)).toBe(1);
    const status = await db.query<{ status: string }>(
      'SELECT status FROM tm_expectations WHERE id = $1',
      [first]
    );
    expect(status.rows[0]?.status).toBe('met');
  });

  test('different dispatches and different actions stay distinct expectations', async () => {
    // The uniqueness must not over-collapse: two genuinely different pieces of
    // work are two expectations, even when they share one half of the identity.
    const base = {
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch' as const,
      max_retries: 2,
    };
    const a = await registerExpectation({
      ...base,
      action_ref: 'action-1',
      dispatch_ref: 'dispatch-1',
    });
    const sameActionOtherDispatch = await registerExpectation({
      ...base,
      action_ref: 'action-1',
      dispatch_ref: 'dispatch-2',
    });
    const otherActionSameDispatch = await registerExpectation({
      ...base,
      action_ref: 'action-2',
      dispatch_ref: 'dispatch-1',
    });
    expect(new Set([a, sameActionOtherDispatch, otherActionSameDispatch]).size).toBe(3);
  });

  test('registration without an action_ref falls back to the dispatch_ref identity', async () => {
    // A caller with no journal action still gets idempotency, keyed on the
    // dispatch alone.
    const registration = {
      dispatch_ref: 'dispatch-no-action',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'escalate' as const,
      max_retries: 0,
    };
    const first = await registerExpectation(registration);
    const second = await registerExpectation(registration);
    expect(second).toBe(first);
    const rows = await db.query<{ cnt: number | string }>(
      'SELECT COUNT(*) AS cnt FROM tm_expectations WHERE dispatch_ref = $1',
      ['dispatch-no-action']
    );
    expect(Number(rows.rows[0]?.cnt)).toBe(1);
  });

  test('expectation_met_before_deadline', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-1',
      recipient: 'xo',
      evidence_json: JSON.stringify({ kind: 'issue_comment_exists', repo: 'x/y', number: 1 }),
      due_at: new Date(Date.now() + 60_000).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    const active = await listDueExpectations(new Date().toISOString());
    expect(active.map(row => row.id)).toContain(id);
    await markMet(id, 'https://github.com/x/y/issues/1#issuecomment-1');
    const row = await db.query<{ status: string; evidence_pointer: string }>(
      'SELECT status, evidence_pointer FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(row.rows[0]).toEqual({
      status: 'met',
      evidence_pointer: 'https://github.com/x/y/issues/1#issuecomment-1',
    });
  });

  test('retry and escalation mutations are bounded state transitions', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-2',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    expect(await claimRedispatchAttempt(id, 0, new Date().toISOString())).toBe(1);
    expect(await markEscalated(id, 'dispatch:escalation')).toBe(true);
    const row = await db.query<{ status: string; retries: number; evidence_pointer: string }>(
      'SELECT status, retries, evidence_pointer FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(row.rows[0]).toEqual({
      status: 'escalated',
      retries: 1,
      evidence_pointer: 'dispatch:escalation',
    });
  });

  test('give-up transition and aggregate counts include every status', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-give-up',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'give_up',
      max_retries: 0,
    });
    await markGivenUp(id, 'deadline elapsed');
    const counts = await getExpectationCounts();
    expect(counts.given_up).toBe(1);
    expect(counts.pending).toBe(0);
    expect(counts.met).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.escalated).toBe(0);
  });

  test('two concurrent claims on the same attempt: exactly one wins', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-cas',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    // Both ticks observed retries=0 and race to claim attempt 1.
    const [a, b] = await Promise.all([
      claimRedispatchAttempt(id, 0, dueAt),
      claimRedispatchAttempt(id, 0, dueAt),
    ]);
    // Fails on the old behaviour: the retry advance was an unconditional
    // UPDATE ... WHERE id = $1, so both ticks advanced the counter and sent.
    expect([a, b].filter(value => value !== null)).toEqual([1]);
    const row = await db.query<{ retries: number }>(
      'SELECT retries FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(Number(row.rows[0]?.retries)).toBe(1);
  });

  test('the claim advances the count before the send, so a crash cannot lose it', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-crash',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    const claimed = await claimRedispatchAttempt(id, 0, new Date().toISOString());
    expect(claimed).toBe(1);
    // Simulate the process dying here -- before any send. The counter is
    // already durable, so the retry budget cannot be replayed from zero.
    const row = await db.query<{ retries: number; status: string }>(
      'SELECT retries, status FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(Number(row.rows[0]?.retries)).toBe(1);
    expect(row.rows[0]?.status).toBe('failed');
    // A tick that still believes retries=0 cannot re-claim attempt 1.
    expect(await claimRedispatchAttempt(id, 0, new Date().toISOString())).toBeNull();
  });

  test('two ticks race met vs failed: exactly one transition wins', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-race-met-failed',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    // Tick A verified the evidence; tick B saw the deadline pass. Both act on
    // the same pending snapshot.
    const [met, failed] = await Promise.all([markMet(id, 'https://example/proof'), markFailed(id)]);
    // Fails on the old behaviour: both were blind UPDATE ... WHERE id = $1, so
    // both "succeeded" and the later write silently won.
    expect([met, failed].filter(Boolean)).toHaveLength(1);
    const row = await db.query<{ status: string; evidence_pointer: string | null }>(
      'SELECT status, evidence_pointer FROM tm_expectations WHERE id = $1',
      [id]
    );
    // Whichever won, a terminal met must never be regressed to failed.
    if (met) {
      expect(row.rows[0]?.status).toBe('met');
      expect(row.rows[0]?.evidence_pointer).toBe('https://example/proof');
    } else {
      expect(row.rows[0]?.status).toBe('failed');
    }
  });

  test('a terminal met is never regressed by a stale worker', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-no-regress',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    expect(await markMet(id, 'https://example/proof')).toBe(true);
    // Every other transition a stale tick could attempt must now be refused.
    expect(await markFailed(id)).toBe(false);
    expect(await markEscalated(id, 'dispatch:late')).toBe(false);
    expect(await markGivenUp(id, 'late')).toBe(false);
    expect(await markMet(id, 'https://example/second-observer')).toBe(false);
    const row = await db.query<{ status: string; evidence_pointer: string | null }>(
      'SELECT status, evidence_pointer FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(row.rows[0]?.status).toBe('met');
    expect(row.rows[0]?.evidence_pointer).toBe('https://example/proof');
  });

  test('two ticks race claim vs met: a verified expectation is never redispatched', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-race-claim-met',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    const [met, claimed] = await Promise.all([
      markMet(id, 'https://example/proof'),
      claimRedispatchAttempt(id, 0, new Date().toISOString()),
    ]);
    // Exactly one wins. The retry-counter CAS alone did NOT prevent this --
    // the active-status predicate on the claim is what closes it.
    expect([met, claimed !== null].filter(Boolean)).toHaveLength(1);
    const row = await db.query<{ status: string; retries: number }>(
      'SELECT status, retries FROM tm_expectations WHERE id = $1',
      [id]
    );
    if (met) {
      expect(claimed).toBeNull();
      expect(row.rows[0]?.status).toBe('met');
      expect(Number(row.rows[0]?.retries)).toBe(0);
    } else {
      expect(claimed).toBe(1);
      expect(row.rows[0]?.status).toBe('failed');
    }
  });

  test('a claim against an already-met expectation is refused outright', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-claim-after-met',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    expect(await markMet(id, 'https://example/proof')).toBe(true);
    // The retry count is still 0 and under the cap, so the pre-repair CAS --
    // which checked only retries -- would have claimed and redispatched work
    // that had already succeeded.
    expect(await claimRedispatchAttempt(id, 0, new Date().toISOString())).toBeNull();
    const row = await db.query<{ status: string; retries: number }>(
      'SELECT status, retries FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(row.rows[0]?.status).toBe('met');
    expect(Number(row.rows[0]?.retries)).toBe(0);
  });

  test('claimRecoveryReplay moves the deadline without spending a retry', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-recovery',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    expect(await claimRedispatchAttempt(id, 0, new Date(0).toISOString())).toBe(1);
    const fresh = new Date(Date.now() + 900_000).toISOString();
    expect(await claimRecoveryReplay(id, 1, fresh, new Date(0).toISOString())).toBe(true);
    const row = await db.query<{ due_at: string; retries: number; status: string }>(
      'SELECT due_at, retries, status FROM tm_expectations WHERE id = $1',
      [id]
    );
    // The deadline moved; the retry count did NOT -- recovery finishes an
    // attempt already paid for rather than buying another.
    expect(Date.parse(String(row.rows[0]?.due_at))).toBe(Date.parse(fresh));
    expect(Number(row.rows[0]?.retries)).toBe(1);
    expect(row.rows[0]?.status).toBe('failed');
  });

  test('two ticks race the recovery replay: exactly one wins', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-recovery-race',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    expect(await claimRedispatchAttempt(id, 0, new Date(0).toISOString())).toBe(1);
    const fresh = new Date(Date.now() + 900_000).toISOString();
    const [a, b] = await Promise.all([
      claimRecoveryReplay(id, 1, fresh, new Date(0).toISOString()),
      claimRecoveryReplay(id, 1, fresh, new Date(0).toISOString()),
    ]);
    // The claim is what makes the replay exclusive: both ticks see the same
    // unsent attempt, only one may put it on the wire.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  test('recovery replay is refused once the expectation is terminal', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-recovery-met',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 2,
    });
    expect(await claimRedispatchAttempt(id, 0, new Date(0).toISOString())).toBe(1);
    expect(await markMet(id, 'https://example/proof')).toBe(true);
    // A tick racing a concurrent verification must not replay a dispatch for
    // work that already succeeded.
    expect(
      await claimRecoveryReplay(id, 1, new Date().toISOString(), new Date(0).toISOString())
    ).toBe(false);
  });

  test('claimEscalation is exclusive and leaves the row selectable for replay', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-escalating',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'escalate',
      max_retries: 0,
    });
    const [a, b] = await Promise.all([
      claimEscalation(id, 'tm:expectation:x:escalate'),
      claimEscalation(id, 'tm:expectation:x:escalate'),
    ]);
    // Exclusive: a worker that loses never sends.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const row = await db.query<{ status: string }>(
      'SELECT status FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(row.rows[0]?.status).toBe('escalating');
    // NOT terminal: the tick must still see it so an unconfirmed send is
    // replayed rather than lost.
    const due = await listDueExpectations(new Date().toISOString());
    expect(due.map(r => r.id)).toContain(id);
  });

  test('markEscalated closes an escalating row, and escalating blocks a stale failure', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-escalating-close',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'escalate',
      max_retries: 0,
    });
    expect(await claimEscalation(id, 'tm:expectation:y:escalate')).toBe(true);
    // A stale worker cannot drag a claimed escalation back to failed.
    expect(await markFailed(id)).toBe(false);
    // The confirm closes it.
    expect(await markEscalated(id, 'tm:expectation:y:escalate')).toBe(true);
    const row = await db.query<{ status: string }>(
      'SELECT status FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(row.rows[0]?.status).toBe('escalated');
    // Terminal: gone from the due list, and no further transition succeeds.
    const due = await listDueExpectations(new Date().toISOString());
    expect(due.map(r => r.id)).not.toContain(id);
    expect(await markEscalated(id, 'again')).toBe(false);
  });

  test('evidence during escalating closes the row as met, against the real DAL', async () => {
    // REGRESSION. markMet used to accept only ['pending','failed'], so a row
    // that had entered 'escalating' could never be closed by late evidence:
    // markMet returned false, the supervisor continued past the rejected
    // transition, and the row stayed 'escalating' forever with every later tick
    // repeating the same failed close.
    //
    // This exercises the REAL sqlite DAL, not a double. The round-5 supervisor
    // test asserted this behaviour through a markMet stub that always returned
    // true, so it passed while the invariant underneath it was broken.
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-met-during-escalating',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'escalate',
      max_retries: 0,
    });
    expect(await claimEscalation(id, 'tm:expectation:m:escalate')).toBe(true);
    const claimed = await db.query<{ status: string }>(
      'SELECT status FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(claimed.rows[0]?.status).toBe('escalating');

    // Late evidence must still close it.
    expect(await markMet(id, 'https://example/late-proof')).toBe(true);
    const row = await db.query<{ status: string; evidence_pointer: string | null }>(
      'SELECT status, evidence_pointer FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(row.rows[0]?.status).toBe('met');
    expect(row.rows[0]?.evidence_pointer).toBe('https://example/late-proof');

    // A subsequent tick must not re-escalate or re-send: the row is terminal,
    // so it is gone from the due list and every further transition is refused.
    const due = await listDueExpectations(new Date().toISOString());
    expect(due.map(r => r.id)).not.toContain(id);
    expect(await claimEscalation(id, 'tm:expectation:m:escalate')).toBe(false);
    expect(await markEscalated(id, 'tm:expectation:m:escalate')).toBe(false);
    expect(await markFailed(id)).toBe(false);
    expect(await markMet(id, 'https://example/second-observer')).toBe(false);
    const final = await db.query<{ status: string; evidence_pointer: string | null }>(
      'SELECT status, evidence_pointer FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(final.rows[0]?.status).toBe('met');
    expect(final.rows[0]?.evidence_pointer).toBe('https://example/late-proof');
  });

  test('claimEscalation is refused once the expectation is met', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-escalate-after-met',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'escalate',
      max_retries: 0,
    });
    expect(await markMet(id, 'https://example/proof')).toBe(true);
    // The round-4 guarantee, preserved: a worker racing a verification loses
    // the claim and therefore never sends the blocker.
    expect(await claimEscalation(id, 'tm:expectation:z:escalate')).toBe(false);
  });

  test('the claim refuses to exceed max_retries', async () => {
    const id = await registerExpectation({
      dispatch_ref: 'dispatch-cap',
      recipient: 'xo',
      evidence_json: '{}',
      due_at: new Date(0).toISOString(),
      on_absence: 'redispatch',
      max_retries: 1,
    });
    expect(await claimRedispatchAttempt(id, 0, new Date().toISOString())).toBe(1);
    expect(await claimRedispatchAttempt(id, 1, new Date().toISOString())).toBeNull();
    const row = await db.query<{ retries: number }>(
      'SELECT retries FROM tm_expectations WHERE id = $1',
      [id]
    );
    expect(Number(row.rows[0]?.retries)).toBe(1);
  });
});

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

beforeEach(() => {
  currentDbPath = join(tmpdir(), `taskmaster-test-${Date.now()}-${Math.random()}.db`);
  db = new SqliteAdapter(currentDbPath);
});

afterEach(async () => {
  await db.close();
  cleanupDb(currentDbPath);
});

describe('tm_journal DAL', () => {
  test('reset winning before notice enqueue rejects the obsolete paused epoch', async () => {
    await db.query(`INSERT INTO dispatch_principals
      (principal_id, display_name, delivery_mode, active)
      VALUES ('duty-officer', 'Duty Officer fixture', 'drain_on_start', 1)`);
    const paused = await setPauseState({
      pause_state: 'PAUSED',
      pause_scope: 'effects',
      pause_reason: 'noise floor',
      pause_actor: 'taskmaster:useful-rate-floor',
    });
    // Reproduce reset committing after the loop read but before Dispatch enqueue.
    await resetTaskmaster({ actor: 'operator', reason: 'recover' });
    const notice = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      {
        correlation_id: 'taskmaster-self-pause-race',
        idempotency_key: `tm:self-pause:${paused.epoch}`,
        task_type: 'agent_message',
        recipient: 'duty-officer',
        body: 'Taskmaster paused; reset guidance.',
      },
      {
        taskmasterPausedEpoch: paused.epoch,
        taskmasterPausedState: 'PAUSED',
        taskmasterPausedScope: 'effects',
      }
    );
    expect(notice).toBeNull();
    expect(
      (
        await db.query(
          "SELECT id FROM agent_dispatch_messages WHERE correlation_id = 'taskmaster-self-pause-race'"
        )
      ).rows
    ).toEqual([]);
  });

  test('notice enqueue holds the SQLite writer fence across control read and insert', async () => {
    await db.query(`INSERT INTO dispatch_principals
      (principal_id, display_name, delivery_mode, active)
      VALUES ('duty-officer', 'Duty Officer fixture', 'drain_on_start', 1)`);
    const paused = await setPauseState({ pause_state: 'PAUSED', pause_scope: 'effects' });
    const other = new Database(currentDbPath);
    other.run('PRAGMA busy_timeout=0');
    const originalQuery = db.query.bind(db);
    let competingResetError: unknown;
    let controlReadObserved = false;
    db.query = async <T>(sql: string, params?: unknown[]) => {
      const result = await originalQuery<T>(sql, params);
      if (sql.startsWith('SELECT pause_state, pause_scope, epoch FROM tm_control')) {
        controlReadObserved = true;
        try {
          other.run("UPDATE tm_control SET pause_state='RUNNING', epoch=epoch+1 WHERE id=1");
        } catch (error) {
          competingResetError = error;
        }
      }
      return result;
    };
    const data = {
      correlation_id: 'notice-writer-fence',
      idempotency_key: `tm:self-pause:${paused.epoch}`,
      task_type: 'agent_message' as const,
      recipient: 'duty-officer',
      body: 'Paused; reset guidance.',
    };
    try {
      const notice = await createAuthenticatedMessage(
        { kind: 'system', sender: 'taskmaster' },
        data,
        {
          taskmasterPausedEpoch: paused.epoch,
          taskmasterPausedState: 'PAUSED',
          taskmasterPausedScope: 'effects',
        }
      );
      expect(controlReadObserved).toBe(true);
      expect(String(competingResetError)).toContain('locked');
      expect(notice?.status).toBe('queued');
      db.query = originalQuery;
      const retry = await createAuthenticatedMessage(
        { kind: 'system', sender: 'taskmaster' },
        data,
        {
          taskmasterPausedEpoch: paused.epoch,
          taskmasterPausedState: 'PAUSED',
          taskmasterPausedScope: 'effects',
        }
      );
      expect(retry?.id).toBe(notice?.id);
      expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(1);
      await resetTaskmaster({ actor: 'operator', reason: 'after valid enqueue' });
      expect(
        await createAuthenticatedMessage({ kind: 'system', sender: 'taskmaster' }, data, {
          taskmasterPausedEpoch: paused.epoch,
          taskmasterPausedState: 'PAUSED',
          taskmasterPausedScope: 'effects',
        })
      ).toBeNull();
    } finally {
      db.query = originalQuery;
      other.close();
    }
  });

  test('notice fence accepts a paused epoch returned as text by the database driver', async () => {
    await db.query(`INSERT INTO dispatch_principals
      (principal_id, display_name, delivery_mode, active)
      VALUES ('duty-officer', 'Duty Officer fixture', 'drain_on_start', 1)`);
    const paused = await setPauseState({ pause_state: 'PAUSED', pause_scope: 'effects' });
    const originalQuery = db.query.bind(db);
    db.query = <T>(sql: string, params?: unknown[]) =>
      originalQuery<T>(
        sql.replace(
          'SELECT pause_state, pause_scope, epoch FROM tm_control',
          'SELECT pause_state, pause_scope, CAST(epoch AS TEXT) AS epoch FROM tm_control'
        ),
        params
      );
    try {
      const notice = await createAuthenticatedMessage(
        { kind: 'system', sender: 'taskmaster' },
        {
          correlation_id: 'text-epoch',
          idempotency_key: `tm:self-pause:${paused.epoch}`,
          task_type: 'agent_message',
          recipient: 'duty-officer',
          body: 'valid paused notice',
        },
        {
          taskmasterPausedEpoch: paused.epoch,
          taskmasterPausedState: 'PAUSED',
          taskmasterPausedScope: 'effects',
        }
      );
      expect(notice?.status).toBe('queued');
      expect(
        (await db.query("SELECT id FROM agent_dispatch_messages WHERE correlation_id='text-epoch'"))
          .rowCount
      ).toBe(1);
    } finally {
      db.query = originalQuery;
    }
  });

  test('notice fence refuses a concurrent HARD_PAUSE at the authorized epoch', async () => {
    await db.query(`INSERT INTO dispatch_principals
      (principal_id, display_name, delivery_mode, active)
      VALUES ('duty-officer', 'Duty Officer fixture', 'drain_on_start', 1)`);
    const paused = await setPauseState({
      pause_state: 'PAUSED',
      pause_scope: 'effects',
      pause_reason: 'noise floor',
      pause_actor: 'taskmaster:useful-rate-floor',
    });
    // A hard pause is an escalation, not a reset: it does NOT bump the epoch,
    // so an epoch-only fence would still let the notice escape it.
    await db.query("UPDATE tm_control SET pause_state='HARD_PAUSE' WHERE id=1");
    expect(
      (await db.query<{ epoch: number }>('SELECT epoch FROM tm_control WHERE id=1')).rows[0]
    ).toEqual({ epoch: paused.epoch });
    const notice = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      {
        correlation_id: 'hard-pause-notice',
        idempotency_key: `tm:self-pause:${paused.epoch}`,
        task_type: 'agent_message',
        recipient: 'duty-officer',
        body: 'must not escape a hard pause',
      },
      {
        taskmasterPausedEpoch: paused.epoch,
        taskmasterPausedState: 'PAUSED',
        taskmasterPausedScope: 'effects',
      }
    );
    expect(notice).toBeNull();
    expect(
      (
        await db.query(
          "SELECT id FROM agent_dispatch_messages WHERE correlation_id='hard-pause-notice'"
        )
      ).rows
    ).toEqual([]);
  });

  test('notice fence refuses a concurrent re-pause onto a different scope', async () => {
    await db.query(`INSERT INTO dispatch_principals
      (principal_id, display_name, delivery_mode, active)
      VALUES ('duty-officer', 'Duty Officer fixture', 'drain_on_start', 1)`);
    const paused = await setPauseState({
      pause_state: 'PAUSED',
      pause_scope: 'effects',
      pause_reason: 'noise floor',
      pause_actor: 'taskmaster:useful-rate-floor',
    });
    // Re-pausing onto a wider scope at the same epoch: the caller's exemption
    // decision was made against 'effects' and no longer holds.
    await db.query("UPDATE tm_control SET pause_scope='all' WHERE id=1");
    const notice = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      {
        correlation_id: 'scope-change-notice',
        idempotency_key: `tm:self-pause:${paused.epoch}`,
        task_type: 'agent_message',
        recipient: 'duty-officer',
        body: 'must not escape a wider scope',
      },
      {
        taskmasterPausedEpoch: paused.epoch,
        taskmasterPausedState: 'PAUSED',
        taskmasterPausedScope: 'effects',
      }
    );
    expect(notice).toBeNull();
    expect(
      (
        await db.query(
          "SELECT id FROM agent_dispatch_messages WHERE correlation_id='scope-change-notice'"
        )
      ).rows
    ).toEqual([]);
  });

  test('notice fence rejects a fence that does not name the authorized PAUSED state', async () => {
    await expect(
      createAuthenticatedMessage(
        { kind: 'system', sender: 'taskmaster' },
        {
          correlation_id: 'hard-pause-fence-arg',
          idempotency_key: 'tm:self-pause:0',
          task_type: 'agent_message',
          recipient: 'duty-officer',
          body: 'fence must name PAUSED',
        },
        {
          taskmasterPausedEpoch: 0,
          taskmasterPausedState: 'HARD_PAUSE' as unknown as 'PAUSED',
          taskmasterPausedScope: 'effects',
        }
      )
    ).rejects.toThrow('taskmaster_notice_fence_invalid');
  });

  test('notice fence cannot be used by a different system sender', async () => {
    await expect(
      createAuthenticatedMessage(
        { kind: 'system', sender: 'overseer' },
        {
          correlation_id: 'invalid-notice',
          idempotency_key: 'tm:self-pause:0',
          task_type: 'agent_message',
          recipient: 'duty-officer',
          body: 'not Taskmaster',
        },
        {
          taskmasterPausedEpoch: 0,
          taskmasterPausedState: 'PAUSED',
          taskmasterPausedScope: 'effects',
        }
      )
    ).rejects.toThrow('taskmaster_notice_fence_invalid');
  });

  test('records one distinct reset audit row per invocation', async () => {
    const first = await recordResetAudit({
      actor: 'operator',
      reason: 'recover Taskmaster',
      previousEpoch: 1,
      newEpoch: 2,
      transitioned: true,
    });
    const second = await recordResetAudit({
      actor: 'operator',
      reason: 'recover Taskmaster',
      previousEpoch: 2,
      newEpoch: 2,
      transitioned: false,
    });
    expect(first.id).not.toBe(second.id);
    const audits = await db.query<{ proposal_json: string }>(
      "SELECT proposal_json FROM tm_journal WHERE thread_ref = 'taskmaster:reset'"
    );
    expect(audits.rows).toHaveLength(2);
    expect(JSON.parse(audits.rows[1]!.proposal_json).transitioned).toBe(false);
  });

  test('reset is safe twice: expires once, increments once, and audits both calls', async () => {
    await setPauseState({
      pause_state: 'PAUSED',
      pause_scope: 'effects',
      pause_reason: 'floor',
      pause_actor: 'taskmaster:useful-rate-floor',
    });
    const before = await getPauseState();
    await recordAction({
      thread_ref: 'gh:test/repo#1',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'parked',
    });

    const first = await resetTaskmaster({ actor: 'operator', reason: 'recover' });
    const second = await resetTaskmaster({ actor: 'operator', reason: 'recover' });

    expect(first.control.pause_state).toBe('RUNNING');
    expect(first.control.epoch).toBe(before.epoch + 1);
    expect(first.expiredProposals).toBe(1);
    expect(second.control.epoch).toBe(first.control.epoch);
    expect(second.expiredProposals).toBe(0);
    expect(first.audit.id).not.toBe(second.audit.id);
    const audits = await db.query<{ cnt: number | string }>(
      "SELECT COUNT(*) AS cnt FROM tm_journal WHERE thread_ref = 'taskmaster:reset'"
    );
    expect(Number(audits.rows[0]?.cnt)).toBe(2);
  });

  test('already-running reset preserves the epoch window and accumulated noise grades', async () => {
    const epochStart = new Date(Date.now() - 3_600_000).toISOString();
    const evidenceAt = new Date(Date.now() - 1_800_000).toISOString();
    await db.query(
      "UPDATE tm_control SET pause_state='RUNNING', epoch=7, updated_at=$1 WHERE id=1",
      [epochStart]
    );
    for (let i = 0; i < 20; i++) {
      const action = await recordAction({
        thread_ref: `gh:test/noise#${String(i)}`,
        action_type: 'nudge',
        proposal_json: '{}',
        outcome: 'sent',
      });
      await gradeAction(action.id, 'noise');
    }
    await db.query('UPDATE tm_journal SET created_at=$1', [evidenceAt]);
    const reset = await resetTaskmaster({ actor: 'operator', reason: 'repeat' });
    expect(reset.control.epoch).toBe(7);
    expect(reset.control.updated_at).toBe(epochStart);
    expect(JSON.parse(reset.audit.proposal_json).transitioned).toBe(false);
    const window = await getActionsSince(reset.control.updated_at);
    expect(window.filter(row => row.grade === 'noise')).toHaveLength(20);
  });

  test('concurrent resets increment the epoch once and report their own atomic audit', async () => {
    await setPauseState({ pause_state: 'PAUSED', pause_scope: 'effects', pause_actor: 'test' });
    const before = await getPauseState();
    await recordAction({
      thread_ref: 'gh:test/repo#1',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'parked',
    });
    const results = await Promise.all([
      resetTaskmaster({ actor: 'first', reason: 'recover' }),
      resetTaskmaster({ actor: 'second', reason: 'recover' }),
    ]);
    expect((await getPauseState()).epoch).toBe(before.epoch + 1);
    expect(results.map(result => result.expiredProposals).sort()).toEqual([0, 1]);
    const audits = results.map(result => JSON.parse(result.audit.proposal_json));
    expect(audits.filter(audit => audit.transitioned)).toHaveLength(1);
    expect(audits.map(audit => audit.new_epoch)).toEqual([before.epoch + 1, before.epoch + 1]);
    expect(new Set(results.map(result => result.audit.id)).size).toBe(2);
    expect(results[0]!.control.pause_actor).toBe('first');
    expect(results[1]!.control.pause_actor).toBe('second');
  });

  test('audit insertion failure rolls back reset state and proposal expiration', async () => {
    await setPauseState({ pause_state: 'PAUSED', pause_scope: 'effects', pause_actor: 'test' });
    const before = await getPauseState();
    const action = await recordAction({
      thread_ref: 'gh:test/repo#1',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'parked',
    });
    await db.query(`CREATE TRIGGER reject_reset_audit BEFORE INSERT ON tm_journal
      WHEN NEW.thread_ref = 'taskmaster:reset'
      BEGIN SELECT RAISE(ABORT, 'test reset audit failure'); END`);
    await expect(resetTaskmaster({ actor: 'operator', reason: 'recover' })).rejects.toThrow(
      'test reset audit failure'
    );
    expect(await getPauseState()).toEqual(before);
    expect(
      (await db.query('SELECT outcome FROM tm_journal WHERE id = $1', [action.id])).rows
    ).toEqual([{ outcome: 'parked' }]);
    expect(
      (await db.query("SELECT id FROM tm_journal WHERE thread_ref = 'taskmaster:reset'")).rows
    ).toEqual([]);
  });

  test('fire_cauldron is accepted by the fresh SQLite CHECK', async () => {
    const row = await recordAction({
      thread_ref: 'gh:thinmansoftware/bdc-harness#99',
      action_type: 'fire_cauldron',
      proposal_json: '{"type":"fire_cauldron"}',
      idempotency_key: 'tm:fire:gh:thinmansoftware/bdc-harness#99:1',
      outcome: 'pending',
    });
    expect(row.action_type).toBe('fire_cauldron');
  });

  test('existing four-verb SQLite journal is rebuilt in place', async () => {
    await db.close();
    cleanupDb(currentDbPath);
    const old = new Database(currentDbPath);
    old.run(`CREATE TABLE tm_journal (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, thread_ref TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK (action_type IN ('deliver_ruling','nudge','escalate_p0','digest')),
      proposal_json TEXT NOT NULL, idempotency_key TEXT, before_hash TEXT,
      proof_predicate TEXT, proof_deadline_at TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('pending','sent','parked','deferred','rejected','expired','failed')),
      graded_at TEXT, grade TEXT CHECK (grade IS NULL OR grade IN ('useful','noise','harmful'))
    )`);
    old.run(
      "INSERT INTO tm_journal (id,created_at,thread_ref,action_type,proposal_json,outcome) VALUES ('old','2026-08-24T00:00:00Z','gh:x/y#1','digest','{}','sent')"
    );
    old.close();
    db = new SqliteAdapter(currentDbPath);
    await db.query(
      'INSERT INTO tm_journal (id,created_at,thread_ref,action_type,proposal_json,outcome) VALUES ($1,$2,$3,$4,$5,$6)',
      ['fire', '2026-08-24T01:00:00Z', 'gh:x/y#2', 'fire_cauldron', '{}', 'sent']
    );
    const rows = await db.query<{ action_type: string }>(
      'SELECT action_type FROM tm_journal ORDER BY created_at'
    );
    expect(rows.rows.map(row => row.action_type)).toEqual(['digest', 'fire_cauldron']);
  });

  test('recordAction writes a row-first pending entry and updateActionOutcome flips it', async () => {
    const row = await recordAction({
      thread_ref: 'gh:thinmansoftware/bdc-harness#1',
      action_type: 'nudge',
      proposal_json: '{"type":"nudge"}',
      idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-harness#1:1',
      before_hash: 'abc',
      proof_predicate: 'dispatch row exists',
      proof_deadline_at: new Date(Date.now() + 86_400_000).toISOString(),
      outcome: 'pending',
    });
    expect(row.id.length).toBeGreaterThan(0);
    expect(row.outcome).toBe('pending');
    expect(row.grade).toBeNull();

    const updated = await updateActionOutcome(row.id, 'sent');
    expect(updated?.outcome).toBe('sent');
  });

  test('recordAction returns one logical row for repeated idempotency keys', async () => {
    const input = {
      thread_ref: 'digest:2026-08-09',
      action_type: 'digest' as const,
      proposal_json: '{"type":"digest"}',
      idempotency_key: 'tm:digest:2026-08-09',
      proof_deadline_at: new Date(Date.now() + 86_400_000).toISOString(),
      outcome: 'pending' as const,
    };

    const first = await recordAction(input);
    const second = await recordAction(input);

    expect(second.id).toBe(first.id);
    expect(
      (await getActionsSince(new Date(0).toISOString())).filter(
        row => row.idempotency_key === input.idempotency_key
      )
    ).toHaveLength(1);
  });

  test('recordAction remains compatible with a live-style unique idempotency index', async () => {
    await db.query(
      'CREATE UNIQUE INDEX uq_tm_journal_idempotency_test ON tm_journal(idempotency_key) WHERE idempotency_key IS NOT NULL'
    );
    const input = {
      thread_ref: 'gh:thinmansoftware/bdc-xo#1450',
      action_type: 'nudge' as const,
      proposal_json: '{"type":"nudge"}',
      idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-xo#1450:1',
      outcome: 'pending' as const,
    };

    const first = await recordAction(input);
    const second = await recordAction(input);

    expect(second.id).toBe(first.id);
    expect(
      (await getActionsSince(new Date(0).toISOString())).filter(
        row => row.idempotency_key === input.idempotency_key
      )
    ).toHaveLength(1);
  });

  test('getActionByIdempotencyKey is not limited by journal lookback time', async () => {
    const row = await recordAction({
      thread_ref: 'dispatch:old-ruling',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      idempotency_key: 'tm:deliver_ruling:old-ruling',
      outcome: 'sent',
    });
    await db.query('UPDATE tm_journal SET created_at = $1 WHERE id = $2', [
      '2020-01-01T00:00:00.000Z',
      row.id,
    ]);

    expect((await getActionByIdempotencyKey('tm:deliver_ruling:old-ruling'))?.id).toBe(row.id);
  });

  test('getActionsSince filters by time and optionally by thread_ref', async () => {
    await recordAction({
      thread_ref: 'thread-a',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'sent',
    });
    await recordAction({
      thread_ref: 'thread-b',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      outcome: 'sent',
    });

    const longAgo = new Date(Date.now() - 3_600_000).toISOString();
    const all = await getActionsSince(longAgo);
    expect(all.length).toBe(2);
    const onlyB = await getActionsSince(longAgo, 'thread-b');
    expect(onlyB.length).toBe(1);
    expect(onlyB[0]?.action_type).toBe('escalate_p0');

    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await getActionsSince(future)).length).toBe(0);
  });

  test('gradeAction stamps grade and graded_at after external verification', async () => {
    const row = await recordAction({
      thread_ref: 'thread-a',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      outcome: 'sent',
    });
    const graded = await gradeAction(row.id, 'useful');
    expect(graded?.grade).toBe('useful');
    expect(graded?.graded_at).not.toBeNull();
  });

  test('expireParkedActions expires parked and pending rows only', async () => {
    await recordAction({
      thread_ref: 't1',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'parked',
    });
    await recordAction({
      thread_ref: 't2',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'pending',
    });
    await recordAction({
      thread_ref: 't3',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'sent',
    });
    const expired = await expireParkedActions();
    expect(expired).toBe(2);
    const rows = await getActionsSince(new Date(Date.now() - 3_600_000).toISOString());
    expect(rows.filter(r => r.outcome === 'expired').length).toBe(2);
    expect(rows.filter(r => r.outcome === 'sent').length).toBe(1);
  });
});

describe('tm_control DAL', () => {
  test('getPauseState returns the seeded RUNNING singleton', async () => {
    const control = await getPauseState();
    expect(control.pause_state).toBe('RUNNING');
    expect(control.epoch).toBe(0);
  });

  test('setPauseState pauses without epoch change; resume increments epoch', async () => {
    const paused = await setPauseState({
      pause_state: 'PAUSED',
      pause_reason: 'operator request',
      pause_actor: 'john',
    });
    expect(paused.pause_state).toBe('PAUSED');
    expect(paused.epoch).toBe(0);

    const resumed = await setPauseState({
      pause_state: 'RUNNING',
      pause_actor: 'john',
      incrementEpoch: true,
    });
    expect(resumed.pause_state).toBe('RUNNING');
    expect(resumed.epoch).toBe(1);
  });

  test('HARD_PAUSE (auto-circuit) is a valid tightened state', async () => {
    const hard = await setPauseState({
      pause_state: 'HARD_PAUSE',
      pause_scope: 'effects',
      pause_reason: 'forbidden effect',
      pause_actor: 'taskmaster:auto-circuit',
    });
    expect(hard.pause_state).toBe('HARD_PAUSE');
    expect(hard.pause_scope).toBe('effects');
  });
});

describe('tm_health DAL', () => {
  test('health repair preserves pre-existing schema objects and constraints', async () => {
    await db.close();
    cleanupDb(currentDbPath);
    const old = new Database(currentDbPath);
    old.run(`CREATE TABLE tm_health (
      provider TEXT NOT NULL, state TEXT NOT NULL CHECK (state <> 'invalid'),
      sampled_at TEXT NOT NULL, expires_at TEXT, evidence TEXT,
      annotation TEXT NOT NULL DEFAULT 'retained', PRIMARY KEY (provider, sampled_at)
    )`);
    old.run('CREATE TABLE health_audit (provider TEXT)');
    old.run('CREATE INDEX health_state_before_repair ON tm_health(state)');
    old.run(`CREATE TRIGGER health_insert_before_repair AFTER INSERT ON tm_health
      BEGIN INSERT INTO health_audit(provider) VALUES (NEW.provider); END`);
    old.run(
      "INSERT INTO tm_health(provider,state,sampled_at) VALUES ('claude','dark','2026-08-27')"
    );
    old.run(
      "INSERT INTO tm_health(provider,state,sampled_at) VALUES ('claude','healthy','2026-08-28')"
    );
    old.close();

    db = new SqliteAdapter(currentDbPath);
    const objects = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name IN ('health_state_before_repair','health_insert_before_repair') ORDER BY name"
    );
    expect(objects.rows).toEqual([
      { name: 'health_insert_before_repair' },
      { name: 'health_state_before_repair' },
    ]);
    expect((await db.query('SELECT provider, state, annotation FROM tm_health')).rows).toEqual([
      { provider: 'claude', state: 'healthy', annotation: 'retained' },
    ]);
    await expect(
      db.query("UPDATE tm_health SET state = 'invalid' WHERE provider = 'claude'")
    ).rejects.toThrow();
    await upsertHealthSample({ provider: 'codex', state: 'healthy', expires_at: '2026-09-08' });
    expect(
      (await db.query("SELECT provider FROM health_audit WHERE provider = 'codex'")).rows
    ).toEqual([{ provider: 'codex' }]);
    await upsertHealthSample({ provider: 'claude', state: 'degraded', expires_at: '2026-09-08' });
    expect((await db.query("SELECT state FROM tm_health WHERE provider = 'claude'")).rows).toEqual([
      { state: 'degraded' },
    ]);
  });

  test('legacy composite primary key is repaired and deduplicated before upsert', async () => {
    await db.close();
    cleanupDb(currentDbPath);
    const old = new Database(currentDbPath);
    old.run(`CREATE TABLE tm_health (
      provider TEXT NOT NULL, state TEXT NOT NULL, sampled_at TEXT NOT NULL,
      expires_at TEXT, evidence TEXT, PRIMARY KEY (provider, sampled_at)
    )`);
    old.run(
      "INSERT INTO tm_health VALUES ('claude','dark','2026-08-27T00:00:00Z','2026-08-28T00:00:00Z','old')"
    );
    old.run(
      "INSERT INTO tm_health VALUES ('claude','degraded','2026-08-28T00:00:00Z','2026-08-29T00:00:00Z','latest')"
    );
    old.close();

    db = new SqliteAdapter(currentDbPath);
    const repaired = await db.query<{ state: string; evidence: string }>(
      'SELECT state, evidence FROM tm_health WHERE provider = $1',
      ['claude']
    );
    expect(repaired.rows).toEqual([{ state: 'degraded', evidence: 'latest' }]);

    await upsertHealthSample({
      provider: 'claude',
      state: 'healthy',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      evidence: 'current',
    });
    const rows = await db.query<{ state: string }>(
      'SELECT state FROM tm_health WHERE provider = $1',
      ['claude']
    );
    expect(rows.rows).toEqual([{ state: 'healthy' }]);
    expect((await getHealthSample('claude'))?.evidence).toBe('current');
  });

  test('health repair handles missing primary key and ignores partial unique indexes', async () => {
    await db.close();
    cleanupDb(currentDbPath);
    const old = new Database(currentDbPath);
    old.run(`CREATE TABLE tm_health (
      provider TEXT NOT NULL, state TEXT NOT NULL, sampled_at TEXT NOT NULL,
      expires_at TEXT, evidence TEXT
    )`);
    old.run("CREATE UNIQUE INDEX health_partial ON tm_health(provider) WHERE state = 'healthy'");
    old.run("INSERT INTO tm_health VALUES ('claude','dark','2026-08-28',NULL,'first')");
    old.run("INSERT INTO tm_health VALUES ('claude','degraded','2026-08-28',NULL,'last')");
    old.close();

    db = new SqliteAdapter(currentDbPath);
    expect((await db.query('SELECT evidence FROM tm_health')).rows).toEqual([{ evidence: 'last' }]);
    await upsertHealthSample({ provider: 'claude', state: 'healthy', expires_at: '2026-09-08' });
    expect((await db.query('SELECT state FROM tm_health')).rows).toEqual([{ state: 'healthy' }]);
  });

  test('health repair preserves occupied schema names and chooses a free index name', async () => {
    await db.close();
    cleanupDb(currentDbPath);
    const old = new Database(currentDbPath);
    old.run(`CREATE TABLE tm_health (
      provider TEXT NOT NULL, state TEXT NOT NULL, sampled_at TEXT NOT NULL,
      expires_at TEXT, evidence TEXT, PRIMARY KEY (provider, sampled_at)
    )`);
    old.run('CREATE TABLE other_health (id INTEGER, state TEXT)');
    old.run('CREATE INDEX TM_HEALTH_PROVIDER_UNIQUE ON other_health(state)');
    old.run('CREATE INDEX tm_health_provider_unique_1 ON tm_health(state)');
    old.run('CREATE TABLE tm_health_provider_unique_2 (id INTEGER)');
    old.run("INSERT INTO tm_health VALUES ('claude','dark','2026-08-27',NULL,'old')");
    old.run("INSERT INTO tm_health VALUES ('claude','healthy','2026-08-28',NULL,'new')");
    old.close();

    db = new SqliteAdapter(currentDbPath);
    expect((await db.query('SELECT evidence FROM tm_health')).rows).toEqual([{ evidence: 'new' }]);
    expect(
      (
        await db.query(
          "SELECT tbl_name FROM sqlite_schema WHERE LOWER(name)='tm_health_provider_unique'"
        )
      ).rows
    ).toEqual([{ tbl_name: 'other_health' }]);
    expect((await db.query('PRAGMA index_info(tm_health_provider_unique_1)')).rows).toEqual([
      { seqno: 0, cid: 1, name: 'state' },
    ]);
    expect((await db.query('PRAGMA index_info(tm_health_provider_unique_3)')).rows).toEqual([
      { seqno: 0, cid: 0, name: 'provider' },
    ]);
    await upsertHealthSample({ provider: 'claude', state: 'healthy', expires_at: '2026-09-08' });
    const before = await db.query(
      "SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name"
    );
    await db.close();
    db = new SqliteAdapter(currentDbPath);
    expect(
      (await db.query("SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name")).rows
    ).toEqual(before.rows);
  });

  test('health repair rolls back partial trigger effects when deduplication fails', async () => {
    await db.close();
    cleanupDb(currentDbPath);
    const old = new Database(currentDbPath);
    old.run(`CREATE TABLE tm_health (
      provider TEXT NOT NULL, state TEXT NOT NULL, sampled_at TEXT NOT NULL,
      expires_at TEXT, evidence TEXT, PRIMARY KEY (provider, sampled_at)
    )`);
    old.run('CREATE TABLE health_delete_audit (evidence TEXT)');
    old.run(`CREATE TRIGGER reject_health_delete AFTER DELETE ON tm_health BEGIN
      INSERT INTO health_delete_audit VALUES (OLD.evidence);
      SELECT RAISE(FAIL, 'test health delete rejected'); END`);
    old.run("INSERT INTO tm_health VALUES ('claude','dark','2026-08-27',NULL,'old')");
    old.run("INSERT INTO tm_health VALUES ('claude','healthy','2026-08-28',NULL,'new')");
    old.close();

    expect(() => new SqliteAdapter(currentDbPath)).toThrow('test health delete rejected');
    const inspection = new Database(currentDbPath, { readonly: true });
    try {
      expect(inspection.query('SELECT evidence FROM tm_health ORDER BY sampled_at').all()).toEqual([
        { evidence: 'old' },
        { evidence: 'new' },
      ]);
      expect(inspection.query('SELECT * FROM health_delete_audit').all()).toEqual([]);
    } finally {
      inspection.close();
    }
  });

  test('health repair is a no-op on a second connection', async () => {
    await db.close();
    cleanupDb(currentDbPath);
    const old = new Database(currentDbPath);
    old.run(`CREATE TABLE tm_health (
      provider TEXT NOT NULL, state TEXT NOT NULL, sampled_at TEXT NOT NULL,
      expires_at TEXT, evidence TEXT, PRIMARY KEY (provider, sampled_at)
    )`);
    old.run(
      "INSERT INTO tm_health VALUES ('claude','dark','2026-08-27T00:00:00Z','2026-08-28T00:00:00Z','old')"
    );
    old.run(
      "INSERT INTO tm_health VALUES ('claude','healthy','2026-08-28T00:00:00Z','2026-08-29T00:00:00Z','latest')"
    );
    old.close();

    db = new SqliteAdapter(currentDbPath);
    await db.query('CREATE INDEX tm_health_repair_sentinel ON tm_health(state)');
    await db.close();

    db = new SqliteAdapter(currentDbPath);
    const rows = await db.query<{ provider: string; state: string; evidence: string }>(
      'SELECT provider, state, evidence FROM tm_health'
    );
    expect(rows.rows).toEqual([{ provider: 'claude', state: 'healthy', evidence: 'latest' }]);
    const sentinel = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tm_health_repair_sentinel'"
    );
    expect(sentinel.rows).toEqual([{ name: 'tm_health_repair_sentinel' }]);
  });

  test('providers are upserted independently', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await upsertHealthSample({ provider: 'claude', state: 'healthy', expires_at: expiresAt });
    await upsertHealthSample({ provider: 'codex', state: 'degraded', expires_at: expiresAt });

    const rows = await db.query<{ provider: string }>('SELECT provider FROM tm_health');
    expect(rows.rows).toHaveLength(2);
    expect((await getHealthSample('claude'))?.state).toBe('healthy');
    expect((await getHealthSample('codex'))?.state).toBe('degraded');
  });

  test('upsert + read within expiry; expired samples read as null', async () => {
    await upsertHealthSample({
      provider: 'claude',
      state: 'healthy',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      evidence: 'probe ok',
    });
    const sample = await getHealthSample('claude');
    expect(sample?.state).toBe('healthy');

    await upsertHealthSample({
      provider: 'codex',
      state: 'dark',
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(await getHealthSample('codex')).toBeNull();
  });
});

describe('tm_usage_sample DAL', () => {
  test('a failed meter is persisted as is_unknown=1 with null value, never zero', async () => {
    const sample = await recordUsageSample({
      provider: 'claude',
      window_kind: 'rolling',
      source: 'none',
      value_json: null,
      confidence: 'none',
      is_unknown: true,
    });
    expect(sample.is_unknown).toBe(1);
    expect(sample.value_json).toBeNull();
  });

  test('a real observation persists its value with is_unknown=0', async () => {
    const sample = await recordUsageSample({
      provider: 'claude',
      window_kind: 'rolling',
      source: 'local_artifacts',
      value_json: JSON.stringify({ tokensRemaining: 123_456 }),
      confidence: 'high',
      is_unknown: false,
    });
    expect(sample.is_unknown).toBe(0);
    expect(sample.value_json).toContain('123456');
  });

  test('recent samples are filtered and returned newest-first with a limit', async () => {
    for (const [provider, windowKind, value] of [
      ['xai', 'judge_spawn_outcome', 'first'],
      ['codex', 'judge_spawn_outcome', 'other-provider'],
      ['xai', 'rolling', 'other-window'],
      ['xai', 'judge_spawn_outcome', 'second'],
      ['xai', 'judge_spawn_outcome', 'third'],
    ] as const) {
      await recordUsageSample({
        provider,
        window_kind: windowKind,
        source: 'test',
        value_json: JSON.stringify({ value }),
        is_unknown: false,
      });
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const samples = await getRecentUsageSamples('xai', 'judge_spawn_outcome', 2);
    expect(samples).toHaveLength(2);
    expect(samples.map(sample => JSON.parse(sample.value_json ?? '{}').value)).toEqual([
      'third',
      'second',
    ]);
  });
});

function baseAdoptionRow(
  overrides: Partial<Omit<TmAdoptionRow, 'snapshot_id'>> & { thread_ref: string }
): Omit<TmAdoptionRow, 'snapshot_id'> {
  return {
    repo: 'thinmansoftware/bdc-xo',
    issue_number: 1,
    title: 't',
    priority: 'P2',
    labels_json: '[]',
    owner_login: null,
    is_blocked: 0,
    blocked_reason: null,
    next_action: null,
    latest_marker_kind: null,
    latest_marker_at: null,
    state: 'open',
    last_movement_at: null,
    last_movement_kind: null,
    attempts_24h: 0,
    attempts_total: 0,
    evidence_observed_at: new Date().toISOString(),
    source_updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('tm_adoption DAL', () => {
  test('register: filters priority blocked and named owner while preserving no-filter reads', async () => {
    const snap = await beginAdoptionSnapshot();
    const rows = [
      {
        thread_ref: 'gh:thinmansoftware/bdc-xo#101',
        priority: 'P1',
        owner_login: 'alice',
        is_blocked: 1,
      },
      {
        thread_ref: 'gh:thinmansoftware/bdc-xo#102',
        priority: 'P1',
        owner_login: 'bob',
        is_blocked: 0,
      },
      {
        thread_ref: 'gh:thinmansoftware/bdc-xo#103',
        priority: 'P2',
        owner_login: 'alice',
        is_blocked: 0,
      },
      {
        thread_ref: 'gh:thinmansoftware/bdc-xo#104',
        priority: 'P2',
        owner_login: null,
        is_blocked: 0,
      },
    ];
    for (const row of rows) await upsertAdoptionRow(snap, baseAdoptionRow(row));
    await commitAdoptionSnapshot(snap);

    expect(await getAdoption()).toHaveLength(4);
    expect(await getAdoption({ priority: 'P1' })).toHaveLength(2);
    expect(await getAdoption({ blocked: true })).toHaveLength(1);
    expect(await getAdoption({ blocked: false })).toHaveLength(3);
    expect(await getAdoption({ owner_login: 'alice' })).toHaveLength(2);
  });

  test('register: explicit null owner returns UNKNOWN-only rows', async () => {
    const snap = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      snap,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#105', owner_login: null })
    );
    await upsertAdoptionRow(
      snap,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#106', owner_login: 'alice' })
    );
    await commitAdoptionSnapshot(snap);

    const rows = await getAdoption({ owner_login: null });
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_login).toBeNull();
  });

  test('register: filtered total uses the same predicates as rows', async () => {
    const snap = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      snap,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#107', priority: 'P0' })
    );
    await upsertAdoptionRow(
      snap,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#108', priority: 'P3' })
    );
    await commitAdoptionSnapshot(snap);

    expect(await getAdoptionCount()).toBe(2);
    expect(await getAdoptionCount({ priority: 'P0' })).toBe(1);
  });

  test('register: partial count reports missing evidence and zero before rebuild', async () => {
    expect(await getAdoptionPartialCount()).toBe(0);
    const snap = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      snap,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#109', evidence_observed_at: null })
    );
    await upsertAdoptionRow(snap, baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#110' }));
    await commitAdoptionSnapshot(snap);
    expect(await getAdoptionPartialCount()).toBe(1);
  });

  test('adoption: begin upsert commit exposes rows via getAdoption', async () => {
    const snap = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      snap,
      baseAdoptionRow({
        thread_ref: 'gh:thinmansoftware/bdc-xo#1',
        title: 'One',
        issue_number: 1,
      })
    );
    await upsertAdoptionRow(
      snap,
      baseAdoptionRow({
        thread_ref: 'gh:thinmansoftware/bdc-xo#2',
        title: 'Two',
        issue_number: 2,
      })
    );
    // Uncommitted snapshot is not readable via getAdoption.
    expect(await getAdoption()).toHaveLength(0);

    await commitAdoptionSnapshot(snap, 'abc123');
    const rows = await getAdoption();
    expect(rows).toHaveLength(2);
    const meta = await getAdoptionMeta();
    expect(meta?.committed_snapshot_id).toBe(snap);
    expect(meta?.row_count).toBe(2);
    expect(meta?.source_commit).toBe('abc123');
    expect(meta?.complete).toBe(1);
  });

  test('adoption: abandon drops partial rows and leaves committed snapshot', async () => {
    const good = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      good,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#9', title: 'Good' })
    );
    await commitAdoptionSnapshot(good);

    const bad = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      bad,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#10', title: 'Partial' })
    );
    await abandonAdoptionSnapshot(bad);

    const meta = await getAdoptionMeta();
    expect(meta?.committed_snapshot_id).toBe(good);
    const rows = await getAdoption();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Good');

    // Ensure abandoned snapshot rows are gone.
    const leftover = await db.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM tm_adoption WHERE snapshot_id = $1',
      [bad]
    );
    expect(Number(leftover.rows[0].c)).toBe(0);
  });

  test('adoption: commit retires prior snapshot rows atomically via withTransaction', async () => {
    const first = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      first,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#1', title: 'First' })
    );
    await commitAdoptionSnapshot(first);

    const second = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      second,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#1', title: 'Second' })
    );
    await commitAdoptionSnapshot(second);

    const rows = await getAdoption();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Second');
    expect(rows[0].snapshot_id).toBe(second);

    const all = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM tm_adoption');
    expect(Number(all.rows[0].c)).toBe(1);
  });

  test('adoption: rebuild from empty reproduces deterministic state', async () => {
    const deterministic = {
      thread_ref: 'gh:thinmansoftware/bdc-xo#42',
      repo: 'thinmansoftware/bdc-xo',
      issue_number: 42,
      title: 'Rebuild me',
      priority: 'P1',
      labels_json: '["wo","prio:P1"]',
      owner_login: 'major-build',
      is_blocked: 1,
      blocked_reason: '[BLOCKED] waiting',
      next_action: null,
      latest_marker_kind: 'BLOCKED' as const,
      last_movement_at: '2026-08-01T00:00:00.000Z',
      last_movement_kind: 'assigned' as const,
      source_updated_at: '2026-08-02T00:00:00.000Z',
      state: 'open',
    };

    const snap1 = await beginAdoptionSnapshot();
    await upsertAdoptionRow(snap1, baseAdoptionRow(deterministic));
    await commitAdoptionSnapshot(snap1);
    const first = await getAdoption();
    expect(first).toHaveLength(1);

    // Delete all adoption state (simulates wipe).
    await db.query('DELETE FROM tm_adoption');
    await db.query(
      `UPDATE tm_adoption_meta
       SET committed_snapshot_id = NULL, rebuilt_at = NULL, row_count = NULL,
           source_commit = NULL, complete = 0
       WHERE id = 1`
    );
    expect(await getAdoption()).toHaveLength(0);

    // Rebuild from the same deterministic inputs.
    const snap2 = await beginAdoptionSnapshot();
    await upsertAdoptionRow(snap2, baseAdoptionRow(deterministic));
    await commitAdoptionSnapshot(snap2);
    const second = await getAdoption();
    expect(second).toHaveLength(1);

    const cols = [
      'thread_ref',
      'repo',
      'issue_number',
      'title',
      'state',
      'priority',
      'labels_json',
      'owner_login',
      'is_blocked',
      'blocked_reason',
      'next_action',
      'latest_marker_kind',
      'last_movement_at',
      'last_movement_kind',
      'source_updated_at',
    ] as const;
    for (const col of cols) {
      expect(second[0][col]).toEqual(first[0][col]);
    }
    // snapshot_id differs by construction
    expect(second[0].snapshot_id).not.toBe(first[0].snapshot_id);
  });
});

// ---------------------------------------------------------------------------
// M-155 WO 3 (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01) -- durable noise
// suppression + dispatch same-subject contract, against the REAL SQLite
// schema (fresh DB per test). Test names carry the literal 'push:'.
// ---------------------------------------------------------------------------

describe('tm_suppression DAL (M-155 exception push)', () => {
  test('push: suppression survives an adoption snapshot refresh', async () => {
    const ref = 'gh:thinmansoftware/bdc-xo#77';
    await setSuppression(ref, 'hash-a');

    // Full adoption refresh cycle #1.
    const first = await beginAdoptionSnapshot();
    await upsertAdoptionRow(first, baseAdoptionRow({ thread_ref: ref, title: 'Chronic' }));
    await commitAdoptionSnapshot(first);

    // Full adoption refresh cycle #2: executes
    // `DELETE FROM tm_adoption WHERE snapshot_id <> $1` -- the exact statement
    // that would have erased a suppression column stored on tm_adoption.
    const second = await beginAdoptionSnapshot();
    await upsertAdoptionRow(second, baseAdoptionRow({ thread_ref: ref, title: 'Chronic' }));
    await commitAdoptionSnapshot(second);

    // The durable tm_suppression row still exists and still applies.
    const suppression = await getSuppression();
    expect(suppression.get(ref)?.suppressed_until_hash).toBe('hash-a');
    expect(suppression.get(ref)?.noise_grade_count).toBe(2);

    // Upsert overwrites the hash; clear deletes the row (suppression lift).
    await setSuppression(ref, 'hash-b');
    expect((await getSuppression()).get(ref)?.suppressed_until_hash).toBe('hash-b');
    await clearSuppression(ref);
    expect((await getSuppression()).size).toBe(0);
  });

  test('push: subject_key + repeat_reason satisfy the dispatch contract', async () => {
    const subject = 'gh:thinmansoftware/bdc-xo#88';
    const first = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      {
        correlation_id: 'tm-push-1',
        idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-xo#88:1',
        task_type: 'agent_message',
        recipient: 'xo',
        body: 'first nudge on the subject',
        subject_key: subject,
      }
    );
    // A prior message on the subject becomes handled (addressed).
    await db.query(
      'UPDATE agent_dispatch_messages SET addressed_at = $1, addressed_by = $2 WHERE id = $3',
      [new Date().toISOString(), 'xo', first.id]
    );

    // migration 042 behavior: a repeat on a handled subject WITHOUT a
    // repeat_reason throws.
    await expect(
      createAuthenticatedMessage(
        { kind: 'system', sender: 'taskmaster' },
        {
          correlation_id: 'tm-push-2',
          idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-xo#88:2',
          task_type: 'agent_message',
          recipient: 'xo',
          body: 'repeat without a reason',
          subject_key: subject,
        }
      )
    ).rejects.toThrow('repeat_reason_required');

    // The loop supplies the per-verb literal unconditionally, so the real
    // send path does NOT throw (loop-side proof in loop.test.ts push: tests).
    const repeat = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      {
        correlation_id: 'tm-push-3',
        idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-xo#88:3',
        task_type: 'agent_message',
        recipient: 'xo',
        body: 'repeat with the taskmaster follow-up reason',
        subject_key: subject,
        repeat_reason: 'tm:nudge:follow-up',
      }
    );
    expect(repeat.repeat_reason).toBe('tm:nudge:follow-up');
  });
});

describe('expectation front door (bdc-xo#2007)', () => {
  const spec = JSON.stringify({ kind: 'pr_opened', repo: 'thinmansoftware/fuelglass' });
  const future = (): string => new Date(Date.now() + 86_400_000).toISOString();

  test('a caller-supplied key replaces the derived one and is idempotent', async () => {
    const first = await registerExpectationReportingCreation({
      registration_key: 'ext:xo:fuelglass-1',
      dispatch_ref: 'bdc-xo#2006',
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: 'xo',
    });
    expect(first.created).toBe(true);

    // The SAME key with a DIFFERENT deadline must match the existing row, not
    // open a second expectation and not move the first one's deadline.
    const laterDeadline = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const second = await registerExpectationReportingCreation({
      registration_key: 'ext:xo:fuelglass-1',
      dispatch_ref: 'bdc-xo#2006',
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: laterDeadline,
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: 'xo',
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.expectation.due_at).toBe(first.expectation.due_at);
    expect(second.expectation.due_at).not.toBe(laterDeadline);

    const all = await listExpectations({ limit: 50 });
    expect(all.rows.filter(r => r.registration_key === 'ext:xo:fuelglass-1')).toHaveLength(1);
  });

  test('registered_by and self_supervised are persisted and readable', async () => {
    await registerExpectationReportingCreation({
      registration_key: 'ext:grok:self-1',
      dispatch_ref: 'ref-self',
      recipient: 'grok',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'give_up',
      max_retries: 0,
      registered_by: 'grok',
      self_supervised: true,
    });
    const rows = await listExpectations({ registered_by: 'grok', limit: 10 });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.registered_by).toBe('grok');
    expect(rows.rows[0]?.self_supervised).toBe(1);
  });

  test("the loop's own registrations are attributed to taskmaster, not to a caller", async () => {
    // registerExpectation is the loop's path and passes no registrant, so the
    // default must be the loop -- otherwise loop rows would land in whichever
    // caller's daily budget happened to be the default.
    await registerExpectation({
      dispatch_ref: 'loop-dispatch-1',
      recipient: 'operator',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
    });
    const rows = await listExpectations({ registered_by: 'taskmaster', limit: 10 });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.dispatch_ref).toBe('loop-dispatch-1');
    expect(rows.rows[0]?.self_supervised).toBe(0);
  });

  test('the cap counts the whole front door, not one self-declared registrant', async () => {
    // registered_by is self-declared, so a per-registrant count bounds nothing:
    // a caller at its limit sends a different name. The enforced count is of
    // every ext: row, which makes the bound a property of the operator token.
    for (const n of [1, 2, 3]) {
      await registerExpectationReportingCreation({
        registration_key: `ext:xo:count-${String(n)}`,
        dispatch_ref: `ref-${String(n)}`,
        recipient: 'fable-cursor',
        evidence_json: spec,
        due_at: future(),
        on_absence: 'escalate',
        max_retries: 0,
        registered_by: 'xo',
      });
    }
    await registerExpectationReportingCreation({
      registration_key: 'ext:codex:count-1',
      dispatch_ref: 'ref-codex',
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: 'codex',
    });
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    // Renaming the registrant does NOT reset the count.
    expect(await countExternalExpectationsSince(dayAgo)).toBe(4);
  });

  test("the cap excludes the loop's own rows, so neither side starves the other", async () => {
    await registerExpectation({
      dispatch_ref: 'loop-not-counted',
      recipient: 'operator',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
    });
    await registerExpectationReportingCreation({
      registration_key: 'ext:xo:counted',
      dispatch_ref: 'ref-counted',
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: 'xo',
    });
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    // The loop row exists but is not chargeable to the front door.
    expect(await countExternalExpectationsSince(dayAgo)).toBe(1);
    expect((await listExpectations({ limit: 10 })).total).toBe(2);
  });

  test('the count window excludes rows older than the cutoff', async () => {
    await registerExpectationReportingCreation({
      registration_key: 'ext:xo:window-1',
      dispatch_ref: 'ref-window',
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: 'xo',
    });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(await countExternalExpectationsSince(tomorrow)).toBe(0);
  });

  test('expectationKeyExists distinguishes a retry from a new registration', async () => {
    // This is what lets a retry bypass the cap: a repeat under an existing key
    // creates nothing, so charging it would turn the documented idempotent 200
    // into a 429 and punish exactly the safe retry the key exists to enable.
    expect(await expectationKeyExists('ext:xo:probe-1')).toBe(false);
    await registerExpectationReportingCreation({
      registration_key: 'ext:xo:probe-1',
      dispatch_ref: 'ref-probe',
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: 'xo',
    });
    expect(await expectationKeyExists('ext:xo:probe-1')).toBe(true);
  });

  test('an externally registered expectation is picked up by the due sweep', async () => {
    // The whole point of the front door: a row a session registered must be
    // supervised by exactly the same loop that supervises the loop's own rows.
    const { id } = await registerExpectationReportingCreation({
      registration_key: 'ext:xo:swept-1',
      dispatch_ref: 'bdc-xo#2006',
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: new Date(Date.now() - 1000).toISOString(),
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: 'xo',
    });
    const due = await listDueExpectations(new Date().toISOString());
    expect(due.map(r => r.id)).toContain(id);
  });

  test('listExpectations filters by status and reports the unfiltered total', async () => {
    const { id } = await registerExpectationReportingCreation({
      registration_key: 'ext:xo:status-1',
      dispatch_ref: 'ref-status',
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: 'xo',
    });
    await registerExpectationReportingCreation({
      registration_key: 'ext:xo:status-2',
      dispatch_ref: 'ref-status-2',
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: 'xo',
    });
    await markMet(id, 'https://example/pr/1');
    const met = await listExpectations({ status: 'met', limit: 10 });
    expect(met.rows).toHaveLength(1);
    expect(met.total).toBe(1);
    expect(met.rows[0]?.id).toBe(id);
    expect(met.rows[0]?.evidence_pointer).toBe('https://example/pr/1');
    const pending = await listExpectations({ status: 'pending', limit: 10 });
    expect(pending.rows).toHaveLength(1);
  });

  test('limit caps the rows returned but not the reported total', async () => {
    for (const n of [1, 2, 3, 4]) {
      await registerExpectationReportingCreation({
        registration_key: `ext:xo:limit-${String(n)}`,
        dispatch_ref: `ref-limit-${String(n)}`,
        recipient: 'fable-cursor',
        evidence_json: spec,
        due_at: future(),
        on_absence: 'escalate',
        max_retries: 0,
        registered_by: 'xo',
      });
    }
    const page = await listExpectations({ limit: 2 });
    expect(page.rows).toHaveLength(2);
    // A caller paging the registry must be told how much it has NOT seen.
    expect(page.total).toBe(4);
  });
});

describe('front door daily cap is enforced in the write (Overseer PR 810)', () => {
  const spec = JSON.stringify({ kind: 'pr_opened', repo: 'thinmansoftware/fuelglass' });
  const future = (): string => new Date(Date.now() + 86_400_000).toISOString();

  const register = (
    key: string,
    extra: { daily_cap?: number; cap_exempt?: boolean; registered_by?: string } = {}
  ) =>
    registerExpectationReportingCreation({
      registration_key: key,
      dispatch_ref: `ref-${key}`,
      recipient: 'fable-cursor',
      evidence_json: spec,
      due_at: future(),
      on_absence: 'escalate',
      max_retries: 0,
      registered_by: extra.registered_by ?? 'xo',
      daily_cap: extra.daily_cap,
      cap_exempt: extra.cap_exempt,
    });

  test('the cap refuses the row rather than writing it', async () => {
    expect((await register('ext:xo:cap-a', { daily_cap: 2 })).capped).toBe(false);
    expect((await register('ext:xo:cap-b', { daily_cap: 2 })).capped).toBe(false);
    const third = await register('ext:xo:cap-c', { daily_cap: 2 });
    expect(third.capped).toBe(true);
    if (third.capped) expect(third.observed).toBe(2);
    // The refusal must leave NOTHING behind -- a capped call that still wrote
    // would both break the bound and hand the caller a supervised-looking row.
    expect(await expectationKeyExists('ext:xo:cap-c')).toBe(false);
    expect((await listExpectations({ limit: 20 })).total).toBe(2);
  });

  test('CONCURRENT registrations cannot exceed the cap', async () => {
    // THE FINDING. A count-then-insert sequence lets N racing callers all
    // observe a count below the cap and all then write. The cap is a predicate
    // inside the INSERT precisely so the database evaluates it as part of the
    // same statement that writes.
    const cap = 3;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => register(`ext:xo:race-${String(i)}`, { daily_cap: cap }))
    );
    const admitted = results.filter(r => !r.capped);
    expect(admitted).toHaveLength(cap);
    expect(results.filter(r => r.capped)).toHaveLength(10 - cap);
    // And the database agrees -- the bound held in the data, not just in the
    // return values.
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    expect(await countExternalExpectationsSince(dayAgo)).toBe(cap);
  });

  test('a retry of an existing key is admitted even at the cap', async () => {
    await register('ext:xo:retry-me', { daily_cap: 1 });
    // Cap is now full. A NEW key must be refused...
    expect((await register('ext:xo:something-new', { daily_cap: 1 })).capped).toBe(true);
    // ...but the existing key must still return its row, not a 429. This is the
    // [minor] finding: charging a retry turns the documented idempotent success
    // into a refusal the moment a caller gets busy.
    const retry = await register('ext:xo:retry-me', { daily_cap: 1, cap_exempt: true });
    expect(retry.capped).toBe(false);
    if (!retry.capped) expect(retry.created).toBe(false);
  });

  test('renaming the registrant does not buy more headroom', async () => {
    // registered_by is self-declared, so a per-name cap would be evaded by
    // simply sending a different name. The cap counts the whole ext: population.
    expect((await register('ext:xo:n1', { daily_cap: 2, registered_by: 'xo' })).capped).toBe(false);
    expect((await register('ext:codex:n2', { daily_cap: 2, registered_by: 'codex' })).capped).toBe(
      false
    );
    const third = await register('ext:grok:n3', { daily_cap: 2, registered_by: 'grok' });
    expect(third.capped).toBe(true);
  });

  test("the loop's own registrations are neither capped nor counted", async () => {
    // The loop passes no cap and carries no ext: prefix. Neither side should be
    // able to exhaust the other's headroom.
    for (const n of [1, 2, 3, 4, 5]) {
      await registerExpectation({
        dispatch_ref: `loop-${String(n)}`,
        recipient: 'operator',
        evidence_json: spec,
        due_at: future(),
        on_absence: 'escalate',
        max_retries: 0,
      });
    }
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    expect(await countExternalExpectationsSince(dayAgo)).toBe(0);
    // ...and the front door still has its full budget.
    expect((await register('ext:xo:after-loop', { daily_cap: 1 })).capped).toBe(false);
  });

  test('omitting daily_cap skips the cap entirely', async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect((await register(`ext:xo:uncapped-${String(n)}`)).capped).toBe(false);
    }
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    expect(await countExternalExpectationsSince(dayAgo)).toBe(5);
  });
});

describe('front door cap serializes on PostgreSQL (Overseer PR 810 round 3)', () => {
  // The SQLite concurrency test above proves the bound on the dialect production
  // actually runs (verified live 2026-09-11: no DATABASE_URL, a 1.1 GB
  // /opt/bdc/archon-data/archon.db). It CANNOT prove it on PostgreSQL, where
  // READ COMMITTED gives each statement its own snapshot -- so an atomic
  // statement is not a serializable one, and concurrent transactions with
  // DISTINCT keys could each count the same below-cap total and each insert.
  //
  // There is no Postgres instance in this suite, so what is asserted here is the
  // MECHANISM: the capped path opens a transaction and takes the tm_control row
  // lock BEFORE the insert, and the uncapped paths take neither.
  const spec = JSON.stringify({ kind: 'pr_opened', repo: 'thinmansoftware/fuelglass' });

  /** A fake Postgres adapter that records the statements it is handed. */
  function postgresSpy(): { adapter: SqliteAdapter; statements: string[] } {
    const statements: string[] = [];
    const query = async <T>(sql: string): Promise<{ rows: T[]; rowCount: number }> => {
      statements.push(sql.trim().replace(/\s+/gu, ' '));
      // Every read comes back empty. The insert then looks like a cap rejection
      // and the lookup like a missing row, which is a clean `capped` return --
      // and irrelevant here, because the statement ORDER is what is under test.
      return { rows: [], rowCount: 0 };
    };
    const adapter = {
      dialect: 'postgres',
      query,
      withTransaction: <T>(fn: (q: typeof query) => Promise<T>): Promise<T> => fn(query),
    } as unknown as SqliteAdapter;
    return { adapter, statements };
  }

  async function registerAgainstSpy(
    statements: string[],
    adapter: SqliteAdapter,
    extra: { daily_cap?: number; cap_exempt?: boolean }
  ): Promise<void> {
    const real = db;
    db = adapter;
    try {
      await registerExpectationReportingCreation({
        registration_key: `ext:xo:pg-${String(statements.length)}`,
        dispatch_ref: 'ref-pg',
        recipient: 'fable-cursor',
        evidence_json: spec,
        due_at: new Date(Date.now() + 86_400_000).toISOString(),
        on_absence: 'escalate',
        max_retries: 0,
        registered_by: 'xo',
        ...extra,
      });
    } catch {
      // An uncapped call with no row throws by design; the statements it issued
      // are already recorded, which is all this test reads.
    } finally {
      db = real;
    }
  }

  test('the capped path locks tm_control BEFORE inserting', async () => {
    const spy = postgresSpy();
    await registerAgainstSpy(spy.statements, spy.adapter, { daily_cap: 5 });
    const lockAt = spy.statements.findIndex(s => s.includes('FOR UPDATE'));
    const insertAt = spy.statements.findIndex(s => s.startsWith('INSERT INTO tm_expectations'));
    expect(lockAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    // ORDER IS THE POINT. A lock taken after the insert serializes nothing.
    expect(lockAt).toBeLessThan(insertAt);
    expect(spy.statements[lockAt]).toContain('tm_control');
  });

  test('an UNCAPPED registration takes no lock, so the loop never queues behind the front door', async () => {
    const spy = postgresSpy();
    await registerAgainstSpy(spy.statements, spy.adapter, {});
    expect(spy.statements.some(s => s.includes('FOR UPDATE'))).toBe(false);
    expect(spy.statements.some(s => s.startsWith('INSERT INTO tm_expectations'))).toBe(true);
  });

  test('an EXEMPT retry takes no lock either', async () => {
    const spy = postgresSpy();
    await registerAgainstSpy(spy.statements, spy.adapter, { daily_cap: 5, cap_exempt: true });
    expect(spy.statements.some(s => s.includes('FOR UPDATE'))).toBe(false);
  });

  test('the cap predicate is absent from an uncapped insert', () => {
    // Belt and braces: an uncapped call must not carry the cap subquery at all,
    // or the loop's own registrations would be bounded by the front door's cap.
    const spy = postgresSpy();
    return registerAgainstSpy(spy.statements, spy.adapter, {}).then(() => {
      const insert = spy.statements.find(s => s.startsWith('INSERT INTO tm_expectations')) ?? '';
      expect(insert).not.toContain('SELECT COUNT(*)');
    });
  });
});
