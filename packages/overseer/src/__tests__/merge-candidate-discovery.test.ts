/**
 * PR-first merge candidate discovery tests (bdc-harness#758).
 *
 * The regression these lock down is precise: before this module the candidate
 * set was built ONLY from workflow runs, so an APPROVED + CLEAN pull request
 * whose originating run had already been closed could never enter the set. The
 * heartbeat reported "total":2,"eligible":0 across 19 consecutive ticks while
 * 32 PRs sat open and #730/#731 sat green and mergeable.
 *
 * Every test below constructs a small set of fake PRs and asserts both halves
 * of the fix: WHICH enter the candidate set, and WHAT SPECIFIC REASON is
 * recorded for each one that does not. Silence for an excluded PR is the defect.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyDiscoveredPullRequest,
  classifyPullRequestEvidence,
  discoverMergeCandidates,
  pullRequestKey,
  resolveDiscoveryRepos,
  resolveWatchedBaseBranches,
  summarizeExclusions,
  DEFAULT_WATCHED_BASE_BRANCHES,
} from '../merge-candidate-discovery.ts';
import { watchOnce } from '../watch.ts';
import type {
  DiscoveredPullRequest,
  GitHubClientDeps,
  MergeCandidateDiscoveryDeps,
  OverseerRunStoreDeps,
  PullRequestEvidence,
} from '../types.ts';

const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const WATCHED_BASES = ['dev', 'staging'] as const;
const REPOS = [{ owner: OWNER, repo: REPO }];

function pr(
  overrides: Partial<DiscoveredPullRequest> & { prNumber: number }
): DiscoveredPullRequest {
  return {
    owner: OWNER,
    repo: REPO,
    title: `pull request ${overrides.prNumber}`,
    state: 'open',
    draft: false,
    baseRef: 'dev',
    headRef: `feat/pr-${overrides.prNumber}`,
    headSha: `sha-${overrides.prNumber}`,
    reviewDecision: 'APPROVED',
    ...overrides,
  };
}

function greenEvidence(prNumber: number): PullRequestEvidence {
  return {
    exists: true,
    state: 'open',
    checks: { total: 4, passed: 4, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: OWNER, repo: REPO, number: prNumber },
    prTitle: `pull request ${prNumber}`,
    headSha: `sha-${prNumber}`,
    lookupFailed: false,
  };
}

function failingChecksEvidence(prNumber: number): PullRequestEvidence {
  return {
    ...greenEvidence(prNumber),
    checks: { total: 4, passed: 3, failed: 1, pending: 0 },
  };
}

function pendingChecksEvidence(prNumber: number): PullRequestEvidence {
  return {
    ...greenEvidence(prNumber),
    checks: { total: 4, passed: 2, failed: 0, pending: 2 },
  };
}

function conflictingEvidence(prNumber: number): PullRequestEvidence {
  return { ...greenEvidence(prNumber), mergeable: false };
}

function mergeableUnknownEvidence(prNumber: number): PullRequestEvidence {
  return { ...greenEvidence(prNumber), mergeable: null };
}

function lookupFailedEvidence(): PullRequestEvidence {
  return {
    exists: false,
    state: 'lookup_failed',
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: null,
    lookupFailed: true,
  };
}

/** Build discovery deps over a fixed PR set and a per-PR evidence map. */
function discoveryDeps(
  pullRequests: readonly DiscoveredPullRequest[],
  evidenceByNumber: Record<number, PullRequestEvidence>
): MergeCandidateDiscoveryDeps {
  return {
    listOpenPullRequests: async () => pullRequests,
    findPullRequest: async input => {
      const match = pullRequests.find(candidate => candidate.headRef === input.headBranch);
      const evidence = match ? evidenceByNumber[match.prNumber] : undefined;
      if (!evidence) throw new Error(`no fixture evidence for ${String(input.headBranch)}`);
      return evidence;
    },
  };
}

describe('merge candidate discovery -- the #758 candidate set', () => {
  // THE HEADLINE CASE. A mixed set of five PRs, exactly one of which is the
  // shape #730/#731 had: open, non-draft, APPROVED, checks green, CLEAN. Before
  // the fix none of these could enter the set at all, because the set came from
  // runs. After it, exactly one enters and the other four say why they did not.
  test('approved and clean enters the set; every other PR is excluded with a named reason', async () => {
    const pullRequests = [
      pr({ prNumber: 730 }), // approved + clean -- the only candidate
      pr({ prNumber: 731 }), // approved + conflicting
      pr({ prNumber: 732, reviewDecision: 'CHANGES_REQUESTED' }),
      pr({ prNumber: 733, draft: true }),
      pr({ prNumber: 734 }), // approved but checks failing
    ];
    const evidence: Record<number, PullRequestEvidence> = {
      730: greenEvidence(730),
      731: conflictingEvidence(731),
      732: greenEvidence(732),
      733: greenEvidence(733),
      734: failingChecksEvidence(734),
    };

    const result = await discoverMergeCandidates(discoveryDeps(pullRequests, evidence), {
      watchedBases: WATCHED_BASES,
      repos: REPOS,
    });

    expect(result.evaluated).toBe(5);
    expect(result.unavailable).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.prEvidence.pr?.number).toBe(730);
    expect(result.candidates[0]?.action).toBe('merge_ready');

    // Every excluded PR is named, with its own reason -- not a silent drop.
    const byNumber = new Map(result.exclusions.map(item => [item.prNumber, item.reason]));
    expect(byNumber.get(731)).toBe('not_mergeable');
    expect(byNumber.get(732)).toBe('review_not_approved');
    expect(byNumber.get(733)).toBe('draft');
    expect(byNumber.get(734)).toBe('checks_failing');
    expect(result.exclusions).toHaveLength(4);
    // Every exclusion carries amplifying detail alongside the reason token.
    for (const exclusion of result.exclusions) expect(exclusion.detail.length).toBeGreaterThan(0);
  });

  test('pending checks are reported distinctly from failing checks', async () => {
    const pullRequests = [pr({ prNumber: 800 })];
    const result = await discoverMergeCandidates(
      discoveryDeps(pullRequests, { 800: pendingChecksEvidence(800) }),
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.exclusions[0]?.reason).toBe('checks_pending');
    expect(result.exclusions[0]?.detail).toContain('pending');
  });

  // mergeable=null is GitHub still computing, not a refusal. Reporting it as
  // not_mergeable is how a transient state got read as a permanent verdict.
  test('mergeable=null reports mergeable_unknown, never not_mergeable', async () => {
    const result = await discoverMergeCandidates(
      discoveryDeps([pr({ prNumber: 801 })], { 801: mergeableUnknownEvidence(801) }),
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.exclusions[0]?.reason).toBe('mergeable_unknown');
  });

  test('a PR with no checks at all is excluded as checks_absent, not admitted', async () => {
    const noChecks: PullRequestEvidence = {
      ...greenEvidence(802),
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    };
    const result = await discoverMergeCandidates(
      discoveryDeps([pr({ prNumber: 802 })], { 802: noChecks }),
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.exclusions[0]?.reason).toBe('checks_absent');
  });

  test('a PR targeting an unwatched base is excluded by name, not silently skipped', async () => {
    const result = await discoverMergeCandidates(
      discoveryDeps([pr({ prNumber: 803, baseRef: 'main' })], { 803: greenEvidence(803) }),
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(result.evaluated).toBe(1);
    expect(result.candidates).toHaveLength(0);
    expect(result.exclusions[0]?.reason).toBe('base_branch_not_watched');
    expect(result.exclusions[0]?.detail).toContain('main');
  });

  test('a failed evidence lookup is reported as unknown, never as unmergeable', async () => {
    const result = await discoverMergeCandidates(
      discoveryDeps([pr({ prNumber: 804 })], { 804: lookupFailedEvidence() }),
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.exclusions[0]?.reason).toBe('evidence_lookup_failed');
    expect(result.exclusions[0]?.detail).toContain('unknown');
  });

  test('a PR already covered by the run-derived pass is not evaluated twice', async () => {
    const result = await discoverMergeCandidates(
      discoveryDeps([pr({ prNumber: 805 })], { 805: greenEvidence(805) }),
      {
        watchedBases: WATCHED_BASES,
        repos: REPOS,
        alreadyCoveredPullRequests: new Set([pullRequestKey(OWNER, REPO, 805)]),
      }
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.exclusions[0]?.reason).toBe('already_a_run_candidate');
  });

  // "We did not look" and "there is nothing to merge" must never look alike --
  // conflating them is what let the coordinator report eligible:0 for days.
  test('a missing listOpenPullRequests dep reports unavailable, not an empty sweep', async () => {
    const result = await discoverMergeCandidates(
      { findPullRequest: async () => greenEvidence(1) },
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(result.unavailable).toBe(true);
    expect(result.evaluated).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  test('a repo whose listing throws does not blind the sweep to other repos', async () => {
    const deps: MergeCandidateDiscoveryDeps = {
      listOpenPullRequests: async input => {
        if (input.repo === 'broken') throw new Error('repo unreachable');
        return [pr({ prNumber: 806 })];
      },
      findPullRequest: async () => greenEvidence(806),
    };

    const result = await discoverMergeCandidates(deps, {
      watchedBases: WATCHED_BASES,
      repos: [
        { owner: OWNER, repo: 'broken' },
        { owner: OWNER, repo: REPO },
      ],
    });

    expect(result.unavailable).toBe(false);
    expect(result.candidates).toHaveLength(1);
  });

  test('maxPullRequestsPerTick bounds the sweep without dropping the reason log', async () => {
    const pullRequests = [pr({ prNumber: 810 }), pr({ prNumber: 811 }), pr({ prNumber: 812 })];
    const result = await discoverMergeCandidates(
      discoveryDeps(pullRequests, {
        810: conflictingEvidence(810),
        811: conflictingEvidence(811),
        812: conflictingEvidence(812),
      }),
      { watchedBases: WATCHED_BASES, repos: REPOS, maxPullRequestsPerTick: 2 }
    );

    expect(result.evaluated).toBe(2);
    expect(result.exclusions).toHaveLength(2);
  });
});

describe('merge candidate discovery -- classification units', () => {
  test('draft is reported ahead of every other structural fault', () => {
    const draftAndUnapproved = pr({
      prNumber: 1,
      draft: true,
      reviewDecision: 'CHANGES_REQUESTED',
    });
    expect(classifyDiscoveredPullRequest(draftAndUnapproved, WATCHED_BASES)).toBe('draft');
  });

  test('a closed PR reports not_open', () => {
    expect(classifyDiscoveredPullRequest(pr({ prNumber: 2, state: 'closed' }), WATCHED_BASES)).toBe(
      'not_open'
    );
  });

  test('a null review decision is not approval', () => {
    expect(
      classifyDiscoveredPullRequest(pr({ prNumber: 3, reviewDecision: null }), WATCHED_BASES)
    ).toBe('review_not_approved');
  });

  test('an approved, open, watched-base PR passes the structural predicates', () => {
    expect(classifyDiscoveredPullRequest(pr({ prNumber: 4 }), WATCHED_BASES)).toBeNull();
  });

  test('green evidence passes the evidence predicates', () => {
    expect(classifyPullRequestEvidence(greenEvidence(5))).toBeNull();
  });

  test('summarizeExclusions counts by reason', () => {
    const summary = summarizeExclusions([
      { owner: OWNER, repo: REPO, prNumber: 1, reason: 'draft', detail: 'd' },
      { owner: OWNER, repo: REPO, prNumber: 2, reason: 'draft', detail: 'd' },
      { owner: OWNER, repo: REPO, prNumber: 3, reason: 'checks_failing', detail: 'd' },
    ]);
    expect(summary).toEqual({ draft: 2, checks_failing: 1 });
  });
});

describe('merge candidate discovery -- configuration resolution', () => {
  test('base branches default to the merge manager allowed bases', () => {
    expect(resolveWatchedBaseBranches(undefined)).toEqual([...DEFAULT_WATCHED_BASE_BRANCHES]);
    expect(resolveWatchedBaseBranches('')).toEqual([...DEFAULT_WATCHED_BASE_BRANCHES]);
    expect(resolveWatchedBaseBranches('dev, Staging ,release/ce')).toEqual([
      'dev',
      'staging',
      'release/ce',
    ]);
  });

  test('repo targets are parsed strictly and never guessed at', () => {
    expect(resolveDiscoveryRepos('thinmansoftware/bdc-harness, thinmansoftware/shopops')).toEqual([
      { owner: 'thinmansoftware', repo: 'bdc-harness' },
      { owner: 'thinmansoftware', repo: 'shopops' },
    ]);
    // A bare name has no owner, so there is nothing to look up -- dropped, not
    // completed from a default. An inferred repo is how a merge once acted on
    // the wrong repository.
    expect(resolveDiscoveryRepos('bdc-harness')).toEqual([]);
    expect(resolveDiscoveryRepos('owner/')).toEqual([]);
    expect(resolveDiscoveryRepos('/repo')).toEqual([]);
    expect(resolveDiscoveryRepos('a/b/c')).toEqual([]);
    expect(resolveDiscoveryRepos(undefined)).toEqual([]);
  });

  test('duplicate repo entries are swept once', () => {
    expect(
      resolveDiscoveryRepos('Thinmansoftware/BDC-Harness,thinmansoftware/bdc-harness')
    ).toEqual([{ owner: 'Thinmansoftware', repo: 'BDC-Harness' }]);
  });
});

describe('watchOnce integration -- discovered PRs reach the outcome set', () => {
  const emptyRunStore: OverseerRunStoreDeps = {
    listRunsForWatch: async () => [],
    listRunEvents: async () => [],
  };

  function watchDeps(
    pullRequests: readonly DiscoveredPullRequest[],
    evidenceByNumber: Record<number, PullRequestEvidence>
  ): OverseerRunStoreDeps & GitHubClientDeps {
    const discovery = discoveryDeps(pullRequests, evidenceByNumber);
    return {
      ...emptyRunStore,
      findPullRequest: discovery.findPullRequest,
      listOpenPullRequests: discovery.listOpenPullRequests,
      mergePullRequest: async () => ({ merged: true }),
    };
  }

  // The live symptom: zero runs in the watch window, so the run-derived pass
  // yields nothing at all -- and yet an approved, clean PR must still surface.
  test('an approved clean PR becomes a merge_ready outcome with no runs in the window', async () => {
    const logged: { obj: Record<string, unknown>; msg: string }[] = [];
    const outcomes = await watchOnce(
      watchDeps([pr({ prNumber: 730 })], { 730: greenEvidence(730) }),
      {
        logger: { info: (obj, msg) => logged.push({ obj, msg }) },
        discovery: { watchedBases: WATCHED_BASES, repos: REPOS },
      }
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.action).toBe('merge_ready');
    expect(outcomes[0]?.prEvidence.pr?.number).toBe(730);
    // Synthetic candidates are namespaced so no reader mistakes one for a run id.
    expect(outcomes[0]?.runId).toBe('pr-discovery:thinmansoftware/bdc-harness#730');

    const heartbeat = logged.find(entry => entry.msg === 'merge-coordinator.heartbeat_evaluated');
    expect(heartbeat?.obj.eligible).toBe(1);
    expect(heartbeat?.obj.prsEvaluated).toBe(1);
    expect(heartbeat?.obj.prDiscoveryUnavailable).toBe(false);
  });

  test('each excluded PR logs its own candidate_excluded line with a reason', async () => {
    const logged: { obj: Record<string, unknown>; msg: string }[] = [];
    await watchOnce(
      watchDeps(
        [
          pr({ prNumber: 731 }),
          pr({ prNumber: 732, reviewDecision: 'CHANGES_REQUESTED' }),
          pr({ prNumber: 733, draft: true }),
        ],
        {
          731: conflictingEvidence(731),
          732: greenEvidence(732),
          733: greenEvidence(733),
        }
      ),
      {
        logger: { info: (obj, msg) => logged.push({ obj, msg }) },
        discovery: { watchedBases: WATCHED_BASES, repos: REPOS },
      }
    );

    const excluded = logged.filter(entry => entry.msg === 'merge-coordinator.candidate_excluded');
    expect(excluded).toHaveLength(3);
    const reasons = excluded.map(entry => entry.obj.reason).sort();
    expect(reasons).toEqual(['draft', 'not_mergeable', 'review_not_approved']);
    for (const entry of excluded) {
      expect(entry.obj.prNumber).toBeDefined();
      expect(entry.obj.detail).toBeDefined();
    }

    const heartbeat = logged.find(entry => entry.msg === 'merge-coordinator.heartbeat_evaluated');
    expect(heartbeat?.obj.exclusionsByReason).toEqual({
      not_mergeable: 1,
      review_not_approved: 1,
      draft: 1,
    });
    expect(heartbeat?.obj.eligible).toBe(0);
  });

  // With no discovery dep wired, behaviour must be exactly what it was before
  // this change: the run-derived set, and a heartbeat that SAYS discovery did
  // not run rather than implying a clean sweep found nothing.
  test('without a discovery dep the watcher keeps its run-derived behaviour and says so', async () => {
    const logged: { obj: Record<string, unknown>; msg: string }[] = [];
    const outcomes = await watchOnce(
      {
        listRunsForWatch: async () => [],
        listRunEvents: async () => [],
        findPullRequest: async () => greenEvidence(1),
        mergePullRequest: async () => ({ merged: true }),
      },
      { logger: { info: (obj, msg) => logged.push({ obj, msg }) } }
    );

    expect(outcomes).toHaveLength(0);
    const heartbeat = logged.find(entry => entry.msg === 'merge-coordinator.heartbeat_evaluated');
    expect(heartbeat?.obj.prDiscoveryUnavailable).toBe(true);
    expect(heartbeat?.obj.prsEvaluated).toBe(0);
  });

  test('a throwing discovery sweep does not take down the watch tick', async () => {
    const logged: { obj: Record<string, unknown>; msg: string }[] = [];
    const outcomes = await watchOnce(
      {
        listRunsForWatch: async () => [],
        listRunEvents: async () => [],
        findPullRequest: async () => greenEvidence(1),
        mergePullRequest: async () => ({ merged: true }),
        listOpenPullRequests: async () => {
          throw new Error('sweep exploded');
        },
      },
      {
        logger: { info: (obj, msg) => logged.push({ obj, msg }) },
        discovery: { watchedBases: WATCHED_BASES, repos: REPOS },
      }
    );

    expect(outcomes).toHaveLength(0);
    expect(logged.some(entry => entry.msg === 'merge-coordinator.heartbeat_evaluated')).toBe(true);
  });
});

/**
 * EVIDENCE BINDING (Overseer [major] on d62d6dd5).
 *
 * `findPullRequest` is addressed by head BRANCH and WO id. Neither is unique:
 * two forks can push the same branch name, and one WO id routinely spans
 * several PRs. Discovery was accepting whatever came back without checking it
 * described the PR it had listed -- so PR A's APPROVED listing could be fused
 * to PR B's green checks and clean mergeable state and emitted as one
 * merge_ready record. These tests pin that a mis-bound or stale-head evidence
 * response excludes with a NAMED reason instead of becoming a candidate.
 */
describe('merge candidate discovery -- evidence binding', () => {
  test('two PRs sharing a head branch do not borrow each other evidence', async () => {
    // Both PRs push `fix/shared` (upstream and a fork). The lookup resolves by
    // branch and always answers with #800's evidence -- green and clean.
    const upstream = pr({ prNumber: 800, headRef: 'fix/shared', headSha: 'sha-800' });
    const fork = pr({ prNumber: 801, headRef: 'fix/shared', headSha: 'sha-801' });

    const result = await discoverMergeCandidates(
      {
        listOpenPullRequests: async () => [upstream, fork],
        // Branch-keyed lookup: the exact ambiguity the finding describes.
        findPullRequest: async () => greenEvidence(800),
      },
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    // #800 binds and is a candidate. #801 must NOT inherit #800's greenness.
    expect(result.candidates.map(candidate => candidate.metadata?.pr_number)).toEqual(['800']);

    const mismatch = result.exclusions.find(exclusion => exclusion.prNumber === 801);
    expect(mismatch?.reason).toBe('evidence_mismatch');
    expect(mismatch?.detail).toContain('#800');
    expect(mismatch?.detail).toContain('#801');
  });

  test('an ambiguous WO match resolving to another PR excludes rather than merges it', async () => {
    // One WO id spanning two PRs; the search returns the WRONG one.
    const listed = pr({ prNumber: 810, woId: 'WO-HARNESS-THING-01', headSha: 'sha-810' });

    const result = await discoverMergeCandidates(
      {
        listOpenPullRequests: async () => [listed],
        findPullRequest: async () => ({ ...greenEvidence(999), headSha: 'sha-810' }),
      },
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.exclusions[0]?.reason).toBe('evidence_mismatch');
    expect(result.exclusions[0]?.prNumber).toBe(810);
  });

  // Right PR, WRONG COMMIT. Evidence read after a push describes a different
  // commit than the one whose review decision was classified; admitting it
  // would build a candidate on unreviewed code.
  test('evidence for a stale head excludes rather than becoming a candidate', async () => {
    const listed = pr({ prNumber: 820, headSha: 'sha-new' });

    const result = await discoverMergeCandidates(
      {
        listOpenPullRequests: async () => [listed],
        findPullRequest: async () => ({ ...greenEvidence(820), headSha: 'sha-old' }),
      },
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.exclusions[0]?.reason).toBe('evidence_mismatch');
    expect(result.exclusions[0]?.detail).toContain('sha-old');
    expect(result.exclusions[0]?.detail).toContain('sha-new');
  });

  // Absent identity is UNVERIFIED identity. Waving it through is exactly the
  // acceptance-without-checking the finding is about.
  test('evidence with no pr ref and no head sha is excluded, not trusted', async () => {
    const listed = pr({ prNumber: 830, headSha: 'sha-830' });

    const noRef = await discoverMergeCandidates(
      {
        listOpenPullRequests: async () => [listed],
        findPullRequest: async () => {
          const evidence = { ...greenEvidence(830) };
          delete (evidence as { pr?: unknown }).pr;
          return evidence;
        },
      },
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );
    expect(noRef.candidates).toHaveLength(0);
    expect(noRef.exclusions[0]?.reason).toBe('evidence_mismatch');

    const noSha = await discoverMergeCandidates(
      {
        listOpenPullRequests: async () => [listed],
        findPullRequest: async () => {
          const evidence = { ...greenEvidence(830) };
          delete (evidence as { headSha?: unknown }).headSha;
          return evidence;
        },
      },
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );
    expect(noSha.candidates).toHaveLength(0);
    expect(noSha.exclusions[0]?.reason).toBe('evidence_mismatch');
  });

  // A transient outage is a DIFFERENT operator fact from an ambiguity in the
  // repo, and must keep its own name.
  test('a failed lookup still reports evidence_lookup_failed, not a mismatch', async () => {
    const result = await discoverMergeCandidates(
      {
        listOpenPullRequests: async () => [pr({ prNumber: 840 })],
        findPullRequest: async () => lookupFailedEvidence(),
      },
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(result.exclusions[0]?.reason).toBe('evidence_lookup_failed');
  });

  test('the exact PR number is passed to the lookup so an adapter can disambiguate', async () => {
    const seen: (number | undefined)[] = [];
    await discoverMergeCandidates(
      {
        listOpenPullRequests: async () => [pr({ prNumber: 850, headSha: 'sha-850' })],
        findPullRequest: async input => {
          seen.push(input.prNumber);
          return { ...greenEvidence(850), headSha: 'sha-850' };
        },
      },
      { watchedBases: WATCHED_BASES, repos: REPOS }
    );

    expect(seen).toEqual([850]);
  });
});
