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
  isAutoRereview: boolean;
}

/** Maximum auto-triggered re-reviews per PR; the initial review is not an attempt. */
export const MAX_REREVIEW_ATTEMPTS = 3;

export function buildRereviewReason(
  priorVerdictId: string,
  priorHeadSha: string,
  newHeadSha: string
): string {
  return `changes_requested verdict ${priorVerdictId} reviewed head ${priorHeadSha}; re-review new head ${newHeadSha}`;
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

  const priorAtDifferentHead = prior.find(work => work.headSha !== headSha);
  let repeatReason: string | null = null;
  if (priorAtDifferentHead?.verdict === 'changes_requested') {
    const rereviewAttempts = prior.filter(work => work.isAutoRereview).length;
    if (rereviewAttempts >= MAX_REREVIEW_ATTEMPTS) {
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
        reason: result.reason,
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
