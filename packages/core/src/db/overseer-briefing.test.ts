import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, unlinkSync } from 'fs';
import { removeTempDirWithRetry } from '../test/temp-dir';
import { join } from 'path';
import type { IDatabase } from './adapters/types';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import {
  appendDeliveryReceipt,
  appendOperatorCard,
  claimDueDeliveryJob,
  completeDeliveryJob,
  getOperatorCard,
  listOperatorCards,
} from './overseer-briefing';

let db: IDatabase;
let currentDbPath = '';
let currentHome = '';
const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;

const CARD_ID = 'a'.repeat(64);
const PAYLOAD_DIGEST = 'b'.repeat(64);
const CREATED_AT = '2026-07-16T08:00:00.000Z';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // Test file may not exist.
    }
  }
}

function cardInput(overrides: Record<string, unknown> = {}) {
  return {
    card_id: CARD_ID,
    identity_version: 'overseer-actionable-event-v1',
    canonical_event_identity: {
      identity_version: 'overseer-actionable-event-v1',
      source_event_id: 'event-1',
      run_id: 'run-1',
      wo_id: 'WO-TEST-1',
      event_type: 'node_failed',
      step_name: 'verify',
      event_created_at: CREATED_AT,
      error_class: 'validator_rejected',
    },
    payload_digest: PAYLOAD_DIGEST,
    payload: { blocker: 'validator rejected' },
    run_id: 'run-1',
    wo_id: 'WO-TEST-1',
    repository: 'thinmansoftware/bdc-harness',
    branch: 'feat/test',
    pr_url: null,
    pr_number: null,
    head_sha: null,
    base_branch: 'dev',
    base_sha: 'c'.repeat(40),
    checks: { failed: 1, total: 1 },
    mergeability: 'unknown',
    blocker: 'validator rejected',
    mechanical_evidence: { source: 'unit-test' },
    recovery_attempted: { attempted: false },
    proposed_remediation: { steps: ['review'] },
    next_permitted_action: 'await operator ruling',
    responsible_actor: 'acting-xo',
    actionable_event_at: CREATED_AT,
    required_ruling: 'approve repair',
    evidence_links: { run: '/runs/run-1' },
    lifecycle_classification: 'recovery',
    governance_classification: 'non-production',
    created_at: CREATED_AT,
    ...overrides,
  };
}

describe('overseer briefing persistence', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = join(
      import.meta.dir,
      `.test-overseer-briefing-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    currentDbPath = join(currentHome, 'archon.db');
    process.env.ARCHON_HOME = currentHome;
    delete process.env.DATABASE_URL;
    db = getDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    cleanupDb(currentDbPath);
    removeTempDirWithRetry(currentHome);
    if (oldArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldArchonHome;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  });

  test('keeps migration 035 and SQLite at exact three-table column parity', async () => {
    const migration = readFileSync(
      join(import.meta.dir, '../../../../migrations/035_overseer_escalation_briefing.sql'),
      'utf8'
    );
    const sqlite = readFileSync(join(import.meta.dir, 'adapters/sqlite.ts'), 'utf8');
    const expected = {
      overseer_operator_cards: [
        'card_id',
        'identity_version',
        'canonical_event_identity',
        'payload_digest',
        'payload',
        'run_id',
        'wo_id',
        'repository',
        'branch',
        'pr_url',
        'pr_number',
        'head_sha',
        'base_branch',
        'base_sha',
        'checks',
        'mergeability',
        'blocker',
        'mechanical_evidence',
        'recovery_attempted',
        'proposed_remediation',
        'next_permitted_action',
        'responsible_actor',
        'actionable_event_at',
        'required_ruling',
        'evidence_links',
        'lifecycle_classification',
        'governance_classification',
        'created_at',
      ],
      overseer_operator_card_delivery_jobs: [
        'card_id',
        'channel',
        'state',
        'attempts_started',
        'next_attempt_at',
        'lease_owner',
        'lease_expires_at',
        'fencing_token',
        'updated_at',
      ],
      overseer_operator_card_delivery_receipts: [
        'receipt_id',
        'card_id',
        'channel',
        'attempt_number',
        'phase',
        'started_at',
        'completed_at',
        'outcome',
        'sanitized_status',
        'error_class',
        'next_attempt_at',
        'provider_receipt_id',
        'fencing_token',
        'created_at',
      ],
    } as const;

    for (const [table, columns] of Object.entries(expected)) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(sqlite).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      const actual = await db.query<{ name: string }>(
        `SELECT name FROM pragma_table_info('${table}') ORDER BY cid`
      );
      expect(actual.rows.map(row => row.name)).toEqual(columns);
    }
    expect(migration).toContain('trg_overseer_operator_cards_no_update');
    expect(migration).toContain('trg_overseer_operator_card_delivery_receipts_no_update');
    expect(sqlite).toContain('trg_overseer_operator_cards_no_update');
    expect(sqlite).toContain('trg_overseer_operator_card_delivery_receipts_no_update');
  });

  test('inserts one immutable card plus exactly three jobs and deduplicates identical input', async () => {
    const first = await appendOperatorCard(cardInput());
    const second = await appendOperatorCard(cardInput());

    expect(second.card.card_id).toBe(first.card.card_id);
    expect(first.jobs.map(job => job.channel)).toEqual(['builder_monitor', 'dispatch', 'notion']);
    expect(first.jobs.every(job => job.state === 'pending' && job.attempts_started === 0)).toBe(
      true
    );
    expect((await db.query('SELECT 1 FROM overseer_operator_cards')).rowCount).toBe(1);
    expect((await db.query('SELECT 1 FROM overseer_operator_card_delivery_jobs')).rowCount).toBe(3);

    await expect(appendOperatorCard(cardInput({ payload_digest: 'd'.repeat(64) }))).rejects.toThrow(
      'operator_card_digest_conflict'
    );
    await expect(
      db.query('UPDATE overseer_operator_cards SET blocker = $1', ['tamper'])
    ).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM overseer_operator_cards')).rejects.toThrow(/append-only/);
  });

  test('uses fixed 0/30/120 retry offsets and never creates a fourth attempt', async () => {
    await appendOperatorCard(cardInput());
    const first = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'worker-a',
      now: CREATED_AT,
      lease_duration_ms: 10_000,
    });
    expect(first?.attempts_started).toBe(1);
    await appendDeliveryReceipt({
      receipt_id: 'receipt-start-1',
      card_id: CARD_ID,
      channel: 'dispatch',
      attempt_number: 1,
      phase: 'started',
      started_at: CREATED_AT,
      fencing_token: first?.fencing_token ?? 0,
      lease_owner: 'worker-a',
    });
    await appendDeliveryReceipt({
      receipt_id: 'receipt-terminal-1',
      card_id: CARD_ID,
      channel: 'dispatch',
      attempt_number: 1,
      phase: 'terminal',
      started_at: CREATED_AT,
      completed_at: '2026-07-16T08:00:01.000Z',
      outcome: 'transient_failure',
      sanitized_status: 'temporary outage',
      error_class: 'service_unavailable',
      next_attempt_at: '2026-07-16T08:00:30.000Z',
      fencing_token: first?.fencing_token ?? 0,
      lease_owner: 'worker-a',
    });
    await completeDeliveryJob({
      card_id: CARD_ID,
      channel: 'dispatch',
      owner: 'worker-a',
      fencing_token: first?.fencing_token ?? 0,
      outcome: 'transient_failure',
      now: '2026-07-16T08:00:01.000Z',
    });

    expect(
      await claimDueDeliveryJob({
        channel: 'dispatch',
        owner: 'worker-b',
        now: '2026-07-16T08:00:29.999Z',
      })
    ).toBeNull();
    const second = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'worker-b',
      now: '2026-07-16T08:00:30.000Z',
    });
    expect(second?.attempts_started).toBe(2);
    await completeDeliveryJob({
      card_id: CARD_ID,
      channel: 'dispatch',
      owner: 'worker-b',
      fencing_token: second?.fencing_token ?? 0,
      outcome: 'transient_failure',
      now: '2026-07-16T08:00:31.000Z',
    });
    const third = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'worker-c',
      now: '2026-07-16T08:02:00.000Z',
    });
    expect(third?.attempts_started).toBe(3);
    const exhausted = await completeDeliveryJob({
      card_id: CARD_ID,
      channel: 'dispatch',
      owner: 'worker-c',
      fencing_token: third?.fencing_token ?? 0,
      outcome: 'transient_failure',
      now: '2026-07-16T08:02:01.000Z',
    });
    expect(exhausted.state).toBe('exhausted');
    expect(
      await claimDueDeliveryJob({
        channel: 'dispatch',
        owner: 'worker-d',
        now: '2026-07-16T09:00:00.000Z',
      })
    ).toBeNull();
  });

  test('recovers an expired lease with a monotonic fence and exposes cards with receipts', async () => {
    await appendOperatorCard(cardInput());
    const first = await claimDueDeliveryJob({
      channel: 'notion',
      owner: 'worker-a',
      now: CREATED_AT,
      lease_duration_ms: 1_000,
    });
    await appendDeliveryReceipt({
      receipt_id: 'receipt-restart-start',
      card_id: CARD_ID,
      channel: 'notion',
      attempt_number: 1,
      phase: 'started',
      started_at: CREATED_AT,
      fencing_token: first?.fencing_token ?? 0,
      lease_owner: 'worker-a',
    });

    await closeDatabase();
    resetDatabase();
    db = getDatabase();
    const recovered = await claimDueDeliveryJob({
      channel: 'notion',
      owner: 'worker-b',
      now: '2026-07-16T08:00:02.000Z',
    });
    expect(recovered?.attempts_started).toBe(1);
    expect(recovered?.fencing_token).toBe((first?.fencing_token ?? 0) + 1);

    await appendDeliveryReceipt({
      receipt_id: 'receipt-restart-terminal',
      card_id: CARD_ID,
      channel: 'notion',
      attempt_number: 1,
      phase: 'terminal',
      started_at: CREATED_AT,
      completed_at: '2026-07-16T08:00:02.000Z',
      outcome: 'indeterminate',
      sanitized_status: 'provider state unknown',
      error_class: 'indeterminate',
      fencing_token: recovered?.fencing_token ?? 0,
      lease_owner: 'worker-b',
    });
    await completeDeliveryJob({
      card_id: CARD_ID,
      channel: 'notion',
      owner: 'worker-b',
      fencing_token: recovered?.fencing_token ?? 0,
      outcome: 'indeterminate',
      now: '2026-07-16T08:00:02.000Z',
    });

    const visible = await getOperatorCard(CARD_ID);
    expect(visible?.delivery_summary.notion.state).toBe('indeterminate');
    expect(visible?.receipts).toHaveLength(2);
    expect((await listOperatorCards({ limit: 10 })).items).toHaveLength(1);
    await expect(
      db.query('UPDATE overseer_operator_card_delivery_receipts SET outcome = $1', ['succeeded'])
    ).rejects.toThrow(/append-only/);
  });

  test('rejects a stale worker receipt after lease reclaim and accepts the current fence', async () => {
    await appendOperatorCard(cardInput());
    const first = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'worker-stale',
      now: CREATED_AT,
      lease_duration_ms: 1_000,
    });
    const reclaimed = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'worker-current',
      now: '2026-07-16T08:00:02.000Z',
    });
    type FencedReceipt = Parameters<typeof appendDeliveryReceipt>[0] & { lease_owner: string };
    const appendFenced = appendDeliveryReceipt as (
      input: FencedReceipt
    ) => ReturnType<typeof appendDeliveryReceipt>;
    await expect(
      appendFenced({
        card_id: CARD_ID,
        channel: 'dispatch',
        attempt_number: 1,
        phase: 'started',
        started_at: CREATED_AT,
        fencing_token: first?.fencing_token ?? 0,
        lease_owner: 'worker-stale',
      })
    ).rejects.toThrow('delivery_receipt_stale_fence');
    await expect(
      appendFenced({
        card_id: CARD_ID,
        channel: 'dispatch',
        attempt_number: 1,
        phase: 'started',
        started_at: CREATED_AT,
        fencing_token: reclaimed?.fencing_token ?? 0,
        lease_owner: 'worker-current',
      })
    ).resolves.toMatchObject({ fencing_token: reclaimed?.fencing_token });
  });
});
