import { describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import {
  AUTO_REREVIEW_REASON_PREFIX,
  MAX_REREVIEW_ATTEMPTS,
  buildRereviewReason,
  findAuthorizingPriorReview,
  ingestPullRequestEvent,
  isAutoRereviewReason,
  type IngestDeps,
  type PriorReviewWork,
} from '../pr-review-ingest.ts';

const SECRET = 'rereview-secret';
const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

function request(owner = 'thinmansoftware', repo = 'bdc-harness', prNumber = 650) {
  const rawBody = JSON.stringify({
    action: 'synchronize',
    number: prNumber,
    pull_request: {
      number: prNumber,
      draft: false,
      head: { sha: NEW_HEAD },
      base: { ref: 'dev' },
      user: { login: 'builder' },
    },
    repository: { name: repo, owner: { login: owner } },
  });
  return {
    rawBody,
    signature: `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
    eventType: 'pull_request',
    deliveryId: 'replay-shopops-650',
  };
}

function work(overrides: Partial<PriorReviewWork> = {}): PriorReviewWork {
  return {
    messageId: 'review-1',
    headSha: OLD_HEAD,
    status: 'done',
    verdict: 'changes_requested',
    verdictId: 'verdict-1',
    isAutoRereview: false,
    ...overrides,
  };
}

function deps(prior: PriorReviewWork[]) {
  const enqueued: Parameters<IngestDeps['enqueueReviewWork']>[0][] = [];
  const value: IngestDeps = {
    webhookSecret: SECRET,
    reviewerIdentity: 'reviewer[bot]',
    listPriorReviewWork: async () => prior,
    cancelReviewWork: async () => [],
    enqueueReviewWork: async input => {
      enqueued.push(input);
      if (prior.length > 0 && input.repeatReason === null)
        throw new Error('repeat_reason_required');
      return { messageId: 'new-review', alreadyExisted: false };
    },
    recordReceipt: async () => {},
  };
  return { value, enqueued };
}

describe('bounded repeat reason policy', () => {
  test('CHANGES_REQUESTED at an older head generates a traceable reason and enqueues', async () => {
    const fake = deps([work()]);
    expect((await ingestPullRequestEvent(request(), fake.value)).disposition).toBe('queued');
    const reason = fake.enqueued[0]?.repeatReason ?? '';
    expect(reason).toBe(buildRereviewReason('verdict-1', OLD_HEAD, NEW_HEAD));
    expect(reason).toContain('verdict-1');
    expect(reason).toContain(OLD_HEAD);
    expect(reason).toContain(NEW_HEAD);
  });

  test('an unreasoned enqueue attempt with prior work remains protected by the guard', async () => {
    const fake = deps([work({ headSha: NEW_HEAD })]);
    expect((await ingestPullRequestEvent(request(), fake.value)).reason).toBe(
      'enqueue_failed:repeat_reason_required'
    );
    expect(fake.enqueued[0]?.repeatReason).toBeNull();
  });

  test('APPROVED and missing verdicts get no reason and remain blocked', async () => {
    for (const verdict of ['approved', null] as const) {
      const fake = deps([work({ verdict })]);
      expect((await ingestPullRequestEvent(request(), fake.value)).reason).toBe(
        'enqueue_failed:repeat_reason_required'
      );
      expect(fake.enqueued[0]?.repeatReason).toBeNull();
    }
  });

  test('a never-reviewed PR follows the first-review path unchanged', async () => {
    const fake = deps([]);
    expect((await ingestPullRequestEvent(request(), fake.value)).disposition).toBe('queued');
    expect(fake.enqueued[0]?.repeatReason).toBeNull();
  });

  test('cap excludes the initial review and blocks exactly at the limit', async () => {
    const attempts = Array.from({ length: MAX_REREVIEW_ATTEMPTS }, (_, index) =>
      work({
        messageId: `attempt-${index}`,
        headSha: String(index + 1).repeat(40),
        isAutoRereview: true,
      })
    );
    const blocked = deps([work(), ...attempts]);
    expect((await ingestPullRequestEvent(request(), blocked.value)).reason).toBe(
      'rereview_attempts_exhausted'
    );
    expect(blocked.enqueued).toHaveLength(0);
    const allowed = deps([work(), ...attempts.slice(0, -1)]);
    expect((await ingestPullRequestEvent(request(), allowed.value)).disposition).toBe('queued');
  });

  test('recorded shopops#650 synchronize replay now enqueues', async () => {
    const fake = deps([work()]);
    expect(
      (await ingestPullRequestEvent(request('thinmansoftware', 'shopops', 650), fake.value))
        .disposition
    ).toBe('queued');
  });
});

/**
 * Review finding (Overseer, PR #772): the attempt cap must count only the
 * automatic re-review path's OWN marker. `repeat_reason` is shared free text,
 * and before this change every enqueue -- initial reviews included -- was
 * stamped `review_exact_head:<sha>`, so a `!== null` derivation exhausted the
 * budget on rows that were never automatic re-reviews.
 */
describe('auto re-review marker recognition', () => {
  test('the reason the auto path writes is the one the cap recognizes', () => {
    const reason = buildRereviewReason('verdict-1', OLD_HEAD, NEW_HEAD);
    expect(reason.startsWith(AUTO_REREVIEW_REASON_PREFIX)).toBe(true);
    expect(isAutoRereviewReason(reason)).toBe(true);
    // The traceability the reason already carried is preserved.
    expect(reason).toContain('verdict-1');
    expect(reason).toContain(OLD_HEAD);
    expect(reason).toContain(NEW_HEAD);
  });

  test('legacy, foreign and absent reasons are not auto re-reviews', () => {
    expect(isAutoRereviewReason(`review_exact_head:${OLD_HEAD}`)).toBe(false);
    expect(isAutoRereviewReason('tm:nudge:follow-up')).toBe(false);
    expect(isAutoRereviewReason('system XO escalation handoff')).toBe(false);
    expect(isAutoRereviewReason('Fresh exact-head review after source repair.')).toBe(false);
    expect(isAutoRereviewReason(null)).toBe(false);
    expect(isAutoRereviewReason(undefined)).toBe(false);
    // The marker must lead; a reason merely mentioning it does not count.
    expect(isAutoRereviewReason(`see ${AUTO_REREVIEW_REASON_PREFIX}${NEW_HEAD}`)).toBe(false);
  });

  test('a PR carrying only legacy review_exact_head rows is NOT capped', async () => {
    // The exact defect: more legacy rows than MAX_REREVIEW_ATTEMPTS, zero
    // actual automatic re-reviews. Pre-fix this blocked on the first push.
    const legacy = Array.from({ length: MAX_REREVIEW_ATTEMPTS + 1 }, (_, index) =>
      work({
        messageId: `legacy-${index}`,
        headSha: String(index + 1).repeat(40),
        isAutoRereview: isAutoRereviewReason(`review_exact_head:${String(index + 1).repeat(40)}`),
      })
    );
    const fake = deps([work(), ...legacy]);
    expect((await ingestPullRequestEvent(request(), fake.value)).disposition).toBe('queued');
    expect(isAutoRereviewReason(fake.enqueued[0]?.repeatReason ?? null)).toBe(true);
  });

  test('rows marked by the auto path still count toward the cap', async () => {
    const attempts = Array.from({ length: MAX_REREVIEW_ATTEMPTS }, (_, index) =>
      work({
        messageId: `auto-${index}`,
        headSha: String(index + 1).repeat(40),
        isAutoRereview: isAutoRereviewReason(
          buildRereviewReason(`verdict-${index}`, OLD_HEAD, String(index + 1).repeat(40))
        ),
      })
    );
    expect(attempts.every(attempt => attempt.isAutoRereview)).toBe(true);
    const fake = deps([work(), ...attempts]);
    expect((await ingestPullRequestEvent(request(), fake.value)).reason).toBe(
      'rereview_attempts_exhausted'
    );
    expect(fake.enqueued).toHaveLength(0);
  });

  test('legacy rows do not dilute a genuine cap', async () => {
    // Mixed history: enough auto attempts to cap, plus legacy noise that must
    // neither add to nor subtract from the count.
    const autos = Array.from({ length: MAX_REREVIEW_ATTEMPTS }, (_, index) =>
      work({
        messageId: `auto-${index}`,
        headSha: String(index + 1).repeat(40),
        isAutoRereview: isAutoRereviewReason(
          buildRereviewReason(`verdict-${index}`, OLD_HEAD, String(index + 1).repeat(40))
        ),
      })
    );
    const noise = work({
      messageId: 'legacy-noise',
      headSha: '9'.repeat(40),
      isAutoRereview: isAutoRereviewReason('tm:nudge:follow-up'),
    });
    const fake = deps([work(), noise, ...autos]);
    expect((await ingestPullRequestEvent(request(), fake.value)).reason).toBe(
      'rereview_attempts_exhausted'
    );
  });
});

/**
 * Review finding (Overseer, PR #772): re-review authorization examined only
 * the FIRST prior row on a different head. Prior work arrives newest-first and
 * a row exists from the moment it is queued -- before any verdict. So a fast
 * push sequence hid the verdict behind a newer, verdict-less row and the
 * automatic re-review died with repeat_reason_required.
 */
describe('verdict-bearing prior selection', () => {
  const MID_HEAD = 'c'.repeat(40);

  // Newest-first, matching the listPriorReviewWork contract: head B was queued
  // after head A was reviewed, then cancelled when head C arrived.
  function headMovedTwice(): PriorReviewWork[] {
    return [
      work({
        messageId: 'review-b',
        headSha: MID_HEAD,
        status: 'cancelled',
        verdict: null,
        verdictId: null,
      }),
      work({ messageId: 'review-a', headSha: OLD_HEAD, verdict: 'changes_requested' }),
    ];
  }

  test('a verdict-less newer row does not hide the standing verdict', () => {
    const selected = findAuthorizingPriorReview(headMovedTwice(), NEW_HEAD);
    expect(selected?.messageId).toBe('review-a');
    expect(selected?.verdict).toBe('changes_requested');
  });

  test('head A CHANGES_REQUESTED -> head B queued -> head C enqueues with A reason', async () => {
    const fake = deps(headMovedTwice());
    const result = await ingestPullRequestEvent(request(), fake.value);

    // Pre-fix this was 'enqueue_failed:repeat_reason_required': row B was
    // selected, carried no verdict, and no reason was built.
    expect(result.disposition).toBe('queued');
    const reason = fake.enqueued[0]?.repeatReason ?? '';
    expect(reason).toBe(buildRereviewReason('verdict-1', OLD_HEAD, NEW_HEAD));
    // The reason traces to the head that was actually reviewed, not the
    // intermediate head that never produced a verdict.
    expect(reason).toContain(OLD_HEAD);
    expect(reason).not.toContain(MID_HEAD);
    expect(isAutoRereviewReason(reason)).toBe(true);
  });

  test('a queued (not yet cancelled) intermediate row is skipped the same way', async () => {
    const fake = deps([
      work({
        messageId: 'review-b',
        headSha: MID_HEAD,
        status: 'queued',
        verdict: null,
        verdictId: null,
      }),
      work({ messageId: 'review-a', headSha: OLD_HEAD }),
    ]);
    expect((await ingestPullRequestEvent(request(), fake.value)).disposition).toBe('queued');
    expect(fake.enqueued[0]?.repeatReason).toContain(OLD_HEAD);
  });

  test('a newer APPROVED verdict still withholds authorization', async () => {
    // Selection skips verdict-less rows only. A real newer verdict remains
    // authoritative, so an older changes_requested cannot reach past it.
    const fake = deps([
      work({ messageId: 'review-b', headSha: MID_HEAD, verdict: 'approved' }),
      work({ messageId: 'review-a', headSha: OLD_HEAD, verdict: 'changes_requested' }),
    ]);
    expect((await ingestPullRequestEvent(request(), fake.value)).reason).toBe(
      'enqueue_failed:repeat_reason_required'
    );
    expect(fake.enqueued[0]?.repeatReason).toBeNull();
  });

  test('a verdict on the CURRENT head never authorizes a repeat', () => {
    const selected = findAuthorizingPriorReview(
      [work({ messageId: 'same-head', headSha: NEW_HEAD, verdict: 'changes_requested' })],
      NEW_HEAD
    );
    expect(selected).toBeUndefined();
  });

  test('no verdict-bearing row at any other head selects nothing', () => {
    expect(
      findAuthorizingPriorReview(
        [work({ messageId: 'review-b', headSha: MID_HEAD, verdict: null, verdictId: null })],
        NEW_HEAD
      )
    ).toBeUndefined();
  });

  test('the cap still counts auto attempts hidden behind verdict-less rows', async () => {
    const attempts = Array.from({ length: MAX_REREVIEW_ATTEMPTS }, (_, index) =>
      work({
        messageId: `auto-${index}`,
        headSha: String(index + 1).repeat(40),
        isAutoRereview: true,
      })
    );
    const fake = deps([
      work({
        messageId: 'review-b',
        headSha: MID_HEAD,
        status: 'cancelled',
        verdict: null,
        verdictId: null,
      }),
      work(),
      ...attempts,
    ]);
    expect((await ingestPullRequestEvent(request(), fake.value)).reason).toBe(
      'rereview_attempts_exhausted'
    );
    expect(fake.enqueued).toHaveLength(0);
  });
});
