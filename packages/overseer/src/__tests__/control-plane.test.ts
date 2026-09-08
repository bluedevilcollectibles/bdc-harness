import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { join } from 'path';
import {
  acquireRepositoryMutationLease,
  admitOverseerParent,
  assertIndependentVerifier,
  computeVerifierRegistryDigest,
  heartbeatOverseerParent,
  heartbeatRepositoryMutationLease,
  linkOverseerChild,
  listOverseerControlEvents,
  markFusionBudgetCallStarted,
  reconcileExpiredParentCommitments,
  reconcileFusionBudget,
  registerVerifierRegistry,
  releaseFusionBudgetReservation,
  releaseOverseerParent,
  releaseRepositoryMutationLease,
  reserveFusionBudget,
  transitionOverseerChildState,
  transitionOverseerParentState,
} from '@archon/core/db/overseer-control-plane';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { installOverseerControlPlaneSqlite } from '@archon/core/db/overseer-control-plane-sqlite';
import { createOverseerControlPlaneService } from '../control-plane';

let home = '';

beforeEach(async () => {
  home = join(process.cwd(), `.overseer-control-plane-service-${crypto.randomUUID()}`);
  process.env.ARCHON_HOME = home;
  delete process.env.DATABASE_URL;
  resetDatabase();
  await installOverseerControlPlaneSqlite(getDatabase());
});

afterEach(async () => {
  await closeDatabase();
  delete process.env.ARCHON_HOME;
  if (existsSync(home)) removeTempDirWithRetry(home);
});

describe('Overseer control-plane service', () => {
  test('exposes the complete frozen operation set without an effect callback', () => {
    const service = createOverseerControlPlaneService({
      admitOverseerParent,
      releaseOverseerParent,
      heartbeatOverseerParent,
      transitionOverseerParentState,
      linkOverseerChild,
      transitionOverseerChildState,
      reconcileExpiredParentCommitments,
      acquireRepositoryMutationLease,
      heartbeatRepositoryMutationLease,
      releaseRepositoryMutationLease,
      registerVerifierRegistry,
      assertIndependentVerifier,
      reserveFusionBudget,
      markFusionBudgetCallStarted,
      reconcileFusionBudget,
      releaseFusionBudgetReservation,
      listOverseerControlEvents,
    });
    expect(Object.keys(service).sort()).toEqual(
      [
        'admitOverseerParent',
        'releaseOverseerParent',
        'heartbeatOverseerParent',
        'transitionOverseerParentState',
        'linkOverseerChild',
        'transitionOverseerChildState',
        'reconcileExpiredParentCommitments',
        'acquireRepositoryMutationLease',
        'heartbeatRepositoryMutationLease',
        'releaseRepositoryMutationLease',
        'registerVerifierRegistry',
        'assertIndependentVerifier',
        'reserveFusionBudget',
        'markFusionBudgetCallStarted',
        'reconcileFusionBudget',
        'releaseFusionBudgetReservation',
        'listOverseerControlEvents',
      ].sort()
    );
    expect(Object.isFrozen(service)).toBe(true);
    expect('invokeProvider' in service).toBe(false);
    expect('activate' in service).toBe(false);
  });

  test('verifier registry canonicalization and independence fail closed', async () => {
    const service = createOverseerControlPlaneService({
      admitOverseerParent,
      releaseOverseerParent,
      heartbeatOverseerParent,
      transitionOverseerParentState,
      linkOverseerChild,
      transitionOverseerChildState,
      reconcileExpiredParentCommitments,
      acquireRepositoryMutationLease,
      heartbeatRepositoryMutationLease,
      releaseRepositoryMutationLease,
      registerVerifierRegistry,
      assertIndependentVerifier,
      reserveFusionBudget,
      markFusionBudgetCallStarted,
      reconcileFusionBudget,
      releaseFusionBudgetReservation,
      listOverseerControlEvents,
    });
    const entries = [
      {
        verifier_id: 'fable.review',
        provider: 'anthropic',
        model_family: 'claude',
        roles: ['REVIEWER'] as const,
        enabled: true,
      },
    ];
    const registryDigest = computeVerifierRegistryDigest(entries);
    const input = {
      schema_version: 'overseer-verifier-registry-v1' as const,
      registry_digest: registryDigest,
      entries,
      source_artifact_path: 'artifacts/verifier-registry.json',
      source_git_blob: 'b'.repeat(40),
    };

    expect(await service.registerVerifierRegistry(input)).toMatchObject({ ok: true });
    expect(await service.registerVerifierRegistry(input)).toMatchObject({ ok: true });
    expect(
      await service.assertIndependentVerifier({
        operator_provider: 'openai',
        operator_model_family: 'gpt',
        registry_digest: registryDigest,
        verifier_id: 'fable.review',
        required_role: 'REVIEWER',
      })
    ).toMatchObject({ ok: true, value: { allowed: true } });
    expect(
      await service.assertIndependentVerifier({
        operator_provider: 'anthropic',
        operator_model_family: 'claude',
        registry_digest: registryDigest,
        verifier_id: 'fable.review',
        required_role: 'REVIEWER',
      })
    ).toEqual({ ok: false, code: 'verifier_not_independent' });

    const events = await getDatabase().query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM overseer_control_events WHERE event_kind='REGISTRY_FROZEN'"
    );
    expect(Number(events.rows[0]?.n)).toBe(1);
  });
});
