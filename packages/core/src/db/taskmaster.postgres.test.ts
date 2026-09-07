import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PostgresAdapter } from './adapters/postgres';

const schema = `tm_reset_${randomUUID().replace(/-/g, '')}`;
let admin: PostgresAdapter | undefined;
let primary: PostgresAdapter;
let secondary: PostgresAdapter;
let active: PostgresAdapter;
mock.module('./connection', () => ({ getDatabase: () => active }));
const { resetTaskmaster, upsertHealthSample } = await import('./taskmaster');
const { createAuthenticatedMessage } = await import('./dispatch');
const healthMigration = readFileSync(
  resolve(import.meta.dir, '../../../../migrations/046_tm_health_provider_pk.sql'),
  'utf8'
);

beforeAll(async () => {
  const raw = process.env.TASKMASTER_POSTGRES_TEST_URL;
  if (!raw) throw new Error('TASKMASTER_POSTGRES_TEST_URL is required');
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    (url.pathname !== '/phase15' && !url.pathname.endsWith('_test'))
  ) {
    throw new Error('Taskmaster integration requires a loopback test database');
  }
  admin = new PostgresAdapter(raw);
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  primary = new PostgresAdapter(url.toString());
  secondary = new PostgresAdapter(url.toString());
  active = primary;
  // Use the canonical Dispatch schema in this isolated loopback-test namespace.
  for (const migration of [
    '028_agent_dispatch.sql',
    '029_board_authority_foundation.sql',
    '031_board_motion_dispatch.sql',
    '040_agent_messaging_phase0.sql',
    '042_agent_messaging_phase1.sql',
    '043_agent_messaging_phase15.sql',
  ]) {
    await primary.query(
      readFileSync(resolve(import.meta.dir, '../../../../migrations', migration), 'utf8')
    );
  }
  await primary.query(`INSERT INTO dispatch_principals
    (principal_id, display_name, delivery_mode, active)
    VALUES ('duty-officer', 'Duty Officer fixture', 'drain_on_start', TRUE)`);
  await primary.query(
    readFileSync(
      resolve(import.meta.dir, '../../../../migrations/041_taskmaster_slice1.sql'),
      'utf8'
    )
  );
});

beforeEach(async () => {
  active = primary;
  await primary.query('DROP TRIGGER IF EXISTS reject_reset_audit ON tm_journal');
  await primary.query('TRUNCATE tm_journal');
  await primary.query('TRUNCATE agent_dispatch_messages');
  await primary.query(
    "UPDATE tm_control SET pause_state='PAUSED', epoch=7, pause_scope='all', pause_reason='test', pause_actor='test' WHERE id=1"
  );
  await primary.query(
    "INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,outcome) VALUES ($1,'test:pending','digest','{}','pending')",
    [randomUUID()]
  );
});

afterAll(async () => {
  await Promise.all([primary?.close(), secondary?.close()]);
  if (admin) {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.close();
    }
  }
});

test('independent PostgreSQL pools serialize overlapping resets with one transition', async () => {
  expect(primary.dialect).toBe('postgres');
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      active = i % 2 === 0 ? primary : secondary;
      return resetTaskmaster({ actor: `operator-${i}`, reason: 'test recovery' });
    })
  );
  expect(
    results.filter(result => JSON.parse(result.audit.proposal_json).transitioned)
  ).toHaveLength(1);
  expect(results.reduce((sum, result) => sum + result.expiredProposals, 0)).toBe(1);
  expect(new Set(results.map(result => result.audit.id)).size).toBe(12);
  for (const [i, result] of results.entries()) {
    expect(result.control.epoch).toBe(8);
    expect(result.control.pause_actor).toBe(`operator-${i}`);
    expect(JSON.parse(result.audit.proposal_json).new_epoch).toBe(8);
  }
  const audits = await primary.query(
    "SELECT id FROM tm_journal WHERE thread_ref='taskmaster:reset'"
  );
  expect(audits.rowCount).toBe(12);
});

test('PostgreSQL already-running reset preserves the epoch-start timestamp', async () => {
  const epochStart = new Date(Date.now() - 3_600_000).toISOString();
  await primary.query("UPDATE tm_control SET pause_state='RUNNING', updated_at=$1 WHERE id=1", [
    epochStart,
  ]);
  const result = await resetTaskmaster({ actor: 'operator', reason: 'repeat' });
  expect(result.control.epoch).toBe(7);
  expect(result.control.updated_at).toBe(epochStart);
  expect(result.expiredProposals).toBe(1);
  expect(JSON.parse(result.audit.proposal_json).transitioned).toBe(false);
});

test('PostgreSQL notice fence rejects a reset that won before enqueue', async () => {
  await resetTaskmaster({ actor: 'operator', reason: 'race before enqueue' });
  const notice = await createAuthenticatedMessage(
    { kind: 'system', sender: 'taskmaster' },
    {
      correlation_id: 'pg-notice-race',
      idempotency_key: 'tm:self-pause:7',
      task_type: 'agent_message',
      recipient: 'duty-officer',
      body: 'obsolete pause',
    },
    { taskmasterPausedEpoch: 7 }
  );
  expect(notice).toBeNull();
  expect(
    (await primary.query('SELECT pause_state, epoch FROM tm_control WHERE id=1')).rows
  ).toEqual([{ pause_state: 'RUNNING', epoch: '8' }]);
});

test('PostgreSQL paused notice queues once with BIGINT epoch and holds its row lock', async () => {
  const originalTransaction = primary.withTransaction.bind(primary);
  let competingWriterError: unknown;
  let checkedLock = false;
  primary.withTransaction = async fn =>
    originalTransaction(async query =>
      fn(async <T>(sql: string, params?: unknown[]) => {
        const result = await query<T>(sql, params);
        if (sql.startsWith('SELECT pause_state, epoch FROM tm_control')) {
          checkedLock = true;
          try {
            await secondary.withTransaction(q =>
              q('SELECT id FROM tm_control WHERE id=1 FOR UPDATE NOWAIT')
            );
          } catch (error) {
            competingWriterError = error;
          }
        }
        return result;
      })
    );
  const data = {
    correlation_id: 'pg-valid-notice',
    idempotency_key: 'tm:self-pause:7',
    task_type: 'agent_message' as const,
    recipient: 'duty-officer',
    body: 'valid paused notice',
  };
  try {
    const notice = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      data,
      { taskmasterPausedEpoch: 7 }
    );
    expect(checkedLock).toBe(true);
    expect((competingWriterError as { code?: string })?.code).toBe('55P03');
    expect(notice?.status).toBe('queued');
    primary.withTransaction = originalTransaction;
    const retry = await createAuthenticatedMessage({ kind: 'system', sender: 'taskmaster' }, data, {
      taskmasterPausedEpoch: 7,
    });
    expect(retry?.id).toBe(notice?.id);
    expect((await primary.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(1);
  } finally {
    primary.withTransaction = originalTransaction;
  }
});

test('PostgreSQL audit failure rolls back control and pending expiration', async () => {
  const before = await primary.query('SELECT * FROM tm_control WHERE id=1');
  await primary.query(`CREATE OR REPLACE FUNCTION reject_reset_audit_fn() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'test reset audit failure'; END;
    $$ LANGUAGE plpgsql`);
  await primary.query(`CREATE TRIGGER reject_reset_audit BEFORE INSERT ON tm_journal
    FOR EACH ROW WHEN (NEW.thread_ref='taskmaster:reset') EXECUTE FUNCTION reject_reset_audit_fn()`);
  await expect(resetTaskmaster({ actor: 'operator', reason: 'test recovery' })).rejects.toThrow(
    'test reset audit failure'
  );
  expect((await primary.query('SELECT * FROM tm_control WHERE id=1')).rows).toEqual(before.rows);
  expect(
    (await primary.query("SELECT outcome FROM tm_journal WHERE thread_ref='test:pending'")).rows
  ).toEqual([{ outcome: 'pending' }]);
  expect(
    (await primary.query("SELECT id FROM tm_journal WHERE thread_ref='taskmaster:reset'")).rowCount
  ).toBe(0);
});

describe('tm_health PostgreSQL migration 046', () => {
  // These cases replace tm_health with drifted shapes; restore migration 041's
  // canonical table afterwards so no later suite inherits a dropped table.
  afterAll(async () => {
    await primary.query('DROP TABLE IF EXISTS tm_health CASCADE');
    await primary.query(`CREATE TABLE tm_health (
      provider TEXT PRIMARY KEY, state TEXT NOT NULL,
      sampled_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      evidence TEXT
    )`);
  });

  for (const key of ['absent', 'composite', 'provider'] as const) {
    test(`${key} primary key: preserves latest data, supports upserts, and replays safely`, async () => {
      const db = primary;
      // Migration 041 already created tm_health with the correct provider-only
      // primary key; replace it with the drifted shape this case exercises.
      await db.query('DROP TABLE IF EXISTS tm_health CASCADE');
      const constraint =
        key === 'absent'
          ? ''
          : key === 'composite'
            ? ', CONSTRAINT legacy_health_key PRIMARY KEY (provider, sampled_at)'
            : ', CONSTRAINT correct_health_key PRIMARY KEY (provider)';
      await db.query(`CREATE TABLE tm_health (
        provider TEXT NOT NULL, state TEXT NOT NULL,
        sampled_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
        evidence TEXT${constraint}
      )`);
      if (key !== 'provider') {
        await db.query(`INSERT INTO tm_health VALUES
          ('claude', 'dark', '2026-08-27T00:00:00Z', '2026-08-28T00:00:00Z', 'old')`);
      }
      if (key === 'absent') {
        await db.query(`INSERT INTO tm_health VALUES
          ('claude', 'dark', '2026-08-28T00:00:00Z', '2026-08-29T00:00:00Z', 'tied-earlier')`);
      }
      await db.query(`INSERT INTO tm_health VALUES
        ('claude', 'degraded', '2026-08-28T00:00:00Z', '2026-08-29T00:00:00Z', 'latest'),
        ('codex', 'healthy', '2026-08-26T00:00:00Z', '2026-08-27T00:00:00Z', 'independent')`);
      await db.query('CREATE INDEX health_state_sentinel ON tm_health(state)');

      await db.query(healthMigration);
      const preserved = await db.query(
        'SELECT provider, state, sampled_at, expires_at, evidence FROM tm_health ORDER BY provider'
      );
      expect(preserved.rows).toEqual([
        {
          provider: 'claude',
          state: 'degraded',
          evidence: 'latest',
          sampled_at: new Date('2026-08-28T00:00:00Z'),
          expires_at: new Date('2026-08-29T00:00:00Z'),
        },
        {
          provider: 'codex',
          state: 'healthy',
          evidence: 'independent',
          sampled_at: new Date('2026-08-26T00:00:00Z'),
          expires_at: new Date('2026-08-27T00:00:00Z'),
        },
      ]);
      const primaryKey = await db.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'tm_health'::regclass AND contype = 'p'`
      );
      expect(primaryKey.rows).toHaveLength(1);
      expect(primaryKey.rows[0]?.definition).toBe('PRIMARY KEY (provider)');
      if (key === 'provider') expect(primaryKey.rows[0]?.conname).toBe('correct_health_key');
      await db.query(healthMigration);
      expect((await db.query('SELECT * FROM tm_health ORDER BY provider')).rows).toEqual(
        preserved.rows
      );
      expect((await db.query("SELECT to_regclass('health_state_sentinel') AS name")).rows).toEqual([
        { name: 'health_state_sentinel' },
      ]);

      await upsertHealthSample({
        provider: 'claude',
        state: 'dark',
        expires_at: '2099-01-01T00:00:00Z',
        evidence: 'first',
      });
      await upsertHealthSample({
        provider: 'claude',
        state: 'healthy',
        expires_at: '2099-01-02T00:00:00Z',
        evidence: 'second',
      });
      expect(
        (await db.query('SELECT provider, state, evidence FROM tm_health ORDER BY provider')).rows
      ).toEqual([
        { provider: 'claude', state: 'healthy', evidence: 'second' },
        { provider: 'codex', state: 'healthy', evidence: 'independent' },
      ]);
      const afterUpserts = await db.query('SELECT * FROM tm_health ORDER BY provider');
      await db.query(healthMigration);
      expect((await db.query('SELECT * FROM tm_health ORDER BY provider')).rows).toEqual(
        afterUpserts.rows
      );
    });
  }
});
