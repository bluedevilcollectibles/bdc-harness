/**
 * #796 -- reconcile must not spend a GitHub SEARCH per WO stem.
 *
 * The corrected diagnosis (issue comment, 2026-09-08 04:50Z): the cap being hit
 * was the search API's own 30-requests-per-minute limit, NOT the 5,000/hour core
 * budget. Seven `overseer.reconcile.rate_limit_skip` blocks were logged between
 * 04:15 and 04:46Z, each carrying a `stem` field -- i.e. one search per WO stem
 * per pass -- while `gh api rate_limit` read core 4,999/5,000 at 04:48Z.
 *
 * `findTrackerIssueByStem` is now backed by ONE `issues.listForRepo` walk of the
 * tracker repo per pass, matched locally. These tests hold that line by counting
 * the calls a fake octokit receives.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  MERGED_PR_SEARCH_QUERIES,
  TRACKER_INDEX_MAX_PAGES,
  createTrackerIndex,
  runReconcileOnce,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
} from '../reconcile';
import {
  UNPROTECTED_CACHE_TTL_MS,
  inMemoryAttemptCounterStore,
  resetRequiredContextsAttemptCounters,
  resetUnprotectedBranchCache,
  resolveRequiredContexts,
} from '../adapters/required-contexts.ts';

afterEach(() => {
  resetUnprotectedBranchCache();
  resetRequiredContextsAttemptCounters();
});

/** Forty distinct WO stems -- the scale the issue's stop condition names. */
function fortyStems(): string[] {
  return Array.from({ length: 40 }, (_, index) => `WO-HARNESS-BUDGET-CASE-${index}-01`);
}

interface CallCounts {
  searches: number;
  listForRepo: number;
  listForRepoPages: number[];
}

/**
 * A fake octokit that COUNTS. Every call the tracker index makes lands here, so
 * a regression to per-stem searching shows up as a number, not as a judgement.
 */
function countingOctokit(
  openIssueTitles: string[],
  options: { pageSize?: number } = {}
): { client: Parameters<typeof createTrackerIndex>[0]; counts: CallCounts } {
  const counts: CallCounts = { searches: 0, listForRepo: 0, listForRepoPages: [] };
  const pageSize = options.pageSize ?? 100;
  const issues = openIssueTitles.map((title, index) => ({
    number: 1000 + index,
    title,
    state: 'open',
  }));
  const client = {
    search: {
      issuesAndPullRequests: async () => {
        counts.searches += 1;
        return { data: { items: [] } };
      },
    },
    issues: {
      createComment: async () => undefined,
      addLabels: async () => undefined,
      update: async () => undefined,
      listForRepo: async (input: Record<string, unknown>) => {
        counts.listForRepo += 1;
        const page = Number(input.page ?? 1);
        counts.listForRepoPages.push(page);
        return { data: issues.slice((page - 1) * pageSize, page * pageSize) };
      },
    },
    pulls: {
      listFiles: async () => ({ data: [] }),
      get: async () => {
        throw new Error('not used');
      },
    },
  };
  return { client: async () => client as never, counts };
}

describe('#796 -- the tracker lookup costs one listing, not one search per stem', () => {
  test('40 stems resolve with ZERO searches and a single listing page', async () => {
    const stems = fortyStems();
    const { client, counts } = countingOctokit(stems);
    const index = createTrackerIndex(client);

    for (const stem of stems) {
      expect((await index.findTrackerIssueByStem(stem))?.title).toBe(stem);
    }

    // The stop condition, verbatim: at most one call per repo regardless of how
    // many stems the window holds. Pre-fix this was 40 searches -- past the
    // 30/minute cap in well under a minute.
    expect(counts.searches).toBe(0);
    expect(counts.listForRepo).toBe(1);
    expect(index.stats()).toEqual({ searches: 0, listPages: 1 });
  });

  test('a stem with no open tracker resolves to null without any extra call', async () => {
    const { client, counts } = countingOctokit(['WO-HARNESS-PRESENT-01']);
    const index = createTrackerIndex(client);

    expect(await index.findTrackerIssueByStem('WO-HARNESS-ABSENT-01')).toBeNull();
    expect(await index.findTrackerIssueByStem('WO-HARNESS-PRESENT-01')).not.toBeNull();
    expect(counts.searches).toBe(0);
    expect(counts.listForRepo).toBe(1);
  });

  test('the index is built LAZILY -- a pass that looks up nothing lists nothing', async () => {
    const { client, counts } = countingOctokit(['WO-HARNESS-PRESENT-01']);
    createTrackerIndex(client);
    expect(counts.listForRepo).toBe(0);
  });

  test('matching is EXACT on title, as the search it replaces already was', async () => {
    const { client } = countingOctokit(['WO-HARNESS-EXACT-01']);
    const index = createTrackerIndex(client);

    // A prefix must not match: the old lookup filtered `item.title === stem`,
    // and loosening that here would close the wrong tracker.
    expect(await index.findTrackerIssueByStem('WO-HARNESS-EXACT-0')).toBeNull();
    expect(await index.findTrackerIssueByStem('WO-HARNESS-EXACT-01')).not.toBeNull();
  });

  test('pull requests returned by listForRepo are excluded, as the search excluded them', async () => {
    const counts: CallCounts = { searches: 0, listForRepo: 0, listForRepoPages: [] };
    const client = async () =>
      ({
        search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
        issues: {
          createComment: async () => undefined,
          addLabels: async () => undefined,
          update: async () => undefined,
          listForRepo: async () => {
            counts.listForRepo += 1;
            return {
              data: [
                // listForRepo returns PRs alongside issues; a PR titled after a
                // WO must never be mistaken for that WO's tracker.
                { number: 1, title: 'WO-HARNESS-PRLIKE-01', state: 'open', pull_request: {} },
                { number: 2, title: 'WO-HARNESS-REAL-01', state: 'open' },
              ],
            };
          },
        },
        pulls: { listFiles: async () => ({ data: [] }), get: async () => ({ data: {} }) },
      }) as never;
    const index = createTrackerIndex(client);

    expect(await index.findTrackerIssueByStem('WO-HARNESS-PRLIKE-01')).toBeNull();
    expect(await index.findTrackerIssueByStem('WO-HARNESS-REAL-01')).toMatchObject({
      number: 2,
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
    });
  });

  test('a full page is followed, and paging stops on the first short page', async () => {
    // 150 issues at 100/page: two calls, the second short, then stop.
    const titles = Array.from({ length: 150 }, (_, index) => `WO-HARNESS-PAGED-${index}-01`);
    const { client, counts } = countingOctokit(titles);
    const index = createTrackerIndex(client);

    expect(await index.findTrackerIssueByStem('WO-HARNESS-PAGED-149-01')).not.toBeNull();
    expect(counts.listForRepo).toBe(2);
    expect(counts.listForRepoPages).toEqual([1, 2]);
  });

  test('paging is capped, and a truncated index says so loudly', async () => {
    // Every page full, so the walk would never stop on its own.
    const titles = Array.from(
      { length: 100 * (TRACKER_INDEX_MAX_PAGES + 5) },
      (_, index) => `WO-HARNESS-MANY-${index}-01`
    );
    const { client, counts } = countingOctokit(titles);
    const warnings: string[] = [];
    const index = createTrackerIndex(client, {
      warn: (_fields, message) => warnings.push(message),
    });

    await index.findTrackerIssueByStem('WO-HARNESS-MANY-0-01');

    expect(counts.listForRepo).toBe(TRACKER_INDEX_MAX_PAGES);
    // A silently truncated index stops closing trackers and looks identical to
    // a clean pass, so it must be visible.
    expect(warnings).toContain('overseer.reconcile.tracker_index_truncated');
  });
});

describe('#796 -- the per-pass call counts are logged', () => {
  function budgetDeps(prs: ReconcileMergedPullRequest[]): {
    deps: ReconcileDeps;
    infos: { fields: Record<string, unknown>; message: string }[];
    reported: number;
  } {
    const infos: { fields: Record<string, unknown>; message: string }[] = [];
    const state = { reported: 0 };
    const deps: ReconcileDeps = {
      readCursor: async () => null,
      now: () => new Date('2026-09-08T05:00:00Z'),
      searchMergedPullRequests: async () => prs,
      findTrackerIssueByStem: async () => null,
      addTrackerEvidenceComment: async () => undefined,
      addTrackerLabel: async () => undefined,
      closeTrackerIssue: async () => undefined,
      hasSkipBeenNoted: async () => false,
      hasCloseBeenRecorded: async () => false,
      insertAction: async () => undefined,
      reportGitHubCallsPerPass: () => {
        state.reported += 1;
        infos.push({
          fields: { searches: MERGED_PR_SEARCH_QUERIES, stemSearches: 0 },
          message: 'overseer.reconcile.github_calls_per_pass',
        });
      },
      log: { warn: () => {}, info: () => {} },
    };
    return {
      deps,
      infos,
      get reported() {
        return state.reported;
      },
    };
  }

  test('the count is reported once on a normal pass', async () => {
    const fake = budgetDeps([]);
    await runReconcileOnce({ deps: fake.deps });
    expect(fake.reported).toBe(1);
    expect(fake.infos[0]?.fields.stemSearches).toBe(0);
  });

  test('the count is reported even when the pass SKIPS on a rate limit', async () => {
    // The skipped pass is exactly the one an operator is trying to explain, so
    // reporting only on the happy path would hide the number that matters.
    const fake = budgetDeps([]);
    fake.deps.searchMergedPullRequests = async () => {
      throw Object.assign(new Error('API rate limit exceeded for user ID 255238497'), {
        status: 403,
      });
    };
    const result = await runReconcileOnce({ deps: fake.deps });

    expect(result.skipped).toBe(true);
    expect(fake.reported).toBe(1);
  });

  test('merged-PR searches stay a fixed 2 regardless of stem count', () => {
    // One `in:title` query, one `in:body`. This is the ENTIRE search cost of a
    // pass now; it used to be 2 + one per stem.
    expect(MERGED_PR_SEARCH_QUERIES).toBe(2);
  });
});

describe('#796 -- an unprotected base is not re-probed every tick', () => {
  /**
   * A base whose protection endpoint answers "Branch not protected" and whose
   * rules endpoint returns [] -- the shopops/master shape that produced 45
   * identical calls in 30 minutes.
   */
  function unprotectedInput(counts: { protection: number; rules: number; branch: number }) {
    return {
      owner: 'thinmansoftware',
      repo: 'shopops',
      baseRef: 'master',
      headSha: 'a'.repeat(40),
      attemptStore: inMemoryAttemptCounterStore,
      fetchWithAppClient: async () => {
        counts.protection += 1;
        throw Object.assign(new Error('Branch not protected'), { status: 404 });
      },
      fetchBranchRules: async () => {
        counts.rules += 1;
        return { data: [] };
      },
      fetchBranch: async () => {
        counts.branch += 1;
        return { data: { protected: false } };
      },
    };
  }

  test('the second resolution of the same base makes no further API calls', async () => {
    const counts = { protection: 0, rules: 0, branch: 0 };
    const input = unprotectedInput(counts);

    const first = await resolveRequiredContexts(input, {});
    expect(first).toMatchObject({ state: 'known', contexts: [], source: 'unprotected_branch' });
    const afterFirst = { ...counts };

    // Five more ticks, as the worker would produce over ~3 minutes.
    for (let tick = 0; tick < 5; tick += 1) {
      const again = await resolveRequiredContexts(input, {});
      expect(again).toMatchObject({ state: 'known', contexts: [], source: 'unprotected_branch' });
    }

    expect(counts).toEqual(afterFirst);
    expect(counts.protection).toBe(1);
  });

  test('a different base is not covered by another base cache entry', async () => {
    const masterCounts = { protection: 0, rules: 0, branch: 0 };
    await resolveRequiredContexts(unprotectedInput(masterCounts), {});
    const devCounts = { protection: 0, rules: 0, branch: 0 };
    const devInput = { ...unprotectedInput(devCounts), baseRef: 'dev' };

    await resolveRequiredContexts(devInput, {});

    // Required contexts are BASE-specific; a cache keyed loosely would answer
    // "unprotected" for a base nobody probed.
    expect(devCounts.protection).toBe(1);
  });

  test('the cache is cleared explicitly, so a protection change can be picked up', async () => {
    const counts = { protection: 0, rules: 0, branch: 0 };
    const input = unprotectedInput(counts);
    await resolveRequiredContexts(input, {});
    resetUnprotectedBranchCache();

    await resolveRequiredContexts(input, {});

    expect(counts.protection).toBe(2);
    // Short enough that turning protection ON is noticed within one session.
    expect(UNPROTECTED_CACHE_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  test('a FAILED lookup is never cached -- only positive unprotected evidence is', async () => {
    const counts = { protection: 0, rules: 0, branch: 0 };
    const input = {
      ...unprotectedInput(counts),
      // Rules non-empty: no positive unprotected evidence, so this defers.
      fetchBranchRules: async () => {
        counts.rules += 1;
        return { data: [{ type: 'required_status_checks' }] };
      },
    };

    const first = await resolveRequiredContexts(input, {});
    await resolveRequiredContexts(input, {});

    expect(first.state).not.toBe('known');
    // Caching a failure would turn a transient API fault into a sticky wrong
    // answer; the attempt counter is what bounds this case (#777).
    expect(counts.protection).toBe(2);
  });
});
