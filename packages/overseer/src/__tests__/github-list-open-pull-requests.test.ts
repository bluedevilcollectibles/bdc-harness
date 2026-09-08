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
  fetchAllOpenPullRequests,
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
  /** Record every pulls.list page requested, to assert the listing paginated. */
  readonly pullPageLog?: number[];
  /**
   * Record the PR numbers asked for in each GraphQL request, one entry per
   * request, so tests can assert the query was BATCHED rather than sent as one
   * unbounded alias set.
   */
  readonly graphqlBatchLog?: number[][];
  /**
   * Fail any GraphQL request that asks about one of these PR numbers, leaving
   * every other batch to succeed. Models GitHub rejecting a single query on
   * node/complexity grounds.
   */
  readonly graphqlFailForPrNumbers?: readonly number[];
}

/** PR numbers a batched review-decision query is asking about. */
function prNumbersInQuery(query: string): number[] {
  return [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map(match => Number(match[1]));
}

function octokitWith(
  pulls: FakePullRequest[],
  reviewsByNumber: Record<number, FakeReview[]> = {},
  options: OctokitFakeOptions = {}
): RealGitHubOctokitLike {
  const client: Record<string, unknown> = {
    pulls: {
      // Serves real PAGES, exactly as the REST API does: `per_page` bounds each
      // page and a short page is the last one. A fake that ignored paging and
      // returned everything at once is what let the unpaginated listing bug
      // reach production -- the double must be able to fail the same way.
      list: async (input: { per_page?: number; page?: number }) => {
        const perPage = input.per_page ?? pulls.length;
        const page = input.page ?? 1;
        options.pullPageLog?.push(page);
        const start = (page - 1) * perPage;
        return { data: pulls.slice(start, start + perPage) };
      },
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
    client.graphql = async (query: string) => {
      options.graphqlBatchLog?.push(prNumbersInQuery(query));
      throw new Error('graphql unavailable');
    };
  } else if (options.graphqlDecisions) {
    const decisions = options.graphqlDecisions;
    const failFor = new Set(options.graphqlFailForPrNumbers ?? []);
    // Answers ONLY what the query asked about. A double that returned every
    // decision regardless of the request could not tell a batched query from an
    // unbounded one, and would hide the batching entirely.
    client.graphql = async (query: string) => {
      const asked = prNumbersInQuery(query);
      options.graphqlBatchLog?.push(asked);
      if (asked.some(number => failFor.has(number))) {
        throw new Error('graphql query too complex');
      }
      return {
        repository: Object.fromEntries(
          asked
            .filter(number => Object.hasOwn(decisions, number))
            .map(number => [`pr${number}`, { number, reviewDecision: decisions[number] }])
        ),
      };
    };
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

    const lookup = await fetchReviewDecisions(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [1, 2],
    });

    expect(lookup.decisions.get(1)).toBe('APPROVED');
    expect(lookup.decisions.get(2)).toBe('REVIEW_REQUIRED');
    // A clean read is NOT a degradation.
    expect(lookup.unavailableReason).toBeNull();
  });

  test('a REST-only client (no graphql) reports graphql_client_absent', async () => {
    const lookup = await fetchReviewDecisions(octokitWith([]), {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [1],
    });
    expect(lookup.decisions.size).toBe(0);
    expect(lookup.unavailableReason).toBe('graphql_client_absent');
  });

  // A GraphQL outage must fall back, never admit. An empty map sends every PR
  // to the conservative derivation -- and says so, with the error class.
  test('a GraphQL failure yields an empty map and a named reason, not an assumed approval', async () => {
    const lookup = await fetchReviewDecisions(octokitWith([], {}, { graphqlThrows: true }), {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [1],
    });
    expect(lookup.decisions.size).toBe(0);
    expect(lookup.unavailableReason).toBe('graphql_error');
    expect(lookup.errorClass).toBe('Error');
  });

  // Asking about nothing is not a degradation; it must not fire the warn line.
  test('an empty PR list is not reported as unavailable', async () => {
    const lookup = await fetchReviewDecisions(octokitWith([], {}, { graphqlThrows: true }), {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [],
    });
    expect(lookup.unavailableReason).toBeNull();
  });
});

/**
 * VISIBILITY OF THE FALLBACK.
 *
 * The REST derivation is deliberately STRICTER than GitHub's aggregate, so a
 * GraphQL outage -- an expired token is enough -- silently TIGHTENS the merge
 * gate: PRs GitHub considers approved begin reading `review_not_approved` and
 * simply stop merging. That is indistinguishable from a quiet backlog, which is
 * the exact failure #758 exists to end. So the degradation is announced once
 * per tick and counted on the heartbeat.
 */
describe('createRealListOpenPullRequests -- fallback visibility', () => {
  function warnCapturingList(options: OctokitFakeOptions) {
    const warnings: { obj: Record<string, unknown>; msg: string }[] = [];
    const list = createRealListOpenPullRequests(
      octokitWith(
        [
          {
            number: 920,
            title: 'feat: one',
            state: 'open',
            html_url: 'https://example.invalid/920',
            head: { sha: 'head-a', ref: 'feat/one' },
            base: { ref: 'dev' },
          },
          {
            number: 921,
            title: 'feat: two',
            state: 'open',
            html_url: 'https://example.invalid/921',
            head: { sha: 'head-b', ref: 'feat/two' },
            base: { ref: 'dev' },
          },
          // On an unwatched base: never consults reviews, so not a casualty.
          {
            number: 922,
            title: 'feat: three',
            state: 'open',
            html_url: 'https://example.invalid/922',
            head: { sha: 'head-c', ref: 'feat/three' },
            base: { ref: 'main' },
          },
        ],
        {
          920: [approval(GATE, 'head-a')],
          921: [approval(GATE, 'head-b')],
        },
        options
      ),
      { logger: { warn: (obj, msg) => warnings.push({ obj, msg }) } }
    );
    return { list, warnings };
  }

  test('a GraphQL error takes the fallback path AND logs one warn line per tick', async () => {
    const { list, warnings } = warnCapturingList({ graphqlThrows: true });

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    // THE FALLBACK RAN: exact-head gate approvals still resolve to APPROVED.
    expect(discovered.find(pr => pr.prNumber === 920)?.reviewDecision).toBe('APPROVED');
    expect(discovered.find(pr => pr.prNumber === 921)?.reviewDecision).toBe('APPROVED');

    // ...AND it is visible: ONE line for the whole tick, not one per PR.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toBe('merge-coordinator.review_decision_graphql_unavailable');
    expect(warnings[0]?.obj).toMatchObject({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      reason: 'graphql_error',
      errorClass: 'Error',
      // Only the two PRs on a watched base were asked about.
      prsAffected: 2,
    });

    // Evaluated PRs are marked so the heartbeat can count them; the
    // unwatched-base PR is not a fallback casualty.
    expect(discovered.find(pr => pr.prNumber === 920)?.reviewDecisionFromFallback).toBe(true);
    expect(discovered.find(pr => pr.prNumber === 921)?.reviewDecisionFromFallback).toBe(true);
    expect(discovered.find(pr => pr.prNumber === 922)?.reviewDecisionFromFallback).toBeUndefined();
  });

  test('a healthy GraphQL read logs nothing and marks no fallback', async () => {
    const { list, warnings } = warnCapturingList({
      graphqlDecisions: { 920: 'APPROVED', 921: 'REVIEW_REQUIRED' },
    });

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(warnings).toHaveLength(0);
    expect(discovered.find(pr => pr.prNumber === 920)?.reviewDecision).toBe('APPROVED');
    expect(discovered.find(pr => pr.prNumber === 921)?.reviewDecision).toBe('REVIEW_REQUIRED');
    expect(discovered.find(pr => pr.prNumber === 920)?.reviewDecisionFromFallback).toBe(false);
  });

  test('a REST-only client is reported too -- the gate is degraded either way', async () => {
    const { list, warnings } = warnCapturingList({});

    await list({ owner: 'thinmansoftware', repo: 'bdc-harness', baseBranches: ['dev'] });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toMatchObject({ reason: 'graphql_client_absent', prsAffected: 2 });
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
      // No GraphQL client on this fake, so the conservative fallback resolved it.
      reviewDecisionFromFallback: true,
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

/**
 * OPEN-PR LISTING PAGINATION (Overseer review of e729fea5).
 *
 * `octokit.pulls.list({ per_page: 100 })` unpaginated was the bug: a repo with
 * more than 100 open PRs silently omits every later page on every tick, so
 * those PRs are never evaluated as merge candidates and nothing anywhere says
 * why. That is the invisible-candidate failure #758 exists to end, recreated
 * one layer down -- and it fails looking exactly like a quiet backlog.
 *
 * Two open PRs against master on shopops alone already run to ~30; shopops and
 * bdc-harness together can cross 100, so this is reachable, not theoretical.
 */
describe('open pull request listing pagination', () => {
  /** `count` open PRs on `dev`, numbered 1..count, each with its own head. */
  function manyOpenPulls(count: number): FakePullRequest[] {
    return Array.from({ length: count }, (_unused, index) => {
      const number = index + 1;
      return {
        number,
        title: `feat: pr ${number}`,
        state: 'open',
        html_url: `https://example.invalid/${number}`,
        head: { sha: `head-${number}`, ref: `feat/pr-${number}` },
        base: { ref: 'dev' },
      };
    });
  }

  // THE HEADLINE. 150 open PRs is two pages; an unpaginated read sees 100 and
  // the 50 newest simply do not exist as far as the merge coordinator knows.
  test('150 open PRs across two pages are all listed', async () => {
    const pullPageLog: number[] = [];
    const list = createRealListOpenPullRequests(
      octokitWith(manyOpenPulls(150), {}, { pullPageLog }),
      { logger: { warn: () => undefined } }
    );

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered).toHaveLength(150);
    // Every PR number 1..150 is present -- not merely the right count.
    const numbers = discovered.map(pr => pr.prNumber).sort((a, b) => a - b);
    expect(numbers[0]).toBe(1);
    expect(numbers[149]).toBe(150);
    expect(new Set(numbers).size).toBe(150);
    // It actually followed pages rather than asking for one huge one.
    expect(pullPageLog).toEqual([1, 2]);
    // A complete read flags nothing.
    expect(discovered.every(pr => pr.listingTruncated === undefined)).toBe(true);
  });

  // A short first page is the last page: no wasted second request.
  test('a single short page stops after one request', async () => {
    const pullPageLog: number[] = [];
    const list = createRealListOpenPullRequests(octokitWith(manyOpenPulls(3), {}, { pullPageLog }));

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered).toHaveLength(3);
    expect(pullPageLog).toEqual([1]);
  });

  // An exactly-full final page cannot be distinguished from "more to come"
  // without asking, so it asks -- and the empty page ends it.
  test('an exactly-full page is followed by one more request that ends the walk', async () => {
    const pullPageLog: number[] = [];
    const list = createRealListOpenPullRequests(
      octokitWith(manyOpenPulls(100), {}, { pullPageLog }),
      { logger: { warn: () => undefined } }
    );

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered).toHaveLength(100);
    expect(pullPageLog).toEqual([1, 2]);
    expect(discovered.every(pr => pr.listingTruncated === undefined)).toBe(true);
  });

  // THE CAP. 1001 PRs exceeds 10 pages x 100. The tick must not spin, so it
  // stops -- but the omission is LOGGED and FLAGGED, never silent, because a
  // truncated sweep and an empty queue look identical from the outside.
  test('hitting the page cap logs it and flags the partial list instead of truncating silently', async () => {
    const pullPageLog: number[] = [];
    const warnings: { obj: Record<string, unknown>; msg: string }[] = [];
    const list = createRealListOpenPullRequests(
      octokitWith(manyOpenPulls(1001), {}, { pullPageLog }),
      { logger: { warn: (obj, msg) => warnings.push({ obj, msg }) } }
    );

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    // Stopped at the ceiling rather than walking 11 pages.
    expect(pullPageLog).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(discovered).toHaveLength(1000);

    // SAID OUT LOUD, exactly once per repo per tick, with the numbers an
    // operator needs. Filtered by message rather than asserting the total
    // warning count: this REST-only fake also emits the pre-existing
    // graphql-unavailable line, which is a separate, legitimate warning.
    const truncationWarnings = warnings.filter(
      entry => entry.msg === 'merge-coordinator.open_pull_request_listing_truncated'
    );
    expect(truncationWarnings).toHaveLength(1);
    expect(truncationWarnings[0]?.obj).toMatchObject({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      pagesRead: 10,
      pullsRead: 1000,
    });

    // ...and carried on the returned candidates, so a caller reading only the
    // return value can still tell the sweep was partial.
    expect(discovered.every(pr => pr.listingTruncated === true)).toBe(true);
  });

  // The flag marks a partial SWEEP, not a defective PR: the ones that were read
  // are still fully evaluated candidates and keep their real review decision.
  test('a truncated sweep still evaluates the PRs it did read', async () => {
    const pulls = manyOpenPulls(1001);
    const list = createRealListOpenPullRequests(
      octokitWith(
        pulls,
        {},
        {
          pullPageLog: [],
          graphqlDecisions: { 1: 'APPROVED' },
        }
      ),
      { logger: { warn: () => undefined } }
    );

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    const first = discovered.find(pr => pr.prNumber === 1);
    expect(first?.reviewDecision).toBe('APPROVED');
    expect(first?.listingTruncated).toBe(true);
  });

  // Base filtering is unchanged by pagination: a PR on an unwatched base is
  // still COUNTED and returned (reporting base_branch_not_watched upstream)
  // rather than silently absent -- and it too carries the truncation flag.
  test('pagination does not change base filtering or the unwatched-base record', async () => {
    const pulls = manyOpenPulls(150);
    // Move one PR on the second page to an unwatched base.
    const target = pulls[120];
    if (target) target.base = { ref: 'release/ce' };

    const list = createRealListOpenPullRequests(octokitWith(pulls), {
      logger: { warn: () => undefined },
    });

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered).toHaveLength(150);
    const unwatched = discovered.find(pr => pr.prNumber === 121);
    expect(unwatched?.baseRef).toBe('release/ce');
    expect(unwatched?.reviewDecision).toBeNull();
  });
});

describe('fetchAllOpenPullRequests', () => {
  function pageOf(count: number, offset = 0): FakePullRequest[] {
    return Array.from({ length: count }, (_unused, index) => {
      const number = offset + index + 1;
      return {
        number,
        title: `feat: pr ${number}`,
        state: 'open',
        html_url: `https://example.invalid/${number}`,
        head: { sha: `head-${number}`, ref: `feat/pr-${number}` },
        base: { ref: 'dev' },
      };
    });
  }

  test('reports complete on a short page and returns every PR', async () => {
    const result = await fetchAllOpenPullRequests(octokitWith(pageOf(150)), {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
    });

    expect(result.complete).toBe(true);
    expect(result.pulls).toHaveLength(150);
  });

  test('reports incomplete when the page ceiling is reached', async () => {
    const result = await fetchAllOpenPullRequests(octokitWith(pageOf(1001)), {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
    });

    expect(result.complete).toBe(false);
    expect(result.pulls).toHaveLength(1000);
  });

  test('an empty repo reads one page and reports complete', async () => {
    const result = await fetchAllOpenPullRequests(octokitWith([]), {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
    });

    expect(result.complete).toBe(true);
    expect(result.pulls).toHaveLength(0);
  });
});

/**
 * REVIEW-DECISION QUERY BATCHING (Overseer review of 8ada980c).
 *
 * `fetchReviewDecisions` interpolated one aliased field per PR into a SINGLE
 * unbounded GraphQL request. GitHub costs a query by node count and complexity
 * and rejects a large alias set WHOLESALE -- and the old failure path emptied
 * the whole decision map, so one rejected request dumped every PR in the tick
 * onto the sequential REST derivation. With the open-PR listing now paginating
 * to 1000, that is up to 1000 REST lookups, each itself paginated, in one tick.
 *
 * The query is now batched, and a failure is isolated to its own batch.
 */
describe('review decision query batching', () => {
  function decisionsFor(
    count: number,
    value: string | null = 'APPROVED'
  ): Record<number, string | null> {
    const out: Record<number, string | null> = {};
    for (let number = 1; number <= count; number += 1) out[number] = value;
    return out;
  }

  // THE HEADLINE. 120 PRs at 50 per request is 3 requests, not 1 unbounded one.
  test('120 PRs are asked for in 3 batched GraphQL requests', async () => {
    const graphqlBatchLog: number[][] = [];
    const octokit = octokitWith([], {}, { graphqlDecisions: decisionsFor(120), graphqlBatchLog });

    const lookup = await fetchReviewDecisions(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: Array.from({ length: 120 }, (_unused, index) => index + 1),
    });

    expect(graphqlBatchLog).toHaveLength(3);
    expect(graphqlBatchLog[0]).toHaveLength(50);
    expect(graphqlBatchLog[1]).toHaveLength(50);
    expect(graphqlBatchLog[2]).toHaveLength(20);
    // Every PR is covered exactly once across the batches -- none dropped, none
    // asked for twice.
    const asked = graphqlBatchLog.flat().sort((a, b) => a - b);
    expect(asked).toHaveLength(120);
    expect(new Set(asked).size).toBe(120);

    expect(lookup.batchCount).toBe(3);
    expect(lookup.failedBatchCount).toBe(0);
    expect(lookup.unavailableReason).toBeNull();
    expect(lookup.decisions.size).toBe(120);
    expect(lookup.fallbackPrNumbers).toHaveLength(0);
  });

  // THE ISOLATION. One rejected batch must not discard the answers the other
  // batches obtained -- that is what turned a single complexity rejection into
  // a whole-tick REST stampede.
  test('one failing batch falls back only for its own PRs', async () => {
    const graphqlBatchLog: number[][] = [];
    const octokit = octokitWith(
      [],
      {},
      {
        graphqlDecisions: decisionsFor(120),
        // PR 60 sits in the second batch (51-100).
        graphqlFailForPrNumbers: [60],
        graphqlBatchLog,
      }
    );

    const lookup = await fetchReviewDecisions(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: Array.from({ length: 120 }, (_unused, index) => index + 1),
    });

    // All three requests were still issued: a failure does not abort the walk.
    expect(lookup.batchCount).toBe(3);
    expect(lookup.failedBatchCount).toBe(1);
    expect(lookup.unavailableReason).toBe('graphql_error');

    // The two healthy batches kept their answers.
    expect(lookup.decisions.size).toBe(70);
    expect(lookup.decisions.get(1)).toBe('APPROVED');
    expect(lookup.decisions.get(120)).toBe('APPROVED');

    // Only the failed batch's 50 PRs fall back.
    expect(lookup.fallbackPrNumbers).toHaveLength(50);
    expect(lookup.fallbackPrNumbers).toContain(60);
    expect(lookup.fallbackPrNumbers).not.toContain(1);
    expect(lookup.fallbackPrNumbers).not.toContain(120);
    // A PR in a healthy batch is NOT absent from the map -- absence is the
    // fallback signal, so this is the assertion that proves isolation.
    expect(lookup.decisions.has(1)).toBe(true);
    expect(lookup.decisions.has(60)).toBe(false);
  });

  test('a single batch under the size bound issues exactly one request', async () => {
    const graphqlBatchLog: number[][] = [];
    const octokit = octokitWith([], {}, { graphqlDecisions: decisionsFor(10), graphqlBatchLog });

    const lookup = await fetchReviewDecisions(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });

    expect(graphqlBatchLog).toHaveLength(1);
    expect(lookup.batchCount).toBe(1);
    expect(lookup.decisions.size).toBe(10);
  });

  test('exactly 50 PRs is one batch, 51 is two', async () => {
    const logAt50: number[][] = [];
    await fetchReviewDecisions(
      octokitWith([], {}, { graphqlDecisions: decisionsFor(51), graphqlBatchLog: logAt50 }),
      {
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumbers: Array.from({ length: 50 }, (_unused, index) => index + 1),
      }
    );
    expect(logAt50).toHaveLength(1);

    const logAt51: number[][] = [];
    await fetchReviewDecisions(
      octokitWith([], {}, { graphqlDecisions: decisionsFor(51), graphqlBatchLog: logAt51 }),
      {
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumbers: Array.from({ length: 51 }, (_unused, index) => index + 1),
      }
    );
    expect(logAt51).toHaveLength(2);
    expect(logAt51[1]).toEqual([51]);
  });

  // Every batch failing is the old whole-sweep outage, and must still report as
  // one: nothing was learned, everything falls back.
  test('every batch failing falls back for every PR', async () => {
    const octokit = octokitWith([], {}, { graphqlThrows: true });

    const lookup = await fetchReviewDecisions(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: Array.from({ length: 120 }, (_unused, index) => index + 1),
    });

    expect(lookup.batchCount).toBe(3);
    expect(lookup.failedBatchCount).toBe(3);
    expect(lookup.decisions.size).toBe(0);
    expect(lookup.fallbackPrNumbers).toHaveLength(120);
    expect(lookup.unavailableReason).toBe('graphql_error');
  });

  // A batch that answers but OMITS a PR leaves it absent from the map, which is
  // the fallback signal -- it must be counted, not silently treated as clean.
  test('a PR omitted by an answering batch is counted as fallen back', async () => {
    // Decisions cover 1 and 3 but not 2, so the response omits pr2.
    const octokit = octokitWith([], {}, { graphqlDecisions: { 1: 'APPROVED', 3: 'APPROVED' } });

    const lookup = await fetchReviewDecisions(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [1, 2, 3],
    });

    expect(lookup.decisions.has(1)).toBe(true);
    expect(lookup.decisions.has(2)).toBe(false);
    expect(lookup.fallbackPrNumbers).toEqual([2]);
    // No request THREW, so this is not an error -- it is an incomplete answer.
    expect(lookup.failedBatchCount).toBe(0);
    expect(lookup.unavailableReason).toBe('graphql_empty_response');
  });

  test('no PRs asks nothing and reports a clean read', async () => {
    const graphqlBatchLog: number[][] = [];
    const lookup = await fetchReviewDecisions(
      octokitWith([], {}, { graphqlDecisions: {}, graphqlBatchLog }),
      { owner: 'thinmansoftware', repo: 'bdc-harness', prNumbers: [] }
    );

    expect(graphqlBatchLog).toHaveLength(0);
    expect(lookup.batchCount).toBe(0);
    expect(lookup.unavailableReason).toBeNull();
    expect(lookup.fallbackPrNumbers).toHaveLength(0);
  });

  test('an absent GraphQL client falls back for every PR without issuing a request', async () => {
    const lookup = await fetchReviewDecisions(octokitWith([]), {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumbers: [1, 2, 3],
    });

    expect(lookup.unavailableReason).toBe('graphql_client_absent');
    expect(lookup.batchCount).toBe(0);
    expect(lookup.fallbackPrNumbers).toEqual([1, 2, 3]);
  });
});

/**
 * The batching must reach the discovery path, not just the helper: a PR whose
 * own batch succeeded must NOT be flagged as having used the stricter REST
 * fallback merely because some other batch failed.
 */
describe('per-PR fallback flagging through discovery', () => {
  function openPullsFor(count: number): FakePullRequest[] {
    return Array.from({ length: count }, (_unused, index) => {
      const number = index + 1;
      return {
        number,
        title: `feat: pr ${number}`,
        state: 'open',
        html_url: `https://example.invalid/${number}`,
        head: { sha: `head-${number}`, ref: `feat/pr-${number}` },
        base: { ref: 'dev' },
      };
    });
  }

  test('only the PRs in the failed batch are marked reviewDecisionFromFallback', async () => {
    const decisions: Record<number, string | null> = {};
    for (let number = 1; number <= 120; number += 1) decisions[number] = 'APPROVED';
    const warnings: { obj: Record<string, unknown>; msg: string }[] = [];

    const list = createRealListOpenPullRequests(
      octokitWith(
        openPullsFor(120),
        {},
        {
          graphqlDecisions: decisions,
          graphqlFailForPrNumbers: [60],
        }
      ),
      { logger: { warn: (obj, msg) => warnings.push({ obj, msg }) } }
    );

    const discovered = await list({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      baseBranches: ['dev'],
    });

    expect(discovered).toHaveLength(120);
    const first = discovered.find(pr => pr.prNumber === 1);
    const failed = discovered.find(pr => pr.prNumber === 60);
    // The healthy batch kept GitHub's authoritative answer and is NOT degraded.
    expect(first?.reviewDecision).toBe('APPROVED');
    expect(first?.reviewDecisionFromFallback).toBe(false);
    // The failed batch's PRs fell back to the stricter derivation.
    expect(failed?.reviewDecisionFromFallback).toBe(true);

    // The warn line reports the BATCH shape, and counts only the PRs actually
    // affected rather than the whole sweep.
    const degraded = warnings.filter(
      entry => entry.msg === 'merge-coordinator.review_decision_graphql_unavailable'
    );
    expect(degraded).toHaveLength(1);
    expect(degraded[0]?.obj).toMatchObject({
      reason: 'graphql_error',
      prsAffected: 50,
      batchCount: 3,
      failedBatchCount: 1,
    });
  });
});
