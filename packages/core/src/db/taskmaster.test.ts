import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';
import { Database } from 'bun:sqlite';

let db: SqliteAdapter;
let currentDbPath = '';
const SQLITE_HOOK_TIMEOUT_MS = 30_000;

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
  recordUsageSample,
  registerExpectation,
  listDueExpectations,
  markMet,
  markFailed,
  claimRedispatchAttempt,
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
}, SQLITE_HOOK_TIMEOUT_MS);

afterEach(async () => {
  await db.close();
  cleanupDb(currentDbPath);
}, SQLITE_HOOK_TIMEOUT_MS);

describe('tm_journal DAL', () => {
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
