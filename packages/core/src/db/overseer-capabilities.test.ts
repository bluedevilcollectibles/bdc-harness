import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, unlinkSync } from 'fs';
import { removeTempDirWithRetry } from '../test/temp-dir';
import { join } from 'path';
import type { IDatabase } from './adapters/types';
import { closeDatabase, getDatabase, resetDatabase } from './connection';

let db: IDatabase;
let currentDbPath = '';
let currentHome = '';
const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;

import {
  OVERSEER_CAPABILITIES,
  appendOverseerCapabilityEvent,
  getOverseerCapabilityState,
  listOverseerCapabilityEvents,
  listOverseerCapabilityStates,
  normalizeOverseerCapabilityTimestamp,
  openOverseerCapabilityCircuit,
} from './overseer-capabilities';

const POLICY_DIGEST = 'a'.repeat(64);
const VERIFIER_DIGEST = 'b'.repeat(64);
const ZERO_DIGEST = '0'.repeat(64);

function cleanupDb(path: string): void {
  if (!path) return;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // File may not exist.
    }
  }
}

function eventInput(overrides: Record<string, unknown> = {}): {
  event_id?: string;
  capability: string;
  event_type: string;
  reason: string;
  actor: string;
  correlation_id: string;
  proposal_id?: string | null;
  execution_id?: string | null;
  policy_digest: string;
  verifier_registry_digest: string;
  details?: Record<string, unknown>;
} {
  return {
    capability: 'merge',
    event_type: 'gate_denied',
    reason: 'default-disabled',
    actor: 'test-operator',
    correlation_id: 'corr-1',
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: VERIFIER_DIGEST,
    details: { source: 'unit-test' },
    ...overrides,
  };
}

function createTableDefinition(schema: string, table: string): string {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
  if (start < 0) throw new Error(`missing_table_definition:${table}`);
  const markerPattern = /\n\s*(?:CREATE (?:TABLE|INDEX|TRIGGER)|INSERT |-- [A-Z])/g;
  markerPattern.lastIndex = start + 1;
  const next = markerPattern.exec(schema);
  return schema.slice(start, next?.index ?? schema.length);
}

describe('overseer capability persistence (sqlite)', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = join(
      import.meta.dir,
      `.test-overseer-capabilities-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
    if (currentHome) removeTempDirWithRetry(currentHome);
    if (oldArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldArchonHome;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  });

  test('seeds exactly five disabled and closed capability states in deterministic order', async () => {
    const states = await listOverseerCapabilityStates();

    expect(states.map(state => state.capability)).toEqual([...OVERSEER_CAPABILITIES]);
    expect(states).toHaveLength(5);
    for (const state of states) {
      expect(state.action_enabled).toBe(false);
      expect(state.circuit_state).toBe('closed');
      expect(state.circuit_reason).toBeNull();
      expect(state.circuit_opened_at).toBeNull();
      expect(state.policy_digest).toBe(ZERO_DIGEST);
      expect(state.verifier_registry_digest).toBe(ZERO_DIGEST);
      expect(state.updated_by).toBe('migration-034');
      expect(state.updated_at).toBeString();
    }

    expect((await getOverseerCapabilityState('merge'))?.capability).toBe('merge');
  });

  test('normalizes PostgreSQL Date and offset timestamps to ISO strings', () => {
    expect(normalizeOverseerCapabilityTimestamp(new Date('2026-07-15T12:34:56.789Z'))).toBe(
      '2026-07-15T12:34:56.789Z'
    );
    expect(normalizeOverseerCapabilityTimestamp('2026-07-15T08:34:56.789-04:00')).toBe(
      '2026-07-15T12:34:56.789Z'
    );
  });

  test('keeps PostgreSQL migration and SQLite schema logically equivalent', async () => {
    const migration = readFileSync(
      join(import.meta.dir, '../../../../migrations/034_overseer_capability_state.sql'),
      'utf8'
    );
    const sqlite = readFileSync(join(import.meta.dir, 'adapters/sqlite.ts'), 'utf8');
    const requiredStateColumns = [
      'capability',
      'action_enabled',
      'circuit_state',
      'circuit_reason',
      'circuit_opened_at',
      'policy_digest',
      'verifier_registry_digest',
      'updated_at',
      'updated_by',
    ];
    const requiredEventColumns = [
      'event_id',
      'capability',
      'event_type',
      'reason',
      'actor',
      'correlation_id',
      'proposal_id',
      'execution_id',
      'policy_digest',
      'verifier_registry_digest',
      'details_json',
      'created_at',
    ];

    for (const schema of [migration, sqlite]) {
      const stateTable = createTableDefinition(schema, 'overseer_capability_state');
      const eventTable = createTableDefinition(schema, 'overseer_capability_events');
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS overseer_capability_state');
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS overseer_capability_events');
      expect(schema).toContain('trg_overseer_capability_events_no_update');
      expect(schema).toContain('trg_overseer_capability_events_no_delete');
      expect(schema).toContain('idx_overseer_capability_events_adapter_execution');
      for (const capability of OVERSEER_CAPABILITIES) {
        expect(stateTable).toContain(`'${capability}'`);
        expect(eventTable).toContain(`'${capability}'`);
      }
      for (const eventType of [
        'gate_allowed',
        'gate_denied',
        'circuit_opened',
        'circuit_reset',
        'adapter_attempt',
      ]) {
        expect(eventTable).toContain(`'${eventType}'`);
      }
      for (const column of requiredStateColumns) expect(stateTable).toContain(column);
      for (const column of requiredEventColumns) expect(eventTable).toContain(column);
      expect(stateTable).toMatch(/action_enabled (?:BOOLEAN|INTEGER) NOT NULL DEFAULT (?:FALSE|0)/);
      expect(stateTable).toContain("circuit_state TEXT NOT NULL DEFAULT 'closed'");
      expect(stateTable).toContain("circuit_state IN ('closed', 'open')");
      expect(eventTable).toContain(
        'proposal_id TEXT REFERENCES overseer_m31_action_proposals(proposal_id)'
      );
      expect(eventTable).toContain(
        'execution_id TEXT REFERENCES overseer_m31_action_proposals(execution_id)'
      );
      expect(eventTable).toMatch(/details_json (?:JSONB|TEXT) NOT NULL DEFAULT/);
      for (const column of ['policy_digest', 'verifier_registry_digest']) {
        expect(stateTable).toContain(`${column} TEXT NOT NULL`);
        expect(eventTable).toContain(`${column} TEXT NOT NULL`);
      }
    }

    expect(migration).toContain('action_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain("policy_digest ~ '^[0-9a-f]{64}$'");
    expect(sqlite).toContain("length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'");

    const stateColumns = await db.query<{ name: string }>(
      "SELECT name FROM pragma_table_info('overseer_capability_state') ORDER BY cid"
    );
    expect(stateColumns.rows.map(row => row.name)).toEqual(requiredStateColumns);
    const eventColumns = await db.query<{ name: string }>(
      "SELECT name FROM pragma_table_info('overseer_capability_events') ORDER BY cid"
    );
    expect(eventColumns.rows.map(row => row.name)).toEqual(requiredEventColumns);
  });

  test('appends and reads an immutable capability event', async () => {
    const appended = await appendOverseerCapabilityEvent(eventInput());
    const events = await listOverseerCapabilityEvents('merge');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(appended);
    expect(appended.event_type).toBe('gate_denied');
    expect(appended.details).toEqual({ source: 'unit-test' });
    expect(appended.proposal_id).toBeNull();
    expect(appended.execution_id).toBeNull();
    expect(appended.created_at).toBeString();

    await expect(
      db.query('UPDATE overseer_capability_events SET reason = $1', ['tamper'])
    ).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM overseer_capability_events')).rejects.toThrow(/append-only/);
  });

  test('atomically accepts only one adapter attempt per execution id', async () => {
    await db.query(
      `INSERT INTO overseer_m31_snapshots (
        snapshot_id, schema_version, repository, capture_started_at, capture_completed_at,
        operator_actor, operator_model, read_only_query_method, base_branch, base_sha,
        artifact_path, git_object_format, evidence_git_blob, mutation_attempted,
        mutation_succeeded, fusion_calls_attempted, fusion_calls_succeeded
      ) VALUES ($1, $2, $3, $4, $4, $5, $5, $6, $7, $8, $9, $10, $11, 0, 0, 0, 0)`,
      [
        'snapshot-adapter-claim',
        'v1',
        'thinmansoftware/bdc-harness',
        '2026-07-15T12:00:00.000Z',
        'test',
        'unit-test',
        'dev',
        'a'.repeat(40),
        'artifacts/adapter-claim.json',
        'sha1',
        'b'.repeat(40),
      ]
    );
    await db.query(
      `INSERT INTO overseer_m31_action_proposals (
        proposal_id, repository, pr_number, head_sha, base_branch, base_sha,
        snapshot_id, evidence_path, evidence_git_blob, action_kind,
        action_parameters_json, actor, created_at, expires_at, execution_id,
        capability, policy_digest, verifier_registry_digest
      ) VALUES ($1, $2, 42, $3, $4, $5, $6, $7, $8, 'MERGE', '{}', $9,
        $10, $11, $12, $13, $14, $15)`,
      [
        'proposal-adapter-claim',
        'thinmansoftware/bdc-harness',
        'c'.repeat(40),
        'dev',
        'a'.repeat(40),
        'snapshot-adapter-claim',
        'artifacts/adapter-claim.json',
        'b'.repeat(40),
        'test',
        '2026-07-15T12:00:00.000Z',
        '2026-07-15T12:05:00.000Z',
        'execution-adapter-claim',
        'overseer.m31.merge',
        POLICY_DIGEST,
        VERIFIER_DIGEST,
      ]
    );

    const attempts = await Promise.allSettled([
      appendOverseerCapabilityEvent(
        eventInput({
          event_id: 'adapter-claim-a',
          event_type: 'adapter_attempt',
          proposal_id: 'proposal-adapter-claim',
          execution_id: 'execution-adapter-claim',
        })
      ),
      appendOverseerCapabilityEvent(
        eventInput({
          event_id: 'adapter-claim-b',
          event_type: 'adapter_attempt',
          proposal_id: 'proposal-adapter-claim',
          execution_id: 'execution-adapter-claim',
        })
      ),
    ]);

    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejection = attempts.find(result => result.status === 'rejected');
    expect(rejection?.reason).toHaveProperty(
      'message',
      expect.stringContaining('overseer_capability_events.execution_id')
    );
    expect(
      (await listOverseerCapabilityEvents('merge')).filter(
        event => event.event_type === 'adapter_attempt'
      )
    ).toHaveLength(1);
  });

  test('rejects an adapter replay after the database connection restarts', async () => {
    await db.query(
      `INSERT INTO overseer_m31_snapshots (
        snapshot_id, schema_version, repository, capture_started_at, capture_completed_at,
        operator_actor, operator_model, read_only_query_method, base_branch, base_sha,
        artifact_path, git_object_format, evidence_git_blob, mutation_attempted,
        mutation_succeeded, fusion_calls_attempted, fusion_calls_succeeded
      ) VALUES ($1, $2, $3, $4, $4, $5, $5, $6, $7, $8, $9, $10, $11, 0, 0, 0, 0)`,
      [
        'snapshot-adapter-restart',
        'v1',
        'thinmansoftware/bdc-harness',
        '2026-07-15T12:00:00.000Z',
        'test',
        'unit-test',
        'dev',
        'a'.repeat(40),
        'artifacts/adapter-restart.json',
        'sha1',
        'd'.repeat(40),
      ]
    );
    await db.query(
      `INSERT INTO overseer_m31_action_proposals (
        proposal_id, repository, pr_number, head_sha, base_branch, base_sha,
        snapshot_id, evidence_path, evidence_git_blob, action_kind,
        action_parameters_json, actor, created_at, expires_at, execution_id,
        capability, policy_digest, verifier_registry_digest
      ) VALUES ($1, $2, 42, $3, $4, $5, $6, $7, $8, 'MERGE', '{}', $9,
        $10, $11, $12, $13, $14, $15)`,
      [
        'proposal-adapter-restart',
        'thinmansoftware/bdc-harness',
        'c'.repeat(40),
        'dev',
        'a'.repeat(40),
        'snapshot-adapter-restart',
        'artifacts/adapter-restart.json',
        'd'.repeat(40),
        'test',
        '2026-07-15T12:00:00.000Z',
        '2026-07-15T12:05:00.000Z',
        'execution-adapter-restart',
        'overseer.m31.merge',
        POLICY_DIGEST,
        VERIFIER_DIGEST,
      ]
    );
    await appendOverseerCapabilityEvent(
      eventInput({
        event_id: 'adapter-restart-first',
        event_type: 'adapter_attempt',
        proposal_id: 'proposal-adapter-restart',
        execution_id: 'execution-adapter-restart',
      })
    );

    await closeDatabase();
    resetDatabase();
    db = getDatabase();

    await expect(
      appendOverseerCapabilityEvent(
        eventInput({
          event_id: 'adapter-restart-replay',
          event_type: 'adapter_attempt',
          proposal_id: 'proposal-adapter-restart',
          execution_id: 'execution-adapter-restart',
        })
      )
    ).rejects.toThrow(/overseer_capability_events\.execution_id/);
    expect(
      (await listOverseerCapabilityEvents('merge')).filter(
        event => event.event_type === 'adapter_attempt'
      )
    ).toHaveLength(1);
  });

  test('rejects generic transition events before writes while circuit open emits atomically', async () => {
    for (const eventType of ['circuit_opened', 'circuit_reset']) {
      await expect(
        appendOverseerCapabilityEvent(eventInput({ event_type: eventType }))
      ).rejects.toThrow(/transition.*event/i);
      expect(await listOverseerCapabilityEvents('merge')).toHaveLength(0);
    }

    const opened = await openOverseerCapabilityCircuit({
      capability: 'merge',
      reason: 'atomic-transition',
      actor: 'test-operator',
      correlation_id: 'corr-transition',
      policy_digest: POLICY_DIGEST,
      verifier_registry_digest: VERIFIER_DIGEST,
    });

    expect(opened.event.event_type).toBe('circuit_opened');
    expect(opened.state.circuit_state).toBe('open');
    expect(await listOverseerCapabilityEvents('merge')).toHaveLength(1);
  });

  test('opens only the requested circuit and appends its circuit_opened event', async () => {
    const opened = await openOverseerCapabilityCircuit({
      event_id: 'open-repair-1',
      capability: 'repair',
      reason: 'verifier-failure',
      actor: 'test-operator',
      correlation_id: 'corr-open-1',
      policy_digest: POLICY_DIGEST,
      verifier_registry_digest: VERIFIER_DIGEST,
      details: { verifier: 'test' },
    });

    expect(opened.state.circuit_state).toBe('open');
    expect(opened.state.action_enabled).toBe(false);
    expect(opened.state.circuit_reason).toBe('verifier-failure');
    expect(opened.state.updated_by).toBe('test-operator');
    expect(opened.event.event_type).toBe('circuit_opened');
    expect(opened.event.capability).toBe('repair');

    const states = await listOverseerCapabilityStates();
    expect(
      states.filter(state => state.circuit_state === 'open').map(state => state.capability)
    ).toEqual(['repair']);
    expect(await listOverseerCapabilityEvents('repair')).toHaveLength(1);
    expect(await listOverseerCapabilityEvents('merge')).toHaveLength(0);
  });

  test('rolls back circuit state when its event append fails', async () => {
    await appendOverseerCapabilityEvent(eventInput({ event_id: 'duplicate-event' }));

    await expect(
      openOverseerCapabilityCircuit({
        event_id: 'duplicate-event',
        capability: 'merge',
        reason: 'must-roll-back',
        actor: 'test-operator',
        correlation_id: 'corr-open-fail',
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: VERIFIER_DIGEST,
      })
    ).rejects.toThrow();

    const state = await getOverseerCapabilityState('merge');
    expect(state?.circuit_state).toBe('closed');
    expect(state?.circuit_reason).toBeNull();
    expect(state?.updated_by).toBe('migration-034');
    expect(await listOverseerCapabilityEvents('merge')).toHaveLength(1);
  });

  test('fails closed before writes for unknown vocabulary and malformed digests', async () => {
    await expect(getOverseerCapabilityState('unknown')).rejects.toThrow(/unknown.*capability/i);
    await expect(
      appendOverseerCapabilityEvent(eventInput({ capability: 'unknown' }))
    ).rejects.toThrow(/unknown.*capability/i);
    await expect(
      appendOverseerCapabilityEvent(eventInput({ event_type: 'made_up' }))
    ).rejects.toThrow(/invalid.*event/i);
    await expect(
      appendOverseerCapabilityEvent(eventInput({ policy_digest: 'ABC' }))
    ).rejects.toThrow(/policy_digest.*64-hex/i);
    await expect(
      openOverseerCapabilityCircuit({
        capability: 'merge',
        reason: 'bad-digest',
        actor: 'test-operator',
        correlation_id: 'corr-bad-digest',
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: 'short',
      })
    ).rejects.toThrow(/verifier_registry_digest.*64-hex/i);

    expect(await listOverseerCapabilityEvents('merge')).toHaveLength(0);
    expect((await getOverseerCapabilityState('merge'))?.circuit_state).toBe('closed');
  });
});
