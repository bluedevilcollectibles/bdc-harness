/**
 * Tests for the check-completion re-review ingest (bdc-harness #782 part 1,
 * WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Test 5 / Stop 1).
 *
 * The headline stop condition: "a synthetic check_run completed event for a
 * head with a check-caused CHANGES_REQUESTED verdict produces exactly one
 * queued run_review row for that head; a second identical event produces none."
 */
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  buildRecheckReason,
  completionIsRelevantToVerdict,
  conclusionIsPassing,
  extractCheckCompletion,
  ingestCheckCompletionEvent,
  recheckIdempotencyKey,
  summaryNamesACheck,
  verdictAuthorizesRecheck,
  type RecheckIngestDeps,
  type StandingVerdict,
} from '../pr-review-check-ingest';

const SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

interface Recorded {
  enqueued: {
    idempotencyKey: string;
    prNumber: number;
    headSha: string;
    repeatReason: string;
  }[];
  receipts: { disposition: string; reason?: string }[];
}

function makeDeps(
  verdict: StandingVerdict | null,
  recorded: Recorded,
  overrides: Partial<RecheckIngestDeps> = {}
): RecheckIngestDeps {
  // A real UNIQUE idempotency_key: the second enqueue of the same key returns
  // the existing row rather than inserting, exactly as the database does.
  const rows = new Map<string, string>();
  return {
    webhookSecret: SECRET,
    async readStandingVerdict() {
      return verdict;
    },
    async enqueueRecheckWork(input) {
      recorded.enqueued.push({
        idempotencyKey: input.idempotencyKey,
        prNumber: input.prNumber,
        headSha: input.headSha,
        repeatReason: input.repeatReason,
      });
      const existing = rows.get(input.idempotencyKey);
      if (existing) return { messageId: existing, alreadyExisted: true };
      const messageId = `msg-${rows.size + 1}`;
      rows.set(input.idempotencyKey, messageId);
      return { messageId, alreadyExisted: false };
    },
    async recordReceipt(input) {
      recorded.receipts.push({
        disposition: input.disposition,
        ...(input.reason ? { reason: input.reason } : {}),
      });
    },
    ...overrides,
  };
}

const HEAD = '1191a7361191a7361191a7361191a7361191a736';

function checkRunPayload(
  overrides: {
    action?: string;
    status?: string;
    conclusion?: string | null;
    id?: number;
    prNumbers?: number[];
  } = {}
): string {
  return JSON.stringify({
    action: overrides.action ?? 'completed',
    check_run: {
      id: overrides.id ?? 999001,
      name: 'test (windows-latest)',
      status: overrides.status ?? 'completed',
      conclusion: overrides.conclusion === undefined ? 'success' : overrides.conclusion,
      head_sha: HEAD,
      pull_requests: (overrides.prNumbers ?? [746]).map(number => ({
        number,
        head: { sha: HEAD },
      })),
    },
    repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
  });
}

const CHECK_CAUSED_VERDICT: StandingVerdict = {
  headSha: HEAD,
  disposition: 'changes_requested',
  summary: '[major] checks/test (windows-latest) failed',
  recordedAt: '2026-09-07T11:46:00.000Z',
};

describe('ingestCheckCompletionEvent', () => {
  test('a check_run completion on a check-caused CHANGES_REQUESTED head queues exactly one re-review, and a second identical event queues none', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const rawBody = checkRunPayload();

    const first = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'delivery-1' },
      deps
    );
    expect(first.disposition).toBe('queued');
    expect(first.status).toBe(200);
    expect(first.headSha).toBe(HEAD);
    expect(first.prNumbers).toEqual([746]);
    expect(recorded.enqueued).toHaveLength(1);

    // Second delivery of the SAME completion. GitHub retries deliveries, and the
    // sweep can independently notice the same completion; both must collapse
    // onto the one row.
    const second = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'delivery-2' },
      deps
    );
    expect(second.disposition).toBe('duplicate_delivery');
    expect(second.reason).toBe('idempotent_replay');

    // Two enqueue CALLS, but only ONE distinct row: the shared idempotency key
    // is what bounds this to one automatic re-review per (head, check).
    expect(recorded.enqueued).toHaveLength(2);
    expect(recorded.enqueued[0]?.idempotencyKey).toBe(recorded.enqueued[1]?.idempotencyKey);
    expect(new Set(recorded.enqueued.map(row => row.idempotencyKey)).size).toBe(1);
  });

  /**
   * Overseer review finding, PR #786 @18df6323: ANY COMPLETION TRIGGERED A
   * RE-REVIEW.
   *
   * The path gated only on the standing VERDICT, never on what the completion
   * concluded or which check it was. A job that failed again, or an unrelated
   * job going green, therefore re-ran the reviewer against an unchanged head
   * and could churn a valid CHANGES_REQUESTED.
   */
  test('A FAILED completion queues NOTHING -- the rejection still stands', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const rawBody = checkRunPayload({ conclusion: 'failure' });

    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'delivery-fail' },
      deps
    );

    // THE REGRESSION GUARD: this enqueued before the fix.
    expect(recorded.enqueued).toHaveLength(0);
    expect(result.disposition).toBe('ignored_no_authorizing_verdict');
    const skip = recorded.receipts.find(r => r.disposition === 'ignored_check_not_actionable');
    expect(skip?.reason).toContain('rereview_skipped_check_not_success');
    expect(skip?.reason).toContain('failure');
  });

  test('cancelled and timed_out completions queue nothing either', async () => {
    for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'stale']) {
      const recorded: Recorded = { enqueued: [], receipts: [] };
      const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
      const rawBody = checkRunPayload({ conclusion });
      await ingestCheckCompletionEvent(
        {
          rawBody,
          signature: sign(rawBody),
          eventType: 'check_run',
          deliveryId: `delivery-${conclusion}`,
        },
        deps
      );
      expect(recorded.enqueued).toHaveLength(0);
    }
    // A null conclusion is not a pass either.
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const rawBody = checkRunPayload({ conclusion: null });
    await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'delivery-null' },
      deps
    );
    expect(recorded.enqueued).toHaveLength(0);
  });

  test('SUCCESS on an UNRELATED check queues nothing -- the named check is still red', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    // The verdict names `checks/test (windows-latest)`; this is a different job.
    const rawBody = JSON.stringify({
      action: 'completed',
      check_run: {
        id: 999002,
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        head_sha: HEAD,
        pull_requests: [{ number: 746, head: { sha: HEAD } }],
      },
      repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
    });

    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'delivery-lint' },
      deps
    );

    expect(recorded.enqueued).toHaveLength(0);
    expect(result.disposition).toBe('ignored_no_authorizing_verdict');
    const skip = recorded.receipts.find(r => r.disposition === 'ignored_check_not_actionable');
    expect(skip?.reason).toContain('rereview_skipped_check_not_relevant');
    expect(skip?.reason).toContain('lint');
  });

  test('SUCCESS on the NAMED check queues exactly one re-review', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const rawBody = checkRunPayload({ conclusion: 'success' });

    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'delivery-ok' },
      deps
    );

    expect(result.disposition).toBe('queued');
    expect(recorded.enqueued).toHaveLength(1);
  });

  test('neutral and skipped count as passing, because branch protection treats them so', async () => {
    for (const conclusion of ['neutral', 'skipped']) {
      const recorded: Recorded = { enqueued: [], receipts: [] };
      const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
      const rawBody = checkRunPayload({ conclusion });
      const result = await ingestCheckCompletionEvent(
        {
          rawBody,
          signature: sign(rawBody),
          eventType: 'check_run',
          deliveryId: `delivery-${conclusion}`,
        },
        deps
      );
      expect(result.disposition).toBe('queued');
      expect(recorded.enqueued).toHaveLength(1);
    }
  });

  test('a checks_pending deferral is unblocked by ANY passing check, since it names none', async () => {
    // The deferral case carries no summary at all -- the reviewer never formed a
    // finding. Requiring a name match here would make it permanently stuck.
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(
      { headSha: HEAD, disposition: 'checks_pending', summary: '', recordedAt: null },
      recorded
    );
    const rawBody = JSON.stringify({
      action: 'completed',
      check_run: {
        id: 999003,
        name: 'some-unrelated-job',
        status: 'completed',
        conclusion: 'success',
        head_sha: HEAD,
        pull_requests: [{ number: 746, head: { sha: HEAD } }],
      },
      repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
    });

    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'delivery-pend' },
      deps
    );

    expect(result.disposition).toBe('queued');
    expect(recorded.enqueued).toHaveLength(1);
  });

  test('conclusionIsPassing and completionIsRelevantToVerdict, directly', () => {
    expect(conclusionIsPassing('success')).toBe(true);
    expect(conclusionIsPassing('SUCCESS')).toBe(true);
    expect(conclusionIsPassing('neutral')).toBe(true);
    expect(conclusionIsPassing('skipped')).toBe(true);
    expect(conclusionIsPassing('failure')).toBe(false);
    expect(conclusionIsPassing('cancelled')).toBe(false);
    expect(conclusionIsPassing(null)).toBe(false);
    expect(conclusionIsPassing(undefined)).toBe(false);

    // Matrix suffix: the verdict names the bare context, the event carries the
    // matrix job name.
    expect(
      completionIsRelevantToVerdict(
        { headSha: HEAD, disposition: 'changes_requested', summary: '[major] checks/test failed' },
        { checkName: 'test (windows-latest)' }
      )
    ).toBe(true);
    // A one- or two-letter stem must not match everything.
    expect(
      completionIsRelevantToVerdict(
        { headSha: HEAD, disposition: 'changes_requested', summary: '[major] checks/build failed' },
        { checkName: 'ci (x)' }
      )
    ).toBe(false);
    // No summary at all on a changes_requested verdict: fail closed.
    expect(
      completionIsRelevantToVerdict(
        { headSha: HEAD, disposition: 'changes_requested', summary: '' },
        { checkName: 'test' }
      )
    ).toBe(false);
  });

  test('the idempotency key includes the check id, so it never collides with the push-path review row', () => {
    const key = recheckIdempotencyKey({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 746,
      headSha: HEAD,
      checkId: 'check_run:999001',
    });
    expect(key).toContain('999001');
    expect(key).toContain(HEAD);
    // The push path's key is `pr-review:owner/repo#N@head` with no check id.
    expect(key).not.toBe(`pr-review:thinmansoftware/bdc-harness#746@${HEAD}`);
  });

  test('a different check completing at the same head queues a separate re-review', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const first = checkRunPayload({ id: 111 });
    const second = checkRunPayload({ id: 222 });
    await ingestCheckCompletionEvent(
      { rawBody: first, signature: sign(first), eventType: 'check_run', deliveryId: 'd1' },
      deps
    );
    const result = await ingestCheckCompletionEvent(
      { rawBody: second, signature: sign(second), eventType: 'check_run', deliveryId: 'd2' },
      deps
    );
    expect(result.disposition).toBe('queued');
    expect(new Set(recorded.enqueued.map(row => row.idempotencyKey)).size).toBe(2);
  });

  test('a workflow_run completion is accepted on the same terms', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const rawBody = JSON.stringify({
      action: 'completed',
      workflow_run: {
        id: 4242,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        head_sha: HEAD,
        pull_requests: [{ number: 746 }],
      },
      repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
    });
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'workflow_run', deliveryId: 'd-wf' },
      deps
    );
    expect(result.disposition).toBe('queued');
    expect(recorded.enqueued[0]?.idempotencyKey).toContain('workflow_run:4242');
  });

  test('a CHECKS_PENDING deferral is authorization: the completion is what it was waiting for', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(
      { headSha: HEAD, disposition: 'checks_pending', summary: null, recordedAt: null },
      recorded
    );
    const rawBody = checkRunPayload();
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'd-pending' },
      deps
    );
    expect(result.disposition).toBe('queued');
  });

  test('an APPROVED head is never re-reviewed', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(
      {
        headSha: HEAD,
        disposition: 'approved',
        summary: 'No blocking findings.',
        recordedAt: null,
      },
      recorded
    );
    const rawBody = checkRunPayload();
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'd-approved' },
      deps
    );
    expect(result.disposition).toBe('ignored_no_authorizing_verdict');
    expect(recorded.enqueued).toHaveLength(0);
  });

  test('a CODE-caused rejection is never cleared by re-running a job', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(
      {
        headSha: HEAD,
        disposition: 'changes_requested',
        summary:
          '[blocker] src/auth.ts: token is compared with == instead of a constant-time check',
        recordedAt: null,
      },
      recorded
    );
    const rawBody = checkRunPayload();
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'd-code' },
      deps
    );
    // The code did not change, so the finding still stands.
    expect(result.disposition).toBe('ignored_no_authorizing_verdict');
    expect(recorded.enqueued).toHaveLength(0);
  });

  test('no standing verdict at the head means nothing to clear', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(null, recorded);
    const rawBody = checkRunPayload();
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'd-none' },
      deps
    );
    expect(result.disposition).toBe('ignored_no_authorizing_verdict');
    expect(recorded.enqueued).toHaveLength(0);
  });

  test('an in_progress check is ignored -- only completions trigger', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const rawBody = checkRunPayload({ action: 'created', status: 'in_progress' });
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'd-running' },
      deps
    );
    expect(result.disposition).toBe('ignored_not_completed');
    expect(recorded.enqueued).toHaveLength(0);
  });

  test('an event carrying no pull request costs no GitHub read and queues nothing', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const rawBody = checkRunPayload({ prNumbers: [] });
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'd-nopr' },
      deps
    );
    expect(result.disposition).toBe('ignored_no_open_pull_request');
    expect(recorded.enqueued).toHaveLength(0);
  });

  test('a bad signature is rejected and the body is never parsed', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const result = await ingestCheckCompletionEvent(
      {
        rawBody: checkRunPayload(),
        signature: 'sha256=deadbeef',
        eventType: 'check_run',
        deliveryId: 'd-bad',
      },
      deps
    );
    expect(result.disposition).toBe('rejected_signature');
    expect(result.status).toBe(401);
    expect(recorded.enqueued).toHaveLength(0);
  });

  test('an unconfigured secret fails closed with 500', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded, { webhookSecret: '' });
    const rawBody = checkRunPayload();
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'd-nosecret' },
      deps
    );
    expect(result.disposition).toBe('blocked');
    expect(result.status).toBe(500);
    expect(result.reason).toBe('webhook_secret_not_configured');
  });

  test('a pull_request event is ignored by this ingest', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded);
    const rawBody = checkRunPayload();
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'pull_request', deliveryId: 'd-pr' },
      deps
    );
    expect(result.disposition).toBe('ignored_event');
  });

  test('an enqueue failure is a blocked receipt, not a silent drop', async () => {
    const recorded: Recorded = { enqueued: [], receipts: [] };
    const deps = makeDeps(CHECK_CAUSED_VERDICT, recorded, {
      async enqueueRecheckWork() {
        throw new Error('dispatch_unavailable');
      },
    });
    const rawBody = checkRunPayload();
    const result = await ingestCheckCompletionEvent(
      { rawBody, signature: sign(rawBody), eventType: 'check_run', deliveryId: 'd-fail' },
      deps
    );
    expect(result.disposition).toBe('blocked');
    expect(result.status).toBe(500);
    expect(result.reason).toContain('enqueue_failed');
  });

  test('the repeat reason names the check, so the queued row explains itself', () => {
    const reason = buildRecheckReason({
      checkName: 'test (windows-latest)',
      checkId: 'check_run:999001',
      headSha: HEAD,
      conclusion: 'success',
    });
    expect(reason).toContain('test (windows-latest)');
    expect(reason).toContain(HEAD);
    expect(reason).toContain('success');
  });
});

describe('extractCheckCompletion', () => {
  test('returns null for an incomplete unit', () => {
    expect(
      extractCheckCompletion('check_run', {
        check_run: { id: 1, status: 'in_progress', head_sha: HEAD },
      })
    ).toBeNull();
  });

  test('returns null when the head sha is absent', () => {
    expect(
      extractCheckCompletion('check_run', { check_run: { id: 1, status: 'completed' } })
    ).toBeNull();
  });

  test('deduplicates repeated pull request numbers', () => {
    const completion = extractCheckCompletion('check_run', {
      check_run: {
        id: 7,
        status: 'completed',
        head_sha: HEAD,
        pull_requests: [{ number: 5 }, { number: 5 }, { number: 6 }],
      },
    });
    expect(completion?.prNumbers).toEqual([5, 6]);
  });
});

describe('verdictAuthorizesRecheck', () => {
  test('null verdict does not authorize', () => {
    expect(verdictAuthorizesRecheck(null)).toBe(false);
  });

  test('unrecognized dispositions fail closed', () => {
    for (const disposition of ['custody_conflict', 'submission_failed', 'stale_head', 'weird']) {
      expect(
        verdictAuthorizesRecheck({ headSha: HEAD, disposition, summary: 'checks/test failed' })
      ).toBe(false);
    }
  });
});

describe('summaryNamesACheck', () => {
  test('recognizes the reviewer finding format seen live on 2026-09-07', () => {
    expect(summaryNamesACheck('[major] checks/test (windows-latest) failed')).toBe(true);
  });

  test('recognizes prose forms', () => {
    expect(summaryNamesACheck('the required check did not pass')).toBe(true);
    expect(summaryNamesACheck('CI check failed on this head')).toBe(true);
  });

  test('does not recognize a code finding', () => {
    expect(summaryNamesACheck('[blocker] src/db.ts: SQL injection via string concatenation')).toBe(
      false
    );
  });

  test('empty and absent summaries fail closed', () => {
    expect(summaryNamesACheck('')).toBe(false);
    expect(summaryNamesACheck(null)).toBe(false);
    expect(summaryNamesACheck(undefined)).toBe(false);
  });
});
