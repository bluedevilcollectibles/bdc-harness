/**
 * #803 review 3 -- the cap-comment claim must be recoverable ACROSS PROCESSES.
 *
 * The finding: claim release was recorded only in the process-local
 * `capCommentClaimAttempts` map while the claimed dispatch row is durable. So
 * after `createComment` failed, a retry handled by another worker or after a
 * restart started again at attempt 0 -- an idempotency key the abandoned claim
 * already holds. That retry always loses, and the head is never announced,
 * which is the silent block this whole path exists to end.
 *
 * These tests drive `currentCapCommentAttempt` with the rows a PRIOR process
 * would have left behind, and a cleared memo -- i.e. a fresh process.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CAP_COMMENT_MAX_CLAIM_ATTEMPTS,
  capCommentIdempotencyKey,
  currentCapCommentAttempt,
  resetCapCommentClaimAttempts,
  type CapCommentInput,
} from '../pr-review-wiring.ts';

const input: CapCommentInput = {
  owner: 'thinmansoftware',
  repo: 'fuelglass',
  prNumber: 2,
  headSha: '943c92647a045e4bb5087fd3e4ed12821d318490',
};

const base = capCommentIdempotencyKey(input);

/** The durable rows a prior process left, newest-first like the real store. */
function rows(...keys: string[]): () => Promise<Array<{ idempotency_key: string }>> {
  return async () => keys.map(idempotency_key => ({ idempotency_key }));
}

describe('#803 review 3: claim recovery is durable, not process-local', () => {
  beforeEach(() => {
    resetCapCommentClaimAttempts();
  });

  test('a FRESH process recovers the attempt from the abandoned row, instead of reusing key 0', async () => {
    // Prior process claimed attempt 0, createComment failed, row left behind.
    // This process has an empty memo -- the restart case from the finding.
    const attempt = await currentCapCommentAttempt(input, rows(base));
    expect(attempt).toBe(1); // NOT 0: attempt 0's key is taken
  });

  test('successive abandoned retries keep advancing on a fresh process', async () => {
    const attempt = await currentCapCommentAttempt(
      input,
      rows(`${base}:retry2`, `${base}:retry1`, base)
    );
    expect(attempt).toBe(3);
  });

  test('with no prior rows the first claim is attempt 0', async () => {
    expect(await currentCapCommentAttempt(input, rows())).toBe(0);
  });

  test('rows for OTHER heads and other subjects never advance this head', async () => {
    const otherHead = capCommentIdempotencyKey({ ...input, headSha: 'deadbeef'.repeat(5) });
    const attempt = await currentCapCommentAttempt(
      input,
      rows(otherHead, `${otherHead}:retry1`, 'tm:nudge:something-else')
    );
    expect(attempt).toBe(0);
  });

  test('a store read failure falls back to the memo rather than throwing', async () => {
    const failing = async (): Promise<Array<{ idempotency_key: string }>> => {
      throw new Error('claim store unavailable');
    };
    // Must not reject: the caller treats an unusable claim store as "post anyway",
    // because an unannounced block is the worse failure.
    expect(await currentCapCommentAttempt(input, failing)).toBe(0);
  });

  test('the durable count wins over a STALE lower memo', async () => {
    // Seed the memo at 0 by reading an empty store...
    expect(await currentCapCommentAttempt(input, rows())).toBe(0);
    // ...then another worker's rows appear. Reusing the memo would lose the claim.
    expect(await currentCapCommentAttempt(input, rows(base, `${base}:retry1`))).toBe(2);
  });

  test('recovery stays inside the attempt bound, so the claim stops gating rather than looping', async () => {
    const all = [base];
    for (let i = 1; i <= CAP_COMMENT_MAX_CLAIM_ATTEMPTS; i++) all.push(`${base}:retry${i}`);
    const attempt = await currentCapCommentAttempt(input, rows(...all));
    expect(attempt).toBeGreaterThanOrEqual(CAP_COMMENT_MAX_CLAIM_ATTEMPTS);
  });
});
