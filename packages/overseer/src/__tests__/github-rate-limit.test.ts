/**
 * Tests for rate-limit classification and its deferral wiring
 * (bdc-harness #782 part 2).
 *
 * The headline stop condition: "a mocked 403 rate-limit response during review
 * yields disposition deferred with retry_after set, not
 * changes_requested/indeterminate."
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RATE_LIMIT_RETRY_MS,
  MAX_RATE_LIMIT_RETRY_MS,
  classifyRateLimitError,
  isRateLimitError,
} from '../github-rate-limit';
import { evaluatePullRequest, type PrReviewDeps } from '../pr-review-evaluator';
import { runAndSubmitReview, type SubmitDeps, type ReviewWorkItem } from '../pr-review-submit';

const NOW = new Date('2026-09-07T15:30:00.000Z');

/** The shape @octokit/request-error throws: status + lowercase header record. */
function octokitError(
  status: number,
  headers: Record<string, string>,
  message = 'API rate limit exceeded for user ID 255238497.'
): Error & { status: number; headers: Record<string, string> } {
  const error = new Error(message) as Error & {
    status: number;
    headers: Record<string, string>;
  };
  error.status = status;
  error.headers = headers;
  return error;
}

describe('classifyRateLimitError', () => {
  test('a primary 403 with remaining 0 and a reset epoch defers to the reset instant', () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 900;
    const classification = classifyRateLimitError(
      octokitError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
      NOW
    );
    expect(classification).not.toBeNull();
    expect(classification?.kind).toBe('primary');
    expect(classification?.source).toBe('reset_header');
    expect(classification?.retryAfterMs).toBe(900_000);
    expect(classification?.retryAfter).toBe('2026-09-07T15:45:00.000Z');
  });

  test('a secondary 403 with retry-after prefers that header over the reset epoch', () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 3600;
    const classification = classifyRateLimitError(
      octokitError(
        403,
        { 'retry-after': '60', 'x-ratelimit-reset': String(reset) },
        'You have exceeded a secondary rate limit.'
      ),
      NOW
    );
    expect(classification?.source).toBe('retry_after_header');
    expect(classification?.retryAfterMs).toBe(60_000);
  });

  test('a 429 with retry-after is classified', () => {
    const classification = classifyRateLimitError(
      octokitError(429, { 'retry-after': '30' }, 'Too many requests'),
      NOW
    );
    expect(classification?.retryAfterMs).toBe(30_000);
  });

  test('a rate limit with no usable clock still gets a finite default wait', () => {
    const classification = classifyRateLimitError(
      octokitError(403, { 'x-ratelimit-remaining': '0' }),
      NOW
    );
    expect(classification?.source).toBe('default');
    expect(classification?.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
  });

  test('a far-future reset is clamped so a review is never parked for days', () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 86_400 * 30;
    const classification = classifyRateLimitError(
      octokitError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
      NOW
    );
    expect(classification?.retryAfterMs).toBe(MAX_RATE_LIMIT_RETRY_MS);
  });

  test('an already-elapsed reset falls back to the default rather than a zero wait', () => {
    const reset = Math.floor(NOW.getTime() / 1000) - 60;
    const classification = classifyRateLimitError(
      octokitError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
      NOW
    );
    expect(classification?.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
  });

  test('reads Headers-style bags as well as plain records', () => {
    const error = new Error('API rate limit exceeded') as Error & {
      status: number;
      headers: { get(name: string): string | null };
    };
    error.status = 403;
    const bag = new Map([['retry-after', '45']]);
    error.headers = { get: name => bag.get(name) ?? null };
    expect(classifyRateLimitError(error, NOW)?.retryAfterMs).toBe(45_000);
  });

  test('A BARE 403 IS NOT A RATE LIMIT -- a permission denial must stay terminal', () => {
    // This is the guard against #774: classifying an ordinary authorization
    // failure as a rate limit would defer it forever instead of surfacing it.
    expect(
      classifyRateLimitError(octokitError(403, {}, 'Resource not accessible by integration'))
    ).toBeNull();
    expect(
      isRateLimitError(octokitError(403, { 'x-ratelimit-remaining': '4321' }, 'Forbidden'))
    ).toBe(false);
  });

  test('unrelated errors and non-error values are not rate limits', () => {
    expect(classifyRateLimitError(new Error('ECONNRESET'))).toBeNull();
    expect(classifyRateLimitError(octokitError(500, {}, 'Server Error'))).toBeNull();
    expect(classifyRateLimitError(null)).toBeNull();
    expect(classifyRateLimitError(undefined)).toBeNull();
    expect(classifyRateLimitError('rate limit')).toBeNull();
  });
});

const INPUT = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  pr_number: 776,
  head_sha: 'c3935e09c3935e09c3935e09c3935e09c3935e09',
};

function evaluatorDeps(overrides: Partial<PrReviewDeps> = {}): PrReviewDeps {
  return {
    reviewer: { provider: 'cli', model: 'grok' },
    async fetchEvidence() {
      return { diff: 'diff', checks: [], requiredContexts: [] };
    },
    async fetchAcceptanceCriteria() {
      return null;
    },
    async invokeModel() {
      return { exitCode: 0, stdout: '', timedOut: false };
    },
    ladder: ['grok'],
    ...overrides,
  };
}

describe('evaluatePullRequest under a rate limit', () => {
  test('a 403 rate limit during fetchEvidence yields RATE_LIMITED with retry_after, never INDETERMINATE', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const result = await evaluatePullRequest(
      INPUT,
      evaluatorDeps({
        async fetchEvidence() {
          throw octokitError(403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(reset),
          });
        },
      })
    );
    expect(result.verdict).toBe('RATE_LIMITED');
    expect(result.verdict).not.toBe('INDETERMINATE');
    expect(result.verdict).not.toBe('REQUEST_CHANGES');
    expect(result.retry_after).toBeTruthy();
    expect(result.retry_after_ms).toBeGreaterThan(0);
    expect(result.findings).toEqual([]);
    expect(result.reviewed_head_sha).toBe(INPUT.head_sha);
  });

  test('a non-rate-limit evidence error is still INDETERMINATE', async () => {
    const result = await evaluatePullRequest(
      INPUT,
      evaluatorDeps({
        async fetchEvidence() {
          throw new Error('pr_review_head_moved');
        },
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.retry_after).toBeUndefined();
  });

  test('a rate limit raised by the model seam abandons the ladder rather than spending more budget', async () => {
    const attempted: string[] = [];
    const result = await evaluatePullRequest(
      INPUT,
      evaluatorDeps({
        async fetchEvidence() {
          return {
            diff: 'diff',
            checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
            requiredContexts: ['test'],
          };
        },
        ladder: ['grok', 'codex'],
        async invokeModel(binary) {
          attempted.push(binary);
          throw octokitError(403, { 'retry-after': '120' }, 'API rate limit exceeded');
        },
      })
    );
    expect(result.verdict).toBe('RATE_LIMITED');
    expect(result.retry_after_ms).toBe(120_000);
    // Only the FIRST binary was tried: walking the ladder would burn an
    // already-exhausted budget and end at INDETERMINATE anyway.
    expect(attempted).toEqual(['grok']);
  });
});

const WORK: ReviewWorkItem = {
  correlationId: 'pr-review:thinmansoftware/bdc-harness#776@c3935e09',
  messageId: 'msg-1',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 776,
  headSha: 'c3935e09c3935e09c3935e09c3935e09c3935e09',
  author: 'someone-else',
};

function submitDeps(
  overrides: Partial<SubmitDeps>,
  recorded: { submitted: number; receipts: { disposition: string }[] }
): SubmitDeps {
  return {
    reviewerIdentity: 'thinman-overseer[bot]',
    async runReviewer() {
      return { approved: true, summary: '', reviewedHeadSha: WORK.headSha };
    },
    async submitReview() {
      recorded.submitted += 1;
      return { submitted: true };
    },
    async currentHeadSha() {
      return WORK.headSha;
    },
    async recordReceipt(input) {
      recorded.receipts.push({ disposition: input.disposition });
    },
    ...overrides,
  };
}

describe('runAndSubmitReview under a rate limit', () => {
  test('a rate-limited reviewer verdict defers with retry_after and submits NOTHING', async () => {
    const recorded = { submitted: 0, receipts: [] as { disposition: string }[] };
    const outcome = await runAndSubmitReview(
      WORK,
      submitDeps(
        {
          async runReviewer() {
            return {
              approved: false,
              summary: '',
              reviewedHeadSha: '',
              rateLimited: true,
              retryAfter: '2026-09-07T15:45:00.000Z',
              retryAfterMs: 900_000,
            };
          },
        },
        recorded
      )
    );
    expect(outcome.disposition).toBe('rate_limited');
    expect(outcome.disposition).not.toBe('changes_requested');
    expect(outcome.retryAfter).toBe('2026-09-07T15:45:00.000Z');
    expect(outcome.retryAfterMs).toBe(900_000);
    // No review was posted: a rate limit is not a judgment about the code.
    expect(recorded.submitted).toBe(0);
    expect(recorded.receipts).toEqual([{ disposition: 'rate_limited' }]);
  });

  test('a rate limit thrown out of the reviewer defers instead of reviewer_failed', async () => {
    const recorded = { submitted: 0, receipts: [] as { disposition: string }[] };
    const outcome = await runAndSubmitReview(
      WORK,
      submitDeps(
        {
          async runReviewer() {
            throw octokitError(403, { 'retry-after': '90' }, 'API rate limit exceeded');
          },
        },
        recorded
      )
    );
    expect(outcome.disposition).toBe('rate_limited');
    expect(outcome.retryAfterMs).toBe(90_000);
    expect(recorded.submitted).toBe(0);
  });

  test('a non-rate-limit reviewer throw is still terminal reviewer_failed', async () => {
    const recorded = { submitted: 0, receipts: [] as { disposition: string }[] };
    const outcome = await runAndSubmitReview(
      WORK,
      submitDeps(
        {
          async runReviewer() {
            throw new Error('model_unavailable');
          },
        },
        recorded
      )
    );
    expect(outcome.disposition).toBe('reviewer_failed');
  });

  test('a rate-limited verdict is NOT misclassified as stale_head despite an empty reviewed head', async () => {
    const recorded = { submitted: 0, receipts: [] as { disposition: string }[] };
    const outcome = await runAndSubmitReview(
      WORK,
      submitDeps(
        {
          async runReviewer() {
            return { approved: false, summary: '', reviewedHeadSha: '', rateLimited: true };
          },
          async currentHeadSha() {
            throw new Error('should_not_be_called');
          },
        },
        recorded
      )
    );
    expect(outcome.disposition).toBe('rate_limited');
  });
});
