import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { listOverseerCapabilityEvents } from '@archon/core/db/overseer-capabilities';
import { listOperatorCards } from '@archon/core/db/overseer-briefing';
import { handleNodeFailure } from './overseer-bridge.ts';
import type { DagNode } from './schemas/dag-node.ts';
import type { IWorkflowStore } from './store.ts';
import type { WorkflowRun } from './schemas/workflow-run.ts';
import type { Logger } from '@archon/paths';
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

function makeMockStore(): IWorkflowStore & {
  createDurableWorkflowEvent: ReturnType<typeof mock>;
} {
  return {
    listWorkflowRuns: mock(() => Promise.resolve([])),
    createWorkflowRun: mock(() => Promise.resolve(undefined as never)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    updateWorkflowRunStatus: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    createDurableWorkflowEvent: mock(() =>
      Promise.resolve({
        id: 'persisted-event-1',
        workflow_run_id: 'gate-test-run',
        event_type: 'node_failed',
        step_index: null,
        step_name: 'war-council-validator',
        data: { error: 'REJECT missing required implementation evidence' },
        created_at: '2026-07-16T08:30:00.000Z',
      })
    ),
    listWorkflowEvents: mock(() => Promise.resolve([])),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  };
}

function makeMockLog(): Logger {
  const noop = () => undefined as never;
  return {
    info: mock(noop),
    warn: mock(noop),
    error: mock(noop),
    debug: mock(noop),
    fatal: mock(noop),
    trace: mock(noop),
    silent: mock(noop),
    child: mock(() => makeMockLog()),
    bindings: mock(() => ({})),
    level: 'info',
    levels: { values: {}, labels: {} },
  } as unknown as Logger;
}

function makeWorkflowRun(metadata?: Record<string, unknown>): WorkflowRun {
  return {
    id: 'gate-test-run',
    workflow_name: 'test-wf',
    conversation_id: 'conv-gate',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'msg',
    workflow_def: {},
    skip_persona: false,
    started_at: new Date('2026-05-16T00:00:00Z').toISOString(),
    completed_at: null,
    error: null,
    metadata: metadata ?? null,
  } as unknown as WorkflowRun;
}

function makeNode(id = 'gate-node'): DagNode {
  return { id, command: 'test-cmd' } as DagNode;
}

function makeDeps() {
  const store = makeMockStore();
  const log = makeMockLog();
  const emitter = { emit: mock(() => undefined) };
  const logNodeError = mock(() => Promise.resolve());
  return { store, log, emitter, logNodeError };
}

function hasDeniedLog(log: Logger): boolean {
  const logInfo = log.info as unknown as { mock: { calls: unknown[][] } };
  return logInfo.mock.calls.some(call => call[1] === 'overseer.escalation_denied');
}

async function withPersistentEscalationPermit(
  work: (permit: M31ActionPermit) => Promise<void>
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'archon-workflow-escalation-'));
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
      ) VALUES ('snapshot-workflow-valid', 'v1', $1, $2, $2, 'test', 'test',
        'unit-test', 'dev', $3, 'artifacts/workflow-valid.json', 'sha1', $4,
        0, 0, 0, 0)`,
      ['thinmansoftware/bdc-harness', createdAt, 'a'.repeat(40), 'b'.repeat(40)]
    );
    await db.query(
      `INSERT INTO overseer_m31_action_proposals (
        proposal_id, repository, pr_number, head_sha, base_branch, base_sha,
        snapshot_id, evidence_path, evidence_git_blob, action_kind,
        action_parameters_json, actor, created_at, expires_at, execution_id,
        capability, policy_digest, verifier_registry_digest
      ) VALUES ('proposal-workflow-valid', $1, 42, $2, 'dev', $3,
        'snapshot-workflow-valid', 'artifacts/workflow-valid.json', $4,
        'STAGING_MUTATION', '{}', 'test', $5, $6, 'execution-workflow-valid',
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
      permit_id: 'permit-workflow-valid',
      proposal_id: 'proposal-workflow-valid',
      execution_id: 'execution-workflow-valid',
      repository: 'thinmansoftware/bdc-harness',
      pr_number: 42,
      head_sha: 'c'.repeat(40),
      base_branch: 'dev',
      base_sha: 'a'.repeat(40),
      snapshot_id: 'snapshot-workflow-valid',
      action_kind: 'STAGING_MUTATION',
      capability: 'overseer.m31.staging_mutation',
      issued_at: new Date(now - 1_000).toISOString(),
      valid_until: new Date(now + 60_000).toISOString(),
    };
    await work(permit);
  } finally {
    await closeDatabase();
    resetDatabase();
    removeTempDirWithRetry(home);
  }
}

describe('handleNodeFailure authorization boundary', () => {
  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    for (const key of ENV_KEYS) {
      const value = oldEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('missing permit is denied by the real shared boundary', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode('war-council-validator'), {
      errorMsg: 'REJECT missing required implementation evidence',
      logDir: '/tmp/test',
    });

    expect(hasDeniedLog(deps.log)).toBe(true);
    const logInfo = deps.log.info as unknown as { mock: { calls: unknown[][] } };
    const denialCall = logInfo.mock.calls.find(call => call[1] === 'overseer.escalation_denied');
    expect((denialCall?.[0] as Record<string, unknown>).reason).toBe('permit_missing');
  });

  it('skip decisions never enter the escalation boundary', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      errorMsg: 'npm: command not found',
      logDir: '/tmp/test',
    });

    expect(hasDeniedLog(deps.log)).toBe(false);
  });

  it('valid permit derives the card identity from the returned durable event', async () => {
    await withPersistentEscalationPermit(async permit => {
      const deps = makeDeps();
      await handleNodeFailure(
        deps,
        makeWorkflowRun({ overseer_m31_permit: permit }),
        makeNode('war-council-validator'),
        {
          errorMsg: 'REJECT missing required implementation evidence',
          logDir: '/tmp/test',
        }
      );

      const attempts = (await listOverseerCapabilityEvents('escalation')).filter(
        event => event.event_type === 'adapter_attempt'
      );
      expect(hasDeniedLog(deps.log)).toBe(false);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.details).toMatchObject({
        adapter: 'escalation-notify-only',
        accepted: true,
        mutation_sent: false,
      });
      const cards = await listOperatorCards();
      expect(cards.items).toHaveLength(1);
      expect(cards.items[0]?.card.canonical_event_identity).toMatchObject({
        source_event_id: 'persisted-event-1',
        event_created_at: '2026-07-16T08:30:00.000Z',
        event_type: 'node_failed',
        step_name: 'war-council-validator',
      });
      const durableCreate = deps.store.createDurableWorkflowEvent as ReturnType<typeof mock>;
      expect(durableCreate).toHaveBeenCalledTimes(1);
    });
  });

  it('durable event persistence failure creates no card, jobs, or authorization attempt', async () => {
    await withPersistentEscalationPermit(async permit => {
      const deps = makeDeps();
      deps.store.createDurableWorkflowEvent = mock(async () => {
        throw new Error('durable_event_insert_failed');
      });

      await handleNodeFailure(
        deps,
        makeWorkflowRun({ overseer_m31_permit: permit }),
        makeNode('war-council-validator'),
        {
          errorMsg: 'REJECT missing required implementation evidence',
          logDir: '/tmp/test',
        }
      );

      expect((await listOperatorCards()).items).toHaveLength(0);
      const attempts = (await listOverseerCapabilityEvents('escalation')).filter(
        event => event.event_type === 'adapter_attempt'
      );
      expect(attempts).toHaveLength(0);
    });
  });
});
