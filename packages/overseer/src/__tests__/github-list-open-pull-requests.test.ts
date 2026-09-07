/**
 * Real-adapter tests for PR-first candidate discovery (bdc-harness#758).
 *
 * The REST pull-request listing does not carry GitHub's aggregate
 * `reviewDecision` -- that field exists only on the GraphQL PullRequest type --
 * so the adapter derives it from the individual reviews. These tests pin the
 * derivation rule, because getting it wrong in the permissive direction would
 * admit an unapproved PR into the merge candidate set.
 *
 * Network-free: a plain object stands in for Octokit.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRealListOpenPullRequests,
  deriveReviewDecision,
  extractWoId,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';

interface FakePullRequest {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  html_url: string;
  head: { sha: string; ref?: string };
  base?: { ref?: string };
  body?: string | null;
}

interface FakeReview {
  user: { login?: string | null } | null;
  state: string;
  commit_id: string;
}

function octokitWith(
  pulls: FakePullRequest[],
  reviewsByNumber: Record<number, FakeReview[]> = {},
  options: { throwOnReviewsFor?: number } = {}
): RealGitHubOctokitLike {
  return {
    pulls: {
      list: async () => ({ data: pulls }),
      get: async () => {
        throw new Error('pulls.get not used by listOpenPullRequests');
      },
      merge: async () => ({ data: { merged: false } }),
      listReviews: async (input: { pull_number: number }) => {
        if (options.throwOnReviewsFor === input.pull_number) {
          throw new Error('reviews unavailable');
        }
        return { data: reviewsByNumber[input.pull_number] ?? [] };
      },
    },
    search: {
      issuesAndPullRequests: async () => ({ data: { items: [] } }),
    },
    checks: {
      listForRef: async () => ({ data: { check_runs: [] } }),
    },
  } as unknown as RealGitHubOctokitLike;
}

function approval(login: string): FakeReview {
  return { user: { login }, state: 'APPROVED', commit_id: 'sha-1' };
}

function changesRequested(login: string): FakeReview {
  return { user: { login }, state: 'CHANGES_REQUESTED', commit_id: 'sha-1' };
}

describe('deriveReviewDecision', () => {
  test('an approval with no dissent is APPROVED', () => {
    expect(deriveReviewDecision([{ login: 'overseer', state: 'APPROVED' }])).toBe('APPROVED');
  });

  // One outstanding CHANGES_REQUESTED beats any number of approvals. This is
  // GitHub's own rule and the safe direction: a merge candidate must never be
  // admitted over a standing objection.
  test('one outstanding CHANGES_REQUESTED beats every approval', () => {
    expect(
      deriveReviewDecision([
        { login: 'a', state: 'APPROVED' },
        { login: 'b', state: 'APPROVED' },
        { login: 'c', state: 'CHANGES_REQUESTED' },
      ])
    ).toBe('CHANGES_REQUESTED');
  });

  test('only a reviewer LATEST state counts -- a later approval clears their own block', () => {
    expect(
      deriveReviewDecision([
        { login: 'reviewer', state: 'CHANGES_REQUESTED' },
        { login: 'reviewer', state: 'APPROVED' },
      ])
    ).toBe('APPROVED');
  });

  // A plain comment is not a verdict. Collapsing it into the reviewer's latest
  // state would silently clear a standing CHANGES_REQUESTED.
  test('COMMENTED and PENDING never replace a standing verdict', () => {
    expect(
      deriveReviewDecision([
        { login: 'reviewer', state: 'CHANGES_REQUESTED' },
        { login: 'reviewer', state: 'COMMENTED' },
        { login: 'reviewer', state: 'PENDING' },
      ])
    ).toBe('CHANGES_REQUESTED');
  });

  test('a dismissed approval no longer approves', () => {
    expect(
      deriveReviewDecision([
        { login: 'reviewer', state: 'APPROVED' },
        { login: 'reviewer', state: 'DISMISSED' },
      ])
    ).toBeNull();
  });

  test('no reviews at all is null, never APPROVED', () => {
    expect(deriveReviewDecision([])).toBeNull();
    expect(deriveReviewDecision([{ login: 'a', state: 'COMMENTED' }])).toBeNull();
  });
});

describe('extractWoId', () => {
  test('finds a WO id in the title', () => {
    expect(extractWoId('fix(overseer): WO-HARNESS-THING-01 lands', null)).toBe(
      'WO-HARNESS-THING-01'
    );
  });

  test('finds a WO id in the body when the title has none', () => {
    expect(extractWoId('test: reviewer live-fire', 'Closes WO-HARNESS-CANARY-02')).toBe(
      'WO-HARNESS-CANARY-02'
    );
  });

  test('returns undefined rather than inventing an id', () => {
    expect(extractWoId('chore: tidy up', 'no work order here')).toBeUndefined();
  });
});

describe('createRealListOpenPullRequests', () => {
  test('populates every discovery field from live listing data', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 730,
            title: 'test: reviewer live-fire',
            state: 'open',
            draft: false,
            html_url: 'https://github.com/thinmansoftware/bdc-harness/pull/730',
            head: { sha: 'abc123', ref: 'test/reviewer-live-fire' },
            base: { ref: 'dev' },
            body: 'Closes WO-HARNESS-REVIEW-01',
          },
        ],
        { 730: [approval('thinman-overseer[bot]')] }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev', 'staging'],
    });

    expect(discovered).toEqual({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 730,
      title: 'test: reviewer live-fire',
      state: 'open',
      draft: false,
      baseRef: 'dev',
      headRef: 'test/reviewer-live-fire',
      headSha: 'abc123',
      reviewDecision: 'APPROVED',
      woId: 'WO-HARNESS-REVIEW-01',
    });
  });

  // A PR on an unwatched base is still RETURNED so the caller counts it as
  // evaluated and logs base_branch_not_watched. Filtering it away at the API
  // would reproduce the silent absence #758 is about.
  test('a PR on an unwatched base is still returned, so it can be excluded by name', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith([
        {
          number: 900,
          title: 'release cut',
          state: 'open',
          html_url: 'https://example.invalid/900',
          head: { sha: 'def456', ref: 'release/prep' },
          base: { ref: 'main' },
        },
      ])
    );

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.baseRef).toBe('main');
    expect(discovered[0]?.reviewDecision).toBeNull();
  });

  test('draft PRs are reported as drafts rather than dropped', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 901,
            title: 'wip',
            state: 'open',
            draft: true,
            html_url: 'https://example.invalid/901',
            head: { sha: 'ghi789', ref: 'wip/thing' },
            base: { ref: 'dev' },
          },
        ],
        { 901: [approval('someone')] }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered?.draft).toBe(true);
  });

  // Unknown review state stays unknown, and unknown is not approved. Failing
  // closed is the only safe direction for a merge candidate.
  test('a failed reviews lookup yields a null decision, never an assumed approval', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 902,
            title: 'fix: something',
            state: 'open',
            html_url: 'https://example.invalid/902',
            head: { sha: 'jkl012', ref: 'fix/thing' },
            base: { ref: 'dev' },
          },
        ],
        {},
        { throwOnReviewsFor: 902 }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered?.reviewDecision).toBeNull();
  });

  test('a changes-requested PR reports CHANGES_REQUESTED', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 903,
            title: 'feat: thing',
            state: 'open',
            html_url: 'https://example.invalid/903',
            head: { sha: 'mno345', ref: 'feat/thing' },
            base: { ref: 'dev' },
          },
        ],
        { 903: [approval('a'), changesRequested('b')] }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered?.reviewDecision).toBe('CHANGES_REQUESTED');
  });

  test('an empty base filter accepts every base', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 904,
            title: 'chore: thing',
            state: 'open',
            html_url: 'https://example.invalid/904',
            head: { sha: 'pqr678', ref: 'chore/thing' },
            base: { ref: 'anything' },
          },
        ],
        { 904: [approval('a')] }
      )
    );

    const [discovered] = await list({ owner: 'thinmansoftware', repo: 'bdc-harness' });

    expect(discovered?.reviewDecision).toBe('APPROVED');
  });
});
