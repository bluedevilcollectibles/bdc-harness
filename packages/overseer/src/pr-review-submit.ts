/**
 * Governed reviewer -> GitHub review submission
 * (WO-HARNESS-OVERSEER-REVIEW-ROUTE-01, XO authorization 2026-08-17).
 *
 * The second half of the review route. `pr-review-ingest.ts` turns a verified
 * pull_request event into durable work bound to an exact head; this module
 * takes one claimed work item, runs the governed reviewer, and submits the
 * resulting verdict through the EXISTING Overseer App adapter.
 *
 * XO decision 1 (2026-08-17): a non-approving verdict MUST submit
 * REQUEST_CHANGES -- approve-only is not a reviewer. If submission fails, we
 * fail closed and record the blocker rather than silently degrading to "no
 * review", which would leave the PR indistinguishable from never-reviewed.
 *
 * The reviewer itself is injected. This module owns custody enforcement,
 * exact-head binding, verdict-to-event mapping, evidence-body construction,
 * and receipt writing -- not the review judgment.
 */
import type {
  OverseerReviewEvent,
  SubmitPullRequestReviewInput,
  SubmitPullRequestReviewResult,
} from './adapters/github-real-deps.ts';
import { hasDistinctMergeIdentity } from './adapters/github-real-deps';
import { resolveMergeManagerMode } from './merge-manager';

/** What the governed reviewer returns. */
export interface ReviewerVerdict {
  /** true -> APPROVE; false -> REQUEST_CHANGES. */
  approved: boolean;
  /** Evidence. REQUIRED (non-empty) when approved === false. */
  summary: string;
  /** The head the reviewer actually examined. Must match the work item. */
  reviewedHeadSha: string;
  /**
   * True when CI checks on the bound head are not yet terminal, so no verdict
   * was formed. A non-terminal disposition -- MUST NOT be collapsed into
   * `approved: false` (that would be a REQUEST_CHANGES on checks-pending
   * grounds, the exact bug WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01
   * fixes). The worker releases and retries the item on a later tick.
   */
  checksPending?: boolean;
  /**
   * Set when the required status-check contexts could not be read after the
   * configured attempt bound (#775). TERMINAL and NON-APPROVING: unlike
   * `checksPending` the item is not released for another try, and unlike
   * `approved: false` it is not a code rejection -- the reviewer found nothing
   * wrong, it could not see what CI is mandatory. The submit path posts a
   * COMMENT review carrying `summary` and finishes with
   * `blocked_required_contexts_unavailable`, which the worker escalates.
   */
  requiredContextsUnavailable?: boolean;
}

export interface ReviewWorkItem {
  correlationId: string;
  messageId: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** The exact head this work item is bound to. */
  headSha: string;
  author: string;
}

export type SubmitDisposition =
  | 'approved'
  | 'changes_requested'
  | 'custody_conflict'
  | 'merge_custody_conflict'
  | 'stale_head'
  | 'reviewer_failed'
  | 'submission_failed'
  | 'checks_pending'
  /**
   * NON-TERMINAL (#777 review finding). The head under evaluation was
   * superseded before a required-contexts BLOCK could be recorded. Released and
   * requeued for the new head, exactly like `checks_pending` -- never terminal,
   * because terminating here would retire the work item for a head nobody
   * reviewed and leave the new head with no review at all.
   */
  | 'superseded_head'
  /**
   * TERMINAL, NEVER APPROVING (#775). The required status-check contexts could
   * not be read after the configured attempt bound, so the review is blocked
   * and a human is told. Only reachable once BOTH head gates have passed, so it
   * always binds to a head the reviewer actually evaluated and that is still
   * live. Distinct from `checks_pending` (non-terminal, retried) and from
   * `changes_requested` (a real code finding).
   */
  | 'blocked_required_contexts_unavailable';

export interface SubmitOutcome {
  disposition: SubmitDisposition;
  reason?: string;
  event?: OverseerReviewEvent;
}

export interface SubmitDeps {
  reviewerIdentity: string;
  /** Runs the governed reviewer against an exact head. */
  runReviewer(work: ReviewWorkItem): Promise<ReviewerVerdict>;
  /** The existing Overseer App adapter's general review submission. */
  submitReview(input: SubmitPullRequestReviewInput): Promise<SubmitPullRequestReviewResult>;
  /**
   * Current head of the PR, re-read immediately before submission. A review
   * must never land on a head the reviewer did not examine.
   */
  currentHeadSha(input: { owner: string; repo: string; prNumber: number }): Promise<string>;
  recordReceipt(input: {
    correlationId: string;
    messageId: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    disposition: SubmitDisposition;
    event?: OverseerReviewEvent;
    reason?: string;
  }): Promise<void>;
}

/** Bounds the evidence body so a runaway reviewer cannot post an essay. */
const MAX_EVIDENCE_BODY = 60_000;

/**
 * Builds the review body. Always states the exact head so the review is
 * self-evidencing about what was examined.
 */
export function buildReviewBody(work: ReviewWorkItem, verdict: ReviewerVerdict): string {
  const header = `Independent review by the Overseer App at head \`${work.headSha}\`.`;
  const summary = verdict.summary.trim();
  const body = summary.length > 0 ? `${header}\n\n${summary}` : header;
  return body.length > MAX_EVIDENCE_BODY ? body.slice(0, MAX_EVIDENCE_BODY) : body;
}

/**
 * Run the governed reviewer for one claimed work item and submit its verdict.
 *
 * Order is deliberate: custody first (never review our own PR), then the
 * reviewer, then a head re-read (a push during review invalidates the result),
 * then submission. Every terminal branch writes a receipt.
 */
export async function runAndSubmitReview(
  work: ReviewWorkItem,
  deps: SubmitDeps
): Promise<SubmitOutcome> {
  // CUSTODY: enforced here as well as at ingest, because a work item can be
  // claimed long after it was queued and this is the last point before a real
  // review lands.
  if (work.author?.toLowerCase() === deps.reviewerIdentity.toLowerCase()) {
    return finish(deps, work, work.headSha, {
      disposition: 'custody_conflict',
      reason: 'reviewer_is_pull_request_author',
    });
  }

  // MERGE-CUSTODY (M-153, RULED by John 2026-08-24: "the Review Gate reviews;
  // the Merge Manager merges" -- one identity never does both on the same PR).
  //
  // The question this gate answers is IDENTITY SEPARATION, not merge mode. A
  // review is safe to submit whenever the merge mutation will run as a
  // DIFFERENT GitHub identity than this reviewer, because then approving here
  // cannot let the same actor execute its own approval.
  //
  // Before the ruling this gate blocked on `mode === 'execute'` as a
  // conservative stand-in while M-153 was tabled. That stand-in outlived the
  // question: with the merge manager armed (the only mode that ever merges)
  // no review could be submitted, so no approval ever existed, so the merge
  // manager denied every PR for `review_gate_approval_missing_for_head`. The
  // two halves deadlocked and the machine merged nothing.
  //
  // STILL FAILS CLOSED: when no distinct merge identity is configured, the
  // merge octokit falls back to this same App, so review submission is
  // refused exactly as before.
  const mergeMode = resolveMergeManagerMode();
  if (mergeMode === 'execute' && !hasDistinctMergeIdentity()) {
    return finish(deps, work, work.headSha, {
      disposition: 'merge_custody_conflict',
      reason: 'merge_manager_shares_reviewer_identity_m153',
    });
  }

  let verdict: ReviewerVerdict;
  try {
    verdict = await deps.runReviewer(work);
  } catch (error) {
    return finish(deps, work, work.headSha, {
      disposition: 'reviewer_failed',
      reason: `reviewer_error:${errorCode(error)}`,
    });
  }

  // CHECKS PENDING: CI on the bound head is not terminal yet, so no verdict was
  // formed. This is NOT a rejection -- submit nothing and let the worker release
  // and retry later. Nothing was evaluated, so there is no head to re-read/bind.
  if (verdict.checksPending) {
    return finish(deps, work, work.headSha, {
      disposition: 'checks_pending',
      reason: 'checks_not_terminal',
    });
  }

  // EXACT-HEAD BINDING: the reviewer must have examined the bound head.
  //
  // Both head gates run BEFORE the required-contexts block below. A blocked
  // outcome is TERMINAL, so recording it against a head the reviewer did not
  // actually evaluate -- or one the PR has already moved past -- would retire
  // the work item for a head nobody reviewed (#777 review finding). Every
  // terminal branch, approving or not, passes both gates first.
  if (verdict.reviewedHeadSha !== work.headSha) {
    // A stale evaluator result must never terminate the bound head via the
    // blocked path; report it as superseded so the item is requeued.
    if (verdict.requiredContextsUnavailable) {
      return finish(deps, work, work.headSha, {
        disposition: 'superseded_head',
        reason: 'reviewer_examined_different_head_before_required_contexts_block',
      });
    }
    return finish(deps, work, work.headSha, {
      disposition: 'stale_head',
      reason: 'reviewer_examined_different_head',
    });
  }

  // A push during review invalidates the verdict; do not land it on a head
  // nobody reviewed.
  let liveHead: string;
  try {
    liveHead = await deps.currentHeadSha({
      owner: work.owner,
      repo: work.repo,
      prNumber: work.prNumber,
    });
  } catch (error) {
    return finish(deps, work, work.headSha, {
      disposition: 'submission_failed',
      reason: `head_recheck_failed:${errorCode(error)}`,
    });
  }
  if (liveHead !== work.headSha) {
    // The PR moved while we were evaluating. For a required-contexts BLOCK this
    // matters more than for an ordinary verdict: blocking is terminal, so
    // landing it here would retire the item for head A and leave the new head B
    // with no review at all. Report it as superseded so the worker requeues and
    // re-evaluates against B, rather than closing the book on a head nobody
    // judged.
    if (verdict.requiredContextsUnavailable) {
      return finish(deps, work, work.headSha, {
        disposition: 'superseded_head',
        reason: 'head_advanced_before_required_contexts_block',
      });
    }
    return finish(deps, work, work.headSha, {
      disposition: 'stale_head',
      reason: 'head_advanced_during_review',
    });
  }

  // REQUIRED CONTEXTS UNAVAILABLE (#775): bounded deferral has been exhausted,
  // and the head the reviewer evaluated is confirmed to still be the live head.
  // Post a COMMENT so the PR itself says why it is blocked, then finish with a
  // terminal non-approving disposition the worker escalates. Submission failure
  // must NOT convert this into a retry or an approval, so the disposition is
  // preserved either way -- the escalation is what guarantees a human sees it.
  if (verdict.requiredContextsUnavailable) {
    let submitted = false;
    let submitMessage: string | undefined;
    try {
      const result = await deps.submitReview({
        owner: work.owner,
        repo: work.repo,
        number: work.prNumber,
        event: 'COMMENT',
        body: buildReviewBody(work, verdict),
        commitId: work.headSha,
      });
      submitted = result.submitted;
      submitMessage = result.message;
    } catch (error) {
      submitMessage = errorCode(error);
    }
    return finish(deps, work, work.headSha, {
      disposition: 'blocked_required_contexts_unavailable',
      reason: submitted
        ? 'required_contexts_unavailable_blocked'
        : `required_contexts_unavailable_blocked:comment_failed:${submitMessage ?? 'unknown'}`,
      event: 'COMMENT',
    });
  }

  const event: OverseerReviewEvent = verdict.approved ? 'APPROVE' : 'REQUEST_CHANGES';
  const body = buildReviewBody(work, verdict);

  // A rejection with no evidence is not actionable; refuse before the call.
  if (!verdict.approved && verdict.summary.trim().length === 0) {
    return finish(deps, work, work.headSha, {
      disposition: 'submission_failed',
      reason: 'request_changes_missing_evidence',
      event,
    });
  }

  let submission: SubmitPullRequestReviewResult;
  try {
    submission = await deps.submitReview({
      owner: work.owner,
      repo: work.repo,
      number: work.prNumber,
      event,
      body,
      // The exact head this work item is bound to -- the SAME sha the
      // reviewer verdict was already checked against above. Never the
      // live/current head; a push during review is caught by the
      // stale-head check before this call is ever reached.
      commitId: work.headSha,
    });
  } catch (error) {
    return finish(deps, work, work.headSha, {
      disposition: 'submission_failed',
      reason: `submit_threw:${errorCode(error)}`,
      event,
    });
  }

  if (!submission.submitted) {
    return finish(deps, work, work.headSha, {
      disposition: 'submission_failed',
      reason: submission.message ?? 'submit_rejected',
      event,
    });
  }

  return finish(deps, work, work.headSha, {
    disposition: verdict.approved ? 'approved' : 'changes_requested',
    event,
  });
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 120);
  return 'unknown_error';
}

async function finish(
  deps: SubmitDeps,
  work: ReviewWorkItem,
  headSha: string,
  outcome: SubmitOutcome
): Promise<SubmitOutcome> {
  try {
    await deps.recordReceipt({
      correlationId: work.correlationId,
      messageId: work.messageId,
      owner: work.owner,
      repo: work.repo,
      prNumber: work.prNumber,
      headSha,
      disposition: outcome.disposition,
      ...(outcome.event ? { event: outcome.event } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
  } catch {
    // Receipt failure never converts a classified outcome into a throw.
  }
  return outcome;
}
