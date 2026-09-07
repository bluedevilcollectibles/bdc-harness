/**
 * Real dependency composition for the check-completion re-review route
 * (bdc-harness #782).
 *
 * `pr-review-check-ingest.ts` is pure and injectable. This module is the ONLY
 * place its abstract dependencies bind to real infrastructure: the existing
 * `agent_dispatch_messages` queue and the Overseer submit receipts already
 * written there. It deliberately mirrors `pr-review-wiring.ts` rather than
 * extending it, so the same-head recheck path and the head-moved push path can
 * evolve without either regressing the other.
 *
 * NO GITHUB CLIENT IS CONSTRUCTED HERE. The whole point of #782 part 1 is to
 * decide "does this completion warrant a re-review" from the webhook payload
 * plus the local store, because the shared per-user GitHub budget is what
 * collapsed the review on #776 in the first place.
 */
import * as dispatch from '@archon/core/db/dispatch';
import type { RecheckIngestDeps, StandingVerdict } from './pr-review-check-ingest.ts';
import { recheckCorrelationId } from './pr-review-check-ingest';
import {
  REVIEW_RECIPIENT,
  REVIEW_SENDER,
  reviewSubjectKey,
  type ReviewRouteConfig,
  type ReviewWorkBody,
} from './pr-review-wiring';

/** Receipt recipient the submit path writes its verdicts to. */
const RECEIPT_RECIPIENT = 'operator';

/**
 * Shape of a `pr_review_submit_receipt` body, as written by
 * `createRealSubmitDeps.recordReceipt`. Only the fields the recheck decision
 * needs are modelled; everything else on the receipt is ignored.
 */
interface SubmitReceiptBody {
  kind?: string;
  disposition?: string;
  headSha?: string;
  reason?: string;
  event?: string;
}

/**
 * Reconstruct the standing verdict at one exact PR head from the submit
 * receipts, or null when the reviewer never reached a terminal verdict there.
 *
 * Receipts arrive newest-first, so the FIRST terminal receipt for the head wins
 * -- a later, authoritative verdict is never overwritten by an earlier attempt.
 * Non-terminal bookkeeping rows (`stale_head`, and anything whose head does not
 * match) are skipped rather than treated as the standing state.
 *
 * The verdict's `summary` is not on the receipt; what IS on it is the
 * `disposition` plus the `reason`, and for a `changes_requested` verdict the
 * receipt's `reason` is absent (the submit path records no reason on a clean
 * rejection). So the check-caused test reads the review body the reviewer
 * actually posted, which is carried on the ORIGINATING work item's result body
 * -- see `readStandingVerdict` below.
 */
export function foldSubmitReceipts(
  receipts: { body: string; created_at: string }[],
  headSha: string
): StandingVerdict | null {
  for (const receipt of receipts) {
    let body: SubmitReceiptBody;
    try {
      body = JSON.parse(receipt.body) as SubmitReceiptBody;
    } catch {
      continue;
    }
    if (body.kind !== 'pr_review_submit_receipt') continue;
    if (typeof body.disposition !== 'string') continue;
    if (typeof body.headSha === 'string' && body.headSha !== headSha) continue;
    return {
      headSha,
      disposition: body.disposition,
      summary: null,
      recordedAt: receipt.created_at,
    };
  }
  return null;
}

/**
 * Recover the review summary the reviewer posted for one head from the review
 * work item's stored result body.
 *
 * The worker writes `result_body: JSON.stringify(outcome)` when it finishes an
 * item, and the outcome carries the `reason`. For a check-caused rejection the
 * reviewer's finding text is what named the check -- so when the result body
 * offers nothing, the caller falls back to the receipt disposition alone and
 * the ingest's fail-closed default applies.
 */
export function extractReviewSummary(resultBody: string | null): string | null {
  if (!resultBody) return null;
  try {
    const parsed = JSON.parse(resultBody) as { reason?: unknown; summary?: unknown };
    if (typeof parsed.summary === 'string' && parsed.summary.length > 0) return parsed.summary;
    if (typeof parsed.reason === 'string' && parsed.reason.length > 0) return parsed.reason;
    return null;
  } catch {
    return null;
  }
}

/**
 * Binds the pure recheck ingest dependencies to the live dispatch queue.
 *
 * Reuses `agent_dispatch_messages` with `task_type: 'run_review'` so a queued
 * re-review is claimed by the SAME review worker as a push-triggered review --
 * no second worker, no second protocol. Only the idempotency key differs, and
 * it is what bounds the path to one re-review per (head, completed check).
 */
export function createRealRecheckIngestDeps(config: ReviewRouteConfig): RecheckIngestDeps {
  return {
    webhookSecret: config.webhookSecret,

    async readStandingVerdict(input): Promise<StandingVerdict | null> {
      const correlationId = recheckCorrelationId(input);
      // Exact correlation-id match: head-bound, indexed, and immune to the
      // 500-row page cap that makes a listMessages scan unable to reach an
      // older receipt.
      const receipts = await dispatch.listMessagesByCorrelationId({
        correlationId,
        recipient: RECEIPT_RECIPIENT,
      });
      const verdict = foldSubmitReceipts(receipts, input.headSha);
      if (!verdict) return null;

      // The reviewer's posted finding text lives on the work item's result
      // body, not on the receipt. Read it so a CHANGES_REQUESTED verdict can be
      // classified as check-caused (auto-clearable) or code-caused (not).
      const work = await dispatch.listMessages({
        recipient: REVIEW_RECIPIENT,
        subject_key: reviewSubjectKey(input.owner, input.repo, input.prNumber),
      });
      const atHead = work.find(message => {
        try {
          const body = JSON.parse(message.body) as Partial<ReviewWorkBody>;
          return body.headSha === input.headSha;
        } catch {
          return false;
        }
      });
      return { ...verdict, summary: extractReviewSummary(atHead?.result_body ?? null) };
    },

    async enqueueRecheckWork(input): Promise<{ messageId: string; alreadyExisted: boolean }> {
      const subjectKey = reviewSubjectKey(input.owner, input.repo, input.prNumber);
      // createAuthenticatedMessage is idempotent on idempotency_key: it returns
      // the EXISTING row rather than inserting a duplicate. Look for the prior
      // row FIRST so a replay is reported honestly rather than inferred.
      const prior = await dispatch.listMessages({
        recipient: REVIEW_RECIPIENT,
        subject_key: subjectKey,
      });
      const alreadyExisted = prior.some(
        message => message.idempotency_key === input.idempotencyKey
      );
      const body: ReviewWorkBody = {
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseRef: '',
        author: '',
      };
      const message = await dispatch.createAuthenticatedMessage(
        { kind: 'system', sender: REVIEW_SENDER },
        {
          correlation_id: input.correlationId,
          idempotency_key: input.idempotencyKey,
          task_type: 'run_review',
          recipient: REVIEW_RECIPIENT,
          body: JSON.stringify(body),
          subject_key: subjectKey,
          repeat_reason: input.repeatReason,
        }
      );
      return { messageId: message.id, alreadyExisted };
    },

    async recordReceipt(input): Promise<void> {
      await dispatch.createAuthenticatedMessage(
        { kind: 'system', sender: REVIEW_SENDER },
        {
          correlation_id: input.correlationId || `pr-recheck-receipt:${input.deliveryId}`,
          idempotency_key: `pr-recheck-receipt:${input.deliveryId}:${input.prNumber ?? 'none'}:${input.disposition}`,
          task_type: 'run_report',
          recipient: RECEIPT_RECIPIENT,
          body: JSON.stringify({
            kind: 'pr_review_recheck_ingest_receipt',
            deliveryId: input.deliveryId,
            owner: input.owner,
            repo: input.repo,
            prNumber: input.prNumber,
            headSha: input.headSha,
            disposition: input.disposition,
            reason: input.reason ?? null,
            messageId: input.messageId ?? null,
          }),
        }
      );
    },
  };
}
