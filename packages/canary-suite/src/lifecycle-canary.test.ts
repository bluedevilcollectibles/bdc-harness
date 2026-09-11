import { describe, expect, test } from 'bun:test';
import {
  checkInvariantDiffScope,
  checkLeg1TaskmasterFires,
  checkLeg2CodexLaneOpensPr,
  checkLeg3OverseerCatchesDefect,
  checkLeg4RemediationReachesPr,
  checkLeg5OverseerReapproves,
  checkLeg6AutonomousMerge,
  checkLeg7ReconcileClosesIssue,
  checkLeg8DispatchReadableReply,
  checkLeg9DutyOfficerReports,
  checkLeg10CanaryReverts,
  runLifecycleCanarySuite,
  isValidLifecycleRunId,
  createDefaultArtifactSource,
  type LegPollConfig,
  type LifecycleArtifactSource,
  type LifecycleClock,
  type LifecycleFireResult,
} from './lifecycle-canary';
import { writeLifecycleCanaryArtifacts } from './lifecycle-report';
import type { LifecycleCanaryReport } from './types';
import { rm, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

function fakeClock(startMs = 0): LifecycleClock {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function poll(): LegPollConfig {
  return { clock: fakeClock(), timeoutMs: 1_000, intervalMs: 100 };
}

const RUN_START = '2026-09-02T00:00:00.000Z';

// A source that throws on every method; tests override only what they exercise.
function stubSource(overrides: Partial<LifecycleArtifactSource>): LifecycleArtifactSource {
  const reject = (name: string) => async () => {
    throw new Error(`unexpected call to ${name}`);
  };
  return {
    queryTmJournalFireCauldron: reject('queryTmJournalFireCauldron'),
    listPrsForBranch: reject('listPrsForBranch'),
    viewPr: reject('viewPr'),
    listPrReviews: reject('listPrReviews'),
    countDiffMatches: reject('countDiffMatches'),
    queryRunReview: reject('queryRunReview'),
    mergedActorLogin: reject('mergedActorLogin'),
    viewIssue: reject('viewIssue'),
    dispatchResultBody: reject('dispatchResultBody'),
    readDutyOfficerReport: reject('readDutyOfficerReport'),
    scratchResidueDiff: reject('scratchResidueDiff'),
    countRevertCommits: reject('countRevertCommits'),
    listPrChangedFiles: reject('listPrChangedFiles'),
    getPrHead: reject('getPrHead'),
    ...overrides,
  } as LifecycleArtifactSource;
}

describe('Leg 1 -- Taskmaster fires', () => {
  test('passes when a fire_cauldron row exists', async () => {
    const source = {
      queryTmJournalFireCauldron: async () => [
        {
          id: 1,
          proposal_type: 'fire_cauldron',
          target: 'bdc-harness#4321',
          created_at: RUN_START,
        },
      ],
    };
    const report = await checkLeg1TaskmasterFires({
      source,
      sinceIso: RUN_START,
      targetIssue: 4321,
      fallbackUsed: false,
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
    expect(report.evidenceRefs).toContain('tm_journal.target=bdc-harness#4321');
  });

  test('blocks with fallback gap when Taskmaster never fires', async () => {
    const report = await checkLeg1TaskmasterFires({
      source: { queryTmJournalFireCauldron: async () => [] },
      sinceIso: RUN_START,
      fallbackUsed: true,
      poll: poll(),
    });
    expect(report.verdict).toBe('blocked');
    expect(report.reasonCodes).toContain('taskmaster_never_fires');
    expect(report.gap).toBe('taskmaster-never-fired, fallback: fire.ps1 used');
  });
});

describe('Leg 2 -- codex lane opens PR', () => {
  test('passes and returns the PR number for exactly one PR on base', async () => {
    const result = await checkLeg2CodexLaneOpensPr({
      source: {
        listPrsForBranch: async () => [
          { number: 991, headRefName: 'canary/lifecycle-x', baseRefName: 'dev', state: 'OPEN' },
        ],
      },
      headBranch: 'canary/lifecycle-x',
      baseBranch: 'dev',
      poll: poll(),
    });
    expect(result.report.verdict).toBe('passed');
    expect(result.prNumber).toBe(991);
  });

  test('fails with codex_lane_no_pr when no PR is opened', async () => {
    const result = await checkLeg2CodexLaneOpensPr({
      source: { listPrsForBranch: async () => [] },
      headBranch: 'canary/lifecycle-x',
      baseBranch: 'dev',
      poll: poll(),
    });
    expect(result.report.verdict).toBe('failed');
    expect(result.report.reasonCodes).toContain('codex_lane_no_pr');
    expect(result.prNumber).toBeUndefined();
  });
});

describe('Leg 3 -- Overseer catches the planted defect', () => {
  test('passes when a CHANGES_REQUESTED review names the defect literal', async () => {
    const report = await checkLeg3OverseerCatchesDefect({
      source: {
        listPrReviews: async () => [
          {
            state: 'CHANGES_REQUESTED',
            body: 'canary-marker.ts:1 uses WRONG_VALUE instead of the run id',
            submittedAt: RUN_START,
            authorLogin: 'overseer-bot',
          },
        ],
      },
      prNumber: 991,
      defectSignature: 'WRONG_VALUE',
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
  });

  test('fails when the review approves without naming the defect', async () => {
    const report = await checkLeg3OverseerCatchesDefect({
      source: {
        listPrReviews: async () => [
          {
            state: 'APPROVED',
            body: 'looks good',
            submittedAt: RUN_START,
            authorLogin: 'overseer-bot',
          },
        ],
      },
      prNumber: 991,
      defectSignature: 'WRONG_VALUE',
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('overseer_missed_planted_defect');
  });
});

describe('Leg 4 -- remediation reaches PR', () => {
  test('passes when the literal is gone and records the auto-remediation gap', async () => {
    const report = await checkLeg4RemediationReachesPr({
      source: { countDiffMatches: async () => 0 },
      prNumber: 991,
      literal: 'WRONG_VALUE',
      autoRemediationAvailable: false,
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
    expect(report.gap).toContain('#1835');
  });

  test('fails when the literal remains after the timeout', async () => {
    const report = await checkLeg4RemediationReachesPr({
      source: { countDiffMatches: async () => 1 },
      prNumber: 991,
      literal: 'WRONG_VALUE',
      autoRemediationAvailable: true,
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('remediation_not_applied');
  });
});

describe('Leg 5 -- Overseer re-approves on push', () => {
  const remediationSha = 'abc123';
  const remediationIso = '2026-09-02T01:00:00.000Z';

  test('passes when the synchronize trigger fired and a later review approved', async () => {
    const report = await checkLeg5OverseerReapproves({
      source: {
        queryRunReview: async () => [
          {
            head_sha: remediationSha,
            action: 'synchronize',
            created_at: '2026-09-02T01:01:00.000Z',
          },
        ],
        listPrReviews: async () => [
          {
            state: 'APPROVED',
            body: 'ok now',
            submittedAt: '2026-09-02T01:02:00.000Z',
            authorLogin: 'overseer-bot',
            commitId: remediationSha,
          },
        ],
      },
      prNumber: 991,
      remediationSha,
      remediationCommitIso: remediationIso,
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
  });

  test('fails with resync_trigger_not_firing when no run_review row exists', async () => {
    const report = await checkLeg5OverseerReapproves({
      source: {
        queryRunReview: async () => [],
        listPrReviews: async () => [
          {
            state: 'APPROVED',
            body: 'ok',
            submittedAt: '2026-09-02T01:02:00.000Z',
            authorLogin: 'overseer-bot',
            commitId: remediationSha,
          },
        ],
      },
      prNumber: 991,
      remediationSha,
      remediationCommitIso: remediationIso,
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('overseer_resync_trigger_not_firing');
  });

  test('fails with no_reapproval when trigger fired but no later approval', async () => {
    const report = await checkLeg5OverseerReapproves({
      source: {
        queryRunReview: async () => [
          {
            head_sha: remediationSha,
            action: 'synchronize',
            created_at: '2026-09-02T01:01:00.000Z',
          },
        ],
        listPrReviews: async () => [
          {
            state: 'CHANGES_REQUESTED',
            body: 'still bad',
            submittedAt: '2026-09-02T01:02:00.000Z',
            authorLogin: 'overseer-bot',
            commitId: remediationSha,
          },
        ],
      },
      prNumber: 991,
      remediationSha,
      remediationCommitIso: remediationIso,
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('overseer_no_reapproval');
  });

  test('fails when a stale APPROVED review (older head) is the only one after the timestamp', async () => {
    // Regression for the Overseer [major] finding: an APPROVED review that is
    // NOT pinned to the remediation head must not satisfy the leg, even if
    // its submittedAt is after the remediation commit.
    const report = await checkLeg5OverseerReapproves({
      source: {
        queryRunReview: async () => [
          {
            head_sha: remediationSha,
            action: 'synchronize',
            created_at: '2026-09-02T01:01:00.000Z',
          },
        ],
        listPrReviews: async () => [
          {
            state: 'APPROVED',
            body: 'approved an old head',
            submittedAt: '2026-09-02T01:02:00.000Z',
            authorLogin: 'overseer-bot',
            commitId: 'stale-sha-before-remediation',
          },
        ],
      },
      prNumber: 991,
      remediationSha,
      remediationCommitIso: remediationIso,
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('overseer_no_reapproval');
  });

  test('fails when the latest review on the remediation head is CHANGES_REQUESTED, even though an earlier APPROVED exists on that head', async () => {
    // Regression: "any APPROVED review after remediation" previously passed
    // even when a LATER CHANGES_REQUESTED review on the same head rejected
    // the PR. The current verdict must win.
    const report = await checkLeg5OverseerReapproves({
      source: {
        queryRunReview: async () => [
          {
            head_sha: remediationSha,
            action: 'synchronize',
            created_at: '2026-09-02T01:01:00.000Z',
          },
        ],
        listPrReviews: async () => [
          {
            state: 'APPROVED',
            body: 'looked ok at first',
            submittedAt: '2026-09-02T01:02:00.000Z',
            authorLogin: 'overseer-bot',
            commitId: remediationSha,
          },
          {
            state: 'CHANGES_REQUESTED',
            body: 'found a new issue on re-review',
            submittedAt: '2026-09-02T01:05:00.000Z',
            authorLogin: 'overseer-bot',
            commitId: remediationSha,
          },
        ],
      },
      prNumber: 991,
      remediationSha,
      remediationCommitIso: remediationIso,
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('overseer_no_reapproval');
  });

  test('passes when an earlier CHANGES_REQUESTED on the remediation head is superseded by a later APPROVED', async () => {
    const report = await checkLeg5OverseerReapproves({
      source: {
        queryRunReview: async () => [
          {
            head_sha: remediationSha,
            action: 'synchronize',
            created_at: '2026-09-02T01:01:00.000Z',
          },
        ],
        listPrReviews: async () => [
          {
            state: 'CHANGES_REQUESTED',
            body: 'first pass',
            submittedAt: '2026-09-02T01:02:00.000Z',
            authorLogin: 'overseer-bot',
            commitId: remediationSha,
          },
          {
            state: 'APPROVED',
            body: 'fixed, approving now',
            submittedAt: '2026-09-02T01:05:00.000Z',
            authorLogin: 'overseer-bot',
            commitId: remediationSha,
          },
        ],
      },
      prNumber: 991,
      remediationSha,
      remediationCommitIso: remediationIso,
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
  });
});

describe('Leg 6 -- autonomous merge', () => {
  test('passes when the bot identity merged', async () => {
    const report = await checkLeg6AutonomousMerge({
      source: {
        viewPr: async () => ({
          number: 991,
          state: 'MERGED',
          mergedByLogin: 'bluedevilcollectibles',
          commitCount: 2,
          mergeCommitOid: 'def456',
        }),
        mergedActorLogin: async () => 'bluedevilcollectibles',
      },
      prNumber: 991,
      mergeIdentity: 'bluedevilcollectibles',
      humanLogins: ['jranson'],
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
  });

  test('fails with human_merged_not_autonomous when a human merged', async () => {
    const report = await checkLeg6AutonomousMerge({
      source: {
        viewPr: async () => ({
          number: 991,
          state: 'MERGED',
          mergedByLogin: 'jranson',
          commitCount: 2,
          mergeCommitOid: 'def456',
        }),
        mergedActorLogin: async () => 'jranson',
      },
      prNumber: 991,
      mergeIdentity: 'bluedevilcollectibles',
      humanLogins: ['jranson'],
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('human_merged_not_autonomous');
  });

  test('fails with merge_manager_did_not_merge when still open', async () => {
    const report = await checkLeg6AutonomousMerge({
      source: {
        viewPr: async () => ({
          number: 991,
          state: 'OPEN',
          mergedByLogin: null,
          commitCount: 2,
          mergeCommitOid: null,
        }),
        mergedActorLogin: async () => null,
      },
      prNumber: 991,
      mergeIdentity: 'bluedevilcollectibles',
      humanLogins: ['jranson'],
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('merge_manager_did_not_merge');
  });
});

describe('Leg 7 -- reconcile closes the issue', () => {
  test('passes when the issue is CLOSED', async () => {
    const report = await checkLeg7ReconcileClosesIssue({
      source: {
        viewIssue: async () => ({ number: 4321, state: 'CLOSED', stateReason: 'completed' }),
      },
      issueNumber: 4321,
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
  });

  test('fails when the issue is still OPEN', async () => {
    const report = await checkLeg7ReconcileClosesIssue({
      source: { viewIssue: async () => ({ number: 4321, state: 'OPEN', stateReason: null }) },
      issueNumber: 4321,
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('reconcile_did_not_close');
  });
});

describe('Leg 8 -- dispatch readable reply', () => {
  test('passes when the reply body contains readable text', async () => {
    const report = await checkLeg8DispatchReadableReply({
      source: {
        dispatchResultBody: async () => 'canary run lifecycle-x reached Leg 8 -- all good',
      },
      messageId: 'msg-1',
      expectedSubstring: 'lifecycle-x',
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
  });

  test('fails when the reply body is only a bare sha256 placeholder', async () => {
    const report = await checkLeg8DispatchReadableReply({
      source: { dispatchResultBody: async () => `sha256:${'a'.repeat(64)} bytes=5321` },
      messageId: 'msg-1',
      expectedSubstring: 'lifecycle-x',
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('dispatch_reply_unreadable');
    expect(report.evidenceRefs).toContain('result_body_is_bare_sha256=true');
  });
});

describe('Leg 9 -- Duty Officer reports the run', () => {
  test('passes when the DO report mentions the run and flags nothing stale', async () => {
    const report = await checkLeg9DutyOfficerReports({
      source: { readDutyOfficerReport: async () => 'DO pass: lifecycle-x progressing normally' },
      runId: 'lifecycle-x',
      staleFlagMarkers: ['lifecycle-x stale', 'lifecycle-x idle'],
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
  });

  test('fails when the DO never saw the run', async () => {
    const report = await checkLeg9DutyOfficerReports({
      source: { readDutyOfficerReport: async () => 'DO pass: nothing to report' },
      runId: 'lifecycle-x',
      staleFlagMarkers: [],
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('do_did_not_see_run');
  });

  test('fails when the DO flagged the canary as stale', async () => {
    const report = await checkLeg9DutyOfficerReports({
      source: { readDutyOfficerReport: async () => 'DO pass: lifecycle-x stale -- nudging owner' },
      runId: 'lifecycle-x',
      staleFlagMarkers: ['lifecycle-x stale'],
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('do_flagged_canary_stale');
  });
});

describe('Leg 10 -- canary reverts (residue detection has teeth)', () => {
  test('passes when the scratch diff against base is empty', async () => {
    const report = await checkLeg10CanaryReverts({
      source: { scratchResidueDiff: async () => '', countRevertCommits: async () => 1 },
      baseBranch: 'dev',
      runId: 'lifecycle-x',
      preRunRevision: 'base-sha-pre',
      poll: poll(),
    });
    expect(report.verdict).toBe('passed');
  });

  test('fails with canary_left_residue_on_dev when residue remains (negative test)', async () => {
    const report = await checkLeg10CanaryReverts({
      source: {
        scratchResidueDiff: async () =>
          'diff --git a/.archon/canaries/lifecycle-scratch/canary-marker-x.ts b/...\n+leftover',
        countRevertCommits: async () => 0,
      },
      baseBranch: 'dev',
      runId: 'lifecycle-x',
      preRunRevision: 'base-sha-pre',
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('canary_left_residue_on_dev');
  });
});

describe('Invariant 2 -- diff scope', () => {
  test('no violation when all changed files are under the scratch dir', async () => {
    const result = await checkInvariantDiffScope({
      source: {
        listPrChangedFiles: async () => ['.archon/canaries/lifecycle-scratch/canary-marker-x.ts'],
      },
      prNumber: 991,
      scratchDir: '.archon/canaries/lifecycle-scratch',
    });
    expect(result.violated).toBe(false);
  });

  test('violation when a file outside the scratch dir is touched', async () => {
    const result = await checkInvariantDiffScope({
      source: {
        listPrChangedFiles: async () => [
          '.archon/canaries/lifecycle-scratch/canary-marker-x.ts',
          'packages/server/src/index.ts',
        ],
      },
      prNumber: 991,
      scratchDir: '.archon/canaries/lifecycle-scratch',
    });
    expect(result.violated).toBe(true);
    expect(result.offendingFiles).toContain('packages/server/src/index.ts');
  });
});

describe('runLifecycleCanarySuite (Section 10 named scenarios)', () => {
  const baseFire: LifecycleFireResult = {
    issueNumber: 4321,
    prNumber: 991,
    headBranch: 'canary/lifecycle-x',
    fallbackUsed: true,
    remediationSha: 'abc123',
    remediationCommitIso: '2026-09-02T01:00:00.000Z',
    dispatchMessageId: 'msg-1',
  };

  function fullPassSource(): LifecycleArtifactSource {
    return stubSource({
      queryTmJournalFireCauldron: async () => [],
      listPrsForBranch: async () => [
        { number: 991, headRefName: 'canary/lifecycle-x', baseRefName: 'dev', state: 'MERGED' },
      ],
      listPrReviews: async () => [
        {
          state: 'CHANGES_REQUESTED',
          body: 'WRONG_VALUE at marker:1',
          submittedAt: '2026-09-02T00:30:00.000Z',
          authorLogin: 'overseer-bot',
          commitId: 'pre-remediation-sha',
        },
        {
          state: 'APPROVED',
          body: 'ok',
          submittedAt: '2026-09-02T01:02:00.000Z',
          authorLogin: 'overseer-bot',
          commitId: 'abc123',
        },
      ],
      countDiffMatches: async () => 0,
      queryRunReview: async () => [
        { head_sha: 'abc123', action: 'synchronize', created_at: '2026-09-02T01:01:00.000Z' },
      ],
      viewPr: async () => ({
        number: 991,
        state: 'MERGED',
        mergedByLogin: 'bluedevilcollectibles',
        commitCount: 3,
        mergeCommitOid: 'def456',
      }),
      mergedActorLogin: async () => 'bluedevilcollectibles',
      viewIssue: async () => ({ number: 4321, state: 'CLOSED', stateReason: 'completed' }),
      dispatchResultBody: async () => 'canary run lifecycle-x reached Leg 8 -- readable',
      readDutyOfficerReport: async () => 'DO pass: lifecycle-x progressing',
      scratchResidueDiff: async () => '',
      countRevertCommits: async () => 1,
      listPrChangedFiles: async () => ['.archon/canaries/lifecycle-scratch/canary-marker-x.ts'],
      // Live post-Leg-4 head matches the sha the fixture's Leg 5 reviews/
      // run_review rows are pinned to ('abc123'), same as baseFire.remediationSha
      // here -- a SEPARATE test below asserts Leg 5 uses THIS refreshed value
      // even when it differs from baseFire.remediationSha.
      getPrHead: async () => ({ sha: 'abc123', committedAtIso: '2026-09-02T01:00:00.000Z' }),
    });
  }

  test('Taskmaster-never-fires gap: Leg 1 blocked, remaining legs still execute and pass', async () => {
    const report = await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      source: fullPassSource(),
      initiate: async () => baseFire,
      preRunRevision: 'base-sha-pre',
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: {
        leg1Ms: 500,
        leg2Ms: 500,
        leg3Ms: 500,
        leg4Ms: 500,
        leg5Ms: 500,
        leg6Ms: 500,
        leg7Ms: 500,
        leg8Ms: 500,
        leg9Ms: 500,
        leg10Ms: 500,
      },
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
      autoRemediationAvailable: false,
      dispatchExpectedSubstring: 'lifecycle-x',
    });
    const leg1 = report.legs.find(l => l.legId === 'taskmaster-fire')!;
    expect(leg1.verdict).toBe('blocked');
    expect(leg1.reasonCodes).toContain('taskmaster_never_fires');
    // Every OTHER leg still ran and passed -- the whole run does not abort on Leg 1.
    const others = report.legs.filter(l => l.legId !== 'taskmaster-fire');
    expect(others.every(l => l.verdict === 'passed')).toBe(true);
    expect(report.legs).toHaveLength(10);
    // Overall verdict is blocked (a blocked leg, no failures/violations).
    expect(report.verdict).toBe('blocked');
    expect(report.invariantViolations).toHaveLength(0);
  });

  test('Leg 5 validates against the post-Leg-4 refreshed head, not the initiation sha', async () => {
    const source = fullPassSource();
    // Deliberately make baseFire's initiation sha ('abc123') wrong/stale: no
    // reviews or run_review rows are pinned to it. Only the LIVE post-Leg-4
    // head ('live-head-sha', supplied by getPrHead) has the matching review +
    // trigger row. If Leg 5 used fired.remediationSha from initiation instead
    // of the refreshed head, it would fail to find a match and report failed/
    // blocked; passing here proves it used the refreshed value.
    const refreshed: LifecycleArtifactSource = {
      ...source,
      getPrHead: async () => ({ sha: 'live-head-sha', committedAtIso: '2026-09-02T01:05:00.000Z' }),
      listPrReviews: async () => [
        {
          state: 'CHANGES_REQUESTED',
          body: 'WRONG_VALUE at marker:1',
          submittedAt: '2026-09-02T00:30:00.000Z',
          authorLogin: 'overseer-bot',
          commitId: 'pre-remediation-sha',
        },
        {
          state: 'APPROVED',
          body: 'ok',
          submittedAt: '2026-09-02T01:06:00.000Z',
          authorLogin: 'overseer-bot',
          commitId: 'live-head-sha',
        },
      ],
      queryRunReview: async () => [
        {
          head_sha: 'live-head-sha',
          action: 'synchronize',
          created_at: '2026-09-02T01:05:30.000Z',
        },
      ],
    };
    const report = await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      source: refreshed,
      initiate: async () => baseFire,
      preRunRevision: 'base-sha-pre',
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: {
        leg1Ms: 500,
        leg2Ms: 500,
        leg3Ms: 500,
        leg4Ms: 500,
        leg5Ms: 500,
        leg6Ms: 500,
        leg7Ms: 500,
        leg8Ms: 500,
        leg9Ms: 500,
        leg10Ms: 500,
      },
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
      dispatchExpectedSubstring: 'lifecycle-x',
    });
    const leg5 = report.legs.find(l => l.legId === 'overseer-reapprove')!;
    expect(leg5.verdict).toBe('passed');
    expect(leg5.evidenceRefs).toContain('run_review.head_sha=live-head-sha');
  });

  test('Leg 5 blocked with a clear reason when Leg 4 never produced a head', async () => {
    const source = fullPassSource();
    // Leg 4 fails (defect literal still present) and getPrHead is never
    // expected to be called -- the refresh only runs after Leg 4 passes.
    const noRemediation: LifecycleArtifactSource = {
      ...source,
      countDiffMatches: async () => 2,
      getPrHead: async () => {
        throw new Error('getPrHead should not be called when Leg 4 does not pass');
      },
    };
    const report = await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      source: noRemediation,
      // No remediation metadata from initiation either, so with Leg 4 failing
      // and no successful refresh, Leg 5 has nothing to validate against.
      initiate: async () => ({
        ...baseFire,
        remediationSha: undefined,
        remediationCommitIso: undefined,
      }),
      preRunRevision: 'base-sha-pre',
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: {
        leg1Ms: 500,
        leg2Ms: 500,
        leg3Ms: 500,
        leg4Ms: 500,
        leg5Ms: 500,
        leg6Ms: 500,
        leg7Ms: 500,
        leg8Ms: 500,
        leg9Ms: 500,
        leg10Ms: 500,
      },
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
      dispatchExpectedSubstring: 'lifecycle-x',
    });
    const leg4 = report.legs.find(l => l.legId === 'remediation-reaches-pr')!;
    expect(leg4.verdict).toBe('failed');
    const leg5 = report.legs.find(l => l.legId === 'overseer-reapprove')!;
    expect(leg5.verdict).toBe('blocked');
    expect(leg5.reasonCodes).toContain('no_remediation_commit');
  });

  test('canary residue detection: deliberately-dirty cleanup fails Leg 10', async () => {
    const source = fullPassSource();
    const dirty: LifecycleArtifactSource = {
      ...source,
      scratchResidueDiff: async () =>
        'diff --git a/.archon/canaries/lifecycle-scratch/x.ts b/...\n+residue',
      countRevertCommits: async () => 0,
    };
    const report = await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      source: dirty,
      initiate: async () => baseFire,
      preRunRevision: 'base-sha-pre',
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: {
        leg1Ms: 500,
        leg2Ms: 500,
        leg3Ms: 500,
        leg4Ms: 500,
        leg5Ms: 500,
        leg6Ms: 500,
        leg7Ms: 500,
        leg8Ms: 500,
        leg9Ms: 500,
        leg10Ms: 500,
      },
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
      dispatchExpectedSubstring: 'lifecycle-x',
    });
    const leg10 = report.legs.find(l => l.legId === 'canary-reverts')!;
    expect(leg10.verdict).toBe('failed');
    expect(leg10.reasonCodes).toContain('canary_left_residue_on_dev');
    expect(report.verdict).toBe('failed');
  });

  test('invariant diff-scope violation forces failed verdict even if legs pass', async () => {
    const source = fullPassSource();
    const scopeViolating: LifecycleArtifactSource = {
      ...source,
      listPrChangedFiles: async () => [
        '.archon/canaries/lifecycle-scratch/canary-marker-x.ts',
        'packages/server/src/secret.ts',
      ],
    };
    const report = await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      source: scopeViolating,
      initiate: async () => baseFire,
      preRunRevision: 'base-sha-pre',
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: {
        leg1Ms: 500,
        leg2Ms: 500,
        leg3Ms: 500,
        leg4Ms: 500,
        leg5Ms: 500,
        leg6Ms: 500,
        leg7Ms: 500,
        leg8Ms: 500,
        leg9Ms: 500,
        leg10Ms: 500,
      },
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
      dispatchExpectedSubstring: 'lifecycle-x',
    });
    expect(report.invariantViolations.length).toBeGreaterThan(0);
    expect(report.invariantViolations[0]).toContain('canary_diff_scope_violation');
    expect(report.verdict).toBe('failed');
  });

  test('no PR: downstream legs blocked (never false pass), Leg 10 still runs', async () => {
    const source = stubSource({
      queryTmJournalFireCauldron: async () => [
        {
          id: 1,
          proposal_type: 'fire_cauldron',
          target: 'bdc-harness#4321',
          created_at: RUN_START,
        },
      ],
      listPrsForBranch: async () => [],
      dispatchResultBody: async () => 'canary run lifecycle-x reached Leg 8',
      readDutyOfficerReport: async () => 'DO pass: lifecycle-x progressing',
      scratchResidueDiff: async () => '',
      countRevertCommits: async () => 1,
    });
    const report = await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      source,
      preRunRevision: 'base-sha-pre',
      initiate: async () => ({
        headBranch: 'canary/lifecycle-x',
        fallbackUsed: false,
        dispatchMessageId: 'msg-1',
      }),
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: {
        leg1Ms: 500,
        leg2Ms: 500,
        leg3Ms: 500,
        leg4Ms: 500,
        leg5Ms: 500,
        leg6Ms: 500,
        leg7Ms: 500,
        leg8Ms: 500,
        leg9Ms: 500,
        leg10Ms: 500,
      },
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
      dispatchExpectedSubstring: 'lifecycle-x',
    });
    expect(report.legs).toHaveLength(10);
    expect(report.legs.find(l => l.legId === 'overseer-catch-defect')!.verdict).toBe('blocked');
    expect(report.legs.find(l => l.legId === 'autonomous-merge')!.verdict).toBe('blocked');
    // Leg 10 still executed independently.
    expect(report.legs.find(l => l.legId === 'canary-reverts')!.verdict).toBe('passed');
  });
});

describe('post-review hardening regressions', () => {
  const fastTimeouts = {
    leg1Ms: 300,
    leg2Ms: 300,
    leg3Ms: 300,
    leg4Ms: 300,
    leg5Ms: 300,
    leg6Ms: 300,
    leg7Ms: 300,
    leg8Ms: 300,
    leg9Ms: 300,
    leg10Ms: 300,
  };

  test('Invariant 2: a sibling dir sharing the scratch prefix is a violation', async () => {
    const result = await checkInvariantDiffScope({
      source: {
        listPrChangedFiles: async () => ['.archon/canaries/lifecycle-scratch-evil/payload.ts'],
      },
      prNumber: 991,
      scratchDir: '.archon/canaries/lifecycle-scratch',
    });
    expect(result.violated).toBe(true);
    expect(result.offendingFiles).toContain('.archon/canaries/lifecycle-scratch-evil/payload.ts');
  });

  test('Invariant 2: a traversal segment escaping the scratch dir is a violation', async () => {
    const result = await checkInvariantDiffScope({
      source: {
        listPrChangedFiles: async () => [
          '.archon/canaries/lifecycle-scratch/../../../packages/server/src/index.ts',
        ],
      },
      prNumber: 991,
      scratchDir: '.archon/canaries/lifecycle-scratch',
    });
    expect(result.violated).toBe(true);
  });

  test('Leg 10 anchors residue detection to the captured pre-run revision', async () => {
    const seen: string[][] = [];
    await checkLeg10CanaryReverts({
      source: {
        scratchResidueDiff: async (baseBranch: string, preRunRevision: string) => {
          seen.push([baseBranch, preRunRevision]);
          return '';
        },
        countRevertCommits: async () => 1,
      },
      baseBranch: 'dev',
      runId: 'lifecycle-x',
      preRunRevision: 'base-sha-pre',
      poll: poll(),
    });
    expect(seen[0]).toEqual(['dev', 'base-sha-pre']);
  });

  test('Leg 10 performs the cleanup operation before grading residue', async () => {
    const order: string[] = [];
    const report = await checkLeg10CanaryReverts({
      source: {
        scratchResidueDiff: async () => {
          order.push('measure');
          return '';
        },
        countRevertCommits: async () => 1,
      },
      baseBranch: 'dev',
      runId: 'lifecycle-x',
      preRunRevision: 'base-sha-pre',
      cleanup: async () => {
        order.push('cleanup');
      },
      poll: poll(),
    });
    expect(order[0]).toBe('cleanup');
    expect(order).toContain('measure');
    expect(report.verdict).toBe('passed');
  });

  test('Leg 10 fails closed when cleanup errors even if residue reads clean', async () => {
    const report = await checkLeg10CanaryReverts({
      source: { scratchResidueDiff: async () => '', countRevertCommits: async () => 1 },
      baseBranch: 'dev',
      runId: 'lifecycle-x',
      preRunRevision: 'base-sha-pre',
      cleanup: async () => {
        throw new Error('revert push rejected');
      },
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('canary_cleanup_failed');
  });

  test('Leg 10 still runs and cleans up when an upstream leg throws', async () => {
    let cleaned = false;
    const report = await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      preRunRevision: 'base-sha-pre',
      source: stubSource({
        queryTmJournalFireCauldron: async () => [
          {
            id: 1,
            proposal_type: 'fire_cauldron',
            target: 'bdc-harness#4321',
            created_at: RUN_START,
          },
        ],
        listPrsForBranch: async () => {
          throw new Error('gh exploded');
        },
        scratchResidueDiff: async () => '',
        countRevertCommits: async () => 1,
      }),
      initiate: async () => ({
        issueNumber: 4321,
        headBranch: 'canary/lifecycle-x',
        fallbackUsed: false,
      }),
      cleanup: async () => {
        cleaned = true;
      },
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: fastTimeouts,
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
    });
    expect(cleaned).toBe(true);
    expect(report.legs.find(l => l.legId === 'canary-reverts')!.verdict).toBe('passed');
    expect(report.invariantViolations.some(v => v.startsWith('canary_orchestration_error'))).toBe(
      true
    );
    expect(report.verdict).toBe('failed');
  });

  test('the fire.ps1 fallback is only invoked after the Taskmaster window elapses', async () => {
    const order: string[] = [];
    await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      preRunRevision: 'base-sha-pre',
      source: stubSource({
        queryTmJournalFireCauldron: async () => {
          order.push('poll-taskmaster');
          return [];
        },
        listPrsForBranch: async () => {
          throw new Error('stop here');
        },
        scratchResidueDiff: async () => '',
        countRevertCommits: async () => 1,
      }),
      initiate: async () => {
        order.push('initiate');
        return { headBranch: 'canary/lifecycle-x', fallbackUsed: false };
      },
      fireFallback: async () => {
        order.push('fallback');
        return { issueNumber: 4321 };
      },
      cleanup: async () => {},
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: fastTimeouts,
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
    });
    expect(order[0]).toBe('initiate');
    expect(order[1]).toBe('poll-taskmaster');
    expect(order.indexOf('fallback')).toBeGreaterThan(order.lastIndexOf('poll-taskmaster'));
  });

  test('the fallback is NOT invoked when Taskmaster fires on its own', async () => {
    let fallbackCalls = 0;
    await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      preRunRevision: 'base-sha-pre',
      source: stubSource({
        queryTmJournalFireCauldron: async () => [
          {
            id: 1,
            proposal_type: 'fire_cauldron',
            target: 'bdc-harness#4321',
            created_at: RUN_START,
          },
        ],
        listPrsForBranch: async () => {
          throw new Error('stop here');
        },
        scratchResidueDiff: async () => '',
        countRevertCommits: async () => 1,
      }),
      initiate: async () => ({
        issueNumber: 4321,
        headBranch: 'canary/lifecycle-x',
        fallbackUsed: false,
      }),
      fireFallback: async () => {
        fallbackCalls += 1;
        return {};
      },
      cleanup: async () => {},
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: fastTimeouts,
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
    });
    expect(fallbackCalls).toBe(0);
  });
});

describe('path-traversal runId rejection (Overseer Finding 2)', () => {
  test('CLI-level: isValidLifecycleRunId rejects a traversal runId', () => {
    expect(isValidLifecycleRunId('../../etc/passwd')).toBe(false);
    expect(isValidLifecycleRunId('foo/../../bar')).toBe(false);
    expect(isValidLifecycleRunId('lifecycle-x')).toBe(true);
    expect(isValidLifecycleRunId('lifecycle_x-1')).toBe(true);
  });

  test('artifact-writer level: writeLifecycleCanaryArtifacts rejects a traversal runId even if a caller skipped CLI validation', async () => {
    const outputRoot = join(tmpdir(), `lifecycle-canary-test-${Date.now()}`);
    const report: LifecycleCanaryReport = {
      schemaVersion: 1,
      suiteRunId: '../../etc/passwd',
      generatedAt: '2026-09-02T00:00:00.000Z',
      verdict: 'passed',
      reasonCodes: [],
      invariantViolations: [],
      legs: [],
    };
    await expect(writeLifecycleCanaryArtifacts(outputRoot, report)).rejects.toThrow(
      /lifecycle_canary_invalid_run_id/
    );
    await rm(outputRoot, { recursive: true, force: true });
    await rm(join(outputRoot, '..', 'docs'), { recursive: true, force: true }).catch(() => {});
  });

  test('artifact-writer level: the runId-derived directory resolves and stays inside the artifact root', async () => {
    // The regex already rejects '/' and '..', so this exercises the second,
    // independent layer (path.resolve + containment assertion): a valid runId
    // must produce paths that are all still under outputRoot after resolution.
    const outputRoot = join(tmpdir(), `lifecycle-canary-test-contain-${Date.now()}`);
    const report: LifecycleCanaryReport = {
      schemaVersion: 1,
      suiteRunId: 'valid-run-id',
      generatedAt: '2026-09-02T00:00:00.000Z',
      verdict: 'passed',
      reasonCodes: [],
      invariantViolations: [],
      legs: [],
    };
    const paths = await writeLifecycleCanaryArtifacts(outputRoot, report);
    const runDirPaths = paths.filter(path => !path.includes('docs'));
    expect(runDirPaths.length).toBeGreaterThan(0);
    expect(runDirPaths.every(path => path.startsWith(outputRoot))).toBe(true);
    await rm(outputRoot, { recursive: true, force: true });
    await rm(join(outputRoot, '..', 'docs'), { recursive: true, force: true }).catch(() => {});
  });
});

describe('bounded legs + always-run cleanup (Overseer Finding 1)', () => {
  const fastTimeouts = {
    leg1Ms: 300,
    leg2Ms: 300,
    leg3Ms: 300,
    leg4Ms: 300,
    leg5Ms: 300,
    leg6Ms: 300,
    leg7Ms: 300,
    leg8Ms: 300,
    leg9Ms: 300,
    leg10Ms: 300,
  };

  test('cleanup runs after a leg times out (a hanging leg does not skip Leg 10)', async () => {
    let cleaned = false;
    const report = await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      preRunRevision: 'base-sha-pre',
      // A never-resolving promise simulates a wedged subprocess/API call. The
      // per-leg wall-clock ceiling (legWallClockTimeoutMs) must reject this
      // rather than hang the suite forever.
      source: stubSource({
        queryTmJournalFireCauldron: () => new Promise(() => {}),
        scratchResidueDiff: async () => '',
        countRevertCommits: async () => 1,
      }),
      initiate: async () => ({
        issueNumber: 4321,
        headBranch: 'canary/lifecycle-x',
        fallbackUsed: false,
      }),
      cleanup: async () => {
        cleaned = true;
      },
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: fastTimeouts,
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
      // Small wall-clock ceiling so the test resolves quickly instead of
      // waiting out a real 20-minute default.
      legWallClockTimeoutMs: 25,
    });
    expect(cleaned).toBe(true);
    expect(report.legs.find(l => l.legId === 'canary-reverts')!.verdict).toBe('passed');
    expect(report.invariantViolations.some(v => v.startsWith('canary_orchestration_error'))).toBe(
      true
    );
    expect(report.verdict).toBe('failed');
  });

  test('an artifact-write timeout does not skip cleanup: cleanup runs as part of the suite regardless of what the CLI does with the report afterward', async () => {
    // Cleanup is invoked inside runLifecycleCanarySuite itself (Leg 10), before
    // the CLI ever attempts to write artifacts, so a hang in the downstream
    // artifact-write step (bounded separately by --artifact-write-timeout-ms in
    // cli.ts) cannot prevent cleanup from having already run.
    let cleaned = false;
    const report = await runLifecycleCanarySuite({
      runId: 'lifecycle-x',
      githubRepo: 'thinmansoftware/bdc-harness',
      baseBranch: 'dev',
      preRunRevision: 'base-sha-pre',
      source: stubSource({
        queryTmJournalFireCauldron: async () => [
          {
            id: 1,
            proposal_type: 'fire_cauldron',
            target: 'bdc-harness#4321',
            created_at: RUN_START,
          },
        ],
        listPrsForBranch: async () => [],
        dispatchResultBody: async () => 'canary run lifecycle-x reached Leg 8',
        readDutyOfficerReport: async () => 'DO pass: lifecycle-x progressing',
        scratchResidueDiff: async () => '',
        countRevertCommits: async () => 1,
      }),
      initiate: async () => ({
        headBranch: 'canary/lifecycle-x',
        fallbackUsed: false,
        dispatchMessageId: 'msg-1',
      }),
      cleanup: async () => {
        cleaned = true;
      },
      clock: fakeClock(),
      pollIntervalMs: 100,
      timeouts: fastTimeouts,
      runStartIso: RUN_START,
      mergeIdentity: 'bluedevilcollectibles',
      dispatchExpectedSubstring: 'lifecycle-x',
    });
    expect(cleaned).toBe(true);
    expect(report.legs.find(l => l.legId === 'canary-reverts')!.verdict).toBe('passed');
    // Then simulate the artifact-write step hanging past its own timeout
    // (mirrors cli.ts's withTimeout wrapper around writeLifecycleCanaryArtifacts)
    // and confirm it rejects without touching cleanup state -- cleaned stays true.
    const hangingWriter = () => new Promise<string[]>(() => {});
    const { withTimeout } = await import('./lifecycle-canary');
    await expect(withTimeout(hangingWriter(), 25, 'artifact-write-test')).rejects.toThrow(
      /timeout_after_25ms/
    );
    expect(cleaned).toBe(true);
  });

  test('cleanup itself is bounded: a hanging cleanup() fails Leg 10 as canary_cleanup_failed rather than hanging the process', async () => {
    const report = await checkLeg10CanaryReverts({
      source: { scratchResidueDiff: async () => '', countRevertCommits: async () => 1 },
      baseBranch: 'dev',
      runId: 'lifecycle-x',
      preRunRevision: 'base-sha-pre',
      // Simulates the CLI wrapping cleanup in withTimeout(..., cleanupTimeoutMs, ...)
      // the way runLifecycleCanarySuite does internally.
      cleanup: () =>
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('timeout_after_10ms: leg10-cleanup')), 10);
        }),
      poll: poll(),
    });
    expect(report.verdict).toBe('failed');
    expect(report.reasonCodes).toContain('canary_cleanup_failed');
    expect(report.evidenceRefs.some(ref => ref.includes('timeout_after_10ms'))).toBe(true);
  });
});

describe('createDefaultArtifactSource.scratchResidueDiff -- fails closed on git errors', () => {
  // Regression for the Overseer [major] finding: a missing remote, auth
  // failure, or invalid revision must THROW (fail Leg 10 closed via the
  // existing checkLeg10CanaryReverts try/catch -> canary_cleanup_threw),
  // never return empty stdout that Leg 10 reads as "clean".

  async function initGitRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-canary-residue-'));
    const run = async (args: string[]) => {
      const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      await proc.exited;
    };
    await run(['init', '-q']);
    await run(['config', 'user.email', 'test@example.com']);
    await run(['config', 'user.name', 'test']);
    return dir;
  }

  test('throws when git fetch fails (no such remote / origin never configured)', async () => {
    const repoDir = await initGitRepo();
    try {
      const source = createDefaultArtifactSource({
        dbPath: ':memory:does-not-matter-for-this-test',
        githubRepo: 'thinmansoftware/bdc-harness',
        repoDir,
        scratchDir: '.archon/canaries/lifecycle-scratch',
        dutyOfficerReportPath: null,
      });
      // No 'origin' remote exists in the fresh repo -> git fetch origin <branch> fails.
      await expect(source.scratchResidueDiff('dev', 'HEAD')).rejects.toThrow(
        /lifecycle_canary_scratch_residue_fetch_failed/
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test('throws when git diff fails (invalid preRunRevision)', async () => {
    const repoDir = await initGitRepo();
    try {
      // Create an initial commit and a fake 'origin' remote pointing at the
      // repo itself so `git fetch origin <branch>` succeeds, isolating the
      // failure to the diff step with a bogus revision.
      const write = async (args: string[]) => {
        const proc = Bun.spawn(['git', ...args], { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
      };
      await Bun.write(join(repoDir, 'README.md'), 'hello');
      await write(['add', '.']);
      await write(['commit', '-q', '-m', 'init']);
      await write(['branch', '-M', 'dev']);
      await write(['remote', 'add', 'origin', repoDir]);
      await write(['fetch', '-q', 'origin']);

      const source = createDefaultArtifactSource({
        dbPath: ':memory:does-not-matter-for-this-test',
        githubRepo: 'thinmansoftware/bdc-harness',
        repoDir,
        scratchDir: '.archon/canaries/lifecycle-scratch',
        dutyOfficerReportPath: null,
      });
      await expect(source.scratchResidueDiff('dev', 'not-a-real-revision-000000')).rejects.toThrow(
        /lifecycle_canary_scratch_residue_diff_failed/
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test('returns the real diff (does not throw) on a clean, valid comparison', async () => {
    const repoDir = await initGitRepo();
    try {
      const write = async (args: string[]) => {
        const proc = Bun.spawn(['git', ...args], { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
      };
      await Bun.write(join(repoDir, 'README.md'), 'hello');
      await write(['add', '.']);
      await write(['commit', '-q', '-m', 'init']);
      await write(['branch', '-M', 'dev']);
      await write(['remote', 'add', 'origin', repoDir]);
      await write(['fetch', '-q', 'origin']);

      const source = createDefaultArtifactSource({
        dbPath: ':memory:does-not-matter-for-this-test',
        githubRepo: 'thinmansoftware/bdc-harness',
        repoDir,
        scratchDir: '.archon/canaries/lifecycle-scratch',
        dutyOfficerReportPath: null,
      });
      const diff = await source.scratchResidueDiff('dev', 'HEAD');
      expect(diff.trim().length).toBe(0);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
