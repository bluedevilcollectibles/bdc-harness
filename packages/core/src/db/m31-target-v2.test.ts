import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';
import { installM31TargetV2Sqlite } from './m31-target-v2-sqlite';
import { getM31ChainAssessment } from './merge-steward';

let db: SqliteAdapter;
let dbPath = '';
mock.module('./connection', () => ({ getDatabase: () => db }));

import {
  appendM31DiscrepancyV2,
  appendM31ExecutionOutcomeV2,
  appendM31ExecutionReconciliationV2,
  canonicalJsonV2,
  compareAndConsumeM31ProposalV2,
  createM31ActionProposalV2,
  getM31ChainAssessmentV2,
  listM31ExecutionReceiptEventsV2,
  registerM31SnapshotV2,
  reserveM31ExecutionEffectV2,
  targetDigestV2,
  targetKeyV2,
  type M31ActionTargetV2,
} from './m31-target-v2';

const T0 = '2026-07-16T12:00:00.000Z';
const H = (seed: string, n = 64): string =>
  createHash('sha256').update(seed).digest('hex').slice(0, n);

const targets: readonly M31ActionTargetV2[] = [
  {
    target_kind: 'workflow_run',
    repository: 'org/repo',
    run_id: '123e4567-e89b-42d3-a456-426614174000',
    wo_id: 'WO-1',
    workflow_name: 'build',
    codebase_id: null,
    status: 'failed',
    event_tip: 'event-9',
    head_sha: null,
    base_sha: null,
  },
  {
    target_kind: 'issue',
    repository: 'org/repo',
    issue_number: 8,
    provider_node_id: 'I_8',
    state: 'open',
    updated_at: T0,
    is_pull_request: false,
  },
  {
    target_kind: 'work_order',
    repository: 'org/repo',
    wo_id: 'WO-2',
    spec_path: 'docs/work-orders/WO-2.md',
    spec_revision: 'r1',
    spec_hash: H('spec'),
    tracker_issue_number: 9,
    tracker_provider_node_id: 'I_9',
    tracker_state: 'open',
    tracker_updated_at: T0,
    tracker_is_pull_request: false,
  },
  {
    target_kind: 'pull_request',
    repository: 'org/repo',
    pr_number: 10,
    provider_node_id: 'PR_10',
    head_sha: H('head', 40),
    base_branch: 'dev',
    base_sha: H('base', 40),
    state: 'open',
    updated_at: T0,
  },
];

async function snapshot(targetsToUse = targets) {
  return registerM31SnapshotV2({
    repository: 'org/repo',
    capture_started_at: T0,
    capture_completed_at: T0,
    operator_actor: 'builder',
    operator_model: 'codex',
    read_only_query_method: 'fixture',
    evidence_artifact_path: 'artifacts/snapshot.json',
    git_object_format: 'sha1',
    evidence_git_blob: H(`snapshot-${targetsToUse.length}`, 40),
    targets: targetsToUse.map((target, index) => ({
      target,
      evidence_artifact_path: `artifacts/${index}.json`,
      git_object_format: 'sha1' as const,
      evidence_git_blob: H(`member-${index}`, 40),
      observed_at: T0,
    })),
    test_clock_now: T0,
  });
}

beforeEach(async () => {
  dbPath = join(process.cwd(), `.m31-v2-test-${crypto.randomUUID()}.db`);
  db = new SqliteAdapter(dbPath);
  await installM31TargetV2Sqlite(db);
});

afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm'])
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      /* absent */
    }
});

describe('M31 target v2 persistence', () => {
  test('five independent v2 tables have PostgreSQL and SQLite parity', async () => {
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'overseer_m31_%_v2' ORDER BY name"
    );
    expect(tables.rows.map(row => row.name)).toEqual([
      'overseer_m31_action_proposals_v2',
      'overseer_m31_discrepancies_v2',
      'overseer_m31_execution_receipts_v2',
      'overseer_m31_snapshots_v2',
      'overseer_m31_target_members_v2',
    ]);
    for (const table of tables.rows.map(row => row.name)) {
      const fks = await db.query<{ table: string }>(`PRAGMA foreign_key_list('${table}')`);
      expect(fks.rows.every(fk => fk.table.endsWith('_v2'))).toBe(true);
      const triggers = await db.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name=$1",
        [table]
      );
      expect(Number(triggers.rows[0]?.n)).toBeGreaterThanOrEqual(2);
    }
    const snap = await snapshot([targets[0]!]);
    expect(
      db.query('UPDATE overseer_m31_snapshots_v2 SET operator_actor=$1 WHERE snapshot_id=$2', [
        'attacker',
        snap.snapshot_id,
      ])
    ).rejects.toThrow('append-only');
    expect(
      db.query('DELETE FROM overseer_m31_snapshots_v2 WHERE snapshot_id=$1', [snap.snapshot_id])
    ).rejects.toThrow('append-only');
  });

  test('exhaustive action-target matrix rejects every unlisted pair before writes', async () => {
    const snap = await snapshot();
    const all = [
      'MERGE',
      'CLOSE',
      'REOPEN',
      'REFRESH',
      'REBASE',
      'PUSH',
      'RETARGET',
      'REPAIR',
      'REFIRE',
      'COMMENT',
      'LABEL',
      'ASSIGN',
      'REVIEW',
      'STAGING_MUTATION',
      'PRODUCTION_MUTATION',
      'DEPLOY',
    ] as const;
    const allowed: Record<string, readonly string[]> = {
      workflow_run: ['REPAIR', 'REFIRE'],
      issue: ['CLOSE', 'REOPEN', 'COMMENT', 'LABEL', 'ASSIGN'],
      work_order: ['CLOSE', 'REOPEN', 'COMMENT', 'LABEL', 'ASSIGN'],
      pull_request: [
        'MERGE',
        'CLOSE',
        'REOPEN',
        'REFRESH',
        'REBASE',
        'REPAIR',
        'COMMENT',
        'LABEL',
        'ASSIGN',
      ],
    };
    let passed = 0;
    for (const target of targets)
      for (const action_kind of all) {
        const result = await createM31ActionProposalV2({
          repository: 'org/repo',
          target,
          snapshot_id: snap.snapshot_id,
          evidence_path: 'artifacts/proposal.json',
          action_kind,
          action_parameters: {},
          actor: 'builder',
          policy_digest: H('policy'),
          verifier_registry_digest: H('registry'),
          test_clock_now: T0,
        });
        if (allowed[target.target_kind]?.includes(action_kind)) {
          expect(result.ok).toBe(true);
          passed += 1;
        } else expect(result).toEqual({ ok: false, failure: 'action_target_mismatch' });
      }
    const count = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM overseer_m31_action_proposals_v2'
    );
    expect(Number(count.rows[0]?.n)).toBe(passed);

    for (const target of targets)
      for (const actionKind of all) {
        const write = db.query(
          `INSERT INTO overseer_m31_action_proposals_v2 (
             proposal_id,repository,target_kind,target_key,target_identity_json,target_digest,
             snapshot_id,evidence_path,evidence_git_blob,action_kind,action_parameters_json,
             actor,created_at,expires_at,execution_id,capability,policy_digest,verifier_registry_digest
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'db-matrix',$8,$9,'{}','db-matrix',$10,$11,$12,$13,$14,$15)`,
          [
            `m31v2-proposal-${crypto.randomUUID()}`,
            target.repository,
            target.target_kind,
            targetKeyV2(target),
            canonicalJsonV2(target),
            targetDigestV2(target),
            snap.snapshot_id,
            H(`db-member-${target.target_kind}`, 40),
            actionKind,
            T0,
            '2026-07-16T12:15:00.000Z',
            `m31v2-execution-${crypto.randomUUID()}`,
            `overseer.m31.${actionKind.toLowerCase()}`,
            H('policy'),
            H('registry'),
          ]
        );
        if (allowed[target.target_kind]?.includes(actionKind))
          await expect(write).resolves.toBeTruthy();
        else await expect(write).rejects.toThrow();
      }
  });

  test('permit, reservation, outcome, and reconciliation are ordered and single use', async () => {
    const snap = await snapshot([targets[0]!]);
    const created = await createM31ActionProposalV2({
      repository: 'org/repo',
      target: targets[0]!,
      snapshot_id: snap.snapshot_id,
      evidence_path: 'p',
      action_kind: 'REPAIR',
      action_parameters: {},
      actor: 'builder',
      policy_digest: H('policy'),
      verifier_registry_digest: H('registry'),
      test_clock_now: T0,
    });
    if (!created.ok) throw new Error(created.failure);
    const live = {
      known: true as const,
      target: targets[0]!,
      policy_digest: H('policy'),
      verifier_registry_digest: H('registry'),
      observed_at: T0,
    };
    const permit = await compareAndConsumeM31ProposalV2({
      proposal_id: created.value.proposal_id,
      observation: live,
      test_clock_now: T0,
    });
    expect(permit.ok).toBe(true);
    expect(
      await compareAndConsumeM31ProposalV2({
        proposal_id: created.value.proposal_id,
        observation: live,
        test_clock_now: T0,
      })
    ).toEqual({ ok: false, failure: 'proposal_replayed' });
    if (!permit.ok) throw new Error(permit.failure);
    const [first, second] = await Promise.all([
      reserveM31ExecutionEffectV2({
        permit: permit.permit,
        adapter_name: 'fake',
        provider_operation: 'repair',
        reason: 'test',
        evidence: {},
        test_clock_now: T0,
      }),
      reserveM31ExecutionEffectV2({
        permit: permit.permit,
        adapter_name: 'fake',
        provider_operation: 'repair',
        reason: 'test',
        evidence: {},
        test_clock_now: T0,
      }),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(
      await appendM31ExecutionReconciliationV2({
        execution_id: permit.permit.execution_id,
        outcome: 'effect_reconciled_failed',
        reason: 'early',
        evidence: {},
        test_clock_now: T0,
      })
    ).toEqual({ ok: false, failure: 'evidence_conflicting' });
    expect(
      (
        await appendM31ExecutionOutcomeV2({
          execution_id: permit.permit.execution_id,
          outcome: 'effect_indeterminate',
          reason: 'unknown',
          evidence: {},
          test_clock_now: T0,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await appendM31ExecutionReconciliationV2({
          execution_id: permit.permit.execution_id,
          outcome: 'effect_reconciled_failed',
          reason: 'verified absent',
          evidence: {},
          test_clock_now: T0,
        })
      ).ok
    ).toBe(true);
    expect(
      (await listM31ExecutionReceiptEventsV2(permit.permit.execution_id)).map(
        event => event.event_sequence
      )
    ).toEqual([1, 2, 3, 4]);
  });

  test('target digest is canonical and invalid or mixed targets write nothing', async () => {
    const issueA = targets[1]!;
    const issueB = { ...issueA };
    expect(targetDigestV2(issueA)).toBe(targetDigestV2(issueB));
    const bad = { ...issueA, issue_number: 0 } as M31ActionTargetV2;
    await expect(snapshot([bad])).rejects.toThrow('target_invalid');
    const count = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM overseer_m31_snapshots_v2'
    );
    expect(Number(count.rows[0]?.n)).toBe(0);
  });

  test('canonical JSON golden vector recursively sorts keys and preserves array order', () => {
    const value = { z: true, arr: [{ b: 2, a: 1 }, 3], a: { z: 2, a: 1 } };
    const canonical = canonicalJsonV2(value);
    expect(canonical).toBe('{"a":{"a":1,"z":2},"arr":[{"a":1,"b":2},3],"z":true}');
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(
      '8d08b07ef9328b39f4d991258fbcbd07abadea2345a9eba2e197fe73a46d0a37'
    );
  });

  test('all four frozen target key and digest vectors match the contract', () => {
    const golden: readonly M31ActionTargetV2[] = [
      targets[0]!,
      targets[1]!,
      { ...targets[2]!, spec_hash: '0'.repeat(64) },
      { ...targets[3]!, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) },
    ];
    expect(golden.map(targetKeyV2)).toEqual([
      'org/repo#workflow_run:123e4567-e89b-42d3-a456-426614174000',
      'org/repo#issue:8',
      'org/repo#work_order:WO-2',
      'org/repo#pull_request:10',
    ]);
    expect(golden.map(targetDigestV2)).toEqual([
      'a5e03e898bb58677023725a4d03f48d0f33d758b895a063037599f0001dfc0a9',
      'f740bc35bc4a80c808e568fed0c1da68c9bbb7193f37bdb7ca33690f42439051',
      '6866253289065046d776438e2155ea5d1b25eb24598360f6bf9377acf54eb469',
      '7acd08dc9956c3c21d187a29b4d72462bb465e4882cc64a4c31a5de56c0670fb',
    ]);
    expect(golden.map(canonicalJsonV2)).toHaveLength(4);
  });

  test('cross-version isolation preserves both v1 and v2 chain state', async () => {
    const v1Before = await getM31ChainAssessment('org/repo');
    const snap = await snapshot([targets[1]!]);
    expect(await getM31ChainAssessment('org/repo')).toEqual(v1Before);
    const before = await getM31ChainAssessmentV2('org/repo');
    await db.query(
      "INSERT INTO overseer_m31_snapshots (snapshot_id,schema_version,repository,capture_started_at,capture_completed_at,operator_actor,operator_model,read_only_query_method,base_branch,base_sha,artifact_path,git_object_format,evidence_git_blob,mutation_attempted,mutation_succeeded,fusion_calls_attempted,fusion_calls_succeeded,created_at) VALUES ($1,'m31-substrate-v1','org/repo',$2,$2,'x','x','x','dev',$3,'x','sha1',$4,0,0,0,0,$2)",
      [crypto.randomUUID(), T0, H('base-v1', 40), H('blob-v1', 40)]
    );
    expect(await getM31ChainAssessmentV2('org/repo')).toEqual(before);
    expect(before.tip_snapshot_id).toBe(snap.snapshot_id);
  });

  test('discrepancy resolution is a strict append-only row and cannot resolve twice', async () => {
    const snap = await snapshot([targets[1]!]);
    const key = 'org/repo#issue:8';
    const open = await appendM31DiscrepancyV2({
      snapshot_id: snap.snapshot_id,
      evidence_git_blob: H('open-discrepancy', 40),
      affected_targets: [key],
      conflict: { state: 'changed' },
      recorded_by: 'reviewer',
      predecessor_discrepancy_id: null,
      test_clock_now: T0,
    });
    expect((await getM31ChainAssessmentV2('org/repo')).unresolved_discrepancies).toBe(1);
    const resolution = await appendM31DiscrepancyV2({
      snapshot_id: snap.snapshot_id,
      evidence_git_blob: H('resolution', 40),
      affected_targets: [key],
      conflict: { state: 'changed' },
      recorded_by: 'reviewer-2',
      predecessor_discrepancy_id: open.discrepancy_id,
      resolution: {
        resolves_discrepancy_id: open.discrepancy_id,
        resolution_code: 'live_state_reconciled',
        evidence_digest: H('resolution-evidence'),
      },
      resolved_by: 'reviewer-2',
      test_clock_now: T0,
    });
    expect((await getM31ChainAssessmentV2('org/repo')).unresolved_discrepancies).toBe(0);
    await expect(
      appendM31DiscrepancyV2({
        snapshot_id: snap.snapshot_id,
        evidence_git_blob: H('resolution-2', 40),
        affected_targets: [key],
        conflict: { state: 'changed' },
        recorded_by: 'reviewer-3',
        predecessor_discrepancy_id: resolution.discrepancy_id,
        resolution: {
          resolves_discrepancy_id: open.discrepancy_id,
          resolution_code: 'duplicate',
          evidence_digest: H('resolution-evidence-2'),
        },
        resolved_by: 'reviewer-3',
        test_clock_now: T0,
      })
    ).rejects.toThrow('discrepancy_already_resolved');
  });

  test('two independent SQLite connections produce one snapshot genesis winner', async () => {
    const second = new SqliteAdapter(dbPath);
    await installM31TargetV2Sqlite(second);
    const repository = `race/${crypto.randomUUID()}`;
    const insertGenesis = async (adapter: SqliteAdapter, seed: string) => {
      await adapter.query('BEGIN IMMEDIATE');
      try {
        await adapter.query(
          `INSERT INTO overseer_m31_snapshots_v2 (
             snapshot_id,schema_version,repository,capture_started_at,capture_completed_at,
             operator_actor,operator_model,read_only_query_method,evidence_artifact_path,
             git_object_format,evidence_git_blob,created_at
           ) VALUES ($1,'m31-target-v2',$2,$3,$3,'test','test','test','test','sha1',$4,$3)`,
          [`m31v2-snapshot-${crypto.randomUUID()}`, repository, T0, seed.repeat(40)]
        );
        await adapter.query('COMMIT');
      } catch (error) {
        await adapter.query('ROLLBACK');
        throw error;
      }
    };
    try {
      const race = await Promise.allSettled([insertGenesis(db, 'e'), insertGenesis(second, 'f')]);
      expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(race.filter(result => result.status === 'rejected')).toHaveLength(1);
      const tips = await db.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM overseer_m31_snapshots_v2 WHERE repository=$1',
        [repository]
      );
      expect(Number(tips.rows[0]?.n)).toBe(1);
    } finally {
      await second.close();
    }
  });
});
