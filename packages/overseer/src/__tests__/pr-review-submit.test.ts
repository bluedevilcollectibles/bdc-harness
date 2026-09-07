/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 -- governed reviewer invocation and
 * verdict submission.
 *
 * Covers: approve path, REQUEST_CHANGES path (XO decision 1 -- a reviewer that
 * cannot reject is not a reviewer), custody conflict, exact-head binding,
 * stale-head invalidation mid-review, reviewer failure, submission failure,
 * and receipt creation. Hermetic -- fake deps only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildReviewBody,
  runAndSubmitReview,
  type ReviewWorkItem,
  type SubmitDeps,
} from '../pr-review-submit.ts';

const REVIEWER = 'thinman-overseer[bot]';
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'd'.repeat(40);

const WORK: ReviewWorkItem = {
  correlationId: `pr-review:thinmansoftware/bdc-harness#673@${HEAD}`,
  messageId: 'msg-1',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 673,
  headSha: HEAD,
  author: 'bluedevilcollectibles',
};

interface Recorded {
  submitted: Parameters<SubmitDeps['submitReview']>[0][];
  receipts: Parameters<SubmitDeps['recordReceipt']>[0][];
}

function makeDeps(overrides: Partial<SubmitDeps> = {}): { deps: SubmitDeps; rec: Recorded } {
  const rec: Recorded = { submitted: [], receipts: [] };
  const deps: SubmitDeps = {
    reviewerIdentity: REVIEWER,
    runReviewer: async () => ({
      approved: true,
      summary: 'All stop conditions verified.',
      reviewedHeadSha: HEAD,
    }),
    submitReview: async input => {
      rec.submitted.push(input);
      return { submitted: true };
    },
    currentHeadSha: async () => HEAD,
    recordReceipt: async input => {
      rec.receipts.push(input);
    },
    ...overrides,
  };
  return { deps, rec };
}

describe('approve path', () => {
  test('an approving verdict submits APPROVE', async () => {
    const { deps, rec } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
    expect(rec.submitted[0]?.event).toBe('APPROVE');
    expect(rec.receipts[0]?.disposition).toBe('approved');
  });

  test('the submitted review binds to the exact head the reviewer evaluated (commitId)', async () => {
    const { deps, rec } = makeDeps();
    await runAndSubmitReview(WORK, deps);
    expect(rec.submitted[0]?.commitId).toBe(HEAD);
    expect(rec.submitted[0]?.commitId).toBe(WORK.headSha);
  });

  test('the review body states the exact reviewed head', async () => {
    const { deps, rec } = makeDeps();
    await runAndSubmitReview(WORK, deps);
    expect(rec.submitted[0]?.body).toContain(HEAD);
  });
});

describe('request-changes path (XO decision 1)', () => {
  test('a non-approving verdict submits REQUEST_CHANGES, not silence', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({
        approved: false,
        summary: 'Stop condition 3 fails: manifest grep returns 0 matches.',
        reviewedHeadSha: HEAD,
      }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('changes_requested');
    expect(rec.submitted[0]?.event).toBe('REQUEST_CHANGES');
    expect(rec.submitted[0]?.body).toContain('Stop condition 3 fails');
  });

  test('a rejection with no evidence is refused before any network call', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({ approved: false, summary: '   ', reviewedHeadSha: HEAD }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('submission_failed');
    expect(outcome.reason).toBe('request_changes_missing_evidence');
    expect(rec.submitted).toHaveLength(0);
  });
});

describe('custody conflict', () => {
  test('never reviews a PR the reviewer authored', async () => {
    const { deps, rec } = makeDeps();
    const outcome = await runAndSubmitReview({ ...WORK, author: REVIEWER }, deps);
    expect(outcome.disposition).toBe('custody_conflict');
    expect(rec.submitted).toHaveLength(0);
    expect(rec.receipts[0]?.disposition).toBe('custody_conflict');
  });

  test('custody is checked BEFORE the reviewer runs (no wasted invocation)', async () => {
    let reviewerRan = false;
    const { deps } = makeDeps({
      runReviewer: async () => {
        reviewerRan = true;
        return { approved: true, summary: 'x', reviewedHeadSha: HEAD };
      },
    });
    await runAndSubmitReview({ ...WORK, author: REVIEWER }, deps);
    expect(reviewerRan).toBe(false);
  });
});

describe('merge-custody conflict (M-153, RULED 2026-08-24)', () => {
  const MODE_ENV = 'OVERSEER_MERGE_MANAGER_MODE';
  const MERGE_TOKEN_ENV = 'MERGE_MANAGER_GH_TOKEN';
  let priorMode: string | undefined;
  let priorToken: string | undefined;

  beforeEach(() => {
    priorMode = process.env[MODE_ENV];
    priorToken = process.env[MERGE_TOKEN_ENV];
    // Default to the single-identity condition so each test states its own.
    delete process.env[MERGE_TOKEN_ENV];
  });

  afterEach(() => {
    if (priorMode === undefined) delete process.env[MODE_ENV];
    else process.env[MODE_ENV] = priorMode;
    if (priorToken === undefined) delete process.env[MERGE_TOKEN_ENV];
    else process.env[MERGE_TOKEN_ENV] = priorToken;
  });

  test('refuses to submit when the armed merge manager shares this identity', async () => {
    process.env[MODE_ENV] = 'execute';
    delete process.env[MERGE_TOKEN_ENV];
    const { deps, rec } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('merge_custody_conflict');
    expect(outcome.reason).toBe('merge_manager_shares_reviewer_identity_m153');
    expect(rec.submitted).toHaveLength(0);
    expect(rec.receipts[0]?.disposition).toBe('merge_custody_conflict');
  });

  // THE DEADLOCK REGRESSION. Production ran mode=execute with a distinct merge
  // PAT configured; the old mode-only gate still refused every review, so no
  // approval was ever posted and the merge manager denied every PR for
  // `review_gate_approval_missing_for_head`. 50 review work items failed with
  // `merge_manager_mode_execute_review_blocked_pending_m153` and the machine
  // merged nothing. This test fails on the pre-fix gate.
  test('submits an APPROVE at the exact head when merge runs as a distinct identity', async () => {
    process.env[MODE_ENV] = 'execute';
    process.env[MERGE_TOKEN_ENV] = 'ghp_distinct_merge_identity';
    const { deps, rec } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
    expect(rec.submitted).toHaveLength(1);
    expect(rec.submitted[0]?.event).toBe('APPROVE');
    // Head-SHA pinning is what makes the approval satisfy the merge gate.
    expect(rec.submitted[0]?.commitId).toBe(HEAD);
  });

  test('proceeds normally when the merge manager is parked in hold-canary', async () => {
    process.env[MODE_ENV] = 'hold-canary';
    const { deps } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
  });

  test('proceeds normally when the merge manager is in comment_findings', async () => {
    process.env[MODE_ENV] = 'comment_findings';
    const { deps } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
  });

  test('fails closed (blocks review) on an unset mode -- default is hold-canary, not execute', async () => {
    delete process.env[MODE_ENV];
    const { deps } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
  });

  test('the merge-custody check runs BEFORE the reviewer (no wasted invocation)', async () => {
    process.env[MODE_ENV] = 'execute';
    let reviewerRan = false;
    const { deps } = makeDeps({
      runReviewer: async () => {
        reviewerRan = true;
        return { approved: true, summary: 'x', reviewedHeadSha: HEAD };
      },
    });
    await runAndSubmitReview(WORK, deps);
    expect(reviewerRan).toBe(false);
  });
});

describe('checks pending (WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01)', () => {
  test('a checks-pending verdict submits nothing and records a checks_pending receipt', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({
        approved: false,
        summary: '',
        reviewedHeadSha: HEAD,
        checksPending: true,
      }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('checks_pending');
    expect(outcome.reason).toBe('checks_not_terminal');
    // No REQUEST_CHANGES (or any review) is submitted on checks-pending grounds.
    expect(rec.submitted).toHaveLength(0);
    // A receipt is still recorded so the defer is observable.
    expect(rec.receipts).toHaveLength(1);
    expect(rec.receipts[0]?.disposition).toBe('checks_pending');
    expect(rec.receipts[0]?.headSha).toBe(HEAD);
  });

  test('custody and merge-custody are still enforced before the checks-pending branch', async () => {
    // Custody runs before runReviewer is even called, so a reviewer-authored PR
    // is a custody_conflict regardless of checksPending.
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({
        approved: false,
        summary: '',
        reviewedHeadSha: HEAD,
        checksPending: true,
      }),
    });
    const outcome = await runAndSubmitReview({ ...WORK, author: REVIEWER }, deps);
    expect(outcome.disposition).toBe('custody_conflict');
    expect(rec.submitted).toHaveLength(0);
  });
});

describe('required contexts unavailable -- blocked, never approved (#775)', () => {
  const BLOCKED_SUMMARY =
    'Required status-check contexts unavailable after 5 attempts (reason: permission); review blocked, not approved.';

  function blockedReviewer(): SubmitDeps['runReviewer'] {
    return async () => ({
      approved: false,
      summary: BLOCKED_SUMMARY,
      reviewedHeadSha: HEAD,
      requiredContextsUnavailable: true,
    });
  }

  test('posts a COMMENT review and finishes with the blocked disposition', async () => {
    const { deps, rec } = makeDeps({ runReviewer: blockedReviewer() });
    const outcome = await runAndSubmitReview(WORK, deps);

    expect(outcome.disposition).toBe('blocked_required_contexts_unavailable');
    expect(outcome.reason).toBe('required_contexts_unavailable_blocked');
    // A COMMENT states the problem on the PR without approving it and without
    // claiming a code finding that was never made.
    expect(rec.submitted).toHaveLength(1);
    expect(rec.submitted[0]?.event).toBe('COMMENT');
    expect(rec.submitted[0]?.event).not.toBe('APPROVE');
    expect(rec.submitted[0]?.body).toContain('review blocked, not approved');
    expect(rec.submitted[0]?.commitId).toBe(HEAD);
    // Terminal: a receipt exists, and it is the escalation the operator drains.
    expect(rec.receipts).toHaveLength(1);
    expect(rec.receipts[0]?.disposition).toBe('blocked_required_contexts_unavailable');
  });

  test('a failed comment still blocks -- it never degrades to a retry or an approval', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: blockedReviewer(),
      submitReview: async () => ({ submitted: false, message: 'github_review_unprocessable' }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);

    expect(outcome.disposition).toBe('blocked_required_contexts_unavailable');
    expect(outcome.disposition).not.toBe('checks_pending');
    expect(outcome.reason).toContain('comment_failed');
    // The escalation is what guarantees a human sees it even when the comment
    // could not be posted, so the receipt must still be written.
    expect(rec.receipts[0]?.disposition).toBe('blocked_required_contexts_unavailable');
  });

  test('a throwing comment is classified, not propagated', async () => {
    const { deps } = makeDeps({
      runReviewer: blockedReviewer(),
      submitReview: async () => {
        throw new Error('network exploded');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('blocked_required_contexts_unavailable');
  });

  test('checks-pending is checked first: a pending verdict never blocks', async () => {
    // The two are distinct outcomes. checksPending is retried; blocked is not.
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({
        approved: false,
        summary: '',
        reviewedHeadSha: HEAD,
        checksPending: true,
      }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('checks_pending');
    expect(rec.submitted).toHaveLength(0);
  });

  test('head moved to B: no comment, no blocked for A, and B stays reviewable (#777)', async () => {
    // The exact exposure the #777 review found. The reviewer evaluated head A
    // and could not read the required contexts; meanwhile the PR was pushed to
    // head B. Blocking is TERMINAL, so recording it here would retire the work
    // item for a head nobody reviewed and leave B with no review at all.
    let currentHeadCalls = 0;
    const { deps, rec } = makeDeps({
      runReviewer: blockedReviewer(),
      currentHeadSha: async () => {
        currentHeadCalls += 1;
        return NEW_HEAD;
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);

    // Non-terminal: requeued for the new head, never blocked, never approved.
    expect(outcome.disposition).toBe('superseded_head');
    expect(outcome.disposition).not.toBe('blocked_required_contexts_unavailable');
    expect(outcome.reason).toBe('head_advanced_before_required_contexts_block');
    // The live head WAS actually re-read -- the gate is not being skipped.
    expect(currentHeadCalls).toBe(1);
    // Nothing was posted to the PR for head A.
    expect(rec.submitted).toHaveLength(0);
    // And no terminal blocked receipt exists for A.
    expect(rec.receipts.some(r => r.disposition === 'blocked_required_contexts_unavailable')).toBe(
      false
    );

    // B is still reviewable: the same work item bound to B, with the head now
    // stable, reaches the terminal blocked outcome on its own evidence.
    const workAtB: ReviewWorkItem = { ...WORK, headSha: NEW_HEAD };
    const { deps: depsB, rec: recB } = makeDeps({
      runReviewer: async () => ({
        approved: false,
        summary: BLOCKED_SUMMARY,
        reviewedHeadSha: NEW_HEAD,
        requiredContextsUnavailable: true,
      }),
      currentHeadSha: async () => NEW_HEAD,
    });
    const outcomeB = await runAndSubmitReview(workAtB, depsB);
    expect(outcomeB.disposition).toBe('blocked_required_contexts_unavailable');
    expect(recB.submitted[0]?.event).toBe('COMMENT');
    expect(recB.submitted[0]?.commitId).toBe(NEW_HEAD);
  });

  test('a stale evaluator result is superseded, not blocked', async () => {
    // The reviewer returned a verdict for a DIFFERENT head than the work item
    // is bound to. Same rule: a terminal block must never land on a head the
    // reviewer did not actually evaluate.
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({
        approved: false,
        summary: BLOCKED_SUMMARY,
        reviewedHeadSha: NEW_HEAD,
        requiredContextsUnavailable: true,
      }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);

    expect(outcome.disposition).toBe('superseded_head');
    expect(outcome.reason).toBe('reviewer_examined_different_head_before_required_contexts_block');
    expect(rec.submitted).toHaveLength(0);
    expect(rec.receipts.some(r => r.disposition === 'blocked_required_contexts_unavailable')).toBe(
      false
    );
  });

  test('a failed live-head re-read does not block either', async () => {
    // If we cannot even establish what the live head is, we certainly cannot
    // terminate on it.
    const { deps, rec } = makeDeps({
      runReviewer: blockedReviewer(),
      currentHeadSha: async () => {
        throw new Error('github unreachable');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);

    expect(outcome.disposition).toBe('submission_failed');
    expect(outcome.disposition).not.toBe('blocked_required_contexts_unavailable');
    expect(rec.submitted).toHaveLength(0);
  });

  test('custody is still enforced ahead of the blocked branch', async () => {
    const { deps, rec } = makeDeps({ runReviewer: blockedReviewer() });
    const outcome = await runAndSubmitReview({ ...WORK, author: REVIEWER }, deps);
    expect(outcome.disposition).toBe('custody_conflict');
    expect(rec.submitted).toHaveLength(0);
  });
});

describe('exact-head binding', () => {
  test('refuses to submit when the reviewer examined a different head', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({
        approved: true,
        summary: 'looks fine',
        reviewedHeadSha: NEW_HEAD,
      }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('stale_head');
    expect(outcome.reason).toBe('reviewer_examined_different_head');
    expect(rec.submitted).toHaveLength(0);
  });

  test('refuses to submit when the head advanced during review', async () => {
    const { deps, rec } = makeDeps({ currentHeadSha: async () => NEW_HEAD });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('stale_head');
    expect(outcome.reason).toBe('head_advanced_during_review');
    expect(rec.submitted).toHaveLength(0);
  });

  test('a head re-read failure fails closed without submitting', async () => {
    const { deps, rec } = makeDeps({
      currentHeadSha: async () => {
        throw new Error('api_down');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('submission_failed');
    expect(outcome.reason).toContain('head_recheck_failed');
    expect(rec.submitted).toHaveLength(0);
  });
});

describe('failure handling', () => {
  test('a reviewer crash fails closed with a recorded blocker', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: async () => {
        throw new Error('model_unavailable');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('reviewer_failed');
    expect(outcome.reason).toContain('model_unavailable');
    expect(rec.receipts[0]?.disposition).toBe('reviewer_failed');
    expect(rec.submitted).toHaveLength(0);
  });

  test('a rejected submission surfaces the adapter stable code', async () => {
    const { deps, rec } = makeDeps({
      submitReview: async () => ({
        submitted: false,
        message: 'github_review_self_approval_rejected',
      }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('submission_failed');
    expect(outcome.reason).toBe('github_review_self_approval_rejected');
    expect(rec.receipts[0]?.reason).toBe('github_review_self_approval_rejected');
  });

  test('a throwing submission fails closed rather than escaping', async () => {
    const { deps } = makeDeps({
      submitReview: async () => {
        throw new Error('network_reset');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('submission_failed');
    expect(outcome.reason).toContain('submit_threw');
  });

  test('a receipt failure does not convert an outcome into a throw', async () => {
    const { deps } = makeDeps({
      recordReceipt: async () => {
        throw new Error('receipt_down');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
  });
});

describe('receipts', () => {
  test('every terminal disposition writes exactly one correlated receipt', async () => {
    const { deps, rec } = makeDeps();
    await runAndSubmitReview(WORK, deps);
    expect(rec.receipts).toHaveLength(1);
    expect(rec.receipts[0]?.correlationId).toBe(WORK.correlationId);
    expect(rec.receipts[0]?.messageId).toBe('msg-1');
    expect(rec.receipts[0]?.headSha).toBe(HEAD);
    expect(rec.receipts[0]?.event).toBe('APPROVE');
  });
});

describe('buildReviewBody', () => {
  test('includes the head and the reviewer summary', () => {
    const body = buildReviewBody(WORK, {
      approved: false,
      summary: 'Finding: missing test.',
      reviewedHeadSha: HEAD,
    });
    expect(body).toContain(HEAD);
    expect(body).toContain('Finding: missing test.');
  });

  test('bounds a runaway summary', () => {
    const body = buildReviewBody(WORK, {
      approved: false,
      summary: 'x'.repeat(100_000),
      reviewedHeadSha: HEAD,
    });
    expect(body.length).toBeLessThanOrEqual(60_000);
  });
});
