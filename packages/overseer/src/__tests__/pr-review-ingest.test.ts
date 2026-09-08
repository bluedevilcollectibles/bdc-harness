/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 -- PR event ingestion.
 *
 * Required coverage: event handling, signature rejection, duplicate delivery,
 * exact-head binding, stale-head invalidation, custody conflict, review
 * failure, and receipt creation. Fully hermetic -- fake deps, no network, no
 * database, no App key.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import {
  ingestPullRequestEvent,
  reviewCorrelationId,
  type IngestDeps,
  type IngestDisposition,
  type PriorReviewWork,
} from '../pr-review-ingest.ts';

const SECRET = 'ingest-test-secret';
const REVIEWER = 'thinman-overseer[bot]';
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

function sign(payload: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

function prPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'opened',
    number: 673,
    pull_request: {
      number: 673,
      draft: false,
      state: 'open',
      head: { sha: HEAD, ref: 'wo/branch' },
      base: { ref: 'dev', sha: 'c'.repeat(40) },
      user: { login: 'bluedevilcollectibles', type: 'User' },
    },
    repository: {
      name: 'bdc-harness',
      owner: { login: 'thinmansoftware' },
      full_name: 'thinmansoftware/bdc-harness',
    },
    sender: { login: 'bluedevilcollectibles', type: 'User' },
    ...overrides,
  });
}

interface Recorded {
  receipts: Parameters<IngestDeps['recordReceipt']>[0][];
  enqueued: Parameters<IngestDeps['enqueueReviewWork']>[0][];
  cancelled: Parameters<IngestDeps['cancelReviewWork']>[0][];
}

function makeDeps(
  overrides: Partial<IngestDeps> = {},
  prior: PriorReviewWork[] = []
): { deps: IngestDeps; rec: Recorded } {
  const rec: Recorded = { receipts: [], enqueued: [], cancelled: [] };
  const deps: IngestDeps = {
    webhookSecret: SECRET,
    reviewerIdentity: REVIEWER,
    listPriorReviewWork: async () => prior,
    cancelReviewWork: async input => {
      rec.cancelled.push(input);
      return input.messageIds;
    },
    enqueueReviewWork: async input => {
      rec.enqueued.push(input);
      return { messageId: 'msg-1', alreadyExisted: false };
    },
    recordReceipt: async input => {
      rec.receipts.push(input);
    },
    ...overrides,
  };
  return { deps, rec };
}

function req(body: string, over: Partial<Parameters<typeof ingestPullRequestEvent>[0]> = {}) {
  return {
    rawBody: body,
    signature: sign(body),
    eventType: 'pull_request',
    deliveryId: 'delivery-1',
    ...over,
  };
}

describe('signature rejection', () => {
  test('rejects a bad signature and does NOT parse or enqueue', async () => {
    const body = prPayload();
    const { deps, rec } = makeDeps();
    const result = await ingestPullRequestEvent(
      req(body, { signature: sign(body, 'wrong-secret') }),
      deps
    );
    expect(result.disposition).toBe('rejected_signature');
    expect(result.status).toBe(401);
    expect(rec.enqueued).toHaveLength(0);
  });

  test('rejects a missing signature header', async () => {
    const { deps } = makeDeps();
    const result = await ingestPullRequestEvent(req(prPayload(), { signature: undefined }), deps);
    expect(result.disposition).toBe('rejected_signature');
    expect(result.reason).toBe('signature_missing_signature');
  });

  test('fails closed when the webhook secret is not configured', async () => {
    const { deps, rec } = makeDeps({ webhookSecret: '' });
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(result.disposition).toBe('blocked');
    expect(result.status).toBe(500);
    expect(result.reason).toBe('webhook_secret_not_configured');
    expect(rec.enqueued).toHaveLength(0);
  });

  test('a signature-rejected delivery still writes a receipt', async () => {
    const body = prPayload();
    const { deps, rec } = makeDeps();
    await ingestPullRequestEvent(req(body, { signature: sign(body, 'nope') }), deps);
    expect(rec.receipts).toHaveLength(1);
    expect(rec.receipts[0]?.disposition).toBe('rejected_signature');
    expect(rec.receipts[0]?.deliveryId).toBe('delivery-1');
  });
});

describe('event handling', () => {
  test('queues durable work for a reviewable action', async () => {
    const { deps, rec } = makeDeps();
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(result.disposition).toBe('queued');
    expect(result.messageId).toBe('msg-1');
    expect(rec.enqueued).toHaveLength(1);
  });

  test.each(['opened', 'reopened', 'synchronize', 'ready_for_review'])(
    'action %s is reviewable',
    async action => {
      const { deps } = makeDeps();
      const body = prPayload({ action });
      const result = await ingestPullRequestEvent(req(body, { signature: sign(body) }), deps);
      expect(result.disposition).toBe('queued');
    }
  );

  test.each(['closed', 'labeled', 'assigned', 'edited'])(
    'action %s is ignored without enqueueing',
    async action => {
      const { deps, rec } = makeDeps();
      const body = prPayload({ action });
      const result = await ingestPullRequestEvent(req(body, { signature: sign(body) }), deps);
      expect(result.disposition).toBe('ignored_event');
      expect(rec.enqueued).toHaveLength(0);
    }
  );

  test('non-pull_request event types are ignored', async () => {
    const { deps, rec } = makeDeps();
    const result = await ingestPullRequestEvent(req(prPayload(), { eventType: 'push' }), deps);
    expect(result.disposition).toBe('ignored_event');
    expect(result.reason).toBe('event_type_not_pull_request');
    expect(rec.enqueued).toHaveLength(0);
  });

  test('draft PRs are not reviewed', async () => {
    const { deps, rec } = makeDeps();
    const body = prPayload({
      pull_request: {
        number: 673,
        draft: true,
        head: { sha: HEAD },
        base: { ref: 'dev' },
        user: { login: 'bluedevilcollectibles' },
      },
    });
    const result = await ingestPullRequestEvent(req(body, { signature: sign(body) }), deps);
    expect(result.disposition).toBe('ignored_draft');
    expect(rec.enqueued).toHaveLength(0);
  });

  test('ready_for_review on a draft-flagged payload IS reviewed', async () => {
    const { deps } = makeDeps();
    const body = prPayload({
      action: 'ready_for_review',
      pull_request: {
        number: 673,
        draft: true,
        head: { sha: HEAD },
        base: { ref: 'dev' },
        user: { login: 'bluedevilcollectibles' },
      },
    });
    const result = await ingestPullRequestEvent(req(body, { signature: sign(body) }), deps);
    expect(result.disposition).toBe('queued');
  });

  test('an unparseable body fails closed after signature passes', async () => {
    const body = 'not json';
    const { deps } = makeDeps();
    const result = await ingestPullRequestEvent(req(body, { signature: sign(body) }), deps);
    expect(result.disposition).toBe('blocked');
    expect(result.reason).toBe('payload_unparseable');
  });

  test('incomplete PR context fails closed rather than queueing junk', async () => {
    const { deps, rec } = makeDeps();
    const body = prPayload({
      pull_request: { number: 673, head: {}, base: { ref: 'dev' }, user: { login: 'x' } },
    });
    const result = await ingestPullRequestEvent(req(body, { signature: sign(body) }), deps);
    expect(result.disposition).toBe('blocked');
    expect(result.reason).toBe('incomplete_pull_request_context');
    expect(rec.enqueued).toHaveLength(0);
  });
});

describe('exact-head binding', () => {
  test('queued work carries the exact head SHA and a head-bound correlation id', async () => {
    const { deps, rec } = makeDeps();
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(result.headSha).toBe(HEAD);
    expect(rec.enqueued[0]?.headSha).toBe(HEAD);
    expect(result.correlationId).toBe(
      reviewCorrelationId({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 673,
        headSha: HEAD,
      })
    );
    expect(result.correlationId).toContain(HEAD);
  });

  test('a different head produces a different correlation id and idempotency key', async () => {
    const a = reviewCorrelationId({ owner: 'o', repo: 'r', prNumber: 1, headSha: HEAD });
    const b = reviewCorrelationId({ owner: 'o', repo: 'r', prNumber: 1, headSha: OLD_HEAD });
    expect(a).not.toBe(b);
  });

  test('correlation id is deterministic across calls (retry-safe)', async () => {
    const input = { owner: 'o', repo: 'r', prNumber: 5, headSha: HEAD };
    expect(reviewCorrelationId(input)).toBe(reviewCorrelationId(input));
  });
});

describe('duplicate delivery', () => {
  test('an idempotent replay reports duplicate_delivery, not a second queue item', async () => {
    const { deps, rec } = makeDeps({
      enqueueReviewWork: async () => ({ messageId: 'msg-existing', alreadyExisted: true }),
    });
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(result.disposition).toBe('duplicate_delivery');
    expect(result.reason).toBe('idempotent_replay');
    expect(result.messageId).toBe('msg-existing');
    expect(rec.receipts[0]?.disposition).toBe('duplicate_delivery');
  });

  test('redelivery uses the same idempotency key so the queue collapses it', async () => {
    const { deps, rec } = makeDeps();
    await ingestPullRequestEvent(req(prPayload()), deps);
    await ingestPullRequestEvent(req(prPayload(), { deliveryId: 'delivery-2' }), deps);
    expect(rec.enqueued[0]?.idempotencyKey).toBe(rec.enqueued[1]?.idempotencyKey ?? '');
  });
});

describe('stale-head invalidation', () => {
  test('in-flight work on an older head is cancelled when the head advances', async () => {
    const prior: PriorReviewWork[] = [
      {
        messageId: 'old-1',
        headSha: OLD_HEAD,
        status: 'queued',
        verdict: null,
        verdictId: null,
        isAutoRereview: false,
      },
      {
        messageId: 'old-2',
        headSha: OLD_HEAD,
        status: 'claimed',
        verdict: null,
        verdictId: null,
        isAutoRereview: false,
      },
    ];
    const { deps, rec } = makeDeps({}, prior);
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(result.disposition).toBe('superseded_head');
    expect(result.invalidatedMessageIds).toEqual(['old-1', 'old-2']);
    expect(rec.cancelled[0]?.reason).toBe(`superseded_by_head_${HEAD}`);
  });

  test('terminal prior work is NOT cancelled', async () => {
    const prior: PriorReviewWork[] = [
      {
        messageId: 'done-1',
        headSha: OLD_HEAD,
        status: 'done',
        verdict: null,
        verdictId: null,
        isAutoRereview: false,
      },
      {
        messageId: 'failed-1',
        headSha: OLD_HEAD,
        status: 'failed',
        verdict: null,
        verdictId: null,
        isAutoRereview: false,
      },
      {
        messageId: 'cancelled-1',
        headSha: OLD_HEAD,
        status: 'cancelled',
        verdict: null,
        verdictId: null,
        isAutoRereview: false,
      },
    ];
    const { deps, rec } = makeDeps({}, prior);
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(rec.cancelled).toHaveLength(0);
    expect(result.disposition).toBe('queued');
  });

  test('prior work on the SAME head is not treated as stale', async () => {
    const prior: PriorReviewWork[] = [
      {
        messageId: 'same-1',
        headSha: HEAD,
        status: 'queued',
        verdict: null,
        verdictId: null,
        isAutoRereview: false,
      },
    ];
    const { deps, rec } = makeDeps({}, prior);
    await ingestPullRequestEvent(req(prPayload()), deps);
    expect(rec.cancelled).toHaveLength(0);
  });

  test('a failure while invalidating fails closed and does not enqueue', async () => {
    const { deps, rec } = makeDeps(
      {
        listPriorReviewWork: async () => {
          throw new Error('db_unavailable');
        },
      },
      []
    );
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(result.disposition).toBe('blocked');
    expect(result.reason).toContain('stale_head_invalidation_failed');
    expect(rec.enqueued).toHaveLength(0);
  });
});

describe('custody conflict', () => {
  test('refuses to queue a review of the reviewer own PR', async () => {
    const { deps, rec } = makeDeps();
    const body = prPayload({
      pull_request: {
        number: 673,
        draft: false,
        head: { sha: HEAD },
        base: { ref: 'dev' },
        user: { login: REVIEWER },
      },
    });
    const result = await ingestPullRequestEvent(req(body, { signature: sign(body) }), deps);
    expect(result.disposition).toBe('custody_conflict');
    expect(result.reason).toBe('reviewer_is_pull_request_author');
    expect(rec.enqueued).toHaveLength(0);
  });

  test('custody check is case-insensitive', async () => {
    const { deps, rec } = makeDeps();
    const body = prPayload({
      pull_request: {
        number: 673,
        draft: false,
        head: { sha: HEAD },
        base: { ref: 'dev' },
        user: { login: 'THINMAN-OVERSEER[BOT]' },
      },
    });
    const result = await ingestPullRequestEvent(req(body, { signature: sign(body) }), deps);
    expect(result.disposition).toBe('custody_conflict');
    expect(rec.enqueued).toHaveLength(0);
  });

  test('a different author is not a custody conflict', async () => {
    const { deps } = makeDeps();
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(result.disposition).toBe('queued');
  });
});

describe('failure handling and receipts', () => {
  test('an enqueue failure fails closed with a visible blocker', async () => {
    const { deps, rec } = makeDeps({
      enqueueReviewWork: async () => {
        throw new Error('queue_write_failed');
      },
    });
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(result.disposition).toBe('blocked');
    expect(result.status).toBe(500);
    expect(result.reason).toContain('enqueue_failed');
    expect(rec.receipts[0]?.disposition).toBe('blocked');
  });

  test('every terminal disposition writes exactly one correlated receipt', async () => {
    const cases: { body: string; expected: IngestDisposition }[] = [
      { body: prPayload(), expected: 'queued' },
      { body: prPayload({ action: 'closed' }), expected: 'ignored_event' },
    ];
    for (const testCase of cases) {
      const { deps, rec } = makeDeps();
      const result = await ingestPullRequestEvent(
        req(testCase.body, { signature: sign(testCase.body) }),
        deps
      );
      expect(result.disposition).toBe(testCase.expected);
      expect(rec.receipts).toHaveLength(1);
      expect(rec.receipts[0]?.disposition).toBe(testCase.expected);
    }
  });

  test('a queued receipt carries the correlation id, head, and message id', async () => {
    const { deps, rec } = makeDeps();
    await ingestPullRequestEvent(req(prPayload()), deps);
    const receipt = rec.receipts[0];
    expect(receipt?.correlationId).toContain(HEAD);
    expect(receipt?.headSha).toBe(HEAD);
    expect(receipt?.messageId).toBe('msg-1');
    expect(receipt?.owner).toBe('thinmansoftware');
    expect(receipt?.repo).toBe('bdc-harness');
    expect(receipt?.prNumber).toBe(673);
  });

  test('a receipt write failure does not throw the ingest path open', async () => {
    const { deps } = makeDeps({
      recordReceipt: async () => {
        throw new Error('receipt_store_down');
      },
    });
    const result = await ingestPullRequestEvent(req(prPayload()), deps);
    expect(result.disposition).toBe('queued');
  });
});
