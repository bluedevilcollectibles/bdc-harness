/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 -- route configuration and body
 * contracts. Hermetic: no database, no network.
 *
 * The fail-closed configuration gate is the security-relevant part here. An
 * unconfigured deployment must have NO endpoint rather than an endpoint that
 * accepts unverified input, so these tests pin that behavior.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRealSubmitDeps,
  REVIEW_REVIEWER_IDENTITY_ENV,
  REVIEW_WEBHOOK_SECRET_ENV,
  parseReviewWorkBody,
  resolveReviewRouteConfig,
  reviewSubjectKey,
} from '../pr-review-wiring.ts';
import type { RealGitHubOctokitLike } from '../adapters/github-real-deps.ts';
import type { PrReviewResult } from '../pr-review-evaluator.ts';

const HEAD = 'a'.repeat(40);

function submitOctokit(): RealGitHubOctokitLike {
  return {
    pulls: {
      get: async () => ({ data: { head: { sha: HEAD } } }),
      createReview: async () => ({ data: { id: 1, state: 'APPROVED' } }),
    },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
  } as unknown as RealGitHubOctokitLike;
}

function reviewResult(overrides: Partial<PrReviewResult> = {}): PrReviewResult {
  return {
    verdict: 'APPROVE',
    findings: [],
    reviewed_head_sha: HEAD,
    reviewer: { provider: 'test-cli', model: 'test-model' },
    acceptance_criteria_available: false,
    ...overrides,
  };
}

const work = {
  correlationId: 'correlation-1',
  messageId: 'message-1',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 42,
  headSha: HEAD,
  author: 'contributor',
};

describe('createRealSubmitDeps -- evaluator binding', () => {
  test.each([
    ['APPROVE', true],
    ['REQUEST_CHANGES', false],
    ['INDETERMINATE', false],
  ] as const)('maps %s to approved=%s', async (verdict, approved) => {
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      evaluate: async () =>
        reviewResult({
          verdict,
          findings:
            verdict === 'REQUEST_CHANGES'
              ? [{ scope: 'unsafe.ts', severity: 'major', summary: 'Unsafe change' }]
              : [],
        }),
    });

    expect((await deps.runReviewer(work)).approved).toBe(approved);
  });

  test('maps CHECKS_PENDING to a distinct checksPending signal, not approved=false', async () => {
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      evaluate: async () => reviewResult({ verdict: 'CHECKS_PENDING', error: 'checks_pending' }),
    });

    const verdict = await deps.runReviewer(work);
    expect(verdict.checksPending).toBe(true);
    expect(verdict.approved).toBe(false);
    // Distinct from INDETERMINATE/REQUEST_CHANGES: no summary is fabricated, so
    // it cannot be conflated into a REQUEST_CHANGES-producing approved=false.
    expect(verdict.summary).toBe('');
    expect(verdict.reviewedHeadSha).toBe(HEAD);
  });

  test('maps CHECKS_UNAVAILABLE to a terminal, non-approving blocked signal (#775)', async () => {
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      patOctokit: null,
      evaluate: async () =>
        reviewResult({
          verdict: 'CHECKS_UNAVAILABLE',
          error: 'required_contexts_unavailable_blocked:attempts=5:reason=permission',
        }),
    });

    const verdict = await deps.runReviewer(work);
    expect(verdict.requiredContextsUnavailable).toBe(true);
    expect(verdict.approved).toBe(false);
    // Distinct from CHECKS_PENDING: that one is retried and carries no summary.
    // This one is terminal, so it MUST carry a body -- a COMMENT with nothing
    // in it would tell the human nothing about why the PR is stuck.
    expect(verdict.checksPending).toBeUndefined();
    expect(verdict.summary).toContain('review blocked, not approved');
    expect(verdict.summary).toContain('5 attempts');
    expect(verdict.summary).toContain('permission');
    expect(verdict.reviewedHeadSha).toBe(HEAD);
  });

  test('the blocked summary names the transient cause when that is what failed', async () => {
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      patOctokit: null,
      evaluate: async () =>
        reviewResult({
          verdict: 'CHECKS_UNAVAILABLE',
          error: 'required_contexts_unavailable_blocked:attempts=5:reason=transient',
        }),
    });

    const verdict = await deps.runReviewer(work);
    // Permission and transient need different human actions, so the remedy
    // sentence must not be the same for both.
    expect(verdict.summary).toContain('transient');
    expect(verdict.summary).not.toContain('Grant the Overseer GitHub App');
  });

  test('does not expose internal INDETERMINATE errors in the GitHub summary', async () => {
    const secretError = 'model_error:token=super-secret-provider-detail';
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      evaluate: async () => reviewResult({ verdict: 'INDETERMINATE', error: secretError }),
    });

    const verdict = await deps.runReviewer(work);
    expect(verdict.approved).toBe(false);
    expect(verdict.summary).toContain('could not reach a determinate verdict');
    expect(verdict.summary).not.toContain(secretError);
    expect(verdict.summary).not.toContain('super-secret');
  });

  test('keeps the model-correlation identity separate from the GitHub custody identity', async () => {
    let observedReviewer: unknown;
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      reviewerModel: 'review-model',
      evaluate: async (_input, evaluatorDeps) => {
        observedReviewer = evaluatorDeps.reviewer;
        return reviewResult({ reviewer: evaluatorDeps.reviewer });
      },
    });

    await deps.runReviewer(work);
    expect(deps.reviewerIdentity).toBe('review-app[bot]');
    expect(observedReviewer).toEqual({ provider: 'cli', model: 'review-model' });
    expect(observedReviewer).not.toEqual(
      expect.objectContaining({ provider: deps.reviewerIdentity })
    );
  });
});

describe('resolveReviewRouteConfig -- fail closed', () => {
  test('returns config when both values are present', () => {
    const config = resolveReviewRouteConfig({
      [REVIEW_WEBHOOK_SECRET_ENV]: 'secret-value',
      [REVIEW_REVIEWER_IDENTITY_ENV]: 'thinman-overseer[bot]',
    });
    expect(config).toEqual({
      webhookSecret: 'secret-value',
      reviewerIdentity: 'thinman-overseer[bot]',
    });
  });

  test('uses explicit values from the app env when provided', () => {
    const config = resolveReviewRouteConfig({
      [REVIEW_WEBHOOK_SECRET_ENV]: 'secret-value',
      [REVIEW_REVIEWER_IDENTITY_ENV]: 'thinman-overseer[bot]',
      MERGE_MANAGER_REVIEW_GATE_LOGIN: 'alt-reviewer-bot',
      WEBHOOK_SECRET: 'fallback-secret',
    });
    expect(config).toEqual({
      webhookSecret: 'secret-value',
      reviewerIdentity: 'thinman-overseer[bot]',
    });
  });

  test('falls back to WEBHOOK_SECRET and MERGE_MANAGER_REVIEW_GATE_LOGIN when review vars are absent', () => {
    const config = resolveReviewRouteConfig({
      WEBHOOK_SECRET: 'webhook-fallback',
      MERGE_MANAGER_REVIEW_GATE_LOGIN: 'merge-gate-reviewer',
    });
    expect(config).toEqual({
      webhookSecret: 'webhook-fallback',
      reviewerIdentity: 'merge-gate-reviewer',
    });
  });

  test('falls back to thinman-overseer[bot] when only webhook secret is present', () => {
    const config = resolveReviewRouteConfig({
      [REVIEW_WEBHOOK_SECRET_ENV]: 'secret-value',
    });
    expect(config).toEqual({
      webhookSecret: 'secret-value',
      reviewerIdentity: 'thinman-overseer[bot]',
    });
  });

  test('returns null when the webhook secret is absent', () => {
    expect(
      resolveReviewRouteConfig({ [REVIEW_REVIEWER_IDENTITY_ENV]: 'thinman-overseer[bot]' })
    ).toBeNull();
  });

  test('returns null on an empty environment (default is OFF, not open)', () => {
    expect(resolveReviewRouteConfig({})).toBeNull();
  });

  test('whitespace-only values do not count as configured', () => {
    expect(
      resolveReviewRouteConfig({
        [REVIEW_WEBHOOK_SECRET_ENV]: '   ',
        [REVIEW_REVIEWER_IDENTITY_ENV]: 'thinman-overseer[bot]',
      })
    ).toBeNull();
  });

  test('trims surrounding whitespace from configured values', () => {
    const config = resolveReviewRouteConfig({
      [REVIEW_WEBHOOK_SECRET_ENV]: '  secret-value  ',
      [REVIEW_REVIEWER_IDENTITY_ENV]: '  thinman-overseer[bot]  ',
    });
    expect(config?.webhookSecret).toBe('secret-value');
    expect(config?.reviewerIdentity).toBe('thinman-overseer[bot]');
  });
});

describe('reviewSubjectKey', () => {
  test('is head-INDEPENDENT so every attempt for one PR groups together', () => {
    expect(reviewSubjectKey('thinmansoftware', 'bdc-harness', 673)).toBe(
      'gh:thinmansoftware/bdc-harness#673'
    );
  });

  test('distinguishes different PRs and different repos', () => {
    expect(reviewSubjectKey('o', 'r', 1)).not.toBe(reviewSubjectKey('o', 'r', 2));
    expect(reviewSubjectKey('o', 'r1', 1)).not.toBe(reviewSubjectKey('o', 'r2', 1));
  });
});

describe('parseReviewWorkBody', () => {
  const valid = {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    prNumber: 673,
    headSha: 'a'.repeat(40),
    baseRef: 'dev',
    author: 'bluedevilcollectibles',
  };

  test('round-trips a valid body', () => {
    expect(parseReviewWorkBody(JSON.stringify(valid))).toEqual(valid);
  });

  test('returns null on malformed JSON rather than throwing', () => {
    expect(parseReviewWorkBody('not json')).toBeNull();
  });

  test('returns null when a required field is missing or wrong-typed', () => {
    const { headSha: _omitted, ...missingHead } = valid;
    expect(parseReviewWorkBody(JSON.stringify(missingHead))).toBeNull();
    expect(parseReviewWorkBody(JSON.stringify({ ...valid, prNumber: '673' }))).toBeNull();
  });

  test('tolerates absent optional fields without inventing values', () => {
    const { baseRef: _b, author: _a, ...minimal } = valid;
    const parsed = parseReviewWorkBody(JSON.stringify(minimal));
    expect(parsed?.baseRef).toBe('');
    expect(parsed?.author).toBe('');
  });
});
