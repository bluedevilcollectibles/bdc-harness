import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import type { ReviewRouteConfig } from '@archon/overseer/pr-review-wiring';
import type { SubmitDeps, SubmitOutcome } from '@archon/overseer/pr-review-submit';
import {
  startReviewWorkerClock,
  stopReviewWorkerClock,
  tickReviewWorkerClock,
  type ReviewWorkerDeps,
} from './review-worker-clock';

const CONFIG: ReviewRouteConfig = {
  webhookSecret: 'secret',
  reviewerIdentity: 'thinman-overseer[bot]',
};

function message(id: string, headSha = `head-${id}`): DispatchMessage {
  return {
    id,
    correlation_id: `correlation-${id}`,
    idempotency_key: `review-${id}`,
    task_type: 'run_review',
    sender: 'overseer-review-route',
    recipient: 'overseer-reviewer',
    body: JSON.stringify({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 730,
      headSha,
      baseRef: 'dev',
      author: 'contributor',
    }),
    status: 'queued',
    result_body: null,
    created_at: new Date(0).toISOString(),
    claimed_at: null,
    completed_at: null,
    not_before: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
    recipient_alias: null,
    motion_id: null,
    motion_revision_sha: null,
    resolved_recipient: null,
    resolved_xo_lease_id: null,
    resolved_xo_fencing_token: null,
    resolved_at: null,
    priority: 'normal',
    task_outcome: null,
    acknowledged_at: null,
    acknowledged_by: null,
    addressed_at: null,
    addressed_by: null,
    escalated_tg_at: null,
    escalated_sms_at: null,
    subject_key: 'gh:thinmansoftware/bdc-harness#730',
    route_disposition: null,
    supersedes_id: null,
    repeat_reason: null,
  };
}

function fakeDeps(
  queued: DispatchMessage[],
  outcomeFor: (id: string) => SubmitOutcome = () => ({ disposition: 'approved' })
): ReviewWorkerDeps {
  const terminal = new Set<string>();
  return {
    registerWorker: mock(async data => ({
      ...data,
      status: 'available' as const,
      registered_at: new Date(0).toISOString(),
      last_heartbeat_at: new Date(0).toISOString(),
    })),
    heartbeatWorker: mock(async data => ({
      worker_id: data.worker_id,
      host: 'test',
      capabilities: {},
      max_concurrency: 1,
      status: data.status ?? 'available',
      registered_at: new Date(0).toISOString(),
      last_heartbeat_at: new Date(0).toISOString(),
    })),
    listMessages: mock(async () => queued),
    claimMessage: mock(async ({ id, worker_id }) => {
      if (terminal.has(id)) return null;
      const found = queued.find(item => item.id === id);
      return found
        ? { ...found, status: 'claimed' as const, lease_owner: worker_id, fencing_token: 1 }
        : null;
    }),
    postResult: mock(async input => {
      terminal.add(input.id);
      const found = queued.find(item => item.id === input.id);
      return found
        ? {
            ...found,
            status: input.status ?? 'done',
            result_body: input.result_body,
            task_outcome: input.task_outcome ?? null,
          }
        : null;
    }),
    releaseMessage: mock(async () => null),
    // WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Section 7: the worker now
    // calls the deferral by its WO name. It delegates to releaseMessage, so the
    // fencing guards asserted below are unchanged.
    deferMessage: mock(async () => null),
    runAndSubmitReview: mock(async work => outcomeFor(work.messageId)),
    createSubmitDeps: mock(() => ({ reviewerIdentity: CONFIG.reviewerIdentity }) as SubmitDeps),
  };
}

afterEach(() => stopReviewWorkerClock());

describe('review worker clock', () => {
  test('submits the queued exact head once and marks the item done', async () => {
    const queued = [message('one', 'exact-head')];
    const deps = fakeDeps(queued);

    await tickReviewWorkerClock(CONFIG, deps);
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.runAndSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: 'exact-head', messageId: 'one' }),
      expect.anything()
    );
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'one',
        fencing_token: 1,
        status: 'done',
        task_outcome: 'succeeded',
      })
    );
  });

  test('records a stale-head outcome as terminal without retrying submission', async () => {
    const deps = fakeDeps([message('stale', 'old-head')], () => ({
      disposition: 'stale_head',
      reason: 'head_advanced_during_review',
    }));

    await tickReviewWorkerClock(CONFIG, deps);
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'done', task_outcome: 'succeeded' })
    );
  });

  test.each([
    ['changes_requested', 'done', 'succeeded'],
    ['custody_conflict', 'failed', 'blocked'],
    ['merge_custody_conflict', 'failed', 'blocked'],
    ['reviewer_failed', 'failed', 'failed'],
    ['submission_failed', 'failed', 'failed'],
  ] as const)(
    'maps %s submissions to %s with a %s task outcome',
    async (disposition, status, taskOutcome) => {
      const deps = fakeDeps([message(disposition)], () => ({ disposition }));

      await tickReviewWorkerClock(CONFIG, deps);

      expect(deps.postResult).toHaveBeenCalledWith(
        expect.objectContaining({
          id: disposition,
          status,
          task_outcome: taskOutcome,
        })
      );
    }
  );

  // WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01: a checks-pending item is
  // released (not posted as a result) with a future not_before, and is retried
  // until it reaches a terminal disposition.
  test('defers (never posts) a checks-pending item with a future not_before', async () => {
    const deps = fakeDeps([message('pending', 'exact-head')], () => ({
      disposition: 'checks_pending',
      reason: 'checks_not_terminal',
    }));

    const before = Date.now();
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.deferMessage).toHaveBeenCalledTimes(1);
    const deferArg = (deps.deferMessage as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      id: string;
      fencing_token: number;
      defer_until: string;
    };
    expect(deferArg.id).toBe('pending');
    expect(deferArg.fencing_token).toBe(1);
    expect(new Date(deferArg.defer_until).getTime()).toBeGreaterThan(before);
    // A defer is not a terminal result.
    expect(deps.postResult).not.toHaveBeenCalled();
  });

  // bdc-harness #782 part 2: a rate limit is a deferral with GitHub's own reset
  // clock, never a terminal verdict.
  test('defers a rate-limited item until the reported retry instant', async () => {
    const retryAfter = new Date(Date.now() + 900_000).toISOString();
    const deps = fakeDeps([message('limited', 'exact-head')], () => ({
      disposition: 'rate_limited',
      reason: 'github_rate_limited',
      retryAfter,
      retryAfterMs: 900_000,
    }));

    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.deferMessage).toHaveBeenCalledTimes(1);
    const deferArg = (deps.deferMessage as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      id: string;
      defer_until: string;
    };
    expect(deferArg.id).toBe('limited');
    // The reset instant is used verbatim: retrying earlier would just burn
    // another request against a budget that is still exhausted (#774).
    expect(deferArg.defer_until).toBe(retryAfter);
    expect(deps.postResult).not.toHaveBeenCalled();
  });

  test('a rate-limited item with no reported clock still gets a finite backoff', async () => {
    const deps = fakeDeps([message('noclock', 'exact-head')], () => ({
      disposition: 'rate_limited',
      reason: 'github_rate_limited',
    }));

    const before = Date.now();
    await tickReviewWorkerClock(CONFIG, deps);

    const deferArg = (deps.deferMessage as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      defer_until: string;
    };
    expect(new Date(deferArg.defer_until).getTime()).toBeGreaterThan(before);
    expect(deps.postResult).not.toHaveBeenCalled();
  });

  // bdc-harness #782 part 3: the sweep runs on the heartbeat and never takes
  // the primary review path down with it.
  test('runs the stale-verdict sweep once per tick after the queue is drained', async () => {
    const deps = fakeDeps([message('one', 'exact-head')]);
    const sweep = mock(async () => ({ examined: 1, enqueued: 1, duplicates: 0 }));
    deps.staleVerdictSweep = sweep;

    await tickReviewWorkerClock(CONFIG, deps);

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith(CONFIG);
    // The queued item was still handled.
    expect(deps.postResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }));
  });

  test('a sweep failure never fails the tick or the primary review path', async () => {
    const deps = fakeDeps([message('one', 'exact-head')]);
    deps.staleVerdictSweep = mock(async () => {
      throw new Error('github_unavailable');
    });

    await expect(tickReviewWorkerClock(CONFIG, deps)).resolves.toBeUndefined();
    expect(deps.postResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }));
  });

  test('retries a released item on a later tick until it reaches a terminal disposition', async () => {
    let disposition: SubmitOutcome['disposition'] = 'checks_pending';
    const deps = fakeDeps(
      [message('retry', 'exact-head')],
      () => ({ disposition }) as SubmitOutcome
    );

    // Tick 1: checks still pending -> defer, no result.
    await tickReviewWorkerClock(CONFIG, deps);
    expect(deps.deferMessage).toHaveBeenCalledTimes(1);
    expect(deps.postResult).not.toHaveBeenCalled();

    // Checks conclude; tick 2 picks up the same message and completes it.
    disposition = 'approved';
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(2);
    expect(deps.deferMessage).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'retry', status: 'done', task_outcome: 'succeeded' })
    );
  });

  test('isolates a failed item and continues through the batch', async () => {
    const deps = fakeDeps([message('bad'), message('good')]);
    const originalClaim = deps.claimMessage;
    deps.claimMessage = mock(async input => {
      if (input.id === 'bad') throw new Error('claim failed');
      return originalClaim(input);
    }) as typeof deps.claimMessage;

    await expect(tickReviewWorkerClock(CONFIG, deps)).resolves.toBeUndefined();

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'good' }));
  });

  test('isolates an invalid review body without posting a result and continues the batch', async () => {
    const invalid = { ...message('invalid'), body: JSON.stringify({ owner: 'thinmansoftware' }) };
    const deps = fakeDeps([invalid, message('valid')]);

    await expect(tickReviewWorkerClock(CONFIG, deps)).resolves.toBeUndefined();

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.runAndSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'valid' }),
      expect.anything()
    );
    expect(deps.postResult).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'valid' }));
    expect(deps.postResult).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'invalid' }));
  });

  test('does not start when review route configuration is absent', async () => {
    const deps = fakeDeps([message('never')]);
    const originalNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = 'production';
    try {
      startReviewWorkerClock(null, deps);
      startReviewWorkerClock(undefined, deps);
      await Bun.sleep(5);

      expect(deps.registerWorker).not.toHaveBeenCalled();

      startReviewWorkerClock(CONFIG, deps);
      await Bun.sleep(5);
      expect(deps.registerWorker).toHaveBeenCalledTimes(1);
    } finally {
      stopReviewWorkerClock();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
