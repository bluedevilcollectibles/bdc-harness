import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import { SqliteAdapter } from './adapters/sqlite';
import { setBoardPrincipalResolverForTests } from './board-authority';
import { DispatchNonSystemCapability } from './dispatch-sender-authority';

let db: SqliteAdapter;
let currentDbPath = '';
const raceHomes: string[] = [];
let getDatabaseCalls = 0;

function setSenderAuthMode(mode: 'enforce'): void {
  process.env.DISPATCH_SENDER_AUTH_MODE = mode;
}

mock.module('./connection', () => ({
  getDatabase: () => {
    getDatabaseCalls += 1;
    return db;
  },
}));

import {
  acknowledgeMessage,
  addressMessage,
  cancelMessage,
  claimDispatchEscalation,
  claimMessage,
  createAuthenticatedMessage,
  evaluateWorkerStaleness,
  ensureXoEscalationHandoffs,
  getMessage,
  heartbeatWorker,
  listEligibleXoEscalations,
  listMessages,
  listMessagesByCorrelationPrefixWithoutSubjectKey,
  listUnroutableQueuedMessages,
  listWorkers,
  postResult,
  reconcileDispatchOutcomeNotices,
  registerWorker,
  releaseDispatchEscalationClaim,
  releaseMessage,
  renewMessageLease,
  resolveDispatchRecipient,
  assessDispatchRecipient,
  normalizeDispatchSubjectKey,
  supersedeMessage,
  type CreateAuthenticatedMessageData,
  type DispatchMessage,
} from './dispatch';

/** Test-local fixture constructor -- production path is createAuthenticatedMessage. */
async function createMessage(
  data: CreateAuthenticatedMessageData & { sender: string; sender_principal_id?: string | null }
): Promise<DispatchMessage> {
  if (data.sender_principal_id) {
    return createAuthenticatedMessage(
      testAuthenticatedCapability(data.sender_principal_id, data.sender),
      data
    );
  }
  return createAuthenticatedMessage(testLegacyCapability(data.sender), data);
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

function testLegacyCapability(sender: string) {
  const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;
  const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;
  try {
    process.env.DISPATCH_SENDER_AUTH_MODE = 'off';
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'test-legacy-registry',
        principal_id: 'test-legacy-principal',
        token_sha256: '0'.repeat(64),
        status: 'active',
        send_as: ['claude'],
        receive_as: [],
        roles: ['send'],
      },
    ]);
    return DispatchNonSystemCapability.fromHttpRequest({ requested_sender: sender }).capability;
  } finally {
    if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;
    else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;
    if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;
    else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;
  }
}

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

interface MailboxProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runMailboxRace(
  archonHome: string,
  action: 'acknowledge' | 'address',
  messageId: string
): Promise<MailboxProcessResult[]> {
  const dispatchUrl = pathToFileURL(resolve(import.meta.dir, 'dispatch.ts')).href;
  const connectionUrl = pathToFileURL(resolve(import.meta.dir, 'connection.ts')).href;
  const startFile = join(archonHome, `${action}.start`);
  const childScript = `
    const { acknowledgeMessage, addressMessage } = await import(${JSON.stringify(dispatchUrl)});
    const { closeDatabase, getDatabase } = await import(${JSON.stringify(connectionUrl)});
    getDatabase();
    await Bun.write(process.env.READY_FILE, 'ready');
    while (!(await Bun.file(process.env.START_FILE).exists())) await Bun.sleep(2);
    try {
      const result = process.env.MAILBOX_ACTION === 'acknowledge'
        ? await acknowledgeMessage({ id: process.env.MESSAGE_ID, principal_id: 'operator' })
        : await addressMessage({ id: process.env.MESSAGE_ID, principal_id: 'operator' });
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : 'mailbox_process_failed');
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  `;
  const children: Array<{
    child: ReturnType<typeof Bun.spawn>;
    readyFile: string;
  }> = [];
  for (const index of [0, 1]) {
    const readyFile = join(archonHome, `${action}-${index}.ready`);
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', childScript],
      cwd: resolve(import.meta.dir, '..', '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ARCHON_HOME: archonHome,
        LOG_LEVEL: 'fatal',
        MAILBOX_ACTION: action,
        MESSAGE_ID: messageId,
        READY_FILE: readyFile,
        START_FILE: startFile,
      },
    });
    children.push({ child, readyFile });
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if (existsSync(readyFile)) break;
      if (attempt === 999) throw new Error('mailbox_race_process_ready_timeout');
      await Bun.sleep(5);
    }
  }
  await Bun.write(startFile, 'start');

  return Promise.all(
    children.map(async ({ child }) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    })
  );
}

async function makeSeparateProcessMailboxFixture(
  idempotencyKey: string,
  acknowledged: boolean
): Promise<{ archonHome: string; messageId: string }> {
  const archonHome = mkdtempSync(join(tmpdir(), 'archon-dispatch-race-'));
  raceHomes.push(archonHome);
  const raceDb = new SqliteAdapter(join(archonHome, 'archon.db'));
  const primaryDb = db;
  db = raceDb;
  try {
    const message = await createMessage({
      correlation_id: `${idempotencyKey}-correlation`,
      idempotency_key: idempotencyKey,
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Separate process mailbox race.',
    });
    if (acknowledged) {
      expect((await acknowledgeMessage({ id: message.id, principal_id: 'operator' })).ok).toBe(
        true
      );
    }
    return { archonHome, messageId: message.id };
  } finally {
    db = primaryDb;
    await raceDb.close();
  }
}

describe('dispatch db', () => {
  beforeEach(() => {
    getDatabaseCalls = 0;
    process.env.BUN_ENV = 'test';
    setBoardPrincipalResolverForTests(async () => ({
      principal_id: 'claude',
      seat_id: 'xo',
      roles: ['motion_notifier', 'petition_eligible'],
    }));
    currentDbPath = join(
      import.meta.dir,
      `.test-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    setBoardPrincipalResolverForTests(undefined);
    delete process.env.BUN_ENV;
    await db.close();
    cleanupDb(currentDbPath);
    while (raceHomes.length > 0) {
      const raceHome = raceHomes.pop();
      if (raceHome) rmSync(raceHome, { recursive: true, force: true });
    }
  });

  test('deduplicates repeated idempotency_key posts', async () => {
    const first = await createMessage({
      correlation_id: 'corr-1',
      idempotency_key: 'idem-1',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'Say hello',
    });
    const second = await createMessage({
      correlation_id: 'corr-2',
      idempotency_key: 'idem-1',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'This should not enqueue twice',
    });

    expect(second.id).toBe(first.id);
    expect(second.correlation_id).toBe('corr-1');
    const rows = await db.query('SELECT id FROM agent_dispatch_messages');
    expect(rows.rowCount).toBe(1);
  });

  test('deduplicates legacy creates against Phase 1.5 partial indexes', async () => {
    await db.query(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id,
        recipient, body, status, created_at, priority, fencing_token)
       VALUES ($1, $2, $3, 'agent_message', 'authenticated-sender', 'board:authenticated',
        'operator', 'authenticated namespace row', 'queued', $4, 'normal', 0)`,
      [
        'authenticated-row',
        'authenticated-correlation',
        'shared-partial-key',
        new Date().toISOString(),
      ]
    );

    const [first, second] = await Promise.all([
      createMessage({
        correlation_id: 'legacy-correlation-1',
        idempotency_key: 'shared-partial-key',
        task_type: 'agent_message',
        sender: 'taskmaster',
        recipient: 'operator',
        body: 'legacy namespace row',
      }),
      createMessage({
        correlation_id: 'legacy-correlation-2',
        idempotency_key: 'shared-partial-key',
        task_type: 'agent_message',
        sender: 'taskmaster',
        recipient: 'operator',
        body: 'duplicate legacy namespace row',
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect(first.id).not.toBe('authenticated-row');
    const rows = await db.query<{ sender_principal_id: string | null }>(
      'SELECT sender_principal_id FROM agent_dispatch_messages WHERE idempotency_key = $1',
      ['shared-partial-key']
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.filter(row => row.sender_principal_id === null)).toHaveLength(1);
  });

  test('assesses canonical recipients and rejects missing or inactive principals', async () => {
    await expect(assessDispatchRecipient(' Operator ')).resolves.toEqual({
      ok: true,
      canonical_principal: 'operator',
      delivery_mode: 'drain_on_start',
      reason: null,
    });
    await expect(assessDispatchRecipient(' john ')).resolves.toEqual({
      ok: false,
      canonical_principal: 'john',
      delivery_mode: 'notify_only',
      reason: 'inactive_principal',
    });
    await expect(assessDispatchRecipient(' Missing ')).resolves.toEqual({
      ok: false,
      canonical_principal: 'missing',
      delivery_mode: null,
      reason: 'missing_principal',
    });
  });

  test('canonicalizes concrete recipient filters before listing messages', async () => {
    const message = await createMessage({
      correlation_id: 'corr-canonical-list-filter',
      idempotency_key: 'idem-canonical-list-filter',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'grok',
      body: 'Canonical list filter message.',
    });

    const listed = await listMessages({ recipient: ' Grok ' });

    expect(listed.map(item => item.id)).toEqual([message.id]);
  });

  test('guards new recipients while retaining idempotent creates and board metadata', async () => {
    const original = await createMessage({
      correlation_id: 'corr-idempotent-active',
      idempotency_key: 'idem-idempotent-active',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Original mailbox message.',
    });
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'operator'");

    const retry = await createMessage({
      correlation_id: 'corr-idempotent-inactive',
      idempotency_key: 'idem-idempotent-active',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Must return original before recipient assessment.',
    });
    expect(retry.id).toBe(original.id);
    await expect(
      createMessage({
        correlation_id: 'corr-inactive',
        idempotency_key: 'idem-inactive',
        task_type: 'agent_message',
        sender: 'xo',
        recipient: 'operator',
        body: 'New inactive recipient message.',
      })
    ).rejects.toThrow('inactive_principal');
    await expect(
      createMessage({
        correlation_id: 'corr-missing',
        idempotency_key: 'idem-missing',
        task_type: 'agent_message',
        sender: 'xo',
        recipient: 'missing',
        body: 'Unknown recipient message.',
      })
    ).rejects.toThrow('missing_principal');
    await expect(
      createMessage({
        correlation_id: 'corr-board-without-metadata',
        idempotency_key: 'idem-board-without-metadata',
        task_type: 'board_motion',
        sender: 'xo',
        recipient: ' Board ',
        body: 'Board message without alias metadata.',
      })
    ).rejects.toThrow('board_alias_metadata_required');
    const board = await createMessage({
      correlation_id: 'corr-board-with-metadata',
      idempotency_key: 'idem-board-with-metadata',
      task_type: 'board_motion',
      sender: 'xo',
      recipient: ' Board ',
      body: 'Board message with alias metadata.',
      recipient_alias: 'board',
    });
    expect(board.recipient).toBe('board');
  });

  test('keeps worker polling claimable and rejects mailbox delivery modes', async () => {
    await registerWorker({
      worker_id: 'worker-mode-guard',
      host: 'host',
      capabilities: {},
      max_concurrency: 1,
    });
    const workerMessage = await createMessage({
      correlation_id: 'corr-worker-mode',
      idempotency_key: 'idem-worker-mode',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'codex',
      body: 'Worker poll message.',
    });
    const mailboxMessage = await createMessage({
      correlation_id: 'corr-mailbox-mode',
      idempotency_key: 'idem-mailbox-mode',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'overseer',
      body: 'Notify-only mailbox message.',
    });

    expect(
      (await claimMessage({ id: workerMessage.id, worker_id: 'worker-mode-guard' }))?.status
    ).toBe('claimed');
    expect(
      await claimMessage({ id: mailboxMessage.id, worker_id: 'worker-mode-guard' })
    ).toBeNull();
  });

  test('rejects missing and inactive concrete principals before claim', async () => {
    await registerWorker({
      worker_id: 'worker-registry-guard',
      host: 'host',
      capabilities: {},
      max_concurrency: 1,
    });
    const missingPrincipalMessage = await createMessage({
      correlation_id: 'corr-claim-missing-principal',
      idempotency_key: 'idem-claim-missing-principal',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'codex',
      body: 'Missing principal claim guard.',
    });
    const inactivePrincipalMessage = await createMessage({
      correlation_id: 'corr-claim-inactive-principal',
      idempotency_key: 'idem-claim-inactive-principal',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'grok',
      body: 'Inactive principal claim guard.',
    });
    const wrongModePrincipalMessage = await createMessage({
      correlation_id: 'corr-claim-wrong-mode-principal',
      idempotency_key: 'idem-claim-wrong-mode-principal',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'fusion',
      body: 'Wrong mode principal claim guard.',
    });
    await db.query("DELETE FROM dispatch_principals WHERE principal_id = 'codex'");
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'grok'");
    await db.query(
      "UPDATE dispatch_principals SET delivery_mode = 'alias_resolved' WHERE principal_id = 'fusion'"
    );

    await expect(
      claimMessage({ id: missingPrincipalMessage.id, worker_id: 'worker-registry-guard' })
    ).resolves.toBeNull();
    await expect(
      claimMessage({ id: inactivePrincipalMessage.id, worker_id: 'worker-registry-guard' })
    ).resolves.toBeNull();
    await expect(
      claimMessage({ id: wrongModePrincipalMessage.id, worker_id: 'worker-registry-guard' })
    ).resolves.toBeNull();
    for (const message of [
      missingPrincipalMessage,
      inactivePrincipalMessage,
      wrongModePrincipalMessage,
    ]) {
      expect(await getMessage(message.id)).toMatchObject({
        status: 'queued',
        fencing_token: 0,
        lease_owner: null,
        lease_expires_at: null,
      });
    }
  });

  test('rejects inactive board aliases and inactive resolved board principals before claim', async () => {
    await registerWorker({
      worker_id: 'worker-board-registry-guard',
      host: 'host',
      capabilities: {},
      max_concurrency: 1,
    });
    const boardMessage = await createMessage({
      correlation_id: 'corr-claim-inactive-board-principal',
      idempotency_key:
        'board-motion:M-claim-registry:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:board',
      task_type: 'board_motion',
      sender: 'xo',
      recipient: 'board',
      body: '{"motion_id":"M-claim-registry","title":"T","file_path":"docs/board/motions/M.md"}',
      recipient_alias: 'board',
      motion_id: 'M-claim-registry',
      motion_revision_sha: 'a'.repeat(40),
    });
    const now = new Date();
    await db.query(
      `INSERT INTO board_xo_leases (
         id, lease_id, principal_id, seat_id, holder_id, holder_token_hash,
         fencing_token, acquired_at, renewed_at, expires_at, released_at
       )
       VALUES (1, $1, 'claude', 'xo', 'holder', $2, 13, $3, NULL, $4, NULL)`,
      [
        'lease-registry-guard',
        'c'.repeat(64),
        now.toISOString(),
        new Date(now.getTime() + 60_000).toISOString(),
      ]
    );
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'claude'");

    await expect(
      claimMessage({
        id: boardMessage.id,
        worker_id: 'worker-board-registry-guard',
        delivery_principal: 'claude',
      })
    ).resolves.toBeNull();
    await db.query("UPDATE dispatch_principals SET active = 1 WHERE principal_id = 'claude'");
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'board'");
    await expect(
      claimMessage({
        id: boardMessage.id,
        worker_id: 'worker-board-registry-guard',
        delivery_principal: 'claude',
      })
    ).resolves.toBeNull();
    await db.query(
      "UPDATE dispatch_principals SET active = 1, delivery_mode = 'worker_poll' WHERE principal_id = 'board'"
    );
    await expect(
      claimMessage({
        id: boardMessage.id,
        worker_id: 'worker-board-registry-guard',
        delivery_principal: 'claude',
      })
    ).resolves.toBeNull();
    await db.query(
      "UPDATE dispatch_principals SET delivery_mode = 'alias_resolved' WHERE principal_id = 'board'"
    );
    await db.query("DELETE FROM dispatch_principals WHERE principal_id = 'board'");
    await expect(
      claimMessage({
        id: boardMessage.id,
        worker_id: 'worker-board-registry-guard',
        delivery_principal: 'claude',
      })
    ).resolves.toBeNull();
    await db.query(
      `INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
       VALUES ('board', 'Board', 'alias_resolved', 1)`
    );
    await db.query("DELETE FROM dispatch_principals WHERE principal_id = 'claude'");
    await expect(
      claimMessage({
        id: boardMessage.id,
        worker_id: 'worker-board-registry-guard',
        delivery_principal: 'claude',
      })
    ).resolves.toBeNull();
    expect((await getMessage(boardMessage.id))?.status).toBe('queued');
  });

  test('rejects acknowledgement and addressing after a mailbox principal becomes inactive', async () => {
    const acknowledgeTarget = await createMessage({
      correlation_id: 'corr-ack-inactive-principal',
      idempotency_key: 'idem-ack-inactive-principal',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Inactive acknowledgement guard.',
    });
    const addressTarget = await createMessage({
      correlation_id: 'corr-address-inactive-principal',
      idempotency_key: 'idem-address-inactive-principal',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Inactive address guard.',
    });
    expect((await acknowledgeMessage({ id: addressTarget.id, principal_id: 'operator' })).ok).toBe(
      true
    );
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'operator'");

    await expect(
      acknowledgeMessage({ id: acknowledgeTarget.id, principal_id: 'operator' })
    ).resolves.toEqual({ ok: false, reason: 'wrong_mode' });
    await expect(
      addressMessage({ id: addressTarget.id, principal_id: 'operator' })
    ).resolves.toEqual({ ok: false, reason: 'wrong_mode' });
    await db.query("DELETE FROM dispatch_principals WHERE principal_id = 'operator'");
    await expect(
      acknowledgeMessage({ id: acknowledgeTarget.id, principal_id: 'operator' })
    ).resolves.toEqual({ ok: false, reason: 'wrong_mode' });
    await expect(
      addressMessage({ id: addressTarget.id, principal_id: 'operator' })
    ).resolves.toEqual({ ok: false, reason: 'wrong_mode' });
    expect((await getMessage(acknowledgeTarget.id))?.acknowledged_at).toBeNull();
    expect((await getMessage(addressTarget.id))?.addressed_at).toBeNull();
  });

  test('acknowledges mailbox messages once without changing queue or address state', async () => {
    const message = await createMessage({
      correlation_id: 'corr-ack',
      idempotency_key: 'idem-ack',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Acknowledge me.',
      priority: 'blocker',
    });

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        acknowledgeMessage({ id: message.id, principal_id: 'operator' })
      )
    );
    expect(results.every(result => result.ok)).toBe(true);
    const stored = await getMessage(message.id);
    expect(stored).toMatchObject({
      status: 'queued',
      acknowledged_by: 'operator',
      addressed_at: null,
      addressed_by: null,
    });
    expect(stored?.acknowledged_at).not.toBeNull();
    expect((await acknowledgeMessage({ id: message.id, principal_id: 'operator' })).ok).toBe(true);
  });

  test('acknowledgement revalidates stale recipient state after a guarded update loses', async () => {
    const message = await createMessage({
      correlation_id: 'corr-ack-stale-recipient',
      idempotency_key: 'idem-ack-stale-recipient',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Stale recipient target.',
    });
    const staleMessage = { ...message, recipient: 'codex' };
    const originalDb = db;
    const updateSql: string[] = [];
    let readCount = 0;
    const query = async <T>(sql: string): Promise<{ rows: readonly T[]; rowCount: number }> => {
      if (sql.startsWith('SELECT * FROM agent_dispatch_messages')) {
        readCount += 1;
        const row = readCount === 1 ? message : staleMessage;
        return { rows: [row as T], rowCount: 1 };
      }
      if (sql.startsWith('SELECT principal_id, delivery_mode, active')) {
        return {
          rows: [{ principal_id: 'operator', delivery_mode: 'drain_on_start', active: 1 } as T],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE agent_dispatch_messages')) {
        updateSql.push(sql);
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    db = {
      ...originalDb,
      query,
      withTransaction: async fn => fn(query),
    } as SqliteAdapter;

    try {
      await expect(
        acknowledgeMessage({ id: message.id, principal_id: 'operator' })
      ).resolves.toEqual({ ok: false, reason: 'wrong_recipient' });
      expect(updateSql[0]).toContain('LOWER(TRIM(COALESCE(resolved_recipient, recipient))) = $3');
      expect(updateSql[0]).toContain("CAST(recipient_principal.active AS TEXT) IN ('1', 'true')");
      expect(updateSql[0]).toContain("delivery_mode IN ('drain_on_start', 'notify_only')");
    } finally {
      db = originalDb;
    }
  });

  test('acknowledgement maps a registry deactivation after a lost update to wrong_mode', async () => {
    const message = await createMessage({
      correlation_id: 'corr-ack-registry-deactivation',
      idempotency_key: 'idem-ack-registry-deactivation',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Registry deactivation race target.',
    });
    const originalDb = db;
    const updateSql: string[] = [];
    let principalReadCount = 0;
    const query = async <T>(sql: string): Promise<{ rows: readonly T[]; rowCount: number }> => {
      if (sql.startsWith('SELECT * FROM agent_dispatch_messages')) {
        return { rows: [message as T], rowCount: 1 };
      }
      if (sql.startsWith('SELECT principal_id, delivery_mode, active')) {
        principalReadCount += 1;
        return {
          rows: [
            {
              principal_id: 'operator',
              delivery_mode: 'drain_on_start',
              active: principalReadCount === 1 ? 1 : 0,
            } as T,
          ],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE agent_dispatch_messages')) {
        updateSql.push(sql);
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    db = {
      ...originalDb,
      query,
      withTransaction: async fn => fn(query),
    } as SqliteAdapter;

    try {
      await expect(
        acknowledgeMessage({ id: message.id, principal_id: 'operator' })
      ).resolves.toEqual({ ok: false, reason: 'wrong_mode' });
      expect(updateSql[0]).toContain("CAST(recipient_principal.active AS TEXT) IN ('1', 'true')");
    } finally {
      db = originalDb;
    }
  });

  test('concurrent acknowledgement through independent SQLite connections is idempotent', async () => {
    const message = await createMessage({
      correlation_id: 'corr-ack-independent-connections',
      idempotency_key: 'idem-ack-independent-connections',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Independent connection target.',
    });
    const primaryDb = db;
    const independentDb = new SqliteAdapter(currentDbPath);
    try {
      db = primaryDb;
      const first = acknowledgeMessage({ id: message.id, principal_id: 'operator' });
      db = independentDb;
      const second = acknowledgeMessage({ id: message.id, principal_id: 'operator' });
      const results = await Promise.all([first, second]);

      expect(results.every(result => result.ok)).toBe(true);
    } finally {
      db = primaryDb;
      await independentDb.close();
    }
  });

  test('concurrent acknowledgement in separate processes against one SQLite file is idempotent', async () => {
    const { archonHome, messageId } = await makeSeparateProcessMailboxFixture(
      'idem-ack-separate-processes',
      false
    );

    const results = await runMailboxRace(archonHome, 'acknowledge', messageId);

    expect(results.filter(result => result.exitCode !== 0)).toEqual([]);
    const processResults = results.map(
      result =>
        JSON.parse(result.stdout) as {
          ok: boolean;
          message: { acknowledged_at: string | null };
        }
    );
    expect(processResults).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(new Set(processResults.map(result => result.message.acknowledged_at)).size).toBe(1);
    expect(results.every(result => !result.stderr.includes('database is locked'))).toBe(true);
    const inspectionDb = new SqliteAdapter(join(archonHome, 'archon.db'));
    try {
      const stored = await inspectionDb.query<{
        status: string;
        acknowledged_at: string | null;
        acknowledged_by: string | null;
      }>(
        'SELECT status, acknowledged_at, acknowledged_by FROM agent_dispatch_messages WHERE id = $1',
        [messageId]
      );
      expect(stored.rows[0]).toMatchObject({
        status: 'queued',
        acknowledged_by: 'operator',
      });
      expect(stored.rows[0]?.acknowledged_at).not.toBeNull();
      expect(stored.rows[0]?.acknowledged_at).toBe(processResults[0]?.message.acknowledged_at);
    } finally {
      await inspectionDb.close();
    }
  });

  test('returns every acknowledgement conflict outcome', async () => {
    const mailbox = await createMessage({
      correlation_id: 'corr-ack-conflicts',
      idempotency_key: 'idem-ack-conflicts',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'xo',
      body: 'Mailbox conflict target.',
    });
    const worker = await createMessage({
      correlation_id: 'corr-ack-worker',
      idempotency_key: 'idem-ack-worker',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'codex',
      body: 'Worker conflict target.',
    });
    const nonQueued = await createMessage({
      correlation_id: 'corr-ack-nonqueued',
      idempotency_key: 'idem-ack-nonqueued',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Non-queued conflict target.',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'done' WHERE id = $1", [
      nonQueued.id,
    ]);

    await expect(acknowledgeMessage({ id: 'missing', principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
    await expect(acknowledgeMessage({ id: mailbox.id, principal_id: 'operator' })).resolves.toEqual(
      {
        ok: false,
        reason: 'wrong_recipient',
      }
    );
    await expect(acknowledgeMessage({ id: worker.id, principal_id: 'codex' })).resolves.toEqual({
      ok: false,
      reason: 'wrong_mode',
    });
    await expect(
      acknowledgeMessage({ id: nonQueued.id, principal_id: 'operator' })
    ).resolves.toEqual({
      ok: false,
      reason: 'not_queued',
    });
    expect((await acknowledgeMessage({ id: mailbox.id, principal_id: 'xo' })).ok).toBe(true);
    await expect(acknowledgeMessage({ id: mailbox.id, principal_id: 'xo-fable' })).resolves.toEqual(
      {
        ok: false,
        reason: 'wrong_recipient',
      }
    );
  });

  test('addresses only acknowledged mail by its acknowledger and is idempotent', async () => {
    const message = await createMessage({
      correlation_id: 'corr-address',
      idempotency_key: 'idem-address',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Address me.',
    });
    await expect(addressMessage({ id: message.id, principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'address_before_ack',
    });
    expect((await acknowledgeMessage({ id: message.id, principal_id: 'operator' })).ok).toBe(true);
    await expect(addressMessage({ id: message.id, principal_id: 'xo' })).resolves.toEqual({
      ok: false,
      reason: 'wrong_recipient',
    });
    await expect(
      addressMessage({ id: message.id, principal_id: 'operator' })
    ).resolves.toMatchObject({
      ok: true,
    });
    const repeats = await Promise.all(
      Array.from({ length: 3 }, () => addressMessage({ id: message.id, principal_id: 'operator' }))
    );
    expect(repeats.every(result => result.ok)).toBe(true);
    const stored = await getMessage(message.id);
    expect(stored).toMatchObject({
      status: 'queued',
      acknowledged_by: 'operator',
      addressed_by: 'operator',
    });
    expect(stored?.addressed_at).not.toBeNull();
  });

  test('concurrent address in separate processes against one SQLite file is idempotent', async () => {
    const { archonHome, messageId } = await makeSeparateProcessMailboxFixture(
      'idem-address-separate-processes',
      true
    );

    const results = await runMailboxRace(archonHome, 'address', messageId);

    expect(results.filter(result => result.exitCode !== 0)).toEqual([]);
    const processResults = results.map(
      result =>
        JSON.parse(result.stdout) as {
          ok: boolean;
          message: { addressed_at: string | null };
        }
    );
    expect(processResults).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(new Set(processResults.map(result => result.message.addressed_at)).size).toBe(1);
    expect(results.every(result => !result.stderr.includes('database is locked'))).toBe(true);
    const inspectionDb = new SqliteAdapter(join(archonHome, 'archon.db'));
    try {
      const stored = await inspectionDb.query<{
        status: string;
        acknowledged_by: string | null;
        addressed_at: string | null;
        addressed_by: string | null;
      }>(
        'SELECT status, acknowledged_by, addressed_at, addressed_by FROM agent_dispatch_messages WHERE id = $1',
        [messageId]
      );
      expect(stored.rows[0]).toMatchObject({
        status: 'queued',
        acknowledged_by: 'operator',
        addressed_by: 'operator',
      });
      expect(stored.rows[0]?.addressed_at).not.toBeNull();
      expect(stored.rows[0]?.addressed_at).toBe(processResults[0]?.message.addressed_at);
    } finally {
      await inspectionDb.close();
    }
  });

  test('addressing revalidates final status when a guarded update loses to cancellation', async () => {
    const message = await createMessage({
      correlation_id: 'corr-address-stale-status',
      idempotency_key: 'idem-address-stale-status',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Stale status target.',
    });
    const acknowledged = {
      ...message,
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: 'operator',
    };
    const cancelled = { ...acknowledged, status: 'cancelled' as const };
    const originalDb = db;
    const updateSql: string[] = [];
    let readCount = 0;
    const query = async <T>(sql: string): Promise<{ rows: readonly T[]; rowCount: number }> => {
      if (sql.startsWith('SELECT * FROM agent_dispatch_messages')) {
        readCount += 1;
        const row = readCount === 1 ? acknowledged : cancelled;
        return { rows: [row as T], rowCount: 1 };
      }
      if (sql.startsWith('SELECT principal_id, delivery_mode, active')) {
        return {
          rows: [{ principal_id: 'operator', delivery_mode: 'drain_on_start', active: 1 } as T],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE agent_dispatch_messages')) {
        updateSql.push(sql);
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    db = {
      ...originalDb,
      query,
      withTransaction: async fn => fn(query),
    } as SqliteAdapter;

    try {
      await expect(addressMessage({ id: message.id, principal_id: 'operator' })).resolves.toEqual({
        ok: false,
        reason: 'not_queued',
      });
      expect(updateSql[0]).toContain('LOWER(TRIM(COALESCE(resolved_recipient, recipient))) = $3');
      expect(updateSql[0]).toContain("CAST(recipient_principal.active AS TEXT) IN ('1', 'true')");
      expect(updateSql[0]).toContain("delivery_mode IN ('drain_on_start', 'notify_only')");
    } finally {
      db = originalDb;
    }
  });

  test('returns address actor, mode, state, and existence conflict outcomes', async () => {
    const mailbox = await createMessage({
      correlation_id: 'corr-address-conflicts',
      idempotency_key: 'idem-address-conflicts',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Address conflict target.',
    });
    const worker = await createMessage({
      correlation_id: 'corr-address-worker',
      idempotency_key: 'idem-address-worker',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'codex',
      body: 'Address worker target.',
    });
    const nonQueued = await createMessage({
      correlation_id: 'corr-address-nonqueued',
      idempotency_key: 'idem-address-nonqueued',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Address non-queued target.',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'done' WHERE id = $1", [
      nonQueued.id,
    ]);
    expect((await acknowledgeMessage({ id: mailbox.id, principal_id: 'operator' })).ok).toBe(true);

    await expect(addressMessage({ id: 'missing', principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
    await expect(addressMessage({ id: worker.id, principal_id: 'codex' })).resolves.toEqual({
      ok: false,
      reason: 'wrong_mode',
    });
    await expect(addressMessage({ id: nonQueued.id, principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'not_queued',
    });
    await expect(addressMessage({ id: mailbox.id, principal_id: 'xo' })).resolves.toEqual({
      ok: false,
      reason: 'wrong_recipient',
    });
    await db.query("UPDATE agent_dispatch_messages SET acknowledged_by = 'xo' WHERE id = $1", [
      mailbox.id,
    ]);
    await expect(addressMessage({ id: mailbox.id, principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'actor_mismatch',
    });
  });

  test('lists only due unaddressed queued work by priority while retaining historical queries', async () => {
    const blocker = await createMessage({
      correlation_id: 'corr-list-blocker',
      idempotency_key: 'idem-list-blocker',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Blocker.',
      priority: 'blocker',
    });
    const normal = await createMessage({
      correlation_id: 'corr-list-normal',
      idempotency_key: 'idem-list-normal',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Normal.',
      priority: 'normal',
    });
    const heartbeat = await createMessage({
      correlation_id: 'corr-list-heartbeat',
      idempotency_key: 'idem-list-heartbeat',
      task_type: 'run_report',
      sender: 'xo',
      recipient: 'operator',
      body: 'Heartbeat.',
      priority: 'heartbeat',
    });
    const future = await createMessage({
      correlation_id: 'corr-list-future',
      idempotency_key: 'idem-list-future',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Future.',
      not_before: new Date(Date.now() + 60_000).toISOString(),
      priority: 'blocker',
    });
    const addressed = await createMessage({
      correlation_id: 'corr-list-addressed',
      idempotency_key: 'idem-list-addressed',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Addressed.',
      priority: 'blocker',
    });
    await acknowledgeMessage({ id: addressed.id, principal_id: 'operator' });
    await addressMessage({ id: addressed.id, principal_id: 'operator' });
    await acknowledgeMessage({ id: blocker.id, principal_id: 'operator' });
    const historical = await createMessage({
      correlation_id: 'corr-list-historical',
      idempotency_key: 'idem-list-historical',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Historical.',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'done' WHERE id = $1", [
      historical.id,
    ]);

    const queued = await listMessages({ recipient: 'operator', status: 'queued' });
    expect(queued.map(message => message.id)).toEqual([blocker.id, normal.id, heartbeat.id]);
    expect(queued.map(message => message.id)).not.toContain(future.id);
    expect(queued.map(message => message.id)).not.toContain(addressed.id);
    expect(
      (await listMessages({ recipient: 'operator', status: 'done' })).map(message => message.id)
    ).toContain(historical.id);
  });

  test('reports only queued concrete recipients that are missing or inactive without mutation', async () => {
    const inactive = await createMessage({
      correlation_id: 'corr-unroutable-inactive',
      idempotency_key: 'idem-unroutable-inactive',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Become inactive after enqueue.',
      priority: 'blocker',
    });
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'operator'");
    await db.query(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, priority, created_at, fencing_token)
       VALUES ('missing-recipient', 'corr-unroutable-missing', 'idem-unroutable-missing', 'agent_message', 'xo', 'missing', 'No body in report.', 'queued', 'normal', $1, 0)`,
      [new Date().toISOString()]
    );
    const writes: string[] = [];
    const query = async <T>(sql: string, params?: unknown[]) => {
      writes.push(sql);
      return db.query<T>(sql, params);
    };

    const rows = await listUnroutableQueuedMessages(query);

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: inactive.id, recipient: 'operator', priority: 'blocker' }),
        expect.objectContaining({
          id: 'missing-recipient',
          recipient: 'missing',
          priority: 'normal',
        }),
      ])
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith('SELECT');
  });

  test('uses a PostgreSQL-compatible inactive-principal predicate for unroutable reporting', async () => {
    const queries: string[] = [];
    const rows = await listUnroutableQueuedMessages(async <T>(sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 } as { rows: readonly T[]; rowCount: number };
    });

    expect(rows).toEqual([]);
    expect(queries[0]).toContain("CAST(principal.active AS TEXT) IN ('0', 'false')");
  });

  test('rejects stale fencing token result after lease expiry and reclaim', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    await registerWorker({
      worker_id: 'worker-b',
      host: 'host-b',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-lease',
      idempotency_key: 'idem-lease',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'Review this.',
    });

    const firstClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-a',
      leaseDurationMs: 1,
    });
    expect(firstClaim?.fencing_token).toBe(1);

    await Bun.sleep(10);
    const secondClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-b',
      leaseDurationMs: 60_000,
    });
    expect(secondClaim?.fencing_token).toBe(2);

    const staleResult = await postResult({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: 1,
      result_body: 'late',
    });
    expect(staleResult).toBeNull();
  });

  test('renewMessageLease keeps a long run claimed past its original lease', async () => {
    // WO-HARNESS-ACP-DISPATCH-SLICE-01 / M-118 order 4. Regression target: an
    // agent leg running longer than lease_duration_ms used to become silently
    // reclaimable by another worker mid-run.
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    await registerWorker({
      worker_id: 'worker-b',
      host: 'host-b',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-renew',
      idempotency_key: 'idem-renew',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'grok',
      body: 'Long ACP run.',
    });

    const claim = await claimMessage({
      id: message.id,
      worker_id: 'worker-a',
      leaseDurationMs: 30,
    });
    expect(claim?.fencing_token).toBe(1);

    const renewed = await renewMessageLease({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: claim?.fencing_token ?? 0,
      leaseDurationMs: 60_000,
    });
    // Renewal must NOT bump the token -- it is not a new claim.
    expect(renewed?.fencing_token).toBe(1);
    expect(renewed?.status).toBe('claimed');

    await Bun.sleep(50);
    // Past the ORIGINAL 30ms lease: without renewal worker-b would steal it.
    const steal = await claimMessage({
      id: message.id,
      worker_id: 'worker-b',
      leaseDurationMs: 60_000,
    });
    expect(steal).toBeNull();

    // The original owner still completes with its original token.
    const done = await postResult({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: 1,
      result_body: 'finished after renewal',
    });
    expect(done?.status).toBe('done');
  });

  test('renewMessageLease rejects non-owner, stale token, and unclaimed messages', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-renew-guard',
      idempotency_key: 'idem-renew-guard',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'grok',
      body: 'Guarded.',
    });

    // Not claimed yet -> nothing to renew.
    expect(
      await renewMessageLease({ id: message.id, worker_id: 'worker-a', fencing_token: 1 })
    ).toBeNull();

    const claim = await claimMessage({ id: message.id, worker_id: 'worker-a' });
    expect(claim?.status).toBe('claimed');

    // Wrong owner.
    expect(
      await renewMessageLease({ id: message.id, worker_id: 'worker-b', fencing_token: 1 })
    ).toBeNull();
    // Stale token.
    expect(
      await renewMessageLease({ id: message.id, worker_id: 'worker-a', fencing_token: 99 })
    ).toBeNull();

    // Cancelled message is no longer renewable.
    await cancelMessage({ id: message.id, sender: message.sender });
    expect(
      await renewMessageLease({ id: message.id, worker_id: 'worker-a', fencing_token: 1 })
    ).toBeNull();
  });

  test('releaseMessage returns a claimed item to queued and it is immediately reclaimable', async () => {
    // WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01: the review worker releases
    // a checks-pending item instead of posting a terminal result.
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    await registerWorker({
      worker_id: 'worker-b',
      host: 'host-b',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-release',
      idempotency_key: 'idem-release',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'grok',
      body: 'Defer me.',
    });

    const claim = await claimMessage({ id: message.id, worker_id: 'worker-a' });
    expect(claim?.status).toBe('claimed');
    expect(claim?.fencing_token).toBe(1);

    const released = await releaseMessage({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: claim?.fencing_token ?? 0,
    });
    expect(released?.status).toBe('queued');
    expect(released?.lease_owner).toBeNull();
    expect(released?.lease_expires_at).toBeNull();
    // Not bumped on release; the next claim bumps it.
    expect(released?.fencing_token).toBe(1);

    // Immediately reclaimable (no not_before) by any worker.
    const reclaim = await claimMessage({ id: message.id, worker_id: 'worker-b' });
    expect(reclaim?.status).toBe('claimed');
    expect(reclaim?.fencing_token).toBe(2);
  });

  test('releaseMessage with a future not_before defers reclaim and queued visibility', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-release-backoff',
      idempotency_key: 'idem-release-backoff',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'grok',
      body: 'Backoff me.',
    });

    const claim = await claimMessage({ id: message.id, worker_id: 'worker-a' });
    expect(claim?.status).toBe('claimed');

    const future = new Date(Date.now() + 60_000).toISOString();
    const released = await releaseMessage({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: claim?.fencing_token ?? 0,
      not_before: future,
    });
    expect(released?.status).toBe('queued');
    expect(released?.not_before).toBe(future);

    // Not visible to the queued worker query while backed off...
    const queued = await listMessages({ recipient: 'grok', status: 'queued' });
    expect(queued.map(item => item.id)).not.toContain(message.id);

    // ...nor claimable until not_before passes.
    expect(await claimMessage({ id: message.id, worker_id: 'worker-a' })).toBeNull();
  });

  test('releaseMessage rejects non-owner, stale token, and unclaimed messages', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-release-guard',
      idempotency_key: 'idem-release-guard',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'grok',
      body: 'Guarded release.',
    });

    // Not claimed yet -> nothing to release.
    expect(
      await releaseMessage({ id: message.id, worker_id: 'worker-a', fencing_token: 1 })
    ).toBeNull();

    const claim = await claimMessage({ id: message.id, worker_id: 'worker-a' });
    expect(claim?.status).toBe('claimed');

    // Wrong owner.
    expect(
      await releaseMessage({ id: message.id, worker_id: 'worker-b', fencing_token: 1 })
    ).toBeNull();
    // Stale token.
    expect(
      await releaseMessage({ id: message.id, worker_id: 'worker-a', fencing_token: 99 })
    ).toBeNull();

    // Cancelled message is no longer releasable.
    await cancelMessage({ id: message.id, sender: message.sender });
    expect(
      await releaseMessage({ id: message.id, worker_id: 'worker-a', fencing_token: 1 })
    ).toBeNull();
  });

  test('cancel wins over late claimant result', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-cancel',
      idempotency_key: 'idem-cancel',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'Summarize.',
    });
    const claim = await claimMessage({ id: message.id, worker_id: 'worker-a' });
    expect(claim?.status).toBe('claimed');

    const cancelled = await cancelMessage({ id: message.id, sender: message.sender });
    expect(cancelled.ok && cancelled.message.status).toBe('cancelled');
    const late = await postResult({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: claim?.fencing_token ?? 0,
      result_body: 'too late',
    });
    expect(late).toBeNull();
  });

  test('offline worker cannot claim until heartbeat/register makes it available again', async () => {
    await registerWorker({
      worker_id: 'worker-offline',
      host: 'host',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    await db.query(
      `UPDATE agent_dispatch_workers
       SET last_heartbeat_at = $2
       WHERE worker_id = $1`,
      ['worker-offline', new Date(Date.now() - 10_000).toISOString()]
    );
    await evaluateWorkerStaleness(1_000);
    const message = await createMessage({
      correlation_id: 'corr-offline',
      idempotency_key: 'idem-offline',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'Queued while offline.',
    });

    const offlineClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-offline',
      workerStaleAfterMs: 1_000,
    });
    expect(offlineClaim).toBeNull();

    const heartbeat = await heartbeatWorker({ worker_id: 'worker-offline' });
    expect(heartbeat?.status).toBe('available');
    const onlineClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-offline',
      workerStaleAfterMs: 1_000,
    });
    expect(onlineClaim?.status).toBe('claimed');
  });

  test('listWorkers expires stale available rows before reporting health', async () => {
    await registerWorker({
      worker_id: 'worker-stale',
      host: 'host-stale',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    await registerWorker({
      worker_id: 'worker-fresh',
      host: 'host-fresh',
      capabilities: { providers: ['claude'] },
      max_concurrency: 1,
    });
    await db.query(
      `UPDATE agent_dispatch_workers
       SET last_heartbeat_at = $2
       WHERE worker_id = $1`,
      ['worker-stale', new Date(Date.now() - 10_000).toISOString()]
    );

    const workers = await listWorkers(1_000);

    expect(workers.find(worker => worker.worker_id === 'worker-stale')?.status).toBe('unavailable');
    expect(workers.find(worker => worker.worker_id === 'worker-fresh')?.status).toBe('available');
  });

  test('resolveDispatchRecipient preserves concrete recipients', async () => {
    await expect(resolveDispatchRecipient('codex')).resolves.toEqual({
      ok: true,
      recipient: 'codex',
      recipient_alias: null,
      resolved_xo_lease_id: null,
      resolved_xo_fencing_token: null,
    });
  });

  test('board alias resolves only with a current XO lease', async () => {
    await expect(resolveDispatchRecipient('board')).resolves.toEqual({
      ok: false,
      reason: 'no_valid_xo_lease',
    });
    const now = new Date();
    await db.query(
      `INSERT INTO board_xo_leases (
         id, lease_id, principal_id, seat_id, holder_id, holder_token_hash,
         fencing_token, acquired_at, renewed_at, expires_at, released_at
       )
       VALUES (1, $1, 'claude', 'xo', 'holder', $2, 7, $3, NULL, $4, NULL)`,
      ['lease-1', 'a'.repeat(64), now.toISOString(), new Date(now.getTime() + 60_000).toISOString()]
    );

    await expect(resolveDispatchRecipient('board')).resolves.toEqual({
      ok: true,
      recipient: 'claude',
      recipient_alias: 'board',
      resolved_xo_lease_id: 'lease-1',
      resolved_xo_fencing_token: 7,
    });
  });

  test('board alias list and claim bind the current XO lease', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host',
      capabilities: { providers: ['claude'] },
      max_concurrency: 1,
    });
    const now = new Date();
    await db.query(
      `INSERT INTO board_xo_leases (
         id, lease_id, principal_id, seat_id, holder_id, holder_token_hash,
         fencing_token, acquired_at, renewed_at, expires_at, released_at
       )
       VALUES (1, $1, 'claude', 'xo', 'holder', $2, 11, $3, NULL, $4, NULL)`,
      [
        'lease-claim',
        'b'.repeat(64),
        now.toISOString(),
        new Date(now.getTime() + 60_000).toISOString(),
      ]
    );
    const message = await createMessage({
      correlation_id: 'corr-board',
      idempotency_key: 'board-motion:M-27:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:board',
      task_type: 'board_motion',
      sender: 'gpt',
      recipient: 'board',
      body: '{"motion_id":"M-27","title":"T","file_path":"docs/board/motions/M.md"}',
      recipient_alias: 'board',
      motion_id: 'M-27',
      motion_revision_sha: 'a'.repeat(40),
    });

    const listed = await import('./dispatch').then(module =>
      module.listMessages({ recipient: ' Claude ', status: 'queued', allowBoardAlias: true })
    );
    expect(listed.map(item => item.id)).toContain(message.id);

    const stalePrincipalClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-a',
      delivery_principal: 'gpt',
    });
    expect(stalePrincipalClaim).toBeNull();

    const claim = await claimMessage({
      id: message.id,
      worker_id: 'worker-a',
      delivery_principal: 'claude',
    });
    expect(claim?.resolved_recipient).toBe('claude');
    expect(claim?.resolved_xo_lease_id).toBe('lease-claim');
    expect(claim?.resolved_xo_fencing_token).toBe(11);
  });

  test('acknowledged XO blockers escalate at exact boundaries with fire-once and retryable claims', async () => {
    const created = '2026-08-07T00:00:00.000Z';
    const message = await createMessage({
      correlation_id: 'corr-escalation',
      idempotency_key: 'escalation-boundary',
      task_type: 'agent_message',
      sender: 'codex',
      sender_principal_id: 'codex',
      recipient: 'xo',
      priority: 'blocker',
      body: 'bounded escalation payload',
    });
    await db.query('UPDATE agent_dispatch_messages SET created_at = $2 WHERE id = $1', [
      message.id,
      created,
    ]);
    await db.query('UPDATE agent_dispatch_messages SET acknowledged_at = $2 WHERE id = $1', [
      message.id,
      '2026-08-07T01:00:00.000Z',
    ]);

    expect((await listEligibleXoEscalations(created)).map(item => item.id)).toContain(message.id);

    expect(
      await claimDispatchEscalation({
        id: message.id,
        leg: 'telegram',
        now: '2026-08-07T03:59:59.999Z',
      })
    ).toBeNull();
    const telegram = await claimDispatchEscalation({
      id: message.id,
      leg: 'telegram',
      now: '2026-08-07T04:00:00.000Z',
    });
    expect(telegram?.id).toBe(message.id);
    expect(
      await claimDispatchEscalation({
        id: message.id,
        leg: 'telegram',
        now: '2026-08-07T04:00:00.000Z',
      })
    ).toBeNull();
    expect(
      await claimDispatchEscalation({
        id: message.id,
        leg: 'sms',
        now: '2026-08-07T23:59:59.999Z',
      })
    ).toBeNull();
    const smsClaimedAt = '2026-08-08T00:00:00.000Z';
    expect(
      (await claimDispatchEscalation({ id: message.id, leg: 'sms', now: smsClaimedAt }))?.id
    ).toBe(message.id);
    expect(
      await releaseDispatchEscalationClaim({
        id: message.id,
        leg: 'sms',
        claimed_at: 'wrong-claim',
      })
    ).toBeFalse();
    expect(
      await releaseDispatchEscalationClaim({ id: message.id, leg: 'sms', claimed_at: smsClaimedAt })
    ).toBeTrue();
    expect(
      await claimDispatchEscalation({ id: message.id, leg: 'sms', now: smsClaimedAt })
    ).not.toBeNull();
    expect(
      await claimDispatchEscalation({ id: message.id, leg: 'sms', now: smsClaimedAt })
    ).toBeNull();
  });

  test('legacy unauthenticated blockers never escalate', async () => {
    const created = '2026-08-07T00:00:00.000Z';
    const message = await createMessage({
      correlation_id: 'corr-legacy-escalation',
      idempotency_key: 'legacy-escalation',
      task_type: 'agent_message',
      sender: 'codex',
      recipient: 'xo',
      priority: 'blocker',
      body: 'legacy escalation payload',
    });
    await db.query('UPDATE agent_dispatch_messages SET created_at = $2 WHERE id = $1', [
      message.id,
      created,
    ]);
    await db.query('UPDATE agent_dispatch_messages SET acknowledged_at = $2 WHERE id = $1', [
      message.id,
      '2026-08-07T01:00:00.000Z',
    ]);
    expect(message.sender_principal_id).toBeNull();
    expect((await listEligibleXoEscalations(created)).map(item => item.id)).not.toContain(
      message.id
    );
    expect(
      await claimDispatchEscalation({
        id: message.id,
        leg: 'telegram',
        now: '2026-08-07T05:00:00.000Z',
      })
    ).toBeNull();
  });

  test('addressing suppresses both escalation legs even after acknowledgement', async () => {
    const created = '2026-08-07T00:00:00.000Z';
    const message = await createMessage({
      correlation_id: 'corr-addressed-escalation',
      idempotency_key: 'addressed-escalation',
      task_type: 'agent_message',
      sender: 'codex',
      sender_principal_id: 'codex',
      recipient: 'xo',
      priority: 'blocker',
      body: 'addressed escalation payload',
    });
    await db.query(
      `UPDATE agent_dispatch_messages
       SET created_at = $2, acknowledged_at = $3, addressed_at = $4 WHERE id = $1`,
      [message.id, created, '2026-08-07T01:00:00.000Z', '2026-08-07T02:00:00.000Z']
    );

    expect((await listEligibleXoEscalations(created)).map(item => item.id)).not.toContain(
      message.id
    );
    expect(
      await claimDispatchEscalation({
        id: message.id,
        leg: 'telegram',
        now: '2026-08-07T04:00:00.000Z',
      })
    ).toBeNull();
    expect(
      await claimDispatchEscalation({
        id: message.id,
        leg: 'sms',
        now: '2026-08-08T00:00:00.000Z',
      })
    ).toBeNull();
  });

  test('acknowledged non-XO blockers create one deterministic handoff but never page directly', async () => {
    const created = '2026-08-07T00:00:00.000Z';
    const source = await createMessage({
      correlation_id: 'corr-handoff',
      idempotency_key: 'handoff-source',
      task_type: 'agent_message',
      sender: 'claude',
      sender_principal_id: 'claude',
      recipient: 'codex',
      priority: 'blocker',
      body: 'handoff source',
    });
    await db.query(
      'UPDATE agent_dispatch_messages SET created_at = $2, acknowledged_at = $3 WHERE id = $1',
      [source.id, created, '2026-08-07T01:00:00.000Z']
    );

    expect(
      await claimDispatchEscalation({
        id: source.id,
        leg: 'telegram',
        now: '2026-08-07T04:00:00.000Z',
      })
    ).toBeNull();
    expect(
      await claimDispatchEscalation({
        id: source.id,
        leg: 'sms',
        now: '2026-08-08T00:00:00.000Z',
      })
    ).toBeNull();

    expect(await ensureXoEscalationHandoffs(created)).toBe(1);
    expect(await ensureXoEscalationHandoffs(created)).toBe(0);
    const handoffs = await listMessages({ recipient: 'xo', status: 'queued' });
    const matching = handoffs.filter(item => item.idempotency_key === `xo-handoff:${source.id}`);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.correlation_id).toBe(source.correlation_id);
    expect(matching[0]?.sender_principal_id).toBe('system:dispatch');
    expect(matching[0]?.body).toBe(
      JSON.stringify({ source_id: source.id, kind: 'xo_escalation_handoff' })
    );
  });

  test('legacy unauthenticated blockers never create XO escalation handoffs', async () => {
    const created = '2026-08-07T00:00:00.000Z';
    const source = await createMessage({
      correlation_id: 'corr-legacy-handoff',
      idempotency_key: 'legacy-handoff-source',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      priority: 'blocker',
      body: 'legacy handoff source',
    });
    expect(source.sender_principal_id).toBeNull();
    await db.query(
      'UPDATE agent_dispatch_messages SET created_at = $2, acknowledged_at = $3 WHERE id = $1',
      [source.id, created, '2026-08-07T01:00:00.000Z']
    );

    expect(await ensureXoEscalationHandoffs(created)).toBe(0);
    const handoffs = await listMessages({ recipient: 'xo', status: 'queued' });
    expect(
      handoffs.filter(item => item.idempotency_key === `xo-handoff:${source.id}`)
    ).toHaveLength(0);
  });

  test('legacy unauthenticated outcomes never create authenticated blocker notices', async () => {
    const created = '2026-08-07T00:00:00.000Z';
    const source = await createMessage({
      correlation_id: 'corr-legacy-outcome',
      idempotency_key: 'legacy-outcome-source',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'codex',
      priority: 'normal',
      body: 'legacy outcome source',
    });
    expect(source.sender_principal_id).toBeNull();
    await db.query(
      `UPDATE agent_dispatch_messages
       SET created_at = $2, status = 'failed', task_outcome = 'failed', completed_at = $3
       WHERE id = $1`,
      [source.id, created, '2026-08-07T01:00:00.000Z']
    );

    expect(await reconcileDispatchOutcomeNotices(created)).toBe(0);
    const notices = await listMessages({ recipient: 'xo', status: 'queued' });
    expect(
      notices.filter(item => item.idempotency_key === `outcome-notice:${source.id}`)
    ).toHaveLength(0);
  });

  test('sender-scoped idempotency isolates principals and preserves legacy null scope', async () => {
    const a1 = await createAuthenticatedMessage(testAuthenticatedCapability('alice', 'claude'), {
      correlation_id: 'c1',
      idempotency_key: 'shared-key',
      task_type: 'agent_message',
      recipient: 'codex',
      body: 'from alice',
    });
    const b1 = await createAuthenticatedMessage(testAuthenticatedCapability('bob', 'fusion'), {
      correlation_id: 'c2',
      idempotency_key: 'shared-key',
      task_type: 'agent_message',
      recipient: 'codex',
      body: 'from bob',
    });
    expect(a1.id).not.toBe(b1.id);
    expect(a1.sender_principal_id).toBe('alice');
    expect(b1.sender_principal_id).toBe('bob');
    const a2 = await createAuthenticatedMessage(testAuthenticatedCapability('alice', 'claude'), {
      correlation_id: 'c3',
      idempotency_key: 'shared-key',
      task_type: 'agent_message',
      recipient: 'codex',
      body: 'retry alice',
    });
    expect(a2.id).toBe(a1.id);

    const legacy1 = await createAuthenticatedMessage(testLegacyCapability('claude'), {
      correlation_id: 'c4',
      idempotency_key: 'legacy-key',
      task_type: 'agent_message',
      recipient: 'codex',
      body: 'legacy one',
    });
    const legacy2 = await createAuthenticatedMessage(testLegacyCapability('fusion'), {
      correlation_id: 'c5',
      idempotency_key: 'legacy-key',
      task_type: 'agent_message',
      recipient: 'codex',
      body: 'legacy two',
    });
    expect(legacy2.id).toBe(legacy1.id);
    expect(legacy1.sender_principal_id).toBeNull();
  });

  test('system writers bind fixed principals and ignore hostile preemption keys', async () => {
    await createAuthenticatedMessage(testAuthenticatedCapability('hostile', 'claude'), {
      correlation_id: 'h1',
      idempotency_key: 'xo-handoff:source-1',
      task_type: 'agent_message',
      recipient: 'xo',
      body: 'hostile',
      priority: 'blocker',
    });
    const system = await createAuthenticatedMessage(
      { kind: 'system', sender: 'dispatch' },
      {
        correlation_id: 's1',
        idempotency_key: 'xo-handoff:source-1',
        task_type: 'agent_message',
        recipient: 'xo',
        body: 'system',
        priority: 'blocker',
      }
    );
    expect(system.sender).toBe('dispatch');
    expect(system.sender_principal_id).toBe('system:dispatch');
    expect(system.body).toContain('system');

    const boardAuthority = await DispatchNonSystemCapability.fromBoardProof({
      proof: {},
      purpose: 'motion_notification',
    });
    const board = await createAuthenticatedMessage(boardAuthority.capability, {
      correlation_id: 'b1',
      idempotency_key: 'board-key',
      task_type: 'agent_message',
      recipient: 'board',
      body: '{"ok":true}',
      recipient_alias: 'board',
    });
    expect(board.sender_principal_id).toBe('board:claude');
  });

  test('fixed system writers do not let null-principal rows suppress system effects', async () => {
    const legacyId = '00000000-0000-4000-8000-000000000129';
    const key = 'xo-handoff:legacy-fixed-system-source';
    await db.query(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id,
        recipient, body, status, created_at, fencing_token)
       VALUES ($1, $2, $3, 'agent_message', 'dispatch', NULL,
        'xo', 'hostile legacy effect', 'queued', $4, 0)`,
      [legacyId, 'legacy-system-correlation', key, '2026-08-07T00:00:00.000Z']
    );

    const retried = await createAuthenticatedMessage(
      { kind: 'system', sender: 'dispatch' },
      {
        correlation_id: 'retry-system-correlation',
        idempotency_key: key,
        task_type: 'agent_message',
        recipient: 'xo',
        body: 'authenticated system effect',
      }
    );

    expect(retried.id).not.toBe(legacyId);
    expect(retried.sender_principal_id).toBe('system:dispatch');
    expect(retried.body).toBe('authenticated system effect');
    const count = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM agent_dispatch_messages WHERE idempotency_key = $1',
      [key]
    );
    expect(Number(count.rows[0]?.count)).toBe(2);
  });

  test('rejects hand-constructed non-system sender provenance at compile time and runtime', async () => {
    const data = {
      correlation_id: 'forged-context',
      idempotency_key: 'forged-context',
      task_type: 'agent_message' as const,
      recipient: 'codex',
      body: 'must not persist',
    };
    const forgedAuthenticated = createAuthenticatedMessage(
      // @ts-expect-error authenticated provenance must come from the credential issuer.
      { kind: 'authenticated', principal_id: 'fake', sender: 'xo' },
      data
    );
    const callsBeforeForgedContexts = getDatabaseCalls;
    await expect(forgedAuthenticated).rejects.toThrow('dispatch_sender_capability_invalid');

    const forgedLegacy = createAuthenticatedMessage(
      // @ts-expect-error legacy provenance must come from the mode and registry resolver.
      { kind: 'legacy', sender: 'overseer' },
      { ...data, idempotency_key: 'forged-legacy-context' }
    );
    await expect(forgedLegacy).rejects.toThrow('dispatch_sender_capability_invalid');

    const prototypeForgery = Object.create(
      DispatchNonSystemCapability.prototype
    ) as unknown as Parameters<typeof createAuthenticatedMessage>[0];
    await expect(
      createAuthenticatedMessage(prototypeForgery, {
        ...data,
        idempotency_key: 'forged-prototype-context',
      })
    ).rejects.toThrow('dispatch_sender_capability_invalid');

    const proxyForgery = new Proxy(Object.create(DispatchNonSystemCapability.prototype), {
      get(target, property, receiver) {
        if (property === 'toBoundSender') {
          return () => ({ sender: 'xo', sender_principal_id: 'fake' });
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as Parameters<typeof createAuthenticatedMessage>[0];
    await expect(
      createAuthenticatedMessage(proxyForgery, {
        ...data,
        idempotency_key: 'forged-proxy-context',
      })
    ).rejects.toThrow('dispatch_sender_capability_invalid');
    expect(getDatabaseCalls).toBe(callsBeforeForgedContexts);

    let senderReads = 0;
    const changingSystemSender = new Proxy(
      { kind: 'system' as const, sender: 'dispatch' as const },
      {
        get(target, property, receiver) {
          if (property === 'sender') {
            senderReads += 1;
            return senderReads === 1 ? 'dispatch' : 'forged';
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );
    const fixed = await createAuthenticatedMessage(changingSystemSender, {
      ...data,
      idempotency_key: 'changing-system-sender',
    });
    expect(fixed.sender).toBe('dispatch');
    expect(fixed.sender_principal_id).toBe('system:dispatch');
    expect(senderReads).toBe(1);
  });

  test('supersede replacement uses authenticated sender context', async () => {
    const original = await createAuthenticatedMessage(
      testAuthenticatedCapability('alice', 'claude'),
      {
        correlation_id: 'sup-1',
        idempotency_key: 'sup-orig',
        task_type: 'agent_message',
        recipient: 'codex',
        body: 'original',
      }
    );
    const callsBeforeForgedSupersede = getDatabaseCalls;
    await expect(
      supersedeMessage({
        id: original.id,
        // @ts-expect-error supersede requires issuer-proven sender authority.
        sender_context: { kind: 'authenticated', principal_id: 'fake', sender: 'claude' },
        replacement: {
          correlation_id: 'sup-forged-context',
          idempotency_key: 'sup-forged-context',
          task_type: 'agent_message',
          recipient: 'codex',
          body: 'must not access the database',
        },
      })
    ).rejects.toThrow('dispatch_sender_capability_invalid');
    expect(getDatabaseCalls).toBe(callsBeforeForgedSupersede);
    const wrongPrincipal = await supersedeMessage({
      id: original.id,
      sender_context: testAuthenticatedCapability('bob', 'claude'),
      replacement: {
        correlation_id: 'sup-wrong-principal',
        idempotency_key: 'sup-wrong-principal',
        task_type: 'agent_message',
        recipient: 'codex',
        body: 'must not supersede another principal',
      },
    });
    expect(wrongPrincipal).toEqual({ ok: false, reason: 'actor_mismatch' });
    const wrongRows = await db.query(
      'SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1',
      ['sup-wrong-principal']
    );
    expect(wrongRows.rows).toHaveLength(0);
    const result = await supersedeMessage({
      id: original.id,
      sender_context: testAuthenticatedCapability('alice', 'claude'),
      replacement: {
        correlation_id: 'sup-2',
        idempotency_key: 'sup-repl',
        task_type: 'agent_message',
        recipient: 'codex',
        body: 'replacement',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.sender).toBe('claude');
      expect(result.message.sender_principal_id).toBe('alice');
      expect(result.message.supersedes_id).toBe(original.id);
    }
  });

  test('ordinary creation cannot forge supersedes metadata outside the guarded path', async () => {
    const forged = createAuthenticatedMessage(testAuthenticatedCapability('alice', 'claude'), {
      correlation_id: 'sup-forged',
      idempotency_key: 'sup-forged',
      task_type: 'agent_message',
      recipient: 'codex',
      body: 'forged replacement',
      // @ts-expect-error supersedes_id belongs only to supersedeMessage.
      supersedes_id: 'source-not-owned-by-caller',
    });
    await expect(forged).rejects.toThrow('dispatch_supersedes_guarded_path_required');
    expect(
      (
        await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
          'sup-forged',
        ])
      ).rowCount
    ).toBe(0);
  });

  test('escalation claim ignores legacy null-principal blockers', async () => {
    const legacy = await createAuthenticatedMessage(testLegacyCapability('claude'), {
      correlation_id: 'esc-leg',
      idempotency_key: 'esc-leg',
      task_type: 'agent_message',
      recipient: 'xo',
      body: 'legacy blocker',
      priority: 'blocker',
    });
    await db.query(`UPDATE agent_dispatch_messages SET created_at = $2 WHERE id = $1`, [
      legacy.id,
      new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    ]);
    const claimed = await claimDispatchEscalation({
      id: legacy.id,
      leg: 'telegram',
      now: new Date().toISOString(),
    });
    expect(claimed).toBeNull();

    const authed = await createAuthenticatedMessage(
      testAuthenticatedCapability('alice', 'claude'),
      {
        correlation_id: 'esc-auth',
        idempotency_key: 'esc-auth',
        task_type: 'agent_message',
        recipient: 'xo',
        body: 'auth blocker',
        priority: 'blocker',
      }
    );
    await db.query(`UPDATE agent_dispatch_messages SET created_at = $2 WHERE id = $1`, [
      authed.id,
      new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    ]);
    const claimedAuth = await claimDispatchEscalation({
      id: authed.id,
      leg: 'telegram',
      now: new Date().toISOString(),
    });
    expect(claimedAuth?.id).toBe(authed.id);
  });
  /**
   * listMessagesByCorrelationPrefixWithoutSubjectKey exists for the Overseer
   * legacy-receipt fallback (PR #772). subject_key was added to submit
   * receipts in 2026-09; receipts written before that carry only a
   * correlation_id, and `listMessages` cannot reach them -- it caps limit at
   * 500 and exposes no offset, while the live store holds thousands of
   * operator rows.
   */
  describe('listMessagesByCorrelationPrefixWithoutSubjectKey', () => {
    async function legacyReceipt(id: string, correlationId: string): Promise<string> {
      const message = await createMessage({
        correlation_id: correlationId,
        idempotency_key: `idem-${id}`,
        task_type: 'run_report',
        sender: 'overseer',
        recipient: 'operator',
        body: `legacy receipt ${id}`,
      });
      return message.id;
    }

    /**
     * Write scale and read scale must be the SAME scale.
     *
     * Review finding (Overseer, PR #800): newest-first reads order by
     * COALESCE(seq, rowid), so a raw/fixture/import row inserted with
     * seq = NULL has an effective ordering value of its rowid. Computing the
     * next seq from MAX(seq) alone ignored those rows entirely, so a NULL-seq
     * row with a high rowid could tie or outrank the next normally-inserted
     * row -- an undefined tie in the total order this column exists to
     * guarantee.
     *
     * Runs against the real SqliteAdapter, not a double: the bug lives in the
     * SQL expression, so only real SQL can pin it.
     */
    test('a normal insert outranks a raw NULL-seq row, by seq and by read order', async () => {
      // A writer that bypasses createMessage entirely -- fixture, import, or
      // hand-written SQL -- leaving seq NULL.
      await db.query(
        `INSERT INTO agent_dispatch_messages
           (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, seq)
         VALUES ($1, $2, $3, 'run_report', 'overseer', 'operator', '{}', 'queued', $4, NULL)`,
        [
          '11111111-1111-4111-8111-111111111111',
          'pr-review:o/r#903@raw',
          'idem-raw-null-seq',
          '2026-09-08T00:00:00.000Z',
        ]
      );
      const rawRow = await db.query<{ rowid: number; seq: number | null }>(
        `SELECT rowid, seq FROM agent_dispatch_messages WHERE id = $1`,
        ['11111111-1111-4111-8111-111111111111']
      );
      const rawRowid = rawRow.rows[0]!.rowid;
      // Premise guard: the row really is NULL-seq, so the read path falls back
      // to its rowid. Without this the test could pass vacuously.
      expect(rawRow.rows[0]!.seq).toBeNull();

      const later = await createMessage({
        correlation_id: 'pr-review:o/r#903@normal',
        idempotency_key: 'idem-after-raw',
        task_type: 'run_report',
        sender: 'overseer',
        recipient: 'operator',
        body: 'written through createMessage',
      });
      const laterRow = await db.query<{ seq: number }>(
        `SELECT seq FROM agent_dispatch_messages WHERE id = $1`,
        [later.id]
      );

      // STRICTLY greater than the raw row's effective ordering value, not equal
      // to it -- equality is the undefined tie this fix removes.
      expect(laterRow.rows[0]!.seq).toBeGreaterThan(rawRowid);

      // And the read path agrees: the later write comes back first.
      const found = await listMessagesByCorrelationPrefixWithoutSubjectKey({
        recipient: 'operator',
        correlationPrefix: 'pr-review:o/r#903@',
      });
      expect(found.map(message => message.id)).toEqual([
        later.id,
        '11111111-1111-4111-8111-111111111111',
      ]);
    });

    test('returns only subject_key-less rows matching the prefix, newest-first', async () => {
      const first = await legacyReceipt('a', 'pr-review:thinmansoftware/bdc-harness#800@aaa');
      const second = await legacyReceipt('b', 'pr-review:thinmansoftware/bdc-harness#800@bbb');
      // Same prefix but already indexed by subject_key: the indexed query
      // reaches it, so the legacy path must not also return it.
      await createMessage({
        correlation_id: 'pr-review:thinmansoftware/bdc-harness#800@ccc',
        idempotency_key: 'idem-c',
        task_type: 'run_report',
        sender: 'overseer',
        recipient: 'operator',
        body: 'indexed receipt',
        subject_key: 'gh:thinmansoftware/bdc-harness#800',
      });
      // A PR whose number merely STARTS with 800, and a different repo.
      await legacyReceipt('d', 'pr-review:thinmansoftware/bdc-harness#8001@ddd');
      await legacyReceipt('e', 'pr-review:thinmansoftware/shopops#800@eee');

      const found = await listMessagesByCorrelationPrefixWithoutSubjectKey({
        recipient: 'operator',
        correlationPrefix: 'pr-review:thinmansoftware/bdc-harness#800@',
      });

      expect(found.map(message => message.id)).toEqual([second, first]);
    });

    /**
     * Regression: receipts written inside the same wall-clock millisecond must
     * still come back newest-first.
     *
     * Ordering is guaranteed by the database-assigned `seq` column, NOT by the
     * client clock -- a process-local monotonic timestamp cannot order writes
     * from concurrent writers or survive a restart. `collectVerdicts` depends
     * on this newest-first contract to keep an older failed attempt from
     * outranking a later authoritative verdict.
     */
    test('orders same-millisecond rows newest-first, not by random UUID', async () => {
      const ids: string[] = [];
      for (let index = 0; index < 12; index++) {
        ids.push(await legacyReceipt(`tie-${index}`, `pr-review:o/r#900@${index}`));
      }

      const found = await listMessagesByCorrelationPrefixWithoutSubjectKey({
        recipient: 'operator',
        correlationPrefix: 'pr-review:o/r#900@',
      });

      // Exact reverse insertion order, every time -- no dependence on how the
      // UUIDs happened to sort.
      expect(found.map(message => message.id)).toEqual([...ids].reverse());
      // And the timestamps are strictly decreasing, which is what makes the
      // ordering real rather than incidental.
      const timestamps = found.map(message => message.created_at);
      expect([...timestamps].sort().reverse()).toEqual(timestamps);
      expect(new Set(timestamps).size).toBe(timestamps.length);
    });

    /**
     * The multi-writer case, which is why the ordering key must be assigned by
     * the DATABASE rather than by any client clock (Overseer review, PR #790).
     *
     * Two processes -- or one process before and after a restart -- can stamp
     * the SAME created_at, and a restarted writer can even stamp an older one.
     * A process-local monotonic clock cannot prevent either. Here every row is
     * forced to an identical created_at, so `seq` is the only thing that can
     * order them; measured over 2,000 trials, seq is correct 100% of the time
     * where the old `id DESC` tiebreak was correct 0.9%.
     */
    test('orders rows sharing one created_at by DB seq, across writers', async () => {
      const sharedCreatedAt = '2026-09-08T00:00:00.000Z';
      const ids: string[] = [];
      for (let index = 0; index < 8; index++) {
        const id = await legacyReceipt(`concurrent-${index}`, `pr-review:o/r#901@${index}`);
        ids.push(id);
      }
      // Collapse every timestamp to one value, simulating concurrent writers
      // whose clocks agree (or a restart that rewound the clock).
      await db.query(
        `UPDATE agent_dispatch_messages SET created_at = $1
          WHERE correlation_id LIKE 'pr-review:o/r#901@%'`,
        [sharedCreatedAt]
      );

      const found = await listMessagesByCorrelationPrefixWithoutSubjectKey({
        recipient: 'operator',
        correlationPrefix: 'pr-review:o/r#901@',
      });

      expect(found.map(message => message.created_at)).toEqual(
        Array(ids.length).fill(sharedCreatedAt)
      );
      // Still exact reverse insertion order -- decided purely by seq.
      expect(found.map(message => message.id)).toEqual([...ids].reverse());
    });

    /**
     * seq must be the PRIMARY ordering key, not a tiebreak after created_at
     * (Overseer review, PR #790).
     *
     * A writer that restarted, or whose clock skewed backwards, stamps a LOWER
     * created_at than rows already committed -- while still taking a HIGHER
     * seq, because seq comes from the database. Ordering by created_at first
     * would sort that later write behind earlier rows, which is not an
     * insertion order. The last row written must come back first regardless of
     * what its clock said.
     */
    test('a row with an older created_at but higher seq still sorts first', async () => {
      const earlier = await legacyReceipt('skew-old', 'pr-review:o/r#902@1');
      const later = await legacyReceipt('skew-new', 'pr-review:o/r#902@2');

      // Simulate the clock-skewed / restarted writer: the LATER row (higher
      // seq) carries a created_at a full day BEFORE the earlier row.
      await db.query(`UPDATE agent_dispatch_messages SET created_at = $1 WHERE id = $2`, [
        '2026-09-07T00:00:00.000Z',
        earlier,
      ]);
      await db.query(`UPDATE agent_dispatch_messages SET created_at = $1 WHERE id = $2`, [
        '2026-09-06T00:00:00.000Z',
        later,
      ]);

      const found = await listMessagesByCorrelationPrefixWithoutSubjectKey({
        recipient: 'operator',
        correlationPrefix: 'pr-review:o/r#902@',
      });

      const rows = found.map(message => message.id);
      // The genuinely-last write leads, even though its timestamp is older.
      expect(rows).toEqual([later, earlier]);
      // Guard the premise: this test is only meaningful while the timestamps
      // actually disagree with insertion order.
      const byId = new Map(found.map(message => [message.id, message.created_at]));
      expect(byId.get(later)! < byId.get(earlier)!).toBe(true);
    });

    test('reaches a row far beyond the listMessages page cap', async () => {
      // listMessages caps limit at 500 and has no offset, so a client-side
      // scan cannot see this row. The SQL predicate can.
      for (let index = 0; index < 520; index += 1) {
        await createMessage({
          correlation_id: `unrelated:${index}`,
          idempotency_key: `idem-noise-${index}`,
          task_type: 'run_report',
          sender: 'overseer',
          recipient: 'operator',
          body: `noise ${index}`,
        });
      }
      const buried = await legacyReceipt('buried', 'pr-review:thinmansoftware/bdc-harness#761@aaa');

      const page = await listMessages({ recipient: 'operator', limit: 500 });
      expect(page.length).toBe(500);
      expect(page.some(message => message.id === buried)).toBe(false);

      const found = await listMessagesByCorrelationPrefixWithoutSubjectKey({
        recipient: 'operator',
        correlationPrefix: 'pr-review:thinmansoftware/bdc-harness#761@',
      });
      expect(found.map(message => message.id)).toEqual([buried]);
    });

    test('treats LIKE metacharacters in the prefix as literals', async () => {
      // '_' is a single-character LIKE wildcard and '%' matches anything.
      // Unescaped, a prefix for repo 'a_c' would also match repo 'abc' and
      // leak a foreign PR verdict into the re-review decision.
      await legacyReceipt('decoy', 'pr-review:thinmansoftware/abc#1@aaa');
      expect(
        await listMessagesByCorrelationPrefixWithoutSubjectKey({
          recipient: 'operator',
          correlationPrefix: 'pr-review:thinmansoftware/a_c#1@',
        })
      ).toHaveLength(0);
      expect(
        await listMessagesByCorrelationPrefixWithoutSubjectKey({
          recipient: 'operator',
          correlationPrefix: '%',
        })
      ).toHaveLength(0);
    });

    test('is scoped to the requested recipient', async () => {
      await legacyReceipt('operator-row', 'pr-review:thinmansoftware/bdc-harness#900@aaa');
      const found = await listMessagesByCorrelationPrefixWithoutSubjectKey({
        recipient: 'grok',
        correlationPrefix: 'pr-review:thinmansoftware/bdc-harness#900@',
      });
      expect(found).toHaveLength(0);
    });
  });
});

describe('normalizeDispatchSubjectKey', () => {
  test('accepts and canonicalizes gh refs', () => {
    expect(normalizeDispatchSubjectKey('gh:ThinmanSoftware/BDC-XO#1745')).toBe(
      'gh:thinmansoftware/bdc-xo#1745'
    );
  });

  test('accepts wo refs', () => {
    expect(normalizeDispatchSubjectKey('wo:WO-HARNESS-TASKMASTER-FIRE-VERB-01')).toBe(
      'wo:WO-HARNESS-TASKMASTER-FIRE-VERB-01'
    );
  });

  test('REGRESSION: accepts taskmaster daily digest refs', () => {
    // The M-129-era shape hardening forgot digest threads; every digest send
    // failed from 2026-08-25T00:00 (one failed effect per tick, health
    // DEGRADED). digest:YYYY-MM-DD is a first-class shape.
    expect(normalizeDispatchSubjectKey('digest:2026-08-25')).toBe('digest:2026-08-25');
  });

  test('rejects malformed digest and garbage shapes', () => {
    expect(() => normalizeDispatchSubjectKey('digest:2026-8-25')).toThrow(
      'dispatch_subject_key_invalid:shape'
    );
    expect(() => normalizeDispatchSubjectKey('digest:tomorrow')).toThrow(
      'dispatch_subject_key_invalid:shape'
    );
    expect(() => normalizeDispatchSubjectKey('random:thing')).toThrow(
      'dispatch_subject_key_invalid:shape'
    );
  });
});
