import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { PostgresAdapter } from './adapters/postgres';

let db: PostgresAdapter;
let adminDb: PostgresAdapter | undefined;
let schemaName: string | undefined;
mock.module('./connection', () => ({ getDatabase: () => db }));
const { upsertHealthSample } = await import('./taskmaster');
const migration = readFileSync(
  new URL('../../../../migrations/046_tm_health_provider_pk.sql', import.meta.url),
  'utf8'
);

beforeEach(async () => {
  const raw = process.env.TASKMASTER_POSTGRES_TEST_URL;
  if (!raw) throw new Error('TASKMASTER_POSTGRES_TEST_URL is required');
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    (url.pathname !== '/phase15' && !url.pathname.endsWith('_test'))
  ) {
    throw new Error('TASKMASTER_POSTGRES_TEST_URL must target a loopback test database');
  }
  adminDb = new PostgresAdapter(raw);
  schemaName = `tm_health_test_${randomUUID().replace(/-/g, '')}`;
  await adminDb.query(`CREATE SCHEMA ${schemaName}`);
  url.searchParams.set('options', `-c search_path=${schemaName}`);
  db = new PostgresAdapter(url.toString());
});

afterEach(async () => {
  try {
    if (db) await db.close();
  } finally {
    try {
      if (adminDb && schemaName) await adminDb.query(`DROP SCHEMA ${schemaName} CASCADE`);
    } finally {
      try {
        if (adminDb) await adminDb.close();
      } finally {
        adminDb = undefined;
        schemaName = undefined;
      }
    }
  }
});

describe('tm_health PostgreSQL migration 046', () => {
  for (const key of ['absent', 'composite', 'provider'] as const) {
    test(`${key} primary key: preserves latest data, supports upserts, and replays safely`, async () => {
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

      await db.query(migration);
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
      const primary = await db.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'tm_health'::regclass AND contype = 'p'`
      );
      expect(primary.rows).toHaveLength(1);
      expect(primary.rows[0]?.definition).toBe('PRIMARY KEY (provider)');
      if (key === 'provider') expect(primary.rows[0]?.conname).toBe('correct_health_key');
      await db.query(migration);
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
      await db.query(migration);
      expect((await db.query('SELECT * FROM tm_health ORDER BY provider')).rows).toEqual(
        afterUpserts.rows
      );
    });
  }
});
