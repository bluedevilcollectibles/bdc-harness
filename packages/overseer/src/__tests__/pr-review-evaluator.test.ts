import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createRealFetchExactHeadPullRequestEvidence,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import { resetRequiredContextsAttemptCounters } from '../adapters/required-contexts.ts';
import {
  buildReviewPrompt,
  checksAreTerminal,
  evaluatePullRequest,
  parseReviewVerdict,
  type PrReviewDeps,
  type PrReviewInput,
} from '../pr-review-evaluator.ts';

// The required-contexts resolver counts CONSECUTIVE unknown attempts per
// owner/repo@base+head in module scope, and degrades to the reported-checks
// heuristic past the bound. These tests assert the FAIL-CLOSED first-attempt
// behaviour, so each must start from a clean count rather than inheriting one
// from an earlier test in this file and degrading by accident.
beforeEach(() => {
  resetRequiredContextsAttemptCounters();
});

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const input: PrReviewInput = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  pr_number: 42,
  head_sha: HEAD_A,
  wo_id: 'WO-TEST-01',
};

function output(
  verdict: 'APPROVE' | 'REQUEST_CHANGES',
  findings: unknown[] = [],
  head = HEAD_A
): string {
  return JSON.stringify({ verdict, findings, reviewed_head_sha: head });
}

function deps(overrides: Partial<PrReviewDeps> = {}): PrReviewDeps {
  return {
    reviewer: { provider: 'test-provider', model: 'review-model' },
    fetchEvidence: async () => ({
      diff: '+ safe implementation',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    }),
    fetchAcceptanceCriteria: async () => 'implementation is safe',
    invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: output('APPROVE') }),
    ladder: ['review-model'],
    ...overrides,
  };
}

describe('governed PR-code reviewer', () => {
  test('1 clean diff yields APPROVE with exact head and reviewer identity', async () => {
    const result = await evaluatePullRequest(input, deps());
    expect(result.verdict).toBe('APPROVE');
    expect(result.reviewed_head_sha).toBe(HEAD_A);
    expect(result.reviewer).toEqual({ provider: 'test-provider', model: 'review-model' });
  });

  test('2 blocking acceptance-criteria finding yields REQUEST_CHANGES', async () => {
    const finding = { scope: 'auth.ts', severity: 'blocker', summary: 'Bypasses authorization' };
    const result = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: output('REQUEST_CHANGES', [finding]),
        }),
      })
    );
    expect(result.verdict).toBe('REQUEST_CHANGES');
    expect(result.findings).toEqual([finding]);
  });

  test('3 unparseable model output is INDETERMINATE, never approval', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({ invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: 'yes' }) })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(parseReviewVerdict('{"verdict":"APPROVE"}')).toBeNull();
  });

  test('4 invocation error is recorded as INDETERMINATE', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async () => {
          throw new Error('provider unavailable');
        },
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toContain('provider unavailable');
  });

  test('5 every ref-addressable GitHub evidence read is pinned to the exact head', async () => {
    const calls: Record<string, unknown>[] = [];
    const octokit = {
      pulls: {
        get: async (request: Record<string, unknown>) => {
          calls.push(request);
          return { data: { head: { sha: HEAD_A }, base: { sha: HEAD_B } } };
        },
      },
      repos: {
        compareCommits: async (request: Record<string, unknown>) => {
          calls.push(request);
          return { data: { files: [{ filename: 'safe.ts', patch: '+ pinned' }] } };
        },
      },
      checks: {
        listForRef: async (request: Record<string, unknown>) => {
          calls.push(request);
          return { data: { check_runs: [] } };
        },
      },
    } as unknown as RealGitHubOctokitLike;
    await createRealFetchExactHeadPullRequestEvidence(octokit)({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.pr_number,
      headSha: input.head_sha,
    });
    expect(calls[0]?.head_sha).toBe(HEAD_A);
    expect(calls[1]?.head).toBe(HEAD_A);
    expect(calls[2]?.ref).toBe(HEAD_A);
  });

  test('5b evidence collection rejects when the live PR head has moved', async () => {
    const octokit = {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD_B }, base: { sha: HEAD_A } } }),
      },
      repos: {
        compareCommits: async () => {
          throw new Error('comparison must not run for a stale head');
        },
      },
      checks: {
        listForRef: async () => {
          throw new Error('checks must not run for a stale head');
        },
      },
    } as unknown as RealGitHubOctokitLike;

    await expect(
      createRealFetchExactHeadPullRequestEvidence(octokit)({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.pr_number,
        headSha: HEAD_A,
      })
    ).rejects.toThrow('pr_review_head_moved');
  });

  test('6 returned head mismatch is INDETERMINATE', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: output('APPROVE', [], HEAD_B),
        }),
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toBe('reviewed_head_mismatch');
  });

  test('7 missing acceptance criteria degrades without failing review', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({ fetchAcceptanceCriteria: async () => null })
    );
    expect(result.verdict).toBe('APPROVE');
    expect(result.acceptance_criteria_available).toBe(false);
  });

  test('8 failing checks are visible to the model and its findings', async () => {
    let prompt = '';
    const finding = { scope: 'checks/test', severity: 'major', summary: 'Tests failed' } as const;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [{ name: 'unit', status: 'completed', conclusion: 'failure' }],
        }),
        invokeModel: async (_binary, value) => {
          prompt = value;
          return {
            exitCode: 0,
            timedOut: false,
            stdout: output('REQUEST_CHANGES', [finding]),
          };
        },
      })
    );
    expect(prompt).toContain('"conclusion":"failure"');
    expect(result.findings).toEqual([finding]);
  });

  test('9 every completed result records non-empty reviewer identity', async () => {
    const result = await evaluatePullRequest(input, deps());
    expect(result.reviewer.provider.length).toBeGreaterThan(0);
    expect(result.reviewer.model.length).toBeGreaterThan(0);
  });

  test('10 prompt asks for code review evidence and strict structured output', () => {
    const prompt = buildReviewPrompt({
      request: input,
      diff: '+ code',
      checks: [],
      acceptanceCriteria: 'must pass',
    });
    expect(prompt).toContain('code diff');
    expect(prompt).toContain('acceptance criteria');
    expect(prompt).toContain('REQUEST_CHANGES');
  });

  // WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01, stop condition 1: a PR whose
  // checks are still non-terminal must never produce a REQUEST_CHANGES on
  // checks-pending grounds. Instead it defers (CHECKS_PENDING) WITHOUT invoking
  // the model.
  test('11 a non-terminal check defers to CHECKS_PENDING and never invokes the model', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [{ name: 'test', status: 'queued', conclusion: null }],
        }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(result.reviewed_head_sha).toBe(HEAD_A);
    expect(result.error).toBe('checks_pending');
    expect(modelInvoked).toBe(false);
  });

  test('12 an empty checks array (no CI reported yet) also defers to CHECKS_PENDING', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({ diff: '+ change', checks: [] }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(modelInvoked).toBe(false);
  });

  test('13 all-completed checks still flow to the model (regression)', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(modelInvoked).toBe(true);
    expect(result.verdict).toBe('APPROVE');
  });

  test('14 checksAreTerminal is true only when every reported check is completed', () => {
    expect(checksAreTerminal([])).toBe(false);
    expect(checksAreTerminal([{ name: 'a', status: 'completed', conclusion: 'success' }])).toBe(
      true
    );
    expect(
      checksAreTerminal([
        { name: 'a', status: 'completed', conclusion: 'success' },
        { name: 'b', status: 'in_progress', conclusion: null },
      ])
    ).toBe(false);
  });

  // WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01, review finding 2026-09-01:
  // GitHub only lists check runs that have already been created, so "every
  // reported check completed" can be true before the rest of the required suite
  // even registers. When required contexts are known they are the authoritative
  // signal: a completed reported check with a required context still ABSENT is
  // NOT terminal.
  test('15 checksAreTerminal defers when a required context has not reported yet', () => {
    // One fast check completed, but 'build' (required) has not registered a run.
    expect(
      checksAreTerminal(
        [{ name: 'test', status: 'completed', conclusion: 'success' }],
        ['test', 'build']
      )
    ).toBe(false);
    // A required context present but still running is likewise non-terminal.
    expect(
      checksAreTerminal(
        [
          { name: 'test', status: 'completed', conclusion: 'success' },
          { name: 'build', status: 'in_progress', conclusion: null },
        ],
        ['test', 'build']
      )
    ).toBe(false);
    // Every required context reported AND completed -> terminal.
    expect(
      checksAreTerminal(
        [
          { name: 'test', status: 'completed', conclusion: 'success' },
          { name: 'build', status: 'completed', conclusion: 'success' },
        ],
        ['test', 'build']
      )
    ).toBe(true);
    // Authoritative empty set (branch enforces nothing) -> heuristic fallback.
    expect(
      checksAreTerminal([{ name: 'test', status: 'completed', conclusion: 'success' }], [])
    ).toBe(true);
    // Source does not model required contexts at all -> heuristic fallback.
    expect(checksAreTerminal([{ name: 'test', status: 'completed', conclusion: 'success' }])).toBe(
      true
    );
    // UNKNOWN required set -> fail closed, never terminal, even when every
    // reported check has completed successfully.
    expect(
      checksAreTerminal([{ name: 'test', status: 'completed', conclusion: 'success' }], null)
    ).toBe(false);
    expect(checksAreTerminal([], null)).toBe(false);
  });

  test('16 a completed reported check with a required context still absent defers to CHECKS_PENDING', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
          requiredContexts: ['test', 'build'],
        }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(result.error).toBe('checks_pending');
    expect(modelInvoked).toBe(false);
  });

  test('17 all required contexts reported and completed flow to the model', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [
            { name: 'test', status: 'completed', conclusion: 'success' },
            { name: 'build', status: 'completed', conclusion: 'success' },
          ],
          requiredContexts: ['test', 'build'],
        }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(modelInvoked).toBe(true);
    expect(result.verdict).toBe('APPROVE');
  });

  test('18 real evidence fetch surfaces base-branch required contexts', async () => {
    const octokit = {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD_A }, base: { sha: HEAD_B, ref: 'main' } } }),
      },
      repos: {
        compareCommits: async () => ({
          data: { files: [{ filename: 'safe.ts', patch: '+ ok' }] },
        }),
        getAllStatusCheckContexts: async (request: Record<string, unknown>) => {
          expect(request.branch).toBe('main');
          return { data: ['test', 'build'] };
        },
      },
      checks: {
        listForRef: async () => ({
          data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
        }),
      },
    } as unknown as RealGitHubOctokitLike;

    const evidence = await createRealFetchExactHeadPullRequestEvidence(octokit)({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.pr_number,
      headSha: HEAD_A,
    });
    expect(evidence.requiredContexts).toEqual(['test', 'build']);
    // Reviewer would defer: 'build' is required but no run reported it yet.
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(false);
  });

  test('19 unreadable branch protection is UNKNOWN (null), never an empty required set', async () => {
    // GitHub returns 404 both for an unprotected branch and for a token that
    // cannot see protection, so a failure must never be read as "nothing is
    // required" -- that is the fail-open path this test locks shut.
    for (const failure of [
      Object.assign(new Error('Branch not protected'), { status: 404 }),
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
      Object.assign(new Error('Bad gateway'), { status: 502 }),
    ]) {
      // Each shape asserts fail-closed on a FIRST attempt; without this the
      // three iterations would share one consecutive-unknown count.
      resetRequiredContextsAttemptCounters();
      const octokit = {
        pulls: {
          get: async () => ({
            data: { head: { sha: HEAD_A }, base: { sha: HEAD_B, ref: 'main' } },
          }),
        },
        repos: {
          compareCommits: async () => ({
            data: { files: [{ filename: 'safe.ts', patch: '+ ok' }] },
          }),
          getAllStatusCheckContexts: async () => {
            throw failure;
          },
        },
        checks: {
          listForRef: async () => ({
            data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
          }),
        },
      } as unknown as RealGitHubOctokitLike;

      const evidence = await createRealFetchExactHeadPullRequestEvidence(octokit)({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.pr_number,
        headSha: HEAD_A,
      });
      expect(evidence.requiredContexts).toBeNull();
      // Fails closed: a completed reported check does NOT make the suite terminal.
      expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(false);
    }
  });

  test('20 an unavailable protection API is UNKNOWN, not an empty required set', async () => {
    const octokit = {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD_A }, base: { sha: HEAD_B, ref: 'main' } } }),
      },
      repos: {
        compareCommits: async () => ({
          data: { files: [{ filename: 'safe.ts', patch: '+ ok' }] },
        }),
        // getAllStatusCheckContexts intentionally absent.
      },
      checks: {
        listForRef: async () => ({
          data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
        }),
      },
    } as unknown as RealGitHubOctokitLike;

    const evidence = await createRealFetchExactHeadPullRequestEvidence(octokit)({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.pr_number,
      headSha: HEAD_A,
    });
    expect(evidence.requiredContexts).toBeNull();
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(false);
  });

  test('21 an authoritative empty required set still allows review to proceed', async () => {
    const octokit = {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD_A }, base: { sha: HEAD_B, ref: 'main' } } }),
      },
      repos: {
        compareCommits: async () => ({
          data: { files: [{ filename: 'safe.ts', patch: '+ ok' }] },
        }),
        getAllStatusCheckContexts: async () => ({ data: [] }),
      },
      checks: {
        listForRef: async () => ({
          data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
        }),
      },
    } as unknown as RealGitHubOctokitLike;

    const evidence = await createRealFetchExactHeadPullRequestEvidence(octokit)({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.pr_number,
      headSha: HEAD_A,
    });
    expect(evidence.requiredContexts).toEqual([]);
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(true);
  });

  test('22 evaluator defers to CHECKS_PENDING when the required set is UNKNOWN', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
          requiredContexts: null,
        }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(result.error).toBe('checks_pending');
    expect(modelInvoked).toBe(false);
  });
});
