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
import { createLogger } from '@archon/paths';
import type {
  DiscoveredPullRequest,
  MergeCandidateDiscoveryDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types.ts';

const log = createLogger('overseer/merge-candidate-discovery');

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
  | 'evidence_mismatch'
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
   * How many evaluated PRs had their review decision resolved by the
   * conservative REST fallback instead of GitHub's own aggregate. Non-zero
   * means the merge gate is running STRICTER than GitHub would, so PRs GitHub
   * considers approved may be sitting excluded. Surfaced on the heartbeat as
   * `prsFallbackDecision` so that reads as a degraded gate, not a quiet backlog.
   */
  readonly fallbackReviewDecisions: number;
  /**
   * True when discovery could not run at all (no dep wired, or every repo
   * lookup threw). Distinguishes "nothing to merge" from "we did not look".
   */
  readonly unavailable: boolean;
  /** Total open PRs listed across every repo, before the per-tick bound. */
  readonly totalOpen: number;
  /**
   * True when the per-tick evaluation bound stopped the sweep short, so some
   * open PRs were not looked at THIS tick. They are not lost: the cursor below
   * resumes at the first unevaluated PR next tick.
   *
   * Deliberately distinct from `DiscoveredPullRequest.listingTruncated`, which
   * reports the separate 1000-PR API listing ceiling. One says "we did not ASK
   * about every PR", the other says "we did not LOOK at every PR we asked
   * about" -- different causes, different fixes, so they are never merged.
   */
  readonly evaluationWindowTruncated: boolean;
  /**
   * Where the next tick resumes: the position after the last PR evaluated, as
   * a keyset over (repo, PR number). Null when the sweep completed the whole
   * population and the next tick starts from the beginning.
   */
  readonly cursorAfter: DiscoveryCursor | null;
}

/**
 * Resume point for the rotating evaluation window, as a KEYSET rather than an
 * offset. An offset would silently skip PRs whenever the population shifted
 * between ticks (a PR merged or opened below the cursor); a keyset resumes at
 * "the first PR after this one" and is stable under both.
 *
 * PER-REPO, because the sweep interleaves repos: each repo advances through its
 * own PRs at its own rate, so one shared position cannot describe where the
 * sweep is. A single cursor at the last-evaluated PR would name whichever repo
 * happened to be last in the round-robin and rewind every other repo to zero --
 * the sweep would then re-evaluate the same first `cap` PRs forever, which is
 * the very defect the rotation exists to fix.
 */
export interface DiscoveryCursor {
  /** Last PR number evaluated in each repo, keyed by lowercased `owner/repo`. */
  readonly perRepo: Readonly<Record<string, number>>;
}

const EMPTY_RESULT: MergeCandidateDiscoveryResult = {
  candidates: [],
  exclusions: [],
  evaluated: 0,
  fallbackReviewDecisions: 0,
  unavailable: true,
  totalOpen: 0,
  evaluationWindowTruncated: false,
  cursorAfter: null,
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

/**
 * Verify that fetched evidence actually describes the PR we listed.
 *
 * THE DEFECT THIS CLOSES (Overseer review of d62d6dd5, [major])
 * ------------------------------------------------------------
 * `findPullRequest` is addressed by head BRANCH and WO id, neither of which is
 * a unique key. Two open PRs can carry the same `headRef` (a fork and the
 * upstream, or two forks, all pushing `fix/thing`), and one WO id routinely
 * spans several PRs. The lookup therefore returns *a* pull request, not
 * necessarily *this* one -- and the caller was accepting it unconditionally.
 * The result is the worst possible shape of wrong: PR A's listing (its title,
 * its APPROVED review decision) fused to PR B's evidence (B's green checks, B's
 * clean mergeable state), emitted as one `merge_ready` record whose downstream
 * merge targets whichever number the record carries. An approval on one PR
 * would authorize a merge of another.
 *
 * The bind is on BOTH coordinates and both are required:
 *
 *  - `evidence.pr.number` must equal `pr.prNumber`. This is the identity check.
 *    A missing `pr` ref cannot be waved through: absent identity is unverified
 *    identity, and the whole point is to stop accepting unverified identity.
 *  - `evidence.headSha` must equal `pr.headSha`. This is the freshness check.
 *    Even for the right PR, evidence read after a push describes a DIFFERENT
 *    commit than the one whose review decision we classified. Admitting it
 *    would approve code no one reviewed -- the same stale-head hole the Review
 *    Gate closes downstream with `commitId === headSha`, closed here too so a
 *    candidate is never built on a moved head in the first place.
 *
 * Fails CLOSED in every uncertain direction: a mismatch, an absent `pr` ref and
 * an absent `headSha` all exclude. Excluding a good PR costs one tick (the
 * sweep is idempotent and re-evaluates next cycle); admitting a mis-bound one
 * merges the wrong code.
 */
export function classifyEvidenceBinding(
  pr: DiscoveredPullRequest,
  evidence: PullRequestEvidence
): MergeCandidateExclusionReason | null {
  // A failed or empty lookup carries no identity to bind, but "we did not learn
  // anything" is a different operator fact from "we learned about the WRONG PR".
  // Yield to `evidence_lookup_failed` so a transient API outage never reads as
  // an ambiguity in the repo.
  if (evidence.lookupFailed || !evidence.exists) return 'evidence_lookup_failed';
  if (evidence.pr?.number !== pr.prNumber) return 'evidence_mismatch';
  if (!evidence.headSha || evidence.headSha !== pr.headSha) return 'evidence_mismatch';
  return null;
}

/** Human-readable amplification of a binding exclusion. Names both coordinates. */
function bindingDetail(
  reason: MergeCandidateExclusionReason,
  pr: DiscoveredPullRequest,
  evidence: PullRequestEvidence
): string {
  if (reason === 'evidence_lookup_failed') return evidenceDetail(reason, evidence);
  if (evidence.pr?.number !== pr.prNumber) {
    const found = evidence.pr === undefined ? 'no pr ref' : `#${evidence.pr.number}`;
    return `evidence resolved to ${found} while listing #${pr.prNumber} -- ambiguous head branch or WO id`;
  }
  const found = evidence.headSha ? evidence.headSha : 'no head sha';
  return `evidence head ${found} does not match listed head ${pr.headSha} -- stale evidence for a moved head`;
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
 * came from the PR sweep rather than from a run.
 *
 * PROVENANCE (John, 2026-09-07: "always merge on green, you do not need to ask
 * me"). The provenance gate compares a RUN'S OWN WORKTREE tip against the PR
 * head. A PR-discovered candidate has no run and so no worktree, which means
 * that check could only ever answer `working_path_missing` -- holding every
 * such PR permanently and recreating, one layer down, exactly the deadlock this
 * module was written to clear. For these candidates provenance is therefore
 * recorded as the named condition `provenance_no_run` and does not block.
 *
 * Nothing else relaxes. The merge still requires an exact-head approval from
 * the Review Gate identity, all required checks SUCCESS, a CLEAN mergeable
 * state, an allowed base, and it still hits the production-effect hold and the
 * Grok judge where configured. `provenance_no_run` is an ABSENT run, which is a
 * different fact from an UNVERIFIABLE one: a real run whose worktree was swept
 * still fails closed, because for it "which commit did this run produce" is a
 * real question we merely could not answer.
 */
export function buildDiscoveredCandidateRecord(
  pr: DiscoveredPullRequest,
  evidence: PullRequestEvidence
): WatchedRunRecord {
  return {
    runId: `${PR_DISCOVERY_RUN_ID_PREFIX}${pr.owner}/${pr.repo}#${pr.prNumber}`,
    woId: pr.woId ?? `gh:${pr.owner}/${pr.repo}#${pr.prNumber}`,
    owner: pr.owner,
    repo: pr.repo,
    status: 'pr_discovered',
    headBranch: pr.headRef,
    metadata: {
      discovery_source: PR_DISCOVERY_SOURCE,
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
  /**
   * Where to resume the rotating evaluation window. Pass the previous tick's
   * `cursorAfter`. Omitted or null starts from the beginning of the population.
   */
  readonly cursor?: DiscoveryCursor | null;
  /** Injectable for tests; defaults to this module's logger. */
  readonly logger?: { info(obj: Record<string, unknown>, msg: string): void };
}

/**
 * Process-local resume point, so the default wiring rotates without any caller
 * having to thread the cursor through. A restart re-reads from the start of the
 * population, which is correct-but-slower rather than wrong: no PR is skipped,
 * some are merely re-evaluated sooner than strictly necessary.
 *
 * Deliberately NOT persisted. A durable cursor would need a store, a migration,
 * and a staleness policy for a value whose worst-case cost is one redundant
 * evaluation pass after a process restart. Kept in-process until that cost is
 * shown to matter.
 */
let processCursor: DiscoveryCursor | null = null;

/** Reset the process-local rotation cursor. Tests only. */
export function resetDiscoveryCursorForTests(): void {
  processCursor = null;
}

function repoKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Build one per-repo queue, each rotated to resume after that repo's own cursor
 * position and wrapping within the repo.
 *
 * Rotation is per repo and PRs are sorted ascending by number, so "resume after
 * N" is meaningful and stable: it uses a `> N` comparison rather than an exact
 * match, which means a cursor pointing at a PR that has since merged still
 * resumes at the next real PR instead of restarting the repo.
 */
function rotatedQueues(
  repos: readonly DiscoveryRepoTarget[],
  byRepo: ReadonlyMap<string, readonly DiscoveredPullRequest[]>,
  cursor: DiscoveryCursor | null
): { key: string; queue: DiscoveredPullRequest[]; fresh: DiscoveredPullRequest[] }[] {
  const queues: { key: string; queue: DiscoveredPullRequest[]; fresh: DiscoveredPullRequest[] }[] =
    [];
  for (const target of repos) {
    const key = repoKey(target.owner, target.repo);
    const sorted = [...(byRepo.get(key) ?? [])].sort((a, b) => a.prNumber - b.prNumber);
    if (sorted.length === 0) continue;
    const after = cursor?.perRepo[key];
    if (after === undefined) {
      queues.push({ key, queue: sorted, fresh: sorted });
      continue;
    }
    const index = sorted.findIndex(pr => pr.prNumber > after);
    // `fresh` is the not-yet-evaluated tail of this repo's pass. When the repo
    // has finished its pass it is empty, and the repo wraps to its top -- but
    // only once every other repo has also finished, so a small repo cannot
    // spend budget re-reading PRs while a large one still has unseen work.
    const fresh = index < 0 ? [] : sorted.slice(index);
    const rotated = index < 0 ? sorted : [...sorted.slice(index), ...sorted.slice(0, index)];
    queues.push({ key, queue: rotated, fresh });
  }
  return queues;
}

/**
 * Interleave the per-repo queues so one busy repo cannot consume the whole
 * per-tick budget while a small repo waits behind it.
 *
 * Round-robin, preserving each repo's own rotated order. With repos of 200 and
 * 50 PRs and a cap of 100, the small repo gets 50 of the slots rather than
 * zero, and each repo still advances through its own PRs across ticks because
 * the cursor is recorded per repo.
 */
function interleaveByRepo(
  queues: readonly { key: string; queue: DiscoveredPullRequest[]; fresh: DiscoveredPullRequest[] }[]
): DiscoveredPullRequest[] {
  if (queues.length === 1) return [...(queues[0]?.queue ?? [])];

  // UNEVALUATED WORK FIRST, round-robin across the repos that still have some.
  // A repo that has finished its pass contributes nothing here, so its slots go
  // to repos with PRs nobody has looked at yet -- otherwise a 50-PR repo would
  // take half of every tick re-reading the same 50 while a 200-PR repo crawled.
  const interleaved: DiscoveredPullRequest[] = [];
  const withFresh = queues.filter(entry => entry.fresh.length > 0);
  const freshTotal = withFresh.reduce((sum, entry) => sum + entry.fresh.length, 0);
  for (let round = 0; interleaved.length < freshTotal; round += 1) {
    for (const entry of withFresh) {
      const pr = entry.fresh[round];
      if (pr) interleaved.push(pr);
    }
  }

  // Then the wrapped remainder, so a tick with spare budget after every repo
  // has completed its pass starts the next pass instead of idling.
  const seen = new Set(interleaved);
  const total = queues.reduce((sum, entry) => sum + entry.queue.length, 0);
  for (let round = 0; interleaved.length < total; round += 1) {
    let advanced = false;
    for (const entry of queues) {
      const pr = entry.queue[round];
      if (pr && !seen.has(pr)) {
        interleaved.push(pr);
        seen.add(pr);
        advanced = true;
      }
    }
    if (!advanced && round > total) break;
  }
  return interleaved;
}

export function pullRequestKey(owner: string, repo: string, prNumber: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}`;
}

/** Prefix marking a synthetic runId minted by the PR-first sweep, not a workflow run. */
export const PR_DISCOVERY_RUN_ID_PREFIX = 'pr-discovery:' as const;

/** Metadata marker written on every PR-discovered candidate. */
export const PR_DISCOVERY_SOURCE = 'pr_first_sweep' as const;

/**
 * True only for candidates this module minted -- a PR found by sweeping GitHub
 * that has NO originating Cauldron run.
 *
 * Load-bearing for the provenance rule (John, 2026-09-07: "always merge on
 * green, you do not need to ask me"). A PR-discovered candidate has no run and
 * therefore no engine-written worktree to bind a head SHA against, so the
 * provenance gate can only ever report `working_path_missing` for it -- which
 * held every such PR forever and is precisely the deadlock #758 set out to
 * clear.
 *
 * BOTH markers are required, and that is deliberate. A real workflow run whose
 * worktree was swept must keep failing provenance closed: it HAS a run, so
 * "which commit did that run produce" is a real question with a real answer we
 * simply could not read, and skipping the check there would let a merge proceed
 * on an unverified claim. Requiring the synthetic `pr-discovery:` runId AND the
 * discovery metadata means only a record this sweep built can take the relaxed
 * path; a run-derived record can never impersonate one by losing a field.
 */
export function isPullRequestDiscoveredCandidate(record: {
  runId?: string;
  metadata?: Record<string, unknown>;
}): boolean {
  return (
    typeof record.runId === 'string' &&
    record.runId.startsWith(PR_DISCOVERY_RUN_ID_PREFIX) &&
    record.metadata?.discovery_source === PR_DISCOVERY_SOURCE
  );
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
  let fallbackReviewDecisions = 0;
  let anyRepoListed = false;

  // LIST EVERY REPO FIRST, then evaluate one interleaved sequence.
  //
  // The previous shape listed and evaluated repo-by-repo, breaking out of the
  // outer loop once the per-tick bound was hit -- so with more open PRs than
  // the cap, repos after the first were never even LISTED, let alone evaluated.
  // Listing is cheap relative to per-PR evidence lookups, and it is what makes
  // both the round-robin and an honest `totalOpen` possible.
  const byRepo = new Map<string, readonly DiscoveredPullRequest[]>();
  for (const target of repos) {
    try {
      const listed = await listOpenPullRequests({
        owner: target.owner,
        repo: target.repo,
        baseBranches: watchedBases,
      });
      byRepo.set(repoKey(target.owner, target.repo), listed);
      anyRepoListed = true;
    } catch {
      // One unreachable repo must not blind the sweep to every other repo.
      // Reported through `unavailable` only if NO repo could be listed.
      continue;
    }
  }

  const startCursor = options.cursor === undefined ? processCursor : options.cursor;
  const queues = rotatedQueues(repos, byRepo, startCursor);
  const totalOpen = queues.reduce((sum, entry) => sum + entry.queue.length, 0);
  // Unevaluated PRs remaining in THIS pass. `totalOpen` is the whole population,
  // so comparing evaluated against it would report a pass as truncated even on
  // the tick that finishes it -- the window is truncated when work is left over.
  const freshTotal = queues.reduce((sum, entry) => sum + entry.fresh.length, 0);
  const sequence = interleaveByRepo(queues);

  // Where each repo got to this tick, so the next tick resumes per repo rather
  // than rewinding every repo to whichever one happened to be evaluated last.
  const lastPerRepo = new Map<string, number>();
  {
    for (const pr of sequence) {
      if (evaluated >= maxPullRequests) break;
      evaluated += 1;
      lastPerRepo.set(repoKey(pr.owner, pr.repo), pr.prNumber);
      // Counted BEFORE any exclusion `continue`: the PRs this most matters for
      // are precisely the ones the stricter fallback pushed into
      // `review_not_approved`. Counting only survivors would hide them.
      if (pr.reviewDecisionFromFallback) fallbackReviewDecisions += 1;

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
          // The unique key, passed so an adapter that can address a PR directly
          // resolves THIS one instead of searching by the ambiguous branch/WO.
          // Optional in the contract, so existing implementations that ignore it
          // still work -- and are still caught by the binding check below.
          prNumber: pr.prNumber,
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

      // BIND FIRST, then read. A lookup addressed by branch/WO id can return a
      // DIFFERENT pull request (duplicate head branches across forks, one WO id
      // spanning several PRs) or the right one at a MOVED head. Checking the
      // substantive predicates before identity would report `checks_failing` or
      // `not_mergeable` about a PR we never asked for -- a wrong reason attached
      // to the wrong number, which is worse than no reason at all.
      const bindingReason = classifyEvidenceBinding(pr, evidence);
      if (bindingReason) {
        exclusions.push({
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
          reason: bindingReason,
          detail: bindingDetail(bindingReason, pr, evidence),
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

  // The window truncated when PRs remained unevaluated after the bound. On a
  // complete pass the cursor RESETS to null so the next tick starts at the top
  // of the population rather than drifting forever.
  // Truncated when this pass could not finish: PRs nobody has evaluated yet
  // remain. A cursor is carried only then; completing the pass clears it so the
  // next tick starts a fresh pass at the top of every repo.
  const evaluationWindowTruncated = evaluated < freshTotal;
  const cursorAfter: DiscoveryCursor | null =
    evaluationWindowTruncated && lastPerRepo.size > 0
      ? {
          perRepo: {
            // Repos untouched this tick keep their previous position, or they
            // would silently restart while another repo consumed the budget.
            ...(startCursor?.perRepo ?? {}),
            ...Object.fromEntries(lastPerRepo),
          },
        }
      : null;
  processCursor = cursorAfter;

  // ONE line per tick naming exactly how much of the population was looked at.
  // A bounded window that says nothing is indistinguishable from a small
  // population -- the same class of silence #758 exists to end.
  (options.logger ?? log).info(
    {
      evaluated,
      totalOpen,
      cursorAfter,
      truncated: evaluationWindowTruncated,
    },
    'merge-coordinator.discovery_window'
  );

  return {
    candidates,
    exclusions,
    evaluated,
    fallbackReviewDecisions,
    unavailable: !anyRepoListed,
    totalOpen,
    evaluationWindowTruncated,
    cursorAfter,
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
