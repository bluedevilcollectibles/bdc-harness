import { describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import {
  MAX_REREVIEW_ATTEMPTS,
  buildRereviewReason,
  ingestPullRequestEvent,
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

  test('same-head delivery gets no reason and remains protected by the guard', async () => {
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
