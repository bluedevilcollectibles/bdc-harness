import {
  claimMessage,
  deferMessage,
  heartbeatWorker,
  listMessages,
  postResult,
  registerWorker,
  releaseMessage,
  type DispatchTaskOutcome,
} from '@archon/core/db/dispatch';
import {
  createDurableSweepCursor,
  createRealStaleVerdictSweepDeps,
  resolveStaleSweepMax,
  runStaleVerdictSweep,
} from './stale-verdict-sweep-wiring';
import { createLogger } from '@archon/paths';
import {
  createRealSubmitDeps,
  parseReviewWorkBody,
  REVIEW_RECIPIENT,
  type ReviewRouteConfig,
} from '@archon/overseer/pr-review-wiring';
import {
  runAndSubmitReview,
  type ReviewWorkItem,
  type SubmitDisposition,
  type SubmitOutcome,
} from '@archon/overseer/pr-review-submit';

const log = createLogger('dispatch/review-worker-clock');
const REVIEW_WORKER_ID = 'overseer-review-worker';
const REVIEW_TASK_TYPE = 'run_review';
// How long a checks-pending review item is held back before it becomes
// re-claimable, so the worker does not re-poll the checks API every tick.
const CHECKS_PENDING_BACKOFF_MS = Math.max(
  1_000,
  Number(process.env.OVERSEER_REVIEW_CHECKS_PENDING_BACKOFF_MS) || 60_000
);
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export interface ReviewWorkerDeps {
  registerWorker: typeof registerWorker;
  heartbeatWorker: typeof heartbeatWorker;
  listMessages: typeof listMessages;
  claimMessage: typeof claimMessage;
  postResult: typeof postResult;
  releaseMessage: typeof releaseMessage;
  /**
   * Fenced claimed->queued deferral with a future clock. Named per
   * WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Section 7; delegates to
   * `releaseMessage`, which already carries the required fencing guards.
   */
  deferMessage: typeof deferMessage;
  runAndSubmitReview: typeof runAndSubmitReview;
  createSubmitDeps: (reviewerIdentity: string) => ReturnType<typeof createRealSubmitDeps>;
  /**
   * Backstop for lost check-completion deliveries (#782 part 3). Optional so a
   * test double can omit it; when absent the sweep simply does not run and the
   * primary review path is untouched.
   */
  staleVerdictSweep?: (config: ReviewRouteConfig) => Promise<unknown>;
}

interface ResultMapping {
  status: 'done' | 'failed';
  task_outcome: DispatchTaskOutcome;
}

function mapSubmitOutcome(
  disposition: Exclude<SubmitDisposition, 'checks_pending' | 'transport_error' | 'rate_limited'>
): ResultMapping {
  switch (disposition) {
    // `stale_head` and `superseded_head` both mean the head this item is BOUND
    // to is no longer the live head. The item's payload carries that dead SHA
    // and nothing rewrites it, so releasing it back to the queue would make
    // every later tick re-evaluate the same stale SHA and return the same
    // disposition forever (#777 review finding). Ingest already covers the new
    // head: a push cancels every in-flight item bound to a different SHA and
    // enqueues a fresh item bound to the exact new head, so this item retiring
    // leaves no head unreviewed. TERMINAL, and `succeeded` rather than
    // `blocked` because supersession is the system working, not a failure.
    case 'approved':
    case 'changes_requested':
    case 'stale_head':
    case 'superseded_head':
      return { status: 'done', task_outcome: 'succeeded' };
    // `blocked_required_contexts_unavailable` (#775): the required
    // status-check contexts could not be read after the attempt bound.
    // TERMINAL and blocked -- never released for another tick (unbounded
    // release is what parked these rows at fencing_token 240) and never
    // succeeded, because no review judgment was ever formed.
    case 'custody_conflict':
    case 'merge_custody_conflict':
    case 'blocked_required_contexts_unavailable':
      return { status: 'failed', task_outcome: 'blocked' };
    case 'reviewer_failed':
    case 'submission_failed':
      return { status: 'failed', task_outcome: 'failed' };
    default: {
      const exhaustive: never = disposition;
      throw new Error(`unknown_review_submit_disposition:${String(exhaustive)}`);
    }
  }
}

export function createRealReviewWorkerDeps(): ReviewWorkerDeps {
  return {
    registerWorker,
    heartbeatWorker,
    listMessages,
    claimMessage,
    postResult,
    releaseMessage,
    deferMessage,
    runAndSubmitReview,
    createSubmitDeps: createRealSubmitDeps,
    staleVerdictSweep: config =>
      runStaleVerdictSweep(
        createRealStaleVerdictSweepDeps(config),
        resolveStaleSweepMax(),
        // DURABLE, not process-local: archon-app-1 is rebuilt regularly, and a
        // cursor that rewinds on restart can never walk a store larger than one
        // process lifetime covers (#786 review @45aa739e).
        createDurableSweepCursor()
      ),
  };
}

export async function tickReviewWorkerClock(
  config: ReviewRouteConfig,
  deps: ReviewWorkerDeps
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await deps.registerWorker({
      worker_id: REVIEW_WORKER_ID,
      host: process.env.HOSTNAME ?? 'in-process',
      capabilities: { task_types: [REVIEW_TASK_TYPE], principal: REVIEW_RECIPIENT },
      max_concurrency: 1,
    });
    await deps.heartbeatWorker({ worker_id: REVIEW_WORKER_ID, status: 'available' });

    // listMessages has no task_type filter. Restrict the recipient in SQL and
    // then filter its generic dispatch queue locally before claiming.
    const messages = (
      await deps.listMessages({ recipient: REVIEW_RECIPIENT, status: 'queued' })
    ).filter(message => message.task_type === REVIEW_TASK_TYPE);

    for (const message of messages) {
      try {
        const claimed = await deps.claimMessage({ id: message.id, worker_id: REVIEW_WORKER_ID });
        if (!claimed) continue;
        const body = parseReviewWorkBody(claimed.body);
        if (!body) throw new Error('invalid_review_work_body');
        const work: ReviewWorkItem = {
          correlationId: claimed.correlation_id,
          messageId: claimed.id,
          owner: body.owner,
          repo: body.repo,
          prNumber: body.prNumber,
          headSha: body.headSha,
          author: body.author,
        };
        const outcome: SubmitOutcome = await deps.runAndSubmitReview(
          work,
          deps.createSubmitDeps(config.reviewerIdentity)
        );
        // CHECKS PENDING is the ONLY non-terminal disposition: the bound head is
        // still live and CI on it has simply not concluded, so releasing the
        // claim with a backoff retries the SAME head productively.
        //
        // `superseded_head` is deliberately NOT released here. Its bound head is
        // dead, the payload still names that dead SHA, and a release would spin
        // the item forever -- see mapSubmitOutcome for the full reasoning.
        if (outcome.disposition === 'checks_pending') {
          // WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Section 7 names this
          // transition `deferMessage`; it is the same fenced claimed->queued
          // transition, called by its WO name.
          await deps.deferMessage({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            defer_until: new Date(Date.now() + CHECKS_PENDING_BACKOFF_MS).toISOString(),
          });
          continue;
        }
        // RATE LIMITED (#782 part 2) is non-terminal for the same reason, but
        // its backoff comes from GitHub's own reset clock rather than a fixed
        // interval: retrying before the budget refills would just burn another
        // request and re-defer (#774's spin). A response with no usable clock
        // falls back to the checks-pending interval so the wait is always
        // finite.
        if (outcome.disposition === 'rate_limited') {
          const deferUntil =
            outcome.retryAfter ??
            new Date(
              Date.now() + (outcome.retryAfterMs ?? CHECKS_PENDING_BACKOFF_MS)
            ).toISOString();
          log.warn(
            { messageId: claimed.id, reason: outcome.reason, deferUntil },
            'overseer_review_rate_limited_deferred'
          );
          await deps.deferMessage({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            defer_until: deferUntil,
          });
          continue;
        }
        // TRANSPORT ERROR (#789) is non-terminal for the same reason: the judge
        // process was never reached, so nothing about the code was evaluated.
        // Terminating here would post CHANGES_REQUESTED for a review that never
        // ran -- the bug this fixes. The backoff comes from the evaluator so a
        // persistent spawn failure cannot spin the worker every tick.
        if (outcome.disposition === 'transport_error') {
          log.warn(
            { messageId: claimed.id, reason: outcome.reason },
            'overseer_review_transport_error_deferred'
          );
          await deps.releaseMessage({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            not_before: new Date(
              Date.now() + (outcome.retryAfterMs ?? CHECKS_PENDING_BACKOFF_MS)
            ).toISOString(),
          });
          continue;
        }
        const result = mapSubmitOutcome(outcome.disposition);
        await deps.postResult({
          id: claimed.id,
          worker_id: REVIEW_WORKER_ID,
          fencing_token: claimed.fencing_token,
          ...result,
          result_body: JSON.stringify(outcome),
        });
      } catch (error) {
        log.error({ err: error, messageId: message.id }, 'overseer_review_work_item_failed');
      }
    }

    // STALE-VERDICT SWEEP (#782 part 3). Runs AFTER the queue is drained so a
    // sweep-enqueued re-review is picked up on the NEXT tick rather than
    // extending this one, and so a sweep failure can never delay the primary
    // review path. It is internally bounded and never throws.
    if (deps.staleVerdictSweep) {
      try {
        await deps.staleVerdictSweep(config);
      } catch (error) {
        log.error({ err: error }, 'overseer_stale_verdict_sweep_failed');
      }
    }
  } catch (error) {
    log.error({ err: error }, 'overseer_review_worker_tick_failed');
  } finally {
    inFlight = false;
  }
}

export function startReviewWorkerClock(
  config: ReviewRouteConfig | null | undefined,
  deps: ReviewWorkerDeps = createRealReviewWorkerDeps()
): void {
  if (!config || timer || process.env.NODE_ENV === 'test') return;
  void tickReviewWorkerClock(config, deps);
  const interval = Math.max(
    1_000,
    Number(process.env.OVERSEER_REVIEW_WORKER_INTERVAL_MS) || 60_000
  );
  timer = setInterval(() => void tickReviewWorkerClock(config, deps), interval);
  timer.unref?.();
}

export function stopReviewWorkerClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
