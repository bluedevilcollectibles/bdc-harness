import type { DecisionResult } from './decide.ts';
import type { ErrorClass } from './classify.ts';

export type WatchedRunStatus = string;

export interface OverseerRunRecord {
  id: string;
  woId: string;
  /**
   * Repo identity as recorded by the run. OPTIONAL -- most runs carry none, and an
   * absent repo must stay absent rather than defaulting to a guess (see parseRepo in
   * @archon/core/db/overseer).
   */
  repo?: string;
  owner?: string;
  status: WatchedRunStatus;
  headBranch?: string;
  /** Engine-written worktree path. Provenance anchor -- not agent-authored. */
  workingPath?: string;
  metadata?: Record<string, unknown>;
}

export interface OverseerWorkflowEvent {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at?: string;
}

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export type PullRequestState = string;

export interface PullRequestCheckSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  conclusion?: string;
}

export interface PullRequestEvidence {
  exists: boolean;
  state: PullRequestState;
  checks: PullRequestCheckSummary;
  mergeable: boolean | null;
  pr?: PullRequestRef;
  prTitle?: string;
  filesChangedCount?: number;
  diffStat?: string;
  htmlUrl?: string;
  /**
   * Head SHA as reported by the GitHub API for this PR. Independent of run metadata --
   * merge provenance compares this against the run's own worktree tip.
   */
  headSha?: string;
  /**
   * True when the lookup itself failed, so `exists: false` means "unknown", not
   * "no PR". Never widens the merge gate (both cases stay `exists: false`); it
   * exists so the watcher stops reporting an unverified absence as a fact.
   */
  lookupFailed?: boolean;
}

export interface GrokJudgeEvidence {
  woId: string;
  prNumber: number;
  prTitle: string;
  headSha: string;
  baseSha: string;
  evidenceDigest: string;
  operator: MergeOperatorIdentity;
  checksSummary: PullRequestCheckSummary;
  filesChangedCount: number;
  diffStat: string;
}

export interface MergeOperatorIdentity {
  identity: string;
  provider: string;
  modelFamily: string;
}

export interface GrokDispositionReceipt {
  schemaVersion: 'overseer-grok-merge-disposition-v1';
  disposition: 'approve' | 'hold';
  reason:
    | 'judge_approve'
    | 'judge_hold'
    | 'judge_output_invalid'
    | 'judge_timeout'
    | 'judge_exit_nonzero'
    | 'judge_error';
  woId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  evidenceDigest: string;
  operator: MergeOperatorIdentity;
}

export interface WatchedRunRecord {
  runId: string;
  woId: string;
  /** Carried through from the run; absent when the run recorded no repo identity. */
  repo?: string;
  owner?: string;
  status: WatchedRunStatus;
  headBranch?: string;
  /** Engine-written worktree path. Provenance anchor -- not agent-authored. */
  workingPath?: string;
  metadata?: Record<string, unknown>;
  errorClass?: ErrorClass | 'tail_node_false_fail';
  action: 'success' | 'merge_ready' | 'escalate' | 'ignore';
  reason: string;
  prEvidence: PullRequestEvidence;
  decision?: DecisionResult;
  lastEvent?: OverseerWorkflowEvent;
}

export interface OverseerRunStoreDeps {
  listRunsForWatch(): Promise<OverseerRunRecord[]>;
  listRunEvents(runId: string): Promise<OverseerWorkflowEvent[]>;
}

export interface OverseerActionsDeps {
  insertOverseerAction(record: {
    runId: string;
    woId: string;
    class: string;
    action: string;
    result: string;
  }): Promise<void>;
}

export interface GrokJudgeDeps {
  judgeSecondOpinion?(evidence: GrokJudgeEvidence): Promise<GrokDispositionReceipt>;
}

export interface GitHubPullRequestSearchInput {
  owner: string;
  repo: string;
  headBranch?: string;
  woId?: string;
  /**
   * Exact pull request number, when the caller already knows it (PR-first
   * discovery does). `headBranch` and `woId` are both NON-UNIQUE -- two forks
   * can push the same branch name and one WO id can span several PRs -- so an
   * implementation that can address a PR directly should prefer this. Optional:
   * implementations may ignore it, and callers verify the returned evidence
   * binds to the PR they asked about regardless.
   */
  prNumber?: number;
}

export interface GitHubPullRequestMergeInput extends PullRequestRef {
  commitTitle?: string;
}

/**
 * One open pull request as returned by PR-first candidate discovery
 * (bdc-harness#758). Deliberately carries only what the discovery predicates
 * read -- the full evidence fetch (checks, mergeability) stays with
 * findPullRequest so a PR excluded on structural grounds costs no extra call.
 */
export interface DiscoveredPullRequest {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  /** GitHub's PR state, e.g. 'open'. */
  state: string;
  draft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  /**
   * GitHub's aggregate review decision: 'APPROVED', 'CHANGES_REQUESTED',
   * 'REVIEW_REQUIRED', or null when the repo/API reports none. Never inferred
   * from individual reviews here -- an absent decision stays absent.
   */
  reviewDecision: string | null;
  /** WO id when one is recoverable from the PR, used to sharpen evidence lookup. */
  woId?: string;
}

export interface GitHubOpenPullRequestListInput {
  owner: string;
  repo: string;
  /** Base branches to restrict the listing to; empty means every base. */
  baseBranches?: readonly string[];
}

/**
 * PR-first discovery seam. OPTIONAL on GitHubClientDeps so every existing
 * composition (fakes, legacy wiring, tests) keeps compiling; when it is absent
 * discovery reports `unavailable` rather than reporting an empty candidate set,
 * because "we did not look" and "nothing to merge" are different facts.
 */
export interface MergeCandidateDiscoveryDeps {
  findPullRequest(input: GitHubPullRequestSearchInput): Promise<PullRequestEvidence>;
  listOpenPullRequests?(
    input: GitHubOpenPullRequestListInput
  ): Promise<readonly DiscoveredPullRequest[]>;
}

export interface GitHubClientDeps {
  findPullRequest(input: GitHubPullRequestSearchInput): Promise<PullRequestEvidence>;
  mergePullRequest(
    input: GitHubPullRequestMergeInput
  ): Promise<{ merged: boolean; message?: string; sha?: string }>;
  /** Reviews used by the Merge Manager's distinct Review Gate approval check. */
  listPullRequestReviews?(
    input: PullRequestRef
  ): Promise<{ login: string; state: string; commitId: string }[]>;
  /**
   * Tier 0 comment_findings channel (judge-first path). Optional: when absent
   * the pipeline records a loud 'comment_channel_unavailable' receipt rather
   * than silently skipping.
   */
  commentOnPullRequest?(
    input: PullRequestRef & { body: string }
  ): Promise<{ commented: boolean; url?: string }>;
  /**
   * Approve a pull request as the configured identity (the Thinman Overseer
   * GitHub App when App auth is active; otherwise the PAT identity). Optional so
   * existing GitHubClientDeps implementers (fakes, legacy compositions) keep
   * compiling. GitHub rejects self-approval regardless of identity -- the real
   * implementation surfaces a usable message rather than throwing in that case.
   */
  approvePullRequest?(input: PullRequestRef): Promise<{ approved: boolean; message?: string }>;
  /**
   * List open pull requests for PR-first merge candidate discovery
   * (bdc-harness#758). Optional: when absent the watcher keeps its
   * run-derived candidate set and logs that discovery was unavailable, rather
   * than silently reporting an empty sweep.
   */
  listOpenPullRequests?(
    input: GitHubOpenPullRequestListInput
  ): Promise<readonly DiscoveredPullRequest[]>;
}

/**
 * Verdict store dependencies for the judge-first pipeline (M-99). Mirrors the
 * claim/finalize functions in @archon/core/db/overseer; injected so tests need
 * no live database.
 */
export interface OverseerVerdictStoreDeps {
  claimVerdict(input: {
    runId: string;
    woId: string;
    headSha?: string;
    hintAction?: string;
    hintErrorClass?: string;
    maxRetries?: number;
  }): Promise<{ claimed: boolean; verdictId?: string; retryCount?: number }>;
  finalizeVerdict(input: {
    verdictId: string;
    status: string;
    verdict?: string;
    confidence?: number;
    model?: string;
    modelRung?: number;
    proposedAction?: string;
    proposedTier?: number;
    requiredTier?: number;
    effectiveTier?: number;
    reason?: string;
    evidenceDigest?: string;
    evidence?: string;
  }): Promise<unknown>;
}
