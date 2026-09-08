import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createHash, randomUUID } from 'crypto';
import { PostgresAdapter } from './adapters/postgres';
import { DispatchNonSystemCapability } from './dispatch-sender-authority';

function requireLoopbackUrl(raw: string | undefined): string {
  if (!raw) throw new Error('DISPATCH_POSTGRES_PHASE15_TEST_URL is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DISPATCH_POSTGRES_PHASE15_TEST_URL is invalid');
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!allowed) {
    throw new Error('DISPATCH_POSTGRES_PHASE15_TEST_URL must target loopback only');
  }
  const databaseName = url.pathname.replace(/^\//, '');
  if (databaseName !== 'phase15' && !databaseName.endsWith('_test')) {
    throw new Error('DISPATCH_POSTGRES_PHASE15_TEST_URL must target a test database');
  }
  return raw;
}

function withSchemaSearchPath(raw: string, schema: string): string {
  const url = new URL(raw);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

let db: PostgresAdapter;
let adminDb: PostgresAdapter;
const schemaName = `phase15_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

const { createAuthenticatedMessage } = await import('./dispatch');

function setSenderAuthMode(mode: 'enforce'): void {
  process.env.DISPATCH_SENDER_AUTH_MODE = mode;
}

function testAuthenticatedCapability(principalId: string, sender: string) {
  const token = `test-token-${principalId}-${sender}`;
  const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;
  const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;
  try {
    setSenderAuthMode('enforce');
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: `test-${principalId}-${sender}`,
        principal_id: principalId,
        token_sha256: createHash('sha256').update(token).digest('hex'),
        status: 'active',
        send_as: [sender],
        receive_as: [sender],
        roles: ['send', 'receive'],
      },
    ]);
    return DispatchNonSystemCapability.fromAuthenticatedRequest({
      principal_id: principalId,
      token,
      requested_sender: sender,
    });
  } finally {
    if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;
    else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;
    if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;
    else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;
  }
}

beforeAll(async () => {
  const url = requireLoopbackUrl(process.env.DISPATCH_POSTGRES_PHASE15_TEST_URL);
  adminDb = new PostgresAdapter(url);
  await adminDb.query(`CREATE SCHEMA ${schemaName}`);
  db = new PostgresAdapter(withSchemaSearchPath(url, schemaName));
  if (db.dialect !== 'postgres') throw new Error('expected postgres dialect');
  await db.query(`
    CREATE TABLE dispatch_principals (
      principal_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  await db.query(`
    INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active) VALUES
      ('claude', 'Claude', 'worker_poll', TRUE),
      ('codex', 'Codex', 'worker_poll', TRUE),
      ('fusion', 'Fusion', 'worker_poll', TRUE),
      ('xo', 'XO', 'drain_on_start', TRUE)
  `);
  await db.query(`
    CREATE TABLE agent_dispatch_messages (
      id UUID PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      task_type TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      result_body TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      not_before TIMESTAMPTZ,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      fencing_token BIGINT NOT NULL DEFAULT 0,
      recipient_alias TEXT,
      motion_id TEXT,
      motion_revision_sha TEXT,
      resolved_recipient TEXT,
      resolved_xo_lease_id TEXT,
      resolved_xo_fencing_token BIGINT,
      resolved_at TIMESTAMPTZ,
      priority TEXT NOT NULL DEFAULT 'normal',
      task_outcome TEXT,
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by TEXT,
      addressed_at TIMESTAMPTZ,
      addressed_by TEXT,
      escalated_tg_at TIMESTAMPTZ,
      escalated_sms_at TIMESTAMPTZ,
      subject_key TEXT,
      repeat_reason TEXT,
      route_disposition TEXT,
      supersedes_id UUID
    )
  `);
  const migration = readFileSync(
    resolve(import.meta.dir, '../../../../migrations/043_agent_messaging_phase15.sql'),
    'utf8'
  );
  await db.query(migration);
  // 047 adds the `seq` insertion counter that every newest-first read orders by
  // and that createMessage writes. Production applies migrations in order, so
  // this fixture must too -- without it the inserts under test fail with
  // 'column "seq" of relation "agent_dispatch_messages" does not exist'.
  await db.query(
    readFileSync(
      resolve(import.meta.dir, '../../../../migrations/047_agent_dispatch_seq.sql'),
      'utf8'
    )
  );
});

afterAll(async () => {
  try {
    await adminDb.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  } catch {
    /* ignore */
  }
  await db?.close();
  await adminDb?.close();
});

describe('dispatch Phase 1.5 PostgreSQL integration', () => {
  test('refuses non-loopback and non-test database targets', () => {
    expect(() => requireLoopbackUrl('postgresql://postgres@db:5432/phase15')).toThrow(
      'must target loopback only'
    );
    expect(() => requireLoopbackUrl('postgresql://postgres@127.0.0.1:5432/production')).toThrow(
      'must target a test database'
    );
  });

  test('migration 043 removes global unique and installs both partial indexes', async () => {
    const schemaChecks = await Promise.all(
      Array.from({ length: 12 }, () =>
        db.query<{ schema: string }>('SELECT current_schema() AS schema')
      )
    );
    expect(schemaChecks.every(result => result.rows[0]?.schema === schemaName)).toBe(true);
    const indexes = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'agent_dispatch_messages'
       ORDER BY indexname`,
      [schemaName]
    );
    const byName = Object.fromEntries(indexes.rows.map(r => [r.indexname, r.indexdef]));
    expect(byName.uq_agent_dispatch_messages_sender_idempotency_authenticated).toContain(
      'sender_principal_id'
    );
    expect(
      byName.uq_agent_dispatch_messages_sender_idempotency_authenticated.toLowerCase()
    ).toContain('sender_principal_id is not null');
    expect(byName.uq_agent_dispatch_messages_idempotency_legacy.toLowerCase()).toContain(
      'sender_principal_id is null'
    );
    const constraints = await db.query<{ conname: string }>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1
          AND t.relname = 'agent_dispatch_messages'
          AND c.contype = 'u'`,
      [schemaName]
    );
    expect(constraints.rows.map(r => r.conname)).not.toContain(
      'agent_dispatch_messages_idempotency_key_key'
    );
  });

  test('migration 043 rolls back the complete schema change after a late failure', async () => {
    const rollbackSchema = `phase15_rollback_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await adminDb.query(`CREATE SCHEMA ${rollbackSchema}`);
    let failingDb: PostgresAdapter | undefined;
    let inspectDb: PostgresAdapter | undefined;
    try {
      const url = requireLoopbackUrl(process.env.DISPATCH_POSTGRES_PHASE15_TEST_URL);
      failingDb = new PostgresAdapter(withSchemaSearchPath(url, rollbackSchema));
      await failingDb.query(`
        CREATE TABLE agent_dispatch_messages (
          id UUID PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE
        )
      `);
      const migration = readFileSync(
        resolve(import.meta.dir, '../../../../migrations/043_agent_messaging_phase15.sql'),
        'utf8'
      );
      const failingMigration = migration.replace(
        /COMMIT;\s*$/,
        'SELECT phase15_intentional_late_failure();\nCOMMIT;'
      );
      expect(failingMigration).not.toBe(migration);
      await expect(failingDb.query(failingMigration)).rejects.toThrow();
      await failingDb.close();
      failingDb = undefined;

      inspectDb = new PostgresAdapter(withSchemaSearchPath(url, rollbackSchema));
      const columns = await inspectDb.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'agent_dispatch_messages'`,
        [rollbackSchema]
      );
      expect(columns.rows.map(row => row.column_name)).not.toContain('sender_principal_id');
      const constraints = await inspectDb.query<{ conname: string }>(
        `SELECT c.conname
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1
            AND t.relname = 'agent_dispatch_messages'
            AND c.contype = 'u'`,
        [rollbackSchema]
      );
      expect(constraints.rows.map(row => row.conname)).toContain(
        'agent_dispatch_messages_idempotency_key_key'
      );
      const partialIndexes = await inspectDb.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_indexes
         WHERE schemaname = $1
           AND indexname IN (
             'uq_agent_dispatch_messages_sender_idempotency_authenticated',
             'uq_agent_dispatch_messages_idempotency_legacy'
           )`,
        [rollbackSchema]
      );
      expect(partialIndexes.rows[0]?.count).toBe('0');
    } finally {
      await failingDb?.close();
      await inspectDb?.close();
      await adminDb.query(`DROP SCHEMA IF EXISTS ${rollbackSchema} CASCADE`);
    }
  });

  test('same-principal concurrent retries return one row; different principals share keys', async () => {
    const key = `race-${randomUUID()}`;
    const mk = (principal: string, sender: string, body: string) =>
      createAuthenticatedMessage(testAuthenticatedCapability(principal, sender), {
        correlation_id: randomUUID(),
        idempotency_key: key,
        task_type: 'agent_message',
        recipient: 'codex',
        body,
      });

    const [a1, a2, a3] = await Promise.all([
      mk('alice', 'claude', 'a1'),
      mk('alice', 'claude', 'a2'),
      mk('alice', 'claude', 'a3'),
    ]);
    expect(new Set([a1.id, a2.id, a3.id]).size).toBe(1);
    expect(a1.sender_principal_id).toBe('alice');

    const bobDb = new PostgresAdapter(
      withSchemaSearchPath(
        requireLoopbackUrl(process.env.DISPATCH_POSTGRES_PHASE15_TEST_URL),
        schemaName
      )
    );
    const previous = db;
    db = bobDb;
    try {
      const bob = await mk('bob', 'fusion', 'bob');
      expect(bob.id).not.toBe(a1.id);
      expect(bob.sender_principal_id).toBe('bob');
    } finally {
      db = previous;
      await bobDb.close();
    }

    const count = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_dispatch_messages WHERE idempotency_key = $1`,
      [key]
    );
    expect(count.rows[0]?.count).toBe('2');
  });

  test('fixed system retry is not suppressed by a null-principal row', async () => {
    const id = randomUUID();
    const key = `legacy-system-${randomUUID()}`;
    await db.query(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id,
        recipient, body, status)
       VALUES ($1, $2, $3, 'agent_message', 'taskmaster', NULL,
        'xo', 'hostile legacy taskmaster effect', 'queued')`,
      [id, randomUUID(), key]
    );

    const retried = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      {
        correlation_id: randomUUID(),
        idempotency_key: key,
        task_type: 'agent_message',
        recipient: 'xo',
        body: 'authenticated taskmaster effect',
      }
    );

    expect(retried.id).not.toBe(id);
    expect(retried.sender_principal_id).toBe('system:taskmaster');
    const count = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_dispatch_messages WHERE idempotency_key = $1',
      [key]
    );
    expect(count.rows[0]?.count).toBe('2');
  });
});
