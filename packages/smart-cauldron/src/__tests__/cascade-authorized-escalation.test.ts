import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { listOverseerCapabilityEvents } from '@archon/core/db/overseer-capabilities';
import { runCascade } from '../cascade.ts';
import type { M31ActionPermit } from '@archon/overseer/m31-substrate';

const POLICY_DIGEST = 'a'.repeat(64);
const VERIFIER_DIGEST = 'b'.repeat(64);
const ENV_KEYS = [
  'ARCHON_HOME',
  'DATABASE_URL',
  'OVERSEER_ENABLED',
  'OVERSEER_EMERGENCY_STOP',
  'OVERSEER_DRY_RUN',
  'OVERSEER_ESCALATION_ACTIONS_ENABLED',
] as const;
const oldEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

async function withPersistentPermit(
  work: (permit: M31ActionPermit) => Promise<void>
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'archon-cascade-escalation-'));
  await closeDatabase();
  resetDatabase();
  process.env.ARCHON_HOME = home;
  delete process.env.DATABASE_URL;
  process.env.OVERSEER_ENABLED = 'true';
  process.env.OVERSEER_EMERGENCY_STOP = 'false';
  process.env.OVERSEER_DRY_RUN = 'false';
  process.env.OVERSEER_ESCALATION_ACTIONS_ENABLED = 'true';

  try {
    const db = getDatabase();
    const now = Date.now();
    const createdAt = new Date(now - 30_000).toISOString();
    const expiresAt = new Date(now + 300_000).toISOString();
    await db.query(
      `INSERT INTO overseer_m31_snapshots (
        snapshot_id, schema_version, repository, capture_started_at, capture_completed_at,
        operator_actor, operator_model, read_only_query_method, base_branch, base_sha,
        artifact_path, git_object_format, evidence_git_blob, mutation_attempted,
        mutation_succeeded, fusion_calls_attempted, fusion_calls_succeeded
      ) VALUES ('snapshot-cascade-valid', 'v1', $1, $2, $2, 'test', 'test',
        'unit-test', 'dev', $3, 'artifacts/cascade-valid.json', 'sha1', $4,
        0, 0, 0, 0)`,
      ['thinmansoftware/bdc-harness', createdAt, 'a'.repeat(40), 'b'.repeat(40)]
    );
    await db.query(
      `INSERT INTO overseer_m31_action_proposals (
        proposal_id, repository, pr_number, head_sha, base_branch, base_sha,
        snapshot_id, evidence_path, evidence_git_blob, action_kind,
        action_parameters_json, actor, created_at, expires_at, execution_id,
        capability, policy_digest, verifier_registry_digest
      ) VALUES ('proposal-cascade-valid', $1, 42, $2, 'dev', $3,
        'snapshot-cascade-valid', 'artifacts/cascade-valid.json', $4,
        'STAGING_MUTATION', '{}', 'test', $5, $6, 'execution-cascade-valid',
        'overseer.m31.staging_mutation', $7, $8)`,
      [
        'thinmansoftware/bdc-harness',
        'c'.repeat(40),
        'a'.repeat(40),
        'b'.repeat(40),
        createdAt,
        expiresAt,
        POLICY_DIGEST,
        VERIFIER_DIGEST,
      ]
    );
    await db.query(
      `UPDATE overseer_capability_state
       SET action_enabled = 1, circuit_state = 'closed', policy_digest = $1,
         verifier_registry_digest = $2, updated_at = $3, updated_by = 'test'
       WHERE capability = 'escalation'`,
      [POLICY_DIGEST, VERIFIER_DIGEST, createdAt]
    );
    const permit: M31ActionPermit = {
      permit_id: 'permit-cascade-valid',
      proposal_id: 'proposal-cascade-valid',
      execution_id: 'execution-cascade-valid',
      repository: 'thinmansoftware/bdc-harness',
      pr_number: 42,
      head_sha: 'c'.repeat(40),
      base_branch: 'dev',
      base_sha: 'a'.repeat(40),
      snapshot_id: 'snapshot-cascade-valid',
      action_kind: 'STAGING_MUTATION',
      capability: 'overseer.m31.staging_mutation',
      issued_at: new Date(now - 1_000).toISOString(),
      valid_until: new Date(now + 60_000).toISOString(),
    };
    await work(permit);
  } finally {
    await closeDatabase();
    resetDatabase();
    rmSync(home, { recursive: true, force: true });
  }
}

describe('cascade default escalation boundary', () => {
  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    for (const key of ENV_KEYS) {
      const value = oldEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('valid permit records one inert attempt through the real persistent boundary', async () => {
    await withPersistentPermit(async permit => {
      const result = await runCascade({
        woId: 'WO-CASCADE-BOUNDARY-01',
        project: 'bdc-harness',
        entryOverride: 'codex',
        overseerPermit: permit,
        deps: {
          fire: async () => ({
            ok: false,
            runId: null,
            conversationId: 'conversation-cascade-boundary',
            infraError: 'HTTP 401: Unauthorized',
          }),
          poll: async () => {
            throw new Error('poll must not run after fire infrastructure failure');
          },
          judge: () => {
            throw new Error('judge must not run after fire infrastructure failure');
          },
          writeRecord: async () => '/tmp/cascade-boundary.json',
        },
      });

      const attempts = (await listOverseerCapabilityEvents('escalation')).filter(
        event => event.event_type === 'adapter_attempt'
      );
      expect(result.status).toBe('infra-alert');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.details).toMatchObject({
        adapter: 'escalation-notify-only',
        accepted: true,
        mutation_sent: false,
      });
    });
  });
});
