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
  createCountedGitHubReconcileDeps,
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
    expect(index.stats()).toEqual({
      searchesAttempted: 0,
      searchesSucceeded: 0,
      listPagesAttempted: 1,
      listPagesSucceeded: 1,
    });
  });

  test('a listing page that THROWS is still counted as attempted', async () => {
    // #796 review: counting only after a successful response hides the call
    // that actually consumed the budget -- the one that got the 403.
    const failing = async (): Promise<never> =>
      ({
        search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
        issues: {
          createComment: async () => undefined,
          addLabels: async () => undefined,
          update: async () => undefined,
          listForRepo: async () => {
            throw Object.assign(new Error('API rate limit exceeded for user ID 255238497'), {
              status: 403,
            });
          },
        },
        pulls: { listFiles: async () => ({ data: [] }), get: async () => ({ data: {} }) },
      }) as never;
    const index = createTrackerIndex(failing);

    await expect(index.findTrackerIssueByStem('WO-HARNESS-ANY-01')).rejects.toThrow();

    expect(index.stats()).toMatchObject({ listPagesAttempted: 1, listPagesSucceeded: 0 });
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

/**
 * The telemetry must MEASURE, not assume (#804 review).
 *
 * These drive the REAL `createCountedGitHubReconcileDeps` -- the same counting
 * and reporting code `createDefaultReconcileDeps` ships -- against a stub
 * client. The first cut's tests faked the reporter and asserted the constant it
 * printed, which is exactly why they could not catch that it printed a constant.
 */
describe('#796 -- the per-pass call counts are MEASURED and logged', () => {
  /** A client whose search queries succeed, fail, or throw per a script. */
  function scriptedOctokit(searchOutcomes: ('ok' | 'rate-limit')[]): {
    client: () => Promise<never>;
    issued: number;
  } {
    const state = { issued: 0 };
    const client = {
      search: {
        issuesAndPullRequests: async () => {
          const outcome = searchOutcomes[state.issued] ?? 'ok';
          state.issued += 1;
          if (outcome === 'rate-limit') {
            throw Object.assign(new Error('API rate limit exceeded for user ID 255238497'), {
              status: 403,
            });
          }
          return { data: { items: [] } };
        },
      },
      issues: {
        createComment: async () => undefined,
        addLabels: async () => undefined,
        update: async () => undefined,
        listForRepo: async () => ({ data: [] }),
      },
      pulls: { listFiles: async () => ({ data: [] }), get: async () => ({ data: {} }) },
    };
    return {
      client: async () => client as never,
      get issued() {
        return state.issued;
      },
    };
  }

  function countedDeps(searchOutcomes: ('ok' | 'rate-limit')[] = []): {
    deps: ReconcileDeps;
    reports: Record<string, unknown>[];
    issued: number;
  } {
    const reports: Record<string, unknown>[] = [];
    const octokit = scriptedOctokit(searchOutcomes);
    const logger = {
      warn: () => {},
      info: (fields: Record<string, unknown>, message: string) => {
        if (message === 'overseer.reconcile.github_calls_per_pass') reports.push(fields);
      },
    };
    const counted = createCountedGitHubReconcileDeps(octokit.client, logger);
    return {
      reports,
      get issued() {
        return octokit.issued;
      },
      deps: {
        readCursor: async () => null,
        now: () => new Date('2026-09-08T05:00:00Z'),
        addTrackerEvidenceComment: async () => undefined,
        addTrackerLabel: async () => undefined,
        closeTrackerIssue: async () => undefined,
        hasSkipBeenNoted: async () => false,
        hasCloseBeenRecorded: async () => false,
        insertAction: async () => undefined,
        log: logger,
        ...counted,
      },
    };
  }

  test('a clean pass reports the TRUE counts: 2 attempted, 2 succeeded', async () => {
    const fake = countedDeps(['ok', 'ok']);

    await runReconcileOnce({ deps: fake.deps });

    expect(fake.reports).toHaveLength(1);
    expect(fake.reports[0]).toMatchObject({
      searches: 2,
      searchesSucceeded: 2,
      mergedPrSearchesAttempted: 2,
      mergedPrSearchesSucceeded: 2,
      stemSearchesAttempted: 0,
    });
    // The report matches what the client actually saw -- the assertion the
    // constant-printing version could never make.
    expect(fake.reports[0]?.searches).toBe(fake.issued);
  });

  test('a pass that fails on the FIRST query reports attempted=1 succeeded=0', async () => {
    const fake = countedDeps(['rate-limit']);

    const result = await runReconcileOnce({ deps: fake.deps });

    expect(result.skipped).toBe(true);
    // The exact defect: this used to report 2 searches for a pass that issued
    // one and got a 403 -- in the very log line meant to explain the skip.
    expect(fake.reports[0]).toMatchObject({
      searches: 1,
      searchesSucceeded: 0,
      mergedPrSearchesAttempted: 1,
      mergedPrSearchesSucceeded: 0,
    });
    expect(fake.issued).toBe(1);
  });

  test('a pass that fails on the SECOND query reports attempted=2 succeeded=1', async () => {
    const fake = countedDeps(['ok', 'rate-limit']);

    await runReconcileOnce({ deps: fake.deps });

    expect(fake.reports[0]).toMatchObject({ searches: 2, searchesSucceeded: 1 });
  });

  test('a pass that never issues a query reports ZERO, not the expected 2', async () => {
    // resolveSearchSince throws before any GitHub call, so nothing was issued.
    const fake = countedDeps(['ok', 'ok']);
    fake.deps.readCursor = async () => {
      throw new Error('cursor store unavailable');
    };

    await expect(runReconcileOnce({ deps: fake.deps })).rejects.toThrow();

    // Reported from the `finally`, and honest: no call was made.
    expect(fake.reports[0]).toMatchObject({ searches: 0, searchesSucceeded: 0 });
    expect(fake.issued).toBe(0);
  });

  test('the tracker listing pages are reported too, attempted and succeeded', async () => {
    const fake = countedDeps(['ok', 'ok']);

    await runReconcileOnce({ deps: fake.deps });

    // No PRs came back, so no stem was looked up and the index stayed unbuilt --
    // the lazy path, honestly reported as zero pages rather than assumed one.
    expect(fake.reports[0]).toMatchObject({
      trackerListPagesAttempted: 0,
      trackerListPagesSucceeded: 0,
    });
  });

  test('a COMPLETE pass issues exactly MERGED_PR_SEARCH_QUERIES searches', () => {
    // The constant is now only the EXPECTED count for a complete pass; the
    // telemetry no longer derives its numbers from it.
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
