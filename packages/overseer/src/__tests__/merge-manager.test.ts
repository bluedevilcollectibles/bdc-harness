import { describe, expect, mock, test } from 'bun:test';
import {
  createMergeManager,
  parseBaseEffectOverrides,
  resolveMergeManagerMode,
  DEFAULT_MERGE_MANAGER_MODE,
} from '../merge-manager.ts';
import type { QualifiedMergeEvidence } from '../actions/merge-ready.ts';
import type { GrokDispositionReceipt, WatchedRunRecord } from '../types.ts';

const RUN_HEAD_SHA = 'a'.repeat(40);

const record: WatchedRunRecord = {
  runId: 'run-merge-manager-1',
  woId: 'WO-MERGE-MANAGER-01',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  status: 'failed',
  action: 'merge_ready',
  reason: 'green PR',
  errorClass: 'tail_node_false_fail',
  // Engine-written worktree path -- required for merge provenance.
  workingPath: '/archon/worktrees/run-merge-manager-1',
  prEvidence: {
    exists: true,
    state: 'open',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42 },
    prTitle: 'Ready to merge',
    filesChangedCount: 1,
    diffStat: '+1 -0',
    headSha: RUN_HEAD_SHA,
  },
};

/** Stand-in for git: the run's worktree tip matches the PR head. */
const readWorktreeHeadSha = async (): Promise<string | null> => RUN_HEAD_SHA;

function evidence(overrides: Partial<QualifiedMergeEvidence> = {}): QualifiedMergeEvidence {
  return {
    record,
    registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
    owner: record.owner,
    repository: record.repo,
    base_branch: 'dev',
    resulting_deployment_effect: 'staging',
    credential_principal: 'overseer-merge-manager-v1',
    action_kind: 'MERGE',
    changed_files: ['src/index.ts'],
    pr_number: 42,
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    required_checks: [{ name: 'ci', conclusion: 'success', head_sha: 'a'.repeat(40) }],
    reviews: [{ resolved: true }],
    independent_review: null,
    operator: {
      identity: 'overseer-merge-manager-v1',
      provider: 'overseer',
      model_family: 'merge-manager',
    },
    manifest: null,
    proposal_id: null,
    proposal_present: false,
    fusion: null,
    expected_verifier_registry_digest: '',
    final_state_consistent: true,
    ...overrides,
  };
}

function approveReceipt(
  input: Parameters<NonNullable<Parameters<typeof createMergeManager>[0]['judge']>>[0]
): GrokDispositionReceipt {
  return {
    schemaVersion: 'overseer-grok-merge-disposition-v1',
    disposition: 'approve',
    reason: 'judge_approve',
    woId: input.woId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    evidenceDigest: input.evidenceDigest,
    operator: input.operator,
  };
}

describe('merge manager mode resolution', () => {
  test('unset / empty / unknown values fail closed to hold-canary', () => {
    expect(resolveMergeManagerMode(undefined)).toBe(DEFAULT_MERGE_MANAGER_MODE);
    expect(resolveMergeManagerMode('')).toBe('hold-canary');
    expect(resolveMergeManagerMode('   ')).toBe('hold-canary');
    expect(resolveMergeManagerMode('soft-merge')).toBe('hold-canary');
    expect(resolveMergeManagerMode('not-a-mode')).toBe('hold-canary');
  });

  test('accepts hold-canary, comment_findings, execute and hyphen alias', () => {
    expect(resolveMergeManagerMode('hold-canary')).toBe('hold-canary');
    expect(resolveMergeManagerMode('hold_canary')).toBe('hold-canary');
    expect(resolveMergeManagerMode('comment_findings')).toBe('comment_findings');
    expect(resolveMergeManagerMode('comment-findings')).toBe('comment_findings');
    expect(resolveMergeManagerMode('execute')).toBe('execute');
    expect(resolveMergeManagerMode('EXECUTE')).toBe('execute');
  });
});

describe('merge manager', () => {
  test('staging and dev-effect merge candidates are judged, executed, and recorded', async () => {
    const assembled = evidence({ resulting_deployment_effect: 'none' });
    const insertOverseerAction = mock(async () => undefined);
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true, message: 'fake_merge_accepted' }));
    const mergePullRequest = mock(async () => ({ merged: false }));
    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-review-gate[bot]',
      listPullRequestReviews: async () => [
        { login: 'thinman-review-gate[bot]', state: 'APPROVED', commitId: RUN_HEAD_SHA },
      ],
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: 'c'.repeat(64) }),
      judge,
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      readWorktreeHeadSha,
    });

    const result = await manager(record);

    expect(result.status).toBe('executed');
    expect(judge).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(assembled);
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merged',
        result: expect.stringContaining('fake_merge_accepted'),
      })
    );
  });

  test('hold-canary + judge approve logs would_comment/would_merge and never merges', async () => {
    const assembled = evidence({ resulting_deployment_effect: 'none' });
    const digest = 'c'.repeat(64);
    const insertOverseerAction = mock(async () => undefined);
    const execute = mock(async () => ({ merged: true, message: 'should_not_run' }));
    const mergePullRequest = mock(async () => ({ merged: true }));
    const commentOnPullRequest = mock(async () => ({ commented: true }));
    const manager = createMergeManager({
      mode: 'hold-canary',
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: digest }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      commentOnPullRequest,
      readWorktreeHeadSha,
    });

    const result = await manager(record);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'hold_canary',
      execution: null,
      mode: 'hold-canary',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(commentOnPullRequest).not.toHaveBeenCalled();

    const actions = insertOverseerAction.mock.calls.map(
      call => call[0] as { action: string; result: string }
    );
    expect(actions.some(a => a.action === 'would_comment')).toBe(true);
    expect(actions.some(a => a.action === 'would_merge')).toBe(true);
    const wouldMerge = actions.find(a => a.action === 'would_merge');
    expect(wouldMerge?.result).toContain(record.runId);
    expect(wouldMerge?.result).toContain(record.woId);
    expect(wouldMerge?.result).toContain(String(assembled.pr_number));
    expect(wouldMerge?.result).toContain(assembled.head_sha);
    expect(wouldMerge?.result).toContain(digest);
    expect(wouldMerge?.result).toContain('hold_canary');
  });

  test('default mode is hold-canary so approve never merges without explicit execute', async () => {
    const insertOverseerAction = mock(async () => undefined);
    const execute = mock(async () => ({ merged: true }));
    const mergePullRequest = mock(async () => ({ merged: true }));
    const manager = createMergeManager({
      assembleEvidence: async () => ({
        evidence: evidence({ resulting_deployment_effect: 'none' }),
        evidenceDigest: 'c'.repeat(64),
      }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      readWorktreeHeadSha,
    });

    const result = await manager(record);

    expect(result.status).toBe('held');
    expect(result.reason).toBe('hold_canary');
    expect(execute).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  test('comment_findings + judge approve posts one comment and never merges', async () => {
    const assembled = evidence({ resulting_deployment_effect: 'none' });
    const digest = 'f'.repeat(64);
    const insertOverseerAction = mock(async () => undefined);
    const execute = mock(async () => ({ merged: true }));
    const mergePullRequest = mock(async () => ({ merged: true }));
    const commentOnPullRequest = mock(async () => ({
      commented: true,
      url: 'https://example.test/comment/1',
    }));
    const manager = createMergeManager({
      mode: 'comment_findings',
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: digest }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      commentOnPullRequest,
      readWorktreeHeadSha,
    });

    const result = await manager(record);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'comment_findings_merge_hard_off',
      execution: null,
      mode: 'comment_findings',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
    const commentInput = commentOnPullRequest.mock.calls[0]?.[0] as {
      owner: string;
      repo: string;
      number: number;
      body: string;
    };
    expect(commentInput.owner).toBe(assembled.owner);
    expect(commentInput.repo).toBe(assembled.repository);
    expect(commentInput.number).toBe(assembled.pr_number);
    expect(commentInput.body).toContain(`runId=${record.runId}`);
    expect(commentInput.body).toContain(`woId=${record.woId}`);
    expect(commentInput.body).toContain(`headSha=${assembled.head_sha}`);
    expect(commentInput.body).toContain('mode=comment_findings');
    expect(commentInput.body).toContain('merge=hard_off');
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'comment_findings' })
    );
  });

  test('comment_findings without comment channel records unavailable and never merges', async () => {
    const insertOverseerAction = mock(async () => undefined);
    const execute = mock(async () => ({ merged: true }));
    const mergePullRequest = mock(async () => ({ merged: true }));
    const manager = createMergeManager({
      mode: 'comment_findings',
      assembleEvidence: async () => ({
        evidence: evidence({ resulting_deployment_effect: 'none' }),
        evidenceDigest: 'd'.repeat(64),
      }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      readWorktreeHeadSha,
    });

    const result = await manager(record);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'comment_channel_unavailable',
      execution: null,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'comment_channel_unavailable' })
    );
  });

  test('unknown mode fails closed to hold-canary and never merges', async () => {
    const execute = mock(async () => ({ merged: true }));
    const mergePullRequest = mock(async () => ({ merged: true }));
    const commentOnPullRequest = mock(async () => ({ commented: true }));
    const insertOverseerAction = mock(async () => undefined);
    const manager = createMergeManager({
      mode: 'soft-merge-please',
      assembleEvidence: async () => ({
        evidence: evidence({ resulting_deployment_effect: 'none' }),
        evidenceDigest: 'e'.repeat(64),
      }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      commentOnPullRequest,
      readWorktreeHeadSha,
    });

    const result = await manager(record);

    expect(result).toMatchObject({ status: 'held', reason: 'hold_canary', mode: 'hold-canary' });
    expect(execute).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(commentOnPullRequest).not.toHaveBeenCalled();
  });

  test('production-effect merge candidates are held for John and never executed', async () => {
    const insertOverseerAction = mock(async () => undefined);
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true }));
    const commentOnPullRequest = mock(async () => ({ commented: true }));
    const manager = createMergeManager({
      mode: 'comment_findings',
      assembleEvidence: async () => ({
        evidence: evidence({ resulting_deployment_effect: 'production' }),
        evidenceDigest: 'd'.repeat(64),
      }),
      judge,
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      commentOnPullRequest,
      readWorktreeHeadSha,
    });

    const result = await manager(record);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'production_effect_held_for_john',
      execution: null,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(commentOnPullRequest).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merge_denied',
        result: 'production_effect_held_for_john',
      })
    );
  });

  test('default evidence assembly holds feature branches targeting production for John', async () => {
    const productionTargetRecord: WatchedRunRecord = {
      ...record,
      headBranch: 'archon/thread-x',
      metadata: {
        base_branch: 'main',
        head_sha: 'f'.repeat(40),
        base_sha: '1'.repeat(40),
        changed_files: 'packages/overseer/src/merge-manager.ts',
      },
    };
    const insertOverseerAction = mock(async () => undefined);
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true }));
    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-review-gate[bot]',
      listPullRequestReviews: async () => [
        { login: 'thinman-review-gate[bot]', state: 'APPROVED', commitId: RUN_HEAD_SHA },
      ],
      judge,
      execute,
      insertOverseerAction,
      findPullRequest: async () => productionTargetRecord.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha,
    });

    const result = await manager(productionTargetRecord);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'production_effect_held_for_john',
      execution: null,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merge_denied',
        result: 'production_effect_held_for_john',
      })
    );
  });

  test('a merge candidate from another repo is not denied for registry scope', async () => {
    const otherRecord = {
      ...record,
      repo: 'bdc-public-site',
      prEvidence: {
        ...record.prEvidence,
        pr: { owner: 'thinmansoftware', repo: 'bdc-public-site', number: 77 },
      },
    };
    const insertOverseerAction = mock(async () => undefined);
    const execute = mock(async () => ({ merged: true, message: 'other_repo_merged' }));
    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-review-gate[bot]',
      listPullRequestReviews: async () => [
        { login: 'thinman-review-gate[bot]', state: 'APPROVED', commitId: RUN_HEAD_SHA },
      ],
      assembleEvidence: async () => ({
        evidence: evidence({
          record: otherRecord,
          repository: 'bdc-public-site',
          pr_number: 77,
          resulting_deployment_effect: 'staging',
        }),
        evidenceDigest: 'e'.repeat(64),
      }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => otherRecord.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha,
    });

    const result = await manager(otherRecord);

    expect(result.status).toBe('executed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merged',
        result: expect.stringContaining('other_repo_merged'),
      })
    );
  });

  describe('mutation activation preconditions', () => {
    function activatedManager(
      options: {
        assembled?: QualifiedMergeEvidence;
        reviews?: { login: string; state: string; commitId: string }[];
        mutationsEnabled?: boolean;
      } = {}
    ) {
      const assembled = options.assembled ?? evidence({ resulting_deployment_effect: 'none' });
      const insertOverseerAction = mock(async () => undefined);
      const mergePullRequest = mock(async () => ({
        merged: true,
        message: 'github_merge_accepted',
        sha: 'd'.repeat(40),
      }));
      const manager = createMergeManager({
        mode: 'execute',
        mutationsEnabled: options.mutationsEnabled ?? true,
        allowedBases: ['dev', 'staging'],
        reviewGateLogin: 'thinman-review-gate[bot]',
        assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: '9'.repeat(64) }),
        judge: async input => approveReceipt(input),
        insertOverseerAction,
        findPullRequest: async () => record.prEvidence,
        mergePullRequest,
        listPullRequestReviews: async () =>
          options.reviews ?? [
            { login: 'thinman-review-gate[bot]', state: 'APPROVED', commitId: RUN_HEAD_SHA },
          ],
        readWorktreeHeadSha,
      });
      return { manager, mergePullRequest, insertOverseerAction };
    }

    test('merges once and truthfully journals mutation and merged SHA', async () => {
      const { manager, mergePullRequest, insertOverseerAction } = activatedManager();
      const result = await manager(record);

      expect(result.status).toBe('executed');
      expect(mergePullRequest).toHaveBeenCalledTimes(1);
      const mergedAction = insertOverseerAction.mock.calls.find(
        call => call[0].action === 'merged'
      );
      expect(mergedAction).toBeDefined();
      expect(JSON.parse(mergedAction![0].result)).toMatchObject({
        mutation_sent: true,
        merged_sha: 'd'.repeat(40),
      });
    });

    test('denies when Review Gate approval is absent', async () => {
      const { manager, mergePullRequest, insertOverseerAction } = activatedManager({ reviews: [] });
      const result = await manager(record);

      expect(result).toMatchObject({
        status: 'held',
        reason: 'review_gate_approval_missing_for_head',
      });
      expect(mergePullRequest).not.toHaveBeenCalled();
      expect(insertOverseerAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'merge_denied',
          result: expect.stringContaining('review_gate_approval_missing_for_head'),
        })
      );
    });

    test('denies a stale approval bound to an older head SHA', async () => {
      const { manager, mergePullRequest } = activatedManager({
        reviews: [
          { login: 'thinman-review-gate[bot]', state: 'APPROVED', commitId: '0'.repeat(40) },
        ],
      });
      const result = await manager(record);

      expect(result).toMatchObject({
        status: 'held',
        reason: 'review_gate_approval_missing_for_head',
      });
      expect(mergePullRequest).not.toHaveBeenCalled();
    });

    test('denies production base even when checks and approval are green', async () => {
      const { manager, mergePullRequest } = activatedManager({
        assembled: evidence({ base_branch: 'master', resulting_deployment_effect: 'none' }),
      });
      const result = await manager(record);

      expect(result).toMatchObject({ status: 'held', reason: 'base_branch_not_allowed' });
      expect(mergePullRequest).not.toHaveBeenCalled();
    });

    test('flag off preserves verdict-only behavior without a mutation', async () => {
      const { manager, mergePullRequest, insertOverseerAction } = activatedManager({
        mutationsEnabled: false,
      });
      const result = await manager(record);

      expect(result).toMatchObject({ status: 'held', reason: 'mutations_disabled' });
      expect(mergePullRequest).not.toHaveBeenCalled();
      expect(insertOverseerAction).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'merged' })
      );
    });
  });

  test('provenance hold short-circuits before comment/merge in all modes', async () => {
    const execute = mock(async () => ({ merged: true }));
    const mergePullRequest = mock(async () => ({ merged: true }));
    const commentOnPullRequest = mock(async () => ({ commented: true }));
    const insertOverseerAction = mock(async () => undefined);
    const manager = createMergeManager({
      mode: 'comment_findings',
      assembleEvidence: async () => ({
        evidence: evidence({ resulting_deployment_effect: 'none' }),
        evidenceDigest: 'a'.repeat(64),
      }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      commentOnPullRequest,
      // Worktree tip does not match PR head -- association proof fails.
      readWorktreeHeadSha: async () => '9'.repeat(40),
    });

    const result = await manager(record);

    expect(result.status).toBe('held');
    expect(result.reason).toBe('provenance_head_sha_mismatch');
    expect(execute).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(commentOnPullRequest).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merge_denied',
        result: 'provenance_head_sha_mismatch',
      })
    );
  });
});

/**
 * PR-DISCOVERED CANDIDATES AND PROVENANCE (John, 2026-09-07).
 *
 * The ruling: "always merge on green, you do not need to ask me." A pull
 * request found by the PR-first sweep (bdc-harness#758) has NO originating
 * Cauldron run, so it has no engine-written worktree for the provenance gate to
 * bind a head SHA against. That gate could therefore only ever answer
 * `working_path_missing` for such a candidate -- holding every one of them
 * permanently and recreating, one layer down, the exact deadlock #758 was
 * written to clear.
 *
 * So an ABSENT run is now the named condition `provenance_no_run` and does not
 * hold. Everything else still gates: exact-head approval by the Review Gate
 * identity, required checks SUCCESS, CLEAN mergeable state, allowed bases, the
 * production-effect hold, and the Grok judge.
 */
describe('merge manager -- PR-discovered candidates with no originating run', () => {
  const PR_HEAD_SHA = 'd'.repeat(40);

  /** A candidate exactly as the PR-first sweep mints it: no run, no worktree. */
  const discoveredRecord: WatchedRunRecord = {
    runId: 'pr-discovery:thinmansoftware/bdc-harness#730',
    woId: 'gh:thinmansoftware/bdc-harness#730',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: 'pr_discovered',
    headBranch: 'test/reviewer-live-fire',
    // No workingPath: there is no run, so there is no engine-written worktree.
    metadata: {
      discovery_source: 'pr_first_sweep',
      base_branch: 'dev',
      head_sha: PR_HEAD_SHA,
      pr_number: '730',
    },
    action: 'merge_ready',
    reason: 'discovered by PR-first sweep',
    prEvidence: {
      exists: true,
      state: 'open',
      checks: { total: 3, passed: 3, failed: 0, pending: 0 },
      mergeable: true,
      pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 730 },
      prTitle: 'test: reviewer live-fire',
      filesChangedCount: 1,
      diffStat: '+1 -0',
      headSha: PR_HEAD_SHA,
    },
  };

  function discoveredEvidence(
    overrides: Partial<QualifiedMergeEvidence> = {}
  ): QualifiedMergeEvidence {
    return {
      ...evidence(),
      record: discoveredRecord,
      base_branch: 'dev',
      resulting_deployment_effect: 'none',
      pr_number: 730,
      head_sha: PR_HEAD_SHA,
      required_checks: [{ name: 'ci', conclusion: 'success', head_sha: PR_HEAD_SHA }],
      ...overrides,
    };
  }

  /** Reading a worktree must never even be attempted for a record with no run. */
  const worktreeMustNotBeRead = async (): Promise<string | null> => {
    throw new Error('provenance must not read a worktree for a PR-discovered candidate');
  };

  test('an approved, green, clean PR with no run MERGES on dev and logs provenance_no_run', async () => {
    const assembled = discoveredEvidence();
    const insertOverseerAction = mock(async () => undefined);
    const execute = mock(async () => ({ merged: true, message: 'fake_merge_accepted' }));

    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-overseer[bot]',
      // Exact-head approval by the Review Gate identity -- still required.
      listPullRequestReviews: async () => [
        { login: 'thinman-overseer[bot]', state: 'APPROVED', commitId: PR_HEAD_SHA },
      ],
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: 'e'.repeat(64) }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => discoveredRecord.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha: worktreeMustNotBeRead,
    });

    const result = await manager(discoveredRecord);

    // THE RULING: no run does not hold the merge.
    expect(result.status).toBe('executed');
    expect(execute).toHaveBeenCalledWith(assembled);

    // ...and the relaxation is NAMED and RECORDED, never silent.
    const actions = insertOverseerAction.mock.calls.map(
      call => (call[0] as { action: string }).action
    );
    expect(actions).toContain('provenance_no_run');
    expect(actions).toContain('merged');
  });

  // The same PR against master is refused BEFORE provenance is ever consulted:
  // a main/master base is a production effect and holds for John.
  test('the same PR against master is still refused on the production hold', async () => {
    const assembled = discoveredEvidence({
      base_branch: 'master',
      resulting_deployment_effect: 'production',
    });
    const insertOverseerAction = mock(async () => undefined);
    const execute = mock(async () => ({ merged: true, message: 'should_not_run' }));

    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-overseer[bot]',
      listPullRequestReviews: async () => [
        { login: 'thinman-overseer[bot]', state: 'APPROVED', commitId: PR_HEAD_SHA },
      ],
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: 'e'.repeat(64) }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => discoveredRecord.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha: worktreeMustNotBeRead,
    });

    const result = await manager({
      ...discoveredRecord,
      metadata: { ...discoveredRecord.metadata, base_branch: 'master' },
    });

    expect(result.status).toBe('held');
    expect(result.reason).toBe('production_effect_held_for_john');
    expect(execute).not.toHaveBeenCalled();
  });

  // A non-production base that is nonetheless outside the allowed list is
  // refused at the precondition gate. Discovery relaxed provenance only.
  test('a base outside MERGE_MANAGER_ALLOWED_BASES is still refused', async () => {
    const assembled = discoveredEvidence({ base_branch: 'sandbox' });
    const execute = mock(async () => ({ merged: true, message: 'should_not_run' }));

    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-overseer[bot]',
      listPullRequestReviews: async () => [
        { login: 'thinman-overseer[bot]', state: 'APPROVED', commitId: PR_HEAD_SHA },
      ],
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: 'e'.repeat(64) }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction: async () => undefined,
      findPullRequest: async () => discoveredRecord.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha: worktreeMustNotBeRead,
    });

    const result = await manager(discoveredRecord);

    expect(result.status).toBe('held');
    expect(result.reason).toBe('base_branch_not_allowed');
    expect(execute).not.toHaveBeenCalled();
  });

  // The Review Gate is untouched: no exact-head approval from the gate identity
  // still refuses, run or no run.
  test('a PR with no Review Gate approval on the head is still refused', async () => {
    const assembled = discoveredEvidence();
    const execute = mock(async () => ({ merged: true, message: 'should_not_run' }));

    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-overseer[bot]',
      // Approved -- but on a SUPERSEDED commit.
      listPullRequestReviews: async () => [
        { login: 'thinman-overseer[bot]', state: 'APPROVED', commitId: 'f'.repeat(40) },
      ],
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: 'e'.repeat(64) }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction: async () => undefined,
      findPullRequest: async () => discoveredRecord.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha: worktreeMustNotBeRead,
    });

    const result = await manager(discoveredRecord);

    expect(result.status).toBe('held');
    expect(result.reason).toBe('review_gate_approval_missing_for_head');
    expect(execute).not.toHaveBeenCalled();
  });

  // THE LINE THAT MUST NOT MOVE. A REAL run whose worktree was swept still
  // fails closed: it HAS a run, so "which commit did that run produce" is a
  // real question we merely could not answer. Only a genuinely run-less
  // candidate takes the relaxed path.
  test('a real run with a missing worktree still holds -- the relaxation is not a bypass', async () => {
    const assembled = evidence({ resulting_deployment_effect: 'none' });
    const execute = mock(async () => ({ merged: true, message: 'should_not_run' }));

    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-overseer[bot]',
      listPullRequestReviews: async () => [
        { login: 'thinman-overseer[bot]', state: 'APPROVED', commitId: RUN_HEAD_SHA },
      ],
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: 'e'.repeat(64) }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction: async () => undefined,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      // Worktree swept.
      readWorktreeHeadSha: async () => null,
    });

    const result = await manager(record);

    expect(result.status).toBe('held');
    expect(result.reason).toBe('provenance_worktree_unavailable');
    expect(execute).not.toHaveBeenCalled();
  });

  // And a record that merely LOOKS discovered cannot claim the relaxed path:
  // both the synthetic runId prefix and the discovery metadata are required.
  test('a run-derived record cannot impersonate a discovered candidate', async () => {
    const impostor: WatchedRunRecord = {
      ...record,
      // Discovery metadata, but a REAL run id -- not a pr-discovery: one.
      metadata: { discovery_source: 'pr_first_sweep' },
      workingPath: undefined,
    };
    const assembled = evidence({ resulting_deployment_effect: 'none', record: impostor });
    const execute = mock(async () => ({ merged: true, message: 'should_not_run' }));

    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-overseer[bot]',
      listPullRequestReviews: async () => [
        { login: 'thinman-overseer[bot]', state: 'APPROVED', commitId: RUN_HEAD_SHA },
      ],
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: 'e'.repeat(64) }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction: async () => undefined,
      findPullRequest: async () => impostor.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha: async () => null,
    });

    const result = await manager(impostor);

    expect(result.status).toBe('held');
    expect(result.reason).toBe('provenance_working_path_missing');
    expect(execute).not.toHaveBeenCalled();
  });
});

/**
 * Per-repo base-effect overrides (John 2026-09-07, "yes add main", scoped by the XO to
 * repos whose main is not a production surface).
 *
 * The effect classifier reads only the branch NAME, so bdc-xo -- docs, specs, scripts --
 * had its main called production and every PR held for John forever. These tests fix the
 * boundary: the named repo is reclassified, every other production main is untouched, a
 * malformed entry changes nothing, and an override can never downgrade run metadata that
 * already declared production.
 */
describe('per-repo base effect overrides', () => {
  const BDC_XO_MAIN_NONE = parseBaseEffectOverrides('thinmansoftware/bdc-xo:main=none');

  /** A run on `repo` whose PR targets `main`, forcing default evidence assembly. */
  function mainTargetRecord(repo: string, metadata: Record<string, string> = {}): WatchedRunRecord {
    return {
      ...record,
      repo,
      headBranch: 'archon/thread-effects',
      prEvidence: {
        ...record.prEvidence,
        pr: { owner: 'thinmansoftware', repo, number: 91 },
      },
      metadata: {
        base_branch: 'main',
        head_sha: RUN_HEAD_SHA,
        base_sha: '1'.repeat(40),
        changed_files: 'docs/work-orders/WO-EXAMPLE-01.md',
        ...metadata,
      },
    };
  }

  function managerFor(
    target: WatchedRunRecord,
    overrides: ReadonlyMap<string, 'none' | 'staging' | 'production' | 'unknown'> | undefined,
    spies: {
      readonly judge: ReturnType<typeof mock>;
      readonly execute: ReturnType<typeof mock>;
      readonly insertOverseerAction: ReturnType<typeof mock>;
    }
  ): ReturnType<typeof createMergeManager> {
    return createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      // `main` is allowed as a BASE here so the test isolates the EFFECT classification;
      // allowed-bases semantics are deliberately untouched by this change.
      allowedBases: ['dev', 'staging', 'main'],
      baseEffectOverrides: overrides,
      reviewGateLogin: 'thinman-review-gate[bot]',
      listPullRequestReviews: async () => [
        { login: 'thinman-review-gate[bot]', state: 'APPROVED', commitId: RUN_HEAD_SHA },
      ],
      judge: spies.judge as never,
      execute: spies.execute as never,
      insertOverseerAction: spies.insertOverseerAction as never,
      findPullRequest: async () => target.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha,
    });
  }

  test('parses owner/repo:branch=effect and lowercases both halves of the key', () => {
    const parsed = parseBaseEffectOverrides(
      ' ThinmanSoftware/BDC-XO:Main=none , thinmansoftware/other:staging=staging '
    );
    expect(parsed.get('thinmansoftware/bdc-xo:main')).toBe('none');
    expect(parsed.get('thinmansoftware/other:staging')).toBe('staging');
    expect(parsed.size).toBe(2);
  });

  test('bdc-xo main is reclassified to none and the candidate is judged and merged', async () => {
    const target = mainTargetRecord('bdc-xo');
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true, message: 'bdc_xo_main_merged' }));
    const insertOverseerAction = mock(async () => undefined);

    const result = await managerFor(target, BDC_XO_MAIN_NONE, {
      judge,
      execute,
      insertOverseerAction,
    })(target);

    expect(result.status).toBe('executed');
    expect(judge).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(insertOverseerAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ result: 'production_effect_held_for_john' })
    );
  });

  test('lspro-react main stays production and is held when no override names it', async () => {
    const target = mainTargetRecord('lspro-react');
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true }));
    const insertOverseerAction = mock(async () => undefined);

    // The bdc-xo override is loaded; it must not leak to any other repo.
    const result = await managerFor(target, BDC_XO_MAIN_NONE, {
      judge,
      execute,
      insertOverseerAction,
    })(target);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'production_effect_held_for_john',
      execution: null,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test('a malformed entry is ignored and the branch regex still holds the repo', async () => {
    // No '=', no ':', and an effect outside the vocabulary -- none may parse.
    const parsed = parseBaseEffectOverrides(
      'thinmansoftware/bdc-xo:main,thinmansoftware-bdc-xo=none,thinmansoftware/bdc-xo:main=maybe'
    );
    expect(parsed.size).toBe(0);

    const target = mainTargetRecord('bdc-xo');
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true }));
    const insertOverseerAction = mock(async () => undefined);

    const result = await managerFor(target, parsed, {
      judge,
      execute,
      insertOverseerAction,
    })(target);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'production_effect_held_for_john',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('an override cannot downgrade a run whose metadata declares production', async () => {
    const target = mainTargetRecord('bdc-xo', { resulting_deployment_effect: 'production' });
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true }));
    const insertOverseerAction = mock(async () => undefined);

    const result = await managerFor(target, BDC_XO_MAIN_NONE, {
      judge,
      execute,
      insertOverseerAction,
    })(target);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'production_effect_held_for_john',
      execution: null,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merge_denied',
        result: 'production_effect_held_for_john',
      })
    );
  });
});
