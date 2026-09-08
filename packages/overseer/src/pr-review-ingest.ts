/**
 * Pull-request event -> independent-review work ingestion
 * (WO-HARNESS-OVERSEER-REVIEW-ROUTE-01, XO authorization 2026-08-17).
 *
 * THE GAP THIS CLOSES: the Overseer App review adapter is real and
 * App-authenticated, but nothing ever calls it. GitHub pull_request events were
 * ignored, no route was registered, and no code created review work. A PR
 * therefore sat at REVIEW_REQUIRED forever with an empty reviewer slot.
 *
 * This module is the missing middle. It is deliberately PURE and INJECTABLE
 * (all IO arrives via IngestDeps) so every branch -- signature rejection,
 * duplicate delivery, exact-head binding, stale-head invalidation, custody
 * conflict, review failure, receipt creation -- is deterministically testable
 * with no network, no database, and no GitHub App key.
 *
 * DESIGN CONSTRAINTS HONORED:
 *  - Signature verification REUSES the extracted proven helper; this module
 *    never implements HMAC itself.
 *  - Durable work REUSES agent_dispatch_messages (task_type 'run_review'),
 *    whose UNIQUE idempotency_key already provides retry dedupe and whose
 *    fencing-token claims are already tested. No second queue.
 *  - Custody separation is enforced BEFORE invoking the reviewer, locally, so
 *    a self-review is never attempted; GitHub's own 422 remains the backstop.
 *  - Every terminal outcome writes a correlated receipt.
 *  - Every failure fails CLOSED with a visible blocker reason.
 *
 * SCOPE: source + tests only. Enabling the App's event subscription, deploying
 * the route, submitting a live review, and merging remain separately gated.
 */
import { checkGitHubWebhookSignature } from '@archon/adapters/forge/github/webhook-signature';

/** pull_request actions that warrant a fresh independent review. */
export const REVIEWABLE_PR_ACTIONS = [
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
] as const;
export type ReviewablePrAction = (typeof REVIEWABLE_PR_ACTIONS)[number];

/** Terminal dispositions. Every one is recorded as a receipt. */
export type IngestDisposition =
  | 'queued'
  | 'duplicate_delivery'
  | 'superseded_head'
  | 'ignored_event'
  | 'ignored_draft'
  | 'rejected_signature'
  | 'custody_conflict'
  | 'blocked';

export interface IngestResult {
  disposition: IngestDisposition;
  /** HTTP status the route should return. */
  status: number;
  /** Stable machine-readable reason; the visible blocker on failure. */
  reason?: string;
  correlationId?: string;
  messageId?: string;
  /** Exact head SHA the queued work is bound to. */
  headSha?: string;
  /** Prior work invalidated by a head change. */
  invalidatedMessageIds?: string[];
}

/** Minimal shape of the inbound pull_request webhook payload. */
export interface PullRequestWebhookPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    draft?: boolean;
    state?: string;
    head?: { sha?: string; ref?: string };
    base?: { ref?: string; sha?: string };
    user?: { login?: string; type?: string };
  };
  repository?: { name?: string; owner?: { login?: string }; full_name?: string };
  sender?: { login?: string; type?: string };
}

/** A prior review work item for this PR, used for stale-head invalidation. */
export interface PriorReviewWork {
  messageId: string;
  headSha: string;
  status: 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
  verdict: 'approved' | 'changes_requested' | 'other' | null;
  verdictId: string | null;
  /**
   * True only when this row was enqueued by the AUTOMATIC re-review path --
   * i.e. its repeat_reason carries AUTO_REREVIEW_REASON_PREFIX. Initial
   * reviews, legacy `review_exact_head:` rows, and reasons written by other
   * subsystems or by hand are all false and never consume the attempt budget.
   */
  isAutoRereview: boolean;
}

/**
 * Default maximum CONSECUTIVE auto-triggered re-reviews; the initial review is
 * not an attempt. Override per deployment with OVERSEER_MAX_REREVIEW_ATTEMPTS.
 */
export const MAX_REREVIEW_ATTEMPTS = 3;

/** Env var overriding the automatic re-review budget (#797). */
export const MAX_REREVIEW_ATTEMPTS_ENV = 'OVERSEER_MAX_REREVIEW_ATTEMPTS';

/**
 * The effective automatic re-review budget (#797).
 *
 * The cap was hardcoded at 3, so the only way to let a PR that legitimately
 * needed a fourth round get one was to edit and redeploy the harness. A
 * non-numeric, zero, or negative value falls back to the default rather than
 * disabling the guard: an operator typo must not turn a runaway PR loose on the
 * judge budget, and `0` is far more likely to be a mistake than a deliberate
 * "never auto re-review". Fractions are floored so `3.9` cannot buy a fourth
 * attempt through a comparison technicality.
 */
export function resolveMaxRereviewAttempts(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[MAX_REREVIEW_ATTEMPTS_ENV];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return MAX_REREVIEW_ATTEMPTS;
  return Math.floor(parsed);
}

/**
 * Counts CONSECUTIVE automatic re-reviews since the last non-automatic review
 * that actually RAN (#797).
 *
 * The bug this fixes: the old count was `prior.filter(isAutoRereview).length`
 * over the PR's whole history, so the budget could only ever be spent, never
 * regained. A PR that converged on round five could not get its APPROVED
 * without an operator, and the hand nudge an operator DID perform bought the PR
 * exactly one review and then handed it straight back to an exhausted budget --
 * which is what left #787 and #790 dark on round four on 2026-09-08.
 *
 * `prior` is newest-first, so this walks from the newest row and stops at the
 * first non-automatic review that produced a verdict. That row is the operator
 * (or initial) look the issue calls the reset point.
 *
 * A non-automatic row is only a reset if it RAN. A hand nudge sitting `queued`,
 * or one `cancelled` by a later push, resolved nothing -- treating it as a reset
 * would let anyone refill the budget indefinitely by queueing nudges that never
 * execute, which is the runaway this cap exists to prevent. Rows with no verdict
 * are therefore skipped entirely: they neither consume the budget nor restore it.
 */
export function countConsecutiveAutoRereviews(prior: PriorReviewWork[]): number {
  let count = 0;
  for (const work of prior) {
    // A ROW WITH NO VERDICT IS NOT AN ATTEMPT, automatic or not.
    //
    // Review finding (Overseer, PR #803): the first cut counted every
    // `isAutoRereview` row before asking whether it had been judged, which
    // contradicted this function's own documented rule and was worse than a
    // doc mismatch. A row exists from the moment work is QUEUED, so a rapid
    // push sequence -- push, push, push before any review completes -- created
    // three unjudged auto rows and exhausted the whole budget before a single
    // automatic re-review had actually run. That is the exact opposite of the
    // guard's purpose: the cap exists to stop a PR that never converges from
    // burning judge budget, and an unjudged row burned none.
    //
    // The test is now symmetric. Only a row that reached a verdict counts, in
    // either direction: an auto verdict spends the budget, a non-auto verdict
    // (a hand nudge, or the initial review) restores it, and anything still in
    // flight or cancelled before judging is skipped entirely.
    if (!isJudgedVerdict(work.verdict)) continue;
    if (work.isAutoRereview) {
      count += 1;
      continue;
    }
    // A non-auto review that RAN is the reset point.
    return count;
  }
  return count;
}

/**
 * True only when a prior row's verdict means A MODEL ACTUALLY JUDGED THE CODE.
 *
 * `null` is the obvious case (queued, claimed, or cancelled before completion).
 * `'other'` is the subtle one, and it matters: `classifyVerdict` maps EVERY
 * non-approve/non-changes_requested submit disposition to `'other'`, and the
 * submit path writes a receipt for all of them -- including the DEFERRALS
 * `checks_pending` and `transport_error`, where no judge was reached and no
 * verdict was formed (#789, #790). Counting those as attempts would let a PR
 * whose CI is merely slow, or whose judge host is briefly unreachable, burn its
 * entire re-review budget without a single review having happened.
 *
 * Symmetrically, `'other'` must not RESET the budget either: a non-auto row
 * that only deferred is not the operator look the reset represents.
 */
function isJudgedVerdict(verdict: PriorReviewWork['verdict']): boolean {
  return verdict === 'approved' || verdict === 'changes_requested';
}

/**
 * Marker embedded in the cap-exhausted PR comment so the same comment is never
 * posted twice for one head (#797).
 *
 * Idempotency has to key on the HEAD, not the PR: a PR can exhaust its budget,
 * get a hand nudge, converge, regress, and exhaust it again at a later head,
 * and each of those is a distinct thing the author needs telling about. The
 * marker is HTML-commented so it is invisible in the rendered comment while
 * remaining exact-matchable by the adapter.
 */
export function rereviewCapCommentMarker(headSha: string): string {
  return `<!-- overseer:rereview-budget-exhausted:${headSha} -->`;
}

/**
 * The comment posted on the PR when the automatic budget is exhausted (#797).
 *
 * The whole defect was invisibility: the cap blocked the push with HTTP 200, an
 * operator receipt, and a log line, so from the PR's side the reviewer simply
 * stopped answering. This says what happened and what to do about it, in the
 * one place the person pushing is actually looking.
 */
export function buildRereviewCapComment(headSha: string, maxAttempts: number): string {
  return [
    rereviewCapCommentMarker(headSha),
    `Automatic re-review budget (${maxAttempts}) exhausted for this pull request.`,
    '',
    `The last review requested changes, and ${maxAttempts} consecutive automatic re-reviews have already run since a maintainer last looked. No review was queued for \`${headSha}\`.`,
    '',
    'A maintainer can request one more review with a Dispatch nudge; once a hand-requested review runs, automatic re-reviews resume for later pushes.',
  ].join('\n');
}

/**
 * Explicit machine-readable marker prefixing every repeat_reason this module
 * writes for an AUTOMATIC re-review.
 *
 * `repeat_reason` is shared free text: Dispatch requires SOME reason on any
 * repeat send, and several unrelated writers already fill it -- Taskmaster
 * nudges (`tm:nudge:*`), XO escalation handoffs, hand-written operator
 * re-review requests, and the pre-2026-09 Overseer enqueue path which stamped
 * EVERY review (initial ones included) with `review_exact_head:<sha>`. So a
 * non-null reason proves nothing about who wrote it or why.
 *
 * Review finding (Overseer, PR #772): deriving `isAutoRereview` from
 * `repeat_reason !== null` therefore counts all of those as automatic
 * re-review attempts, and a PR carrying MAX_REREVIEW_ATTEMPTS legacy rows is
 * capped before a single automatic re-review has actually run. Verified
 * against the live event store 2026-09-06: 6 rows in the legacy
 * `review_exact_head:` format and 134 hand-written prose reasons, with
 * shopops#662 alone holding 16 -- every one of which would have counted.
 *
 * The cap now counts ONLY rows this module marked. Anything else -- legacy
 * format, another subsystem, a human -- is not an attempt.
 */
export const AUTO_REREVIEW_REASON_PREFIX = 'auto_rereview:head_moved:';

/**
 * True only for a repeat_reason this module wrote for an automatic re-review.
 * Deliberately narrow: unrecognized reasons are NOT attempts, so an unrelated
 * writer can never consume a PR's re-review budget.
 */
export function isAutoRereviewReason(repeatReason: string | null | undefined): boolean {
  return typeof repeatReason === 'string' && repeatReason.startsWith(AUTO_REREVIEW_REASON_PREFIX);
}

export function buildRereviewReason(
  priorVerdictId: string,
  priorHeadSha: string,
  newHeadSha: string
): string {
  return `${AUTO_REREVIEW_REASON_PREFIX}${newHeadSha} changes_requested verdict ${priorVerdictId} reviewed head ${priorHeadSha}; re-review new head ${newHeadSha}`;
}

/**
 * Selects the prior review whose verdict authorizes (or refuses) an automatic
 * re-review of `headSha`.
 *
 * Review finding (Overseer, PR #772): the previous `prior.find(work =>
 * work.headSha !== headSha)` took the FIRST row on a different head.
 * `listPriorReviewWork` returns newest-first, and a row is created the moment
 * work is queued -- long before any verdict exists. So a rapid push sequence
 * lost the verdict entirely:
 *
 *   1. head A is reviewed -> CHANGES_REQUESTED (row A carries the verdict)
 *   2. head B arrives -> row B is queued, verdict null
 *   3. head C arrives before B completes -> B is cancelled (verdict still
 *      null), and `find` selects row B because it is newer than A
 *
 * At step 3 the selected row's verdict is null, so no repeat reason was built,
 * and Dispatch rejected the enqueue with `repeat_reason_required` -- the
 * automatic re-review silently died exactly when the author was pushing
 * fastest. The verdict on A was still the live, unaddressed one.
 *
 * The fix is to skip rows that carry no verdict (queued, claimed, or cancelled
 * before completion) and select the most recent VERDICT-BEARING row on a
 * different head. That row is the standing review state of the PR.
 *
 * Rows on the CURRENT head are still excluded: a verdict on this exact head is
 * a duplicate delivery, not a supersession, and must not authorize a repeat.
 * A verdict of `approved` or `other` is deliberately still selected rather
 * than skipped, so an approval continues to withhold authorization instead of
 * letting an older changes_requested row reach back past it.
 */
export function findAuthorizingPriorReview(
  prior: PriorReviewWork[],
  headSha: string
): PriorReviewWork | undefined {
  return prior.find(work => work.headSha !== headSha && work.verdict !== null);
}

export interface IngestDeps {
  /** Shared webhook secret. Empty/absent means the route must fail closed. */
  webhookSecret: string;
  /**
   * The reviewer identity that will submit the review (e.g.
   * 'thinman-overseer[bot]'). Custody separation compares the PR author
   * against this; a match is refused before any reviewer invocation.
   */
  reviewerIdentity: string;
  /** Prior review work for (owner, repo, prNumber), newest first. */
  listPriorReviewWork(input: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<PriorReviewWork[]>;
  /** Cancel superseded work. Idempotent; returns ids actually invalidated. */
  cancelReviewWork(input: { messageIds: string[]; reason: string }): Promise<string[]>;
  /**
   * Enqueue durable review work. MUST be backed by
   * agent_dispatch_messages(task_type='run_review'); its UNIQUE
   * idempotency_key is what makes duplicate delivery a no-op.
   */
  enqueueReviewWork(input: {
    correlationId: string;
    idempotencyKey: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    baseRef: string;
    author: string;
    repeatReason: string | null;
  }): Promise<{ messageId: string; alreadyExisted: boolean }>;
  /**
   * Post the cap-exhausted notice on the PR (#797). MUST be idempotent per
   * head: the implementation checks for an existing comment carrying
   * `rereviewCapCommentMarker(headSha)` before creating one, so a repeated
   * push at the same head does not spam the thread.
   *
   * Optional so existing dependency doubles keep compiling; when absent, the
   * cap still blocks and still writes its receipt -- it just stays silent, i.e.
   * exactly the pre-#797 behaviour rather than a crash.
   *
   * Returns whether a comment was actually created (false = one already
   * existed), which the receipt records so an operator can tell a first
   * exhaustion from a repeat.
   */
  postCapExhaustedComment?(input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    body: string;
    marker: string;
  }): Promise<{ posted: boolean }>;
  /** Persist a correlated audit receipt. Never throws the ingest path open. */
  recordReceipt(input: {
    correlationId: string;
    deliveryId: string;
    owner: string;
    repo: string;
    prNumber: number | null;
    headSha: string | null;
    disposition: IngestDisposition;
    reason?: string;
    messageId?: string;
  }): Promise<void>;
}

export interface IngestRequest {
  /** RAW request body. Never a re-serialized object. */
  rawBody: string;
  signature: string | undefined | null;
  /** x-github-event */
  eventType: string | undefined | null;
  /** x-github-delivery -- the dedupe key for retried deliveries. */
  deliveryId: string | undefined | null;
}

/**
 * Correlation id binding work to one exact head. Deterministic (no clock, no
 * randomness) so a retried delivery of the same head computes the same value.
 */
export function reviewCorrelationId(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): string {
  return `pr-review:${input.owner}/${input.repo}#${input.prNumber}@${input.headSha}`;
}

/**
 * Idempotency key for the durable queue row. Includes the delivery id so a
 * GitHub retry of the SAME delivery collapses onto the same row, while a
 * genuinely new event for the same head still dedupes via correlation.
 */
export function reviewIdempotencyKey(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): string {
  return reviewCorrelationId(input);
}

function isReviewableAction(action: string | undefined): action is ReviewablePrAction {
  return (REVIEWABLE_PR_ACTIONS as readonly string[]).includes(action ?? '');
}

/**
 * Verify, ingest, dedupe, invalidate stale work, enforce custody, and queue
 * durable independent-review work bound to an exact head.
 *
 * Fails closed at every branch: a missing secret, a bad signature, an
 * unparseable body, a missing head SHA, a custody conflict, or an enqueue
 * error all produce a receipt and a non-queued disposition. The reviewer is
 * never invoked from here -- this function only creates the durable work item
 * a governed reviewer later claims.
 */
export async function ingestPullRequestEvent(
  request: IngestRequest,
  deps: IngestDeps
): Promise<IngestResult> {
  const deliveryId = request.deliveryId?.trim() ?? '';

  // Fail closed on an unconfigured secret rather than accepting unverified input.
  if (!deps.webhookSecret) {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 500,
      reason: 'webhook_secret_not_configured',
    };
    await safeReceipt(deps, {
      correlationId: '',
      deliveryId,
      owner: '',
      repo: '',
      prNumber: null,
      headSha: null,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  const signature = checkGitHubWebhookSignature(
    request.rawBody,
    request.signature,
    deps.webhookSecret
  );
  if (!signature.valid) {
    const result: IngestResult = {
      disposition: 'rejected_signature',
      status: 401,
      reason: `signature_${signature.reason ?? 'invalid'}`,
    };
    await safeReceipt(deps, {
      correlationId: '',
      deliveryId,
      owner: '',
      repo: '',
      prNumber: null,
      headSha: null,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  // Only parse AFTER the signature passes -- unverified input is never parsed.
  let payload: PullRequestWebhookPayload;
  try {
    payload = JSON.parse(request.rawBody) as PullRequestWebhookPayload;
  } catch {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 400,
      reason: 'payload_unparseable',
    };
    await safeReceipt(deps, {
      correlationId: '',
      deliveryId,
      owner: '',
      repo: '',
      prNumber: null,
      headSha: null,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  if (request.eventType !== 'pull_request') {
    return finishIgnored(deps, deliveryId, 'ignored_event', 'event_type_not_pull_request');
  }
  if (!isReviewableAction(payload.action)) {
    return finishIgnored(deps, deliveryId, 'ignored_event', 'action_not_reviewable');
  }

  const owner = payload.repository?.owner?.login ?? '';
  const repo = payload.repository?.name ?? '';
  const prNumber = payload.pull_request?.number ?? payload.number ?? 0;
  const headSha = payload.pull_request?.head?.sha ?? '';
  const baseRef = payload.pull_request?.base?.ref ?? '';
  const author = payload.pull_request?.user?.login ?? '';

  if (!owner || !repo || !prNumber || !headSha) {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 400,
      reason: 'incomplete_pull_request_context',
    };
    await safeReceipt(deps, {
      correlationId: '',
      deliveryId,
      owner,
      repo,
      prNumber: prNumber || null,
      headSha: headSha || null,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  // A draft PR is not ready for independent review.
  if (payload.pull_request?.draft === true && payload.action !== 'ready_for_review') {
    return finishIgnored(deps, deliveryId, 'ignored_draft', 'pull_request_is_draft', {
      owner,
      repo,
      prNumber,
      headSha,
    });
  }

  const correlationId = reviewCorrelationId({ owner, repo, prNumber, headSha });

  // CUSTODY SEPARATION: never review our own work. Checked BEFORE any reviewer
  // invocation or enqueue, so a self-review is not merely rejected remotely --
  // it is never attempted.
  if (author?.toLowerCase() === deps.reviewerIdentity.toLowerCase()) {
    const result: IngestResult = {
      disposition: 'custody_conflict',
      status: 200,
      reason: 'reviewer_is_pull_request_author',
      correlationId,
      headSha,
    };
    await safeReceipt(deps, {
      correlationId,
      deliveryId,
      owner,
      repo,
      prNumber,
      headSha,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  // STALE-HEAD INVALIDATION: a head change invalidates every prior in-flight
  // review for this PR bound to a different head. Prior work on the SAME head
  // is a duplicate, not a supersession.
  let invalidatedMessageIds: string[] = [];
  let prior: PriorReviewWork[] = [];
  try {
    prior = await deps.listPriorReviewWork({ owner, repo, prNumber });
    const staleIds = prior
      .filter(work => work.headSha !== headSha)
      .filter(work => work.status === 'queued' || work.status === 'claimed')
      .map(work => work.messageId);
    if (staleIds.length > 0) {
      invalidatedMessageIds = await deps.cancelReviewWork({
        messageIds: staleIds,
        reason: `superseded_by_head_${headSha}`,
      });
    }
  } catch (error) {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 500,
      reason: `stale_head_invalidation_failed:${errorCode(error)}`,
      correlationId,
      headSha,
    };
    await safeReceipt(deps, {
      correlationId,
      deliveryId,
      owner,
      repo,
      prNumber,
      headSha,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  const priorAtDifferentHead = findAuthorizingPriorReview(prior, headSha);
  let repeatReason: string | null = null;
  if (priorAtDifferentHead?.verdict === 'changes_requested') {
    // CONSECUTIVE, not lifetime (#797): a hand-requested review that ran resets
    // the budget, so a PR converging on a later round is not permanently locked
    // out of automatic review.
    const maxAttempts = resolveMaxRereviewAttempts();
    const rereviewAttempts = countConsecutiveAutoRereviews(prior);
    if (rereviewAttempts >= maxAttempts) {
      // SAY SO ON THE PR. The cap previously blocked with HTTP 200 and no
      // visible trace, so the author saw the reviewer simply go quiet.
      let commentPosted: boolean | null = null;
      if (deps.postCapExhaustedComment) {
        try {
          const outcome = await deps.postCapExhaustedComment({
            owner,
            repo,
            prNumber,
            headSha,
            body: buildRereviewCapComment(headSha, maxAttempts),
            marker: rereviewCapCommentMarker(headSha),
          });
          commentPosted = outcome.posted;
        } catch {
          // A comment failure must not change the disposition: the block is
          // correct either way, and the receipt still reaches the operator.
          commentPosted = false;
        }
      }
      const result: IngestResult = {
        disposition: 'blocked',
        status: 200,
        reason: 'rereview_attempts_exhausted',
        correlationId,
        headSha,
        ...(invalidatedMessageIds.length > 0 ? { invalidatedMessageIds } : {}),
      };
      await safeReceipt(deps, {
        correlationId,
        deliveryId,
        owner,
        repo,
        prNumber,
        headSha,
        disposition: result.disposition,
        reason:
          commentPosted === null
            ? result.reason
            : `${result.reason}:comment_${commentPosted ? 'posted' : 'existing_or_failed'}`,
      });
      return result;
    }
    repeatReason = buildRereviewReason(
      priorAtDifferentHead.verdictId ?? priorAtDifferentHead.messageId,
      priorAtDifferentHead.headSha,
      headSha
    );
  }

  // Queue durable work bound to this EXACT head.
  try {
    const enqueued = await deps.enqueueReviewWork({
      correlationId,
      idempotencyKey: reviewIdempotencyKey({ owner, repo, prNumber, headSha }),
      owner,
      repo,
      prNumber,
      headSha,
      baseRef,
      author,
      repeatReason,
    });
    const disposition: IngestDisposition = enqueued.alreadyExisted
      ? 'duplicate_delivery'
      : invalidatedMessageIds.length > 0
        ? 'superseded_head'
        : 'queued';
    const result: IngestResult = {
      disposition,
      status: 200,
      correlationId,
      messageId: enqueued.messageId,
      headSha,
      ...(invalidatedMessageIds.length > 0 ? { invalidatedMessageIds } : {}),
      ...(enqueued.alreadyExisted ? { reason: 'idempotent_replay' } : {}),
    };
    await safeReceipt(deps, {
      correlationId,
      deliveryId,
      owner,
      repo,
      prNumber,
      headSha,
      disposition,
      messageId: enqueued.messageId,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return result;
  } catch (error) {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 500,
      reason: `enqueue_failed:${errorCode(error)}`,
      correlationId,
      headSha,
      ...(invalidatedMessageIds.length > 0 ? { invalidatedMessageIds } : {}),
    };
    await safeReceipt(deps, {
      correlationId,
      deliveryId,
      owner,
      repo,
      prNumber,
      headSha,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 120);
  return 'unknown_error';
}

async function finishIgnored(
  deps: IngestDeps,
  deliveryId: string,
  disposition: Extract<IngestDisposition, 'ignored_event' | 'ignored_draft'>,
  reason: string,
  context?: { owner: string; repo: string; prNumber: number; headSha: string }
): Promise<IngestResult> {
  const result: IngestResult = { disposition, status: 200, reason };
  await safeReceipt(deps, {
    correlationId: context
      ? reviewCorrelationId({
          owner: context.owner,
          repo: context.repo,
          prNumber: context.prNumber,
          headSha: context.headSha,
        })
      : '',
    deliveryId,
    owner: context?.owner ?? '',
    repo: context?.repo ?? '',
    prNumber: context?.prNumber ?? null,
    headSha: context?.headSha ?? null,
    disposition,
    reason,
  });
  return result;
}

/**
 * Receipt persistence must never convert a classified outcome into an
 * unhandled throw. A receipt failure is itself logged as a blocker by the
 * caller's logger, but the ingest disposition stands.
 */
async function safeReceipt(
  deps: IngestDeps,
  input: Parameters<IngestDeps['recordReceipt']>[0]
): Promise<void> {
  try {
    await deps.recordReceipt(input);
  } catch {
    // Intentionally swallowed: see doc comment.
  }
}
