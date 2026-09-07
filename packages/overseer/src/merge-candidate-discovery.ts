/**
 * PR-first merge candidate discovery (bdc-harness#758).
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * Before this module the merge coordinator's candidate set came from exactly one
 * source: `listRunsForWatch()` in watch.ts, which reads
 * `remote_agent_workflow_runs` (see packages/core/src/db/overseer.ts
 * listRunsForOverseerWatch). A pull request could therefore only ever become a
 * merge candidate by being reachable BACKWARDS from a workflow run that
 *
 *   1. is still in a terminal-but-unclosed state
 *      (`status IN ('completed','failed','escalated','cancelled')`), AND
 *   2. has no terminal `overseer_actions` row -- 'merged', 'watch_closed',
 *      'escalate_with_evidence', 'escalation_denied', 'tier_refused',
 *      'comment_findings' all permanently remove the run from the query, AND
 *   3. still carries recoverable owner/repo identity, AND
 *   4. survives the oldest-first `maxRunsPerTick` slice (default 25).
 *
 * A PR that fails ANY of those -- authored by hand, authored by a lane whose run
 * was long since closed with `watch_closed`, or simply older than the window --
 * is structurally invisible to the coordinator. It is not rejected; it is never
 * looked at. That is why 32 open PRs produced `"total":2,"eligible":0` on 19
 * consecutive heartbeats on 2026-09-04, and why #730 and #731 sat APPROVED and
 * CLEAN with every required check green and never merged: their runs were
 * already closed, so no amount of PR-side greenness could put them back in the
 * set. (`total` in that heartbeat was `runs.length` -- the RUN count -- which is
 * also why the number looked absurd next to the open-PR count.)
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Discovers candidates from the OTHER direction: it asks GitHub for the open
 * pull requests against the watched base branches and evaluates every one of
 * them. A PR that is open, not a draft, targets a watched base, has an APPROVED
 * review decision, has all required checks SUCCESS, and is mergeable/CLEAN
 * becomes a candidate. Every PR that is looked at and NOT included gets a
 * specific, named exclusion reason -- never silence.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It does not change merge AUTHORIZATION. Discovery is upstream of authority.
 * Everything downstream still runs unchanged for every candidate this module
 * produces: the M-48 merge enablement flags (MERGE_MANAGER_MUTATIONS_ENABLED,
 * OVERSEER_MERGE_MANAGER_MODE), the production-effect hold for John, the
 * provenance gate, the Review Gate exact-head approval precondition, the
 * allowed-bases check and the Grok second-opinion judge. This module only
 * decides which PRs get LOOKED AT. Whether any of them may actually merge is
 * still the Merge Manager's call, on exactly the rules it had before.
 */
import type {
  DiscoveredPullRequest,
  MergeCandidateDiscoveryDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types.ts';

/** Base branches evaluated when none are configured. Mirrors MERGE_MANAGER_ALLOWED_BASES. */
export const DEFAULT_WATCHED_BASE_BRANCHES = ['dev', 'staging'] as const;

/** Env var naming the base branches PR-first discovery evaluates. */
export const DISCOVERY_BASE_BRANCHES_ENV = 'MERGE_MANAGER_ALLOWED_BASES' as const;

/** Env var naming the repositories PR-first discovery sweeps, as `owner/repo` entries. */
export const DISCOVERY_REPOS_ENV = 'OVERSEER_MERGE_DISCOVERY_REPOS' as const;

/** Hard ceiling on PRs evaluated per tick, so one huge repo cannot starve the loop. */
export const DEFAULT_DISCOVERY_MAX_PRS_PER_TICK = 100;

/**
 * Every reason a looked-at PR can be excluded from the candidate set.
 *
 * These names are the contract with the operator: the whole point of #758 is
 * that an excluded PR says WHY, in a greppable token, rather than vanishing.
 * `discovery_unavailable` and `discovery_lookup_failed` are deliberately
 * distinct from the substantive exclusions -- they mean "we did not learn
 * anything", never "this PR is not mergeable".
 */
export type MergeCandidateExclusionReason =
  | 'draft'
  | 'not_open'
  | 'base_branch_not_watched'
  | 'review_not_approved'
  | 'checks_failing'
  | 'checks_pending'
  | 'checks_absent'
  | 'not_mergeable'
  | 'mergeable_unknown'
  | 'evidence_lookup_failed'
  | 'already_a_run_candidate';

export interface MergeCandidateExclusion {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly reason: MergeCandidateExclusionReason;
  /** Free-text amplification of `reason`. Never a substitute for it. */
  readonly detail: string;
}

export interface MergeCandidateDiscoveryResult {
  /** Synthetic watch records for PRs that passed every discovery predicate. */
  readonly candidates: readonly WatchedRunRecord[];
  /** One entry per PR that was evaluated and NOT included. */
  readonly exclusions: readonly MergeCandidateExclusion[];
  /** How many PRs were actually looked at this tick. */
  readonly evaluated: number;
  /**
   * True when discovery could not run at all (no dep wired, or every repo
   * lookup threw). Distinguishes "nothing to merge" from "we did not look".
   */
  readonly unavailable: boolean;
}

const EMPTY_RESULT: MergeCandidateDiscoveryResult = {
  candidates: [],
  exclusions: [],
  evaluated: 0,
  unavailable: true,
};

/**
 * Parse a comma-separated base-branch list. Reuses MERGE_MANAGER_ALLOWED_BASES
 * on purpose: discovery must never surface a PR the Merge Manager would refuse
 * on `base_branch_not_allowed` grounds, so the two lists are the same list.
 */
export function resolveWatchedBaseBranches(
  raw: string | undefined = process.env[DISCOVERY_BASE_BRANCHES_ENV]
): readonly string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_WATCHED_BASE_BRANCHES];
}

export interface DiscoveryRepoTarget {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Parse `owner/repo` entries from the environment. Malformed entries are
 * DROPPED rather than guessed at -- an inferred repo is exactly the class of
 * mistake that made a merge act on the wrong repository once already.
 */
export function resolveDiscoveryRepos(
  raw: string | undefined = process.env[DISCOVERY_REPOS_ENV]
): readonly DiscoveryRepoTarget[] {
  const targets: DiscoveryRepoTarget[] = [];
  const seen = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash === trimmed.length - 1) continue;
    const owner = trimmed.slice(0, slash).trim();
    const repo = trimmed.slice(slash + 1).trim();
    if (!owner || !repo || repo.includes('/')) continue;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ owner, repo });
  }
  return targets;
}

export function resolveDiscoveryMaxPrsPerTick(
  raw: string | undefined = process.env.OVERSEER_MERGE_DISCOVERY_MAX_PRS_PER_TICK
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DISCOVERY_MAX_PRS_PER_TICK;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DISCOVERY_MAX_PRS_PER_TICK;
}

/**
 * Classify one discovered PR. Returns null when the PR is a candidate.
 *
 * Ordering is chosen so the reported reason is the MOST INFORMATIVE one: state
 * and draft first (cheap, structural), then base, then the review decision,
 * then checks, then mergeability. A draft PR with failing checks reports
 * `draft`, because that is the fact the operator has to act on.
 */
export function classifyDiscoveredPullRequest(
  pr: DiscoveredPullRequest,
  watchedBases: readonly string[]
): MergeCandidateExclusionReason | null {
  if (pr.draft) return 'draft';
  if (pr.state.toLowerCase() !== 'open') return 'not_open';
  if (!watchedBases.includes(pr.baseRef.trim().toLowerCase())) return 'base_branch_not_watched';
  if (pr.reviewDecision !== 'APPROVED') return 'review_not_approved';
  return null;
}

/**
 * Classify the check/mergeability half, which needs the full evidence fetch.
 * Split from the cheap predicates above so a PR that is already excluded on
 * structural grounds costs no extra API call.
 */
export function classifyPullRequestEvidence(
  evidence: PullRequestEvidence
): MergeCandidateExclusionReason | null {
  if (evidence.lookupFailed || !evidence.exists) return 'evidence_lookup_failed';
  if (evidence.state.toLowerCase() !== 'open') return 'not_open';
  if (evidence.checks.total === 0) return 'checks_absent';
  if (evidence.checks.failed > 0) return 'checks_failing';
  if (evidence.checks.pending > 0) return 'checks_pending';
  // GitHub computes mergeable asynchronously: `null` is "still computing", NOT
  // "unmergeable". Reporting them under one reason is how a transient state got
  // read as a permanent verdict before (see createRealFindPullRequest).
  if (evidence.mergeable === null || evidence.mergeable === undefined) return 'mergeable_unknown';
  if (!evidence.mergeable) return 'not_mergeable';
  return null;
}

function detailFor(reason: MergeCandidateExclusionReason, pr: DiscoveredPullRequest): string {
  switch (reason) {
    case 'draft':
      return 'pull request is a draft';
    case 'not_open':
      return `pull request state is ${pr.state}`;
    case 'base_branch_not_watched':
      return `base ${pr.baseRef} is not a watched base branch`;
    case 'review_not_approved':
      return `review decision is ${pr.reviewDecision ?? 'none'}`;
    default:
      return reason;
  }
}

function evidenceDetail(
  reason: MergeCandidateExclusionReason,
  evidence: PullRequestEvidence
): string {
  const checks = evidence.checks;
  switch (reason) {
    case 'evidence_lookup_failed':
      return evidence.lookupFailed
        ? 'PR evidence lookup failed -- state unknown, not established as unmergeable'
        : 'PR evidence reported the pull request as absent';
    case 'not_open':
      return `evidence state is ${evidence.state}`;
    case 'checks_absent':
      return 'no check runs reported on the head commit';
    case 'checks_failing':
      return `${checks.failed} of ${checks.total} checks failing`;
    case 'checks_pending':
      return `${checks.pending} of ${checks.total} checks still pending`;
    case 'mergeable_unknown':
      return 'GitHub has not finished computing mergeability (mergeable=null)';
    case 'not_mergeable':
      return 'GitHub reports the pull request as not mergeable (conflicting)';
    default:
      return reason;
  }
}

/**
 * Build the synthetic watch record for a discovered candidate.
 *
 * `runId` is namespaced `pr-discovery:` on purpose. It is NOT a workflow run id
 * and must never be mistaken for one: downstream `insertOverseerAction` rows
 * carry it, and a reader has to be able to tell at a glance that this candidate
 * came from the PR sweep rather than from a run. The provenance gate compares a
 * run worktree against the PR head; with no worktree there is nothing to
 * compare, so these candidates hold there exactly as an unattributable run
 * would. That is the correct, fail-closed outcome -- discovery widens what is
 * LOOKED AT, never what is authorized.
 */
export function buildDiscoveredCandidateRecord(
  pr: DiscoveredPullRequest,
  evidence: PullRequestEvidence
): WatchedRunRecord {
  return {
    runId: `pr-discovery:${pr.owner}/${pr.repo}#${pr.prNumber}`,
    woId: pr.woId ?? `gh:${pr.owner}/${pr.repo}#${pr.prNumber}`,
    owner: pr.owner,
    repo: pr.repo,
    status: 'pr_discovered',
    headBranch: pr.headRef,
    metadata: {
      discovery_source: 'pr_first_sweep',
      base_branch: pr.baseRef,
      head_sha: pr.headSha,
      pr_number: String(pr.prNumber),
    },
    action: 'merge_ready',
    reason:
      'open, non-draft, APPROVED pull request with all required checks green and a clean ' +
      'mergeable state -- discovered by PR-first sweep',
    prEvidence: evidence,
    decision: {
      decision: 'merge_ready',
      reason: 'pr_first_discovery_candidate',
    },
  };
}

export interface DiscoverMergeCandidatesOptions {
  /** Base branches to accept. Defaults to the resolved env/allowed-bases list. */
  readonly watchedBases?: readonly string[];
  /** Repos to sweep. Defaults to the resolved env list. */
  readonly repos?: readonly DiscoveryRepoTarget[];
  /** Per-tick ceiling on PRs evaluated. */
  readonly maxPullRequestsPerTick?: number;
  /**
   * Run ids already covered by run-derived discovery, keyed by
   * `owner/repo#number`. A PR already reachable from a run is excluded with
   * `already_a_run_candidate` rather than evaluated twice.
   */
  readonly alreadyCoveredPullRequests?: ReadonlySet<string>;
}

export function pullRequestKey(owner: string, repo: string, prNumber: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}`;
}

/**
 * Sweep the watched repos for merge candidates.
 *
 * Fails SOFT and LOUD: a repo whose listing throws contributes nothing to the
 * candidate set but does not abort the sweep or the watch tick, and the result
 * reports `unavailable` only when NOTHING could be looked at. A discovery
 * outage must never look like "there is nothing to merge".
 */
export async function discoverMergeCandidates(
  deps: MergeCandidateDiscoveryDeps,
  options: DiscoverMergeCandidatesOptions = {}
): Promise<MergeCandidateDiscoveryResult> {
  if (!deps.listOpenPullRequests) return EMPTY_RESULT;
  // Bound to `deps` rather than detached, so an implementation that is a real
  // method on a client object keeps its receiver.
  const listOpenPullRequests: NonNullable<
    MergeCandidateDiscoveryDeps['listOpenPullRequests']
  > = input => deps.listOpenPullRequests?.(input) ?? Promise.resolve([]);

  const watchedBases = options.watchedBases ?? resolveWatchedBaseBranches();
  const repos = options.repos ?? resolveDiscoveryRepos();
  if (repos.length === 0) return EMPTY_RESULT;

  const maxPullRequests = options.maxPullRequestsPerTick ?? resolveDiscoveryMaxPrsPerTick();
  const alreadyCovered = options.alreadyCoveredPullRequests ?? new Set<string>();

  const candidates: WatchedRunRecord[] = [];
  const exclusions: MergeCandidateExclusion[] = [];
  let evaluated = 0;
  let anyRepoListed = false;

  for (const target of repos) {
    if (evaluated >= maxPullRequests) break;
    let pullRequests: readonly DiscoveredPullRequest[];
    try {
      pullRequests = await listOpenPullRequests({
        owner: target.owner,
        repo: target.repo,
        baseBranches: watchedBases,
      });
      anyRepoListed = true;
    } catch {
      // One unreachable repo must not blind the sweep to every other repo.
      // Reported through `unavailable` only if NO repo could be listed.
      continue;
    }

    for (const pr of pullRequests) {
      if (evaluated >= maxPullRequests) break;
      evaluated += 1;

      const key = pullRequestKey(pr.owner, pr.repo, pr.prNumber);
      if (alreadyCovered.has(key)) {
        exclusions.push({
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
          reason: 'already_a_run_candidate',
          detail: 'already evaluated this tick via its originating workflow run',
        });
        continue;
      }

      const structural = classifyDiscoveredPullRequest(pr, watchedBases);
      if (structural) {
        exclusions.push({
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
          reason: structural,
          detail: detailFor(structural, pr),
        });
        continue;
      }

      let evidence: PullRequestEvidence;
      try {
        evidence = await deps.findPullRequest({
          owner: pr.owner,
          repo: pr.repo,
          headBranch: pr.headRef,
          woId: pr.woId,
        });
      } catch {
        exclusions.push({
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
          reason: 'evidence_lookup_failed',
          detail: 'PR evidence lookup threw -- state unknown, will be retried next tick',
        });
        continue;
      }

      const evidenceReason = classifyPullRequestEvidence(evidence);
      if (evidenceReason) {
        exclusions.push({
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
          reason: evidenceReason,
          detail: evidenceDetail(evidenceReason, evidence),
        });
        continue;
      }

      candidates.push(buildDiscoveredCandidateRecord(pr, evidence));
    }
  }

  return {
    candidates,
    exclusions,
    evaluated,
    unavailable: !anyRepoListed,
  };
}

/** Count exclusions by reason, for the summarized heartbeat line. */
export function summarizeExclusions(
  exclusions: readonly MergeCandidateExclusion[]
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const exclusion of exclusions) {
    summary[exclusion.reason] = (summary[exclusion.reason] ?? 0) + 1;
  }
  return summary;
}
