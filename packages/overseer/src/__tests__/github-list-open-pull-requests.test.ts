/**
 * Real-adapter tests for PR-first candidate discovery (bdc-harness#758).
 *
 * The REST pull-request listing does not carry GitHub's aggregate
 * `reviewDecision` -- that field exists only on the GraphQL PullRequest type.
 * The adapter therefore prefers GraphQL when a client is available and falls
 * back to a CONSERVATIVE local derivation otherwise. These tests pin both
 * paths, because getting the fallback wrong in the permissive direction would
 * admit an unapproved PR into the merge candidate set.
 *
 * The fallback is deliberately STRICTER than GitHub's aggregate rather than an
 * attempt to reproduce it: REST reviews cannot express required approval counts
 * or CODEOWNERS rules at all, so the derivation substitutes a predicate the
 * merge path already enforces downstream -- an exact-head approval from the
 * Review Gate identity, with no standing objection, over a fully paginated read.
 *
 * Network-free: a plain object stands in for Octokit.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRealListOpenPullRequests,
  deriveReviewDecision,
  extractWoId,
  fetchAllPullRequestReviews,
  fetchReviewDecisions,
  resolveReviewGateLogin,
  DEFAULT_REVIEW_GATE_LOGIN,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';

const GATE = DEFAULT_REVIEW_GATE_LOGIN;

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

interface OctokitFakeOptions {
  readonly throwOnReviewsFor?: number;
  /** Aggregate decisions to serve over GraphQL. Omit for a REST-only client. */
  readonly graphqlDecisions?: Record<number, string | null>;
  /** Make the GraphQL call throw, exercising the fallback. */
  readonly graphqlThrows?: boolean;
  /** Record every listReviews page requested, to assert pagination happened. */
  readonly reviewPageLog?: number[];
}

function octokitWith(
  pulls: FakePullRequest[],
  reviewsByNumber: Record<number, FakeReview[]> = {},
  options: OctokitFakeOptions = {}
): RealGitHubOctokitLike {
  const client: Record<string, unknown> = {
    pulls: {
      list: async () => ({ data: pulls }),
      get: async () => {
        throw new Error('pulls.get not used by listOpenPullRequests');
      },
      merge: async () => ({ data: { merged: false } }),
      // Serves real PAGES: the adapter must follow them to see review 101.
      listReviews: async (input: { pull_number: number; per_page: number; page?: number }) => {
        if (options.throwOnReviewsFor === input.pull_number) {
          throw new Error('reviews unavailable');
        }
        const page = input.page ?? 1;
        options.reviewPageLog?.push(page);
        const all = reviewsByNumber[input.pull_number] ?? [];
        const start = (page - 1) * input.per_page;
        return { data: all.slice(start, start + input.per_page) };
      },
    },
    search: {
      issuesAndPullRequests: async () => ({ data: { items: [] } }),
    },
    checks: {
      listForRef: async () => ({ data: { check_runs: [] } }),
    },
  };

  if (options.graphqlThrows) {
    client.graphql = async () => {
      throw new Error('graphql unavailable');
    };
  } else if (options.graphqlDecisions) {
    const decisions = options.graphqlDecisions;
    client.graphql = async () => ({
      repository: Object.fromEntries(
        Object.entries(decisions).map(([number, reviewDecision]) => [
          `pr${number}`,
          { number: Number(number), reviewDecision },
        ])
      ),
    });
  }

  return client as unknown as RealGitHubOctokitLike;
}

function approval(login: string, commitId = 'sha-1'): FakeReview {
  return { user: { login }, state: 'APPROVED', commit_id: commitId };
}

function changesRequested(login: string, commitId = 'sha-1'): FakeReview {
  return { user: { login }, state: 'CHANGES_REQUESTED', commit_id: commitId };
}

/** The default-shaped options: a complete read pinned to the head under test. */
function onHead(headSha: string) {
  return { headSha, reviewGateLogin: GATE, reviewsIncomplete: false };
}

describe('deriveReviewDecision', () => {
  test('a Review Gate approval on the current head is APPROVED', () => {
    expect(
      deriveReviewDecision([{ login: GATE, state: 'APPROVED', commitId: 'sha-1' }], onHead('sha-1'))
    ).toBe('APPROVED');
  });

  // One outstanding CHANGES_REQUESTED beats any number of approvals. This is
  // GitHub's own rule and the safe direction: a merge candidate must never be
  // admitted over a standing objection.
  test('one outstanding CHANGES_REQUESTED beats every approval', () => {
    expect(
      deriveReviewDecision(
        [
          { login: 'a', state: 'APPROVED', commitId: 'sha-1' },
          { login: GATE, state: 'APPROVED', commitId: 'sha-1' },
          { login: 'c', state: 'CHANGES_REQUESTED', commitId: 'sha-1' },
        ],
        onHead('sha-1')
      )
    ).toBe('CHANGES_REQUESTED');
  });

  test('only a reviewer LATEST state counts -- a later approval clears their own block', () => {
    expect(
      deriveReviewDecision(
        [
          { login: GATE, state: 'CHANGES_REQUESTED', commitId: 'sha-1' },
          { login: GATE, state: 'APPROVED', commitId: 'sha-1' },
        ],
        onHead('sha-1')
      )
    ).toBe('APPROVED');
  });

  // A plain comment is not a verdict. Collapsing it into the reviewer's latest
  // state would silently clear a standing CHANGES_REQUESTED.
  test('COMMENTED and PENDING never replace a standing verdict', () => {
    expect(
      deriveReviewDecision(
        [
          { login: 'reviewer', state: 'CHANGES_REQUESTED', commitId: 'sha-1' },
          { login: 'reviewer', state: 'COMMENTED', commitId: 'sha-1' },
          { login: 'reviewer', state: 'PENDING', commitId: 'sha-1' },
        ],
        onHead('sha-1')
      )
    ).toBe('CHANGES_REQUESTED');
  });

  test('a dismissed approval no longer approves', () => {
    expect(
      deriveReviewDecision(
        [
          { login: GATE, state: 'APPROVED', commitId: 'sha-1' },
          { login: GATE, state: 'DISMISSED', commitId: 'sha-1' },
        ],
        onHead('sha-1')
      )
    ).toBeNull();
  });

  test('no reviews at all is null, never APPROVED', () => {
    expect(deriveReviewDecision([], onHead('sha-1'))).toBeNull();
    expect(
      deriveReviewDecision([{ login: 'a', state: 'COMMENTED', commitId: 'sha-1' }], onHead('sha-1'))
    ).toBeNull();
  });

  // THE STALE-HEAD HOLE (Overseer [major], d62d6dd5). An approval carries the
  // commit it was left on. After a push it describes code the approver never
  // saw, and GitHub drops it from the aggregate -- but the old derivation still
  // read it as APPROVED, turning discovery into a path around the Review Gate's
  // own exact-head check.
  test('an approval on a superseded head does NOT approve the current head', () => {
    expect(
      deriveReviewDecision(
        [{ login: GATE, state: 'APPROVED', commitId: 'sha-old' }],
        onHead('sha-new')
      )
    ).toBeNull();
  });

  test('a stale approval does not rescue a PR once the head moves again', () => {
    // The gate approved sha-1; the author pushed sha-2. Nothing on sha-2 is approved.
    expect(
      deriveReviewDecision(
        [
          { login: 'human', state: 'APPROVED', commitId: 'sha-2' },
          { login: GATE, state: 'APPROVED', commitId: 'sha-1' },
        ],
        onHead('sha-2')
      )
    ).toBeNull();
  });

  // Without a head there is nothing to compare an approval's commit against,
  // so its currency cannot be established -- and an approval that cannot be
  // proven current is not proven at all.
  test('an unknown head yields null rather than trusting the approval', () => {
    expect(
      deriveReviewDecision([{ login: GATE, state: 'APPROVED', commitId: 'sha-1' }], {
        reviewGateLogin: GATE,
      })
    ).toBeNull();
  });

  // REQUIRED APPROVAL COUNT / CODEOWNERS stand-in: a human approval alone is
  // not the Review Gate's approval, and the merge path would refuse it later
  // anyway. Discovery declining it costs a tick; admitting it costs a merge.
  test('an approval from someone other than the Review Gate does not approve', () => {
    expect(
      deriveReviewDecision(
        [
          { login: 'random-human', state: 'APPROVED', commitId: 'sha-1' },
          { login: 'another-human', state: 'APPROVED', commitId: 'sha-1' },
        ],
        onHead('sha-1')
      )
    ).toBeNull();
  });

  test('the Review Gate identity is configurable and matched case-insensitively', () => {
    expect(
      deriveReviewDecision([{ login: 'Custom-Bot', state: 'APPROVED', commitId: 'sha-1' }], {
        headSha: 'sha-1',
        reviewGateLogin: 'custom-bot',
      })
    ).toBe('APPROVED');
  });

  // An incomplete read cannot support the ASSERTION OF ABSENCE that APPROVED
  // requires: the unread page is exactly where a late objection would sit.
  test('an incomplete review read never yields APPROVED', () => {
    expect(
      deriveReviewDecision([{ login: GATE, state: 'APPROVED', commitId: 'sha-1' }], {
        headSha: 'sha-1',
        reviewGateLogin: GATE,
        reviewsIncomplete: true,
      })
    ).toBeNull();
  });

  // Seeing an objection is proof; not seeing one is not. So a standing block
  // still blocks even when the read was partial.
  test('a seen CHANGES_REQUESTED still blocks on an incomplete read', () => {
    expect(
      deriveReviewDecision([{ login: 'reviewer', state: 'CHANGES_REQUESTED', commitId: 'sha-1' }], {
        headSha: 'sha-1',
        reviewGateLogin: GATE,
        reviewsIncomplete: true,
      })
    ).toBe('CHANGES_REQUESTED');
  });
});

describe('resolveReviewGateLogin', () => {
  test('defaults to the Overseer App identity', () => {
    expect(resolveReviewGateLogin(undefined)).toBe('thinman-overseer[bot]');
    expect(resolveReviewGateLogin('   ')).toBe('thinman-overseer[bot]');
  });

  test('an explicit env value wins', () => {
    expect(resolveReviewGateLogin('other-bot[bot]')).toBe('other-bot[bot]');
  });
});

describe('fetchAllPullRequestReviews -- pagination', () => {
  // THE PAGINATION HOLE (Overseer [major], d62d6dd5). `per_page: 100` was read
  // once. Review 101 -- on a busy PR typically the LATEST, and so exactly where
  // a late CHANGES_REQUESTED lands -- was invisible.
  test('reads past review 100 and sees the objection on page 2', async () => {
    const many: FakeReview[] = [];
    for (let i = 0; i < 100; i += 1) many.push(approval(`human-${i}`));
    many.push(changesRequested('late-objector'));

    const pageLog: number[] = [];
    const octokit = octokitWith([], { 42: many }, { reviewPageLog: pageLog });

    const { reviews, complete } = await fetchAllPullRequestReviews(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 42,
    });

    expect(pageLog).toEqual([1, 2]);
    expect(reviews).toHaveLength(101);
    expect(complete).toBe(true);
    expect(reviews[100]?.state).toBe('CHANGES_REQUESTED');
    // And the decision reflects the review that only pagination could see.
    expect(deriveReviewDecision(reviews, onHead('sha-1'))).toBe('CHANGES_REQUESTED');
  });

  test('a short first page stops after one request', async () => {
    const pageLog: number[] = [];
    const octokit = octokitWith([], { 7: [approval(GATE)] }, { reviewPageLog: pageLog });

    const { reviews, complete } = await fetchAllPullRequestReviews(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 7,
    });

    expect(pageLog).toEqual([1]);
    expect(reviews).toHaveLength(1);
    expect(complete).toBe(true);
  });

  test('a page that throws reports incomplete rather than a short clean read', async () => {
    const octokit = octokitWith([], {}, { throwOnReviewsFor: 9 });

    const { reviews, complete } = await fetchAllPullRequestReviews(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 9,
    });

    expect(reviews).toEqual([]);
    expect(complete).toBe(false);
  });
});

describe('fetchReviewDecisions -- GitHub aggregate over GraphQL', () => {
  test('returns GitHub own decision per PR', async () => {
    const octokit = octokitWith(
      [],
      {},
      { graphqlDecisions: { 1: 'APPROVED', 2: 'REVIEW_REQUIRED' } }
    );

    const decisions = await fetchReviewDecisions(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [1, 2],
    });

    expect(decisions.get(1)).toBe('APPROVED');
    expect(decisions.get(2)).toBe('REVIEW_REQUIRED');
  });

  test('a REST-only client (no graphql) yields an empty map, not an error', async () => {
    const decisions = await fetchReviewDecisions(octokitWith([]), {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [1],
    });
    expect(decisions.size).toBe(0);
  });

  // A GraphQL outage must fall back, never admit. An empty map sends every PR
  // to the conservative derivation.
  test('a GraphQL failure yields an empty map rather than an assumed approval', async () => {
    const decisions = await fetchReviewDecisions(octokitWith([], {}, { graphqlThrows: true }), {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [1],
    });
    expect(decisions.size).toBe(0);
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
        { 730: [approval(GATE, 'abc123')] }
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
        { 904: [approval(GATE, 'pqr678')] }
      )
    );

    const [discovered] = await list({ owner: 'thinmansoftware', repo: 'bdc-harness' });

    expect(discovered?.reviewDecision).toBe('APPROVED');
  });

  // THE STALE-HEAD HOLE, end to end through the adapter: the gate approved the
  // PREVIOUS commit, the author pushed, and the listing must not report APPROVED.
  test('a PR whose only approval predates the current head is not APPROVED', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 905,
            title: 'fix: pushed after approval',
            state: 'open',
            html_url: 'https://example.invalid/905',
            head: { sha: 'head-new', ref: 'fix/pushed' },
            base: { ref: 'dev' },
          },
        ],
        { 905: [approval(GATE, 'head-old')] }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered?.headSha).toBe('head-new');
    expect(discovered?.reviewDecision).toBeNull();
  });

  test('a PR approved only by a non-gate human is not APPROVED', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 906,
            title: 'feat: human approved',
            state: 'open',
            html_url: 'https://example.invalid/906',
            head: { sha: 'head-1', ref: 'feat/human' },
            base: { ref: 'dev' },
          },
        ],
        { 906: [approval('a-human', 'head-1')] }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered?.reviewDecision).toBeNull();
  });

  // GitHub's aggregate is the only source that can see required approval counts
  // and CODEOWNERS, so when it is available it WINS -- including when it is
  // more RESTRICTIVE than the local reviews would suggest.
  test('GraphQL reviewDecision is preferred over the local derivation', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 907,
            title: 'feat: needs two approvals',
            state: 'open',
            html_url: 'https://example.invalid/907',
            head: { sha: 'head-2', ref: 'feat/two' },
            base: { ref: 'dev' },
          },
        ],
        // Locally this looks like a clean exact-head gate approval...
        { 907: [approval(GATE, 'head-2')] },
        // ...but GitHub, which alone can see the 2-approval requirement, says no.
        { graphqlDecisions: { 907: 'REVIEW_REQUIRED' } }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered?.reviewDecision).toBe('REVIEW_REQUIRED');
  });

  test('GraphQL APPROVED is carried through', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 908,
            title: 'feat: codeowner approved',
            state: 'open',
            html_url: 'https://example.invalid/908',
            head: { sha: 'head-3', ref: 'feat/owner' },
            base: { ref: 'dev' },
          },
        ],
        {},
        { graphqlDecisions: { 908: 'APPROVED' } }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered?.reviewDecision).toBe('APPROVED');
  });

  test('a GraphQL failure falls back to the conservative derivation', async () => {
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 909,
            title: 'feat: graphql down',
            state: 'open',
            html_url: 'https://example.invalid/909',
            head: { sha: 'head-4', ref: 'feat/fallback' },
            base: { ref: 'dev' },
          },
        ],
        { 909: [approval(GATE, 'head-4')] },
        { graphqlThrows: true }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered?.reviewDecision).toBe('APPROVED');
  });

  // The unpaginated read could not see review 101. Through the adapter, a late
  // objection past the first page must still block.
  test('a late CHANGES_REQUESTED past review 100 is seen by the adapter', async () => {
    const many: FakeReview[] = [];
    for (let i = 0; i < 100; i += 1) many.push(approval(GATE, 'head-5'));
    many.push(changesRequested('late-objector', 'head-5'));

    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 910,
            title: 'feat: busy pr',
            state: 'open',
            html_url: 'https://example.invalid/910',
            head: { sha: 'head-5', ref: 'feat/busy' },
            base: { ref: 'dev' },
          },
        ],
        { 910: many }
      )
    );

    const [discovered] = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered?.reviewDecision).toBe('CHANGES_REQUESTED');
  });
});
