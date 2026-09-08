/**
 * #797 -- the automatic re-review cap must be visible, resettable, configurable.
 *
 * As built the cap was a hardcoded 3 counted over a PR's ENTIRE history, and
 * when it fired the push was blocked with HTTP 200, an operator receipt and a
 * log line -- nothing on the PR. So from the author's side the reviewer simply
 * stopped answering on round four, which is what happened to #787 and #790 on
 * 2026-09-08 while both were in a legitimate converging fix loop.
 *
 * Three defects, three groups below:
 *   INVISIBLE   -> one PR comment per head, idempotent.
 *   NEVER RESET -> count CONSECUTIVE auto re-reviews since a non-auto review ran.
 *   FIXED AT 3  -> OVERSEER_MAX_REREVIEW_ATTEMPTS.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import {
  MAX_REREVIEW_ATTEMPTS,
  MAX_REREVIEW_ATTEMPTS_ENV,
  buildRereviewCapComment,
  countConsecutiveAutoRereviews,
  ingestPullRequestEvent,
  rereviewCapCommentMarker,
  resolveMaxRereviewAttempts,
  type IngestDeps,
  type PriorReviewWork,
} from '../pr-review-ingest.ts';

const SECRET = 'rereview-cap-secret';
const NEW_HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

const originalEnvValue = process.env[MAX_REREVIEW_ATTEMPTS_ENV];
afterEach(() => {
  if (originalEnvValue === undefined) delete process.env[MAX_REREVIEW_ATTEMPTS_ENV];
  else process.env[MAX_REREVIEW_ATTEMPTS_ENV] = originalEnvValue;
});

function request(): Parameters<typeof ingestPullRequestEvent>[0] {
  const rawBody = JSON.stringify({
    action: 'synchronize',
    number: 790,
    pull_request: {
      number: 790,
      draft: false,
      state: 'open',
      head: { sha: NEW_HEAD, ref: 'wo/fix' },
      base: { ref: 'dev' },
      user: { login: 'builder' },
    },
    repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
  });
  return {
    rawBody,
    signature: `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
    eventType: 'pull_request',
    deliveryId: 'delivery-cap-1',
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

/** N auto re-review rows, newest first, each carrying its own verdict. */
function autoAttempts(count: number): PriorReviewWork[] {
  return Array.from({ length: count }, (_, index) =>
    work({
      messageId: `auto-${index}`,
      headSha: String(index + 1).repeat(40),
      isAutoRereview: true,
    })
  );
}

interface Captured {
  comments: { prNumber: number; headSha: string; body: string; marker: string }[];
  receipts: Parameters<IngestDeps['recordReceipt']>[0][];
  enqueued: Parameters<IngestDeps['enqueueReviewWork']>[0][];
}

function deps(
  prior: PriorReviewWork[],
  options: { existingMarkers?: Set<string>; commentSeam?: boolean } = {}
): { value: IngestDeps; captured: Captured } {
  const captured: Captured = { comments: [], receipts: [], enqueued: [] };
  const existingMarkers = options.existingMarkers ?? new Set<string>();
  const value: IngestDeps = {
    webhookSecret: SECRET,
    reviewerIdentity: 'reviewer[bot]',
    listPriorReviewWork: async () => prior,
    cancelReviewWork: async () => [],
    enqueueReviewWork: async input => {
      captured.enqueued.push(input);
      return { messageId: 'new-review', alreadyExisted: false };
    },
    recordReceipt: async input => {
      captured.receipts.push(input);
    },
  };
  if (options.commentSeam !== false) {
    // Stands in for the real adapter: it searches for the marker before
    // creating, which is what makes the notice idempotent per head.
    value.postCapExhaustedComment = async input => {
      if (existingMarkers.has(input.marker)) return { posted: false };
      existingMarkers.add(input.marker);
      captured.comments.push({
        prNumber: input.prNumber,
        headSha: input.headSha,
        body: input.body,
        marker: input.marker,
      });
      return { posted: true };
    };
  }
  return { value, captured };
}

describe('#797 -- the cap is configurable', () => {
  test('defaults to 3 with no env set', () => {
    expect(resolveMaxRereviewAttempts({})).toBe(MAX_REREVIEW_ATTEMPTS);
    expect(MAX_REREVIEW_ATTEMPTS).toBe(3);
  });

  test('an env override of 5 raises the budget', () => {
    expect(resolveMaxRereviewAttempts({ [MAX_REREVIEW_ATTEMPTS_ENV]: '5' })).toBe(5);
  });

  test('a nonsense, zero or negative value falls back to the default, never to 0', () => {
    // Failing OPEN here (cap 0 = never auto re-review) would be a silent
    // outage; failing to the default keeps the guard and the behaviour.
    for (const raw of ['', 'three', '0', '-1', 'NaN']) {
      expect(resolveMaxRereviewAttempts({ [MAX_REREVIEW_ATTEMPTS_ENV]: raw })).toBe(
        MAX_REREVIEW_ATTEMPTS
      );
    }
  });

  test('a fractional value is floored, so 3.9 cannot buy a fourth attempt', () => {
    expect(resolveMaxRereviewAttempts({ [MAX_REREVIEW_ATTEMPTS_ENV]: '3.9' })).toBe(3);
  });

  test('an override of 5 allows the fifth auto re-review', async () => {
    process.env[MAX_REREVIEW_ATTEMPTS_ENV] = '5';
    // Four consecutive auto attempts: blocked under the default, allowed at 5.
    const fake = deps([...autoAttempts(4), work()]);
    const result = await ingestPullRequestEvent(request(), fake.value);

    expect(result.disposition).toBe('queued');
    expect(fake.captured.comments).toHaveLength(0);
  });

  test('the same history IS blocked once the override is removed', async () => {
    delete process.env[MAX_REREVIEW_ATTEMPTS_ENV];
    const fake = deps([...autoAttempts(4), work()]);
    expect((await ingestPullRequestEvent(request(), fake.value)).reason).toBe(
      'rereview_attempts_exhausted'
    );
  });
});

describe('#797 -- the count is CONSECUTIVE, so a hand nudge resets it', () => {
  test('counts auto rows from the newest until a non-auto review that ran', () => {
    const prior = [
      ...autoAttempts(2),
      // The operator's hand-requested review: non-auto, and it produced a verdict.
      work({ messageId: 'hand-nudge', headSha: 'd'.repeat(40) }),
      ...autoAttempts(3),
      work({ messageId: 'initial' }),
    ];
    // Only the two above the nudge count; the three below it are spent history.
    expect(countConsecutiveAutoRereviews(prior)).toBe(2);
  });

  test('a hand-requested review that RAN re-arms the automatic budget', async () => {
    const prior = [
      work({ messageId: 'hand-nudge', headSha: 'd'.repeat(40) }),
      ...autoAttempts(MAX_REREVIEW_ATTEMPTS),
      work({ messageId: 'initial' }),
    ];
    const fake = deps(prior);
    const result = await ingestPullRequestEvent(request(), fake.value);

    // The whole point: a PR that converges on round five gets its APPROVED
    // without an operator having to nudge every remaining round by hand.
    expect(result.disposition).toBe('queued');
    expect(fake.captured.enqueued).toHaveLength(1);
  });

  test('a QUEUED hand nudge that never ran does NOT reset the budget', async () => {
    // Otherwise anyone could refill the budget forever by queueing nudges that
    // never execute -- the exact runaway the cap exists to stop.
    const prior = [
      work({
        messageId: 'hand-nudge-pending',
        headSha: 'd'.repeat(40),
        status: 'queued',
        verdict: null,
        verdictId: null,
      }),
      ...autoAttempts(MAX_REREVIEW_ATTEMPTS),
      work({ messageId: 'initial' }),
    ];
    expect((await ingestPullRequestEvent(request(), deps(prior).value)).reason).toBe(
      'rereview_attempts_exhausted'
    );
  });

  test('a cancelled row is skipped entirely -- it neither spends nor restores', () => {
    const prior = [
      work({ messageId: 'cancelled', status: 'cancelled', verdict: null, verdictId: null }),
      ...autoAttempts(3),
      work({ messageId: 'initial' }),
    ];
    expect(countConsecutiveAutoRereviews(prior)).toBe(3);
  });

  test('a PR with no auto history counts zero', () => {
    expect(countConsecutiveAutoRereviews([])).toBe(0);
    expect(countConsecutiveAutoRereviews([work()])).toBe(0);
  });
});

describe('#797 -- the block is VISIBLE on the pull request', () => {
  test('exhausting the budget posts one comment naming the budget and the remedy', async () => {
    const fake = deps([...autoAttempts(MAX_REREVIEW_ATTEMPTS), work()]);
    const result = await ingestPullRequestEvent(request(), fake.value);

    expect(result.reason).toBe('rereview_attempts_exhausted');
    expect(fake.captured.comments).toHaveLength(1);
    const comment = fake.captured.comments[0]!;
    expect(comment.prNumber).toBe(790);
    expect(comment.body).toContain('Automatic re-review budget (3) exhausted');
    expect(comment.body).toContain(NEW_HEAD);
    // It must say how to get unstuck, not merely that it stopped.
    expect(comment.body).toContain('Dispatch nudge');
  });

  test('a second delivery at the SAME head does not post a second comment', async () => {
    const markers = new Set<string>();
    const prior = [...autoAttempts(MAX_REREVIEW_ATTEMPTS), work()];
    const first = deps(prior, { existingMarkers: markers });
    await ingestPullRequestEvent(request(), first.value);
    const second = deps(prior, { existingMarkers: markers });
    await ingestPullRequestEvent(request(), second.value);

    expect(first.captured.comments).toHaveLength(1);
    // GitHub redelivers and a push storm drives several ingests; the marker is
    // what keeps the thread from filling with identical notices.
    expect(second.captured.comments).toHaveLength(0);
    expect(second.captured.receipts[0]?.reason).toBe(
      'rereview_attempts_exhausted:comment_existing_or_failed'
    );
  });

  test('the marker keys on the HEAD, so a later exhaustion is announced again', () => {
    expect(rereviewCapCommentMarker(NEW_HEAD)).not.toBe(rereviewCapCommentMarker(OLD_HEAD));
    // Invisible in the rendered comment, exact-matchable by the adapter.
    expect(buildRereviewCapComment(NEW_HEAD, 3)).toContain(rereviewCapCommentMarker(NEW_HEAD));
    expect(rereviewCapCommentMarker(NEW_HEAD).startsWith('<!--')).toBe(true);
  });

  test('the receipt records whether the comment was actually posted', async () => {
    const fake = deps([...autoAttempts(MAX_REREVIEW_ATTEMPTS), work()]);
    await ingestPullRequestEvent(request(), fake.value);
    expect(fake.captured.receipts[0]?.reason).toBe('rereview_attempts_exhausted:comment_posted');
  });

  test('a comment failure never changes the block or throws the ingest open', async () => {
    const fake = deps([...autoAttempts(MAX_REREVIEW_ATTEMPTS), work()]);
    fake.value.postCapExhaustedComment = async () => {
      throw new Error('github_unreachable');
    };
    const result = await ingestPullRequestEvent(request(), fake.value);

    expect(result.disposition).toBe('blocked');
    expect(result.status).toBe(200);
    expect(fake.captured.enqueued).toHaveLength(0);
  });

  test('a deps double with no comment seam still blocks, exactly as before', async () => {
    // The seam is optional so existing dependency doubles keep compiling; its
    // absence must degrade to the pre-#797 silence, never to a crash.
    const fake = deps([...autoAttempts(MAX_REREVIEW_ATTEMPTS), work()], { commentSeam: false });
    const result = await ingestPullRequestEvent(request(), fake.value);

    expect(result.reason).toBe('rereview_attempts_exhausted');
    expect(fake.captured.receipts[0]?.reason).toBe('rereview_attempts_exhausted');
  });

  test('no comment is posted when the budget is not exhausted', async () => {
    const fake = deps([...autoAttempts(MAX_REREVIEW_ATTEMPTS - 1), work()]);
    const result = await ingestPullRequestEvent(request(), fake.value);

    expect(result.disposition).toBe('queued');
    expect(fake.captured.comments).toHaveLength(0);
  });
});
