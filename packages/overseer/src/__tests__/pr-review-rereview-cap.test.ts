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
import {
  CAP_COMMENT_MAX_COMMENT_PAGES,
  capCommentIdempotencyKey,
  postCapExhaustedCommentWith,
  type CapCommentInput,
} from '../pr-review-wiring.ts';

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

  test('an UNJUDGED automatic row does not consume the budget', async () => {
    // Review finding (Overseer, PR #803): the first cut counted every
    // `isAutoRereview` row before asking whether it had been judged. A row
    // exists from the moment work is QUEUED, so three fast pushes created three
    // unjudged auto rows and exhausted the budget before a single automatic
    // re-review had actually run -- the opposite of the guard's purpose, since
    // an unjudged row burned no judge budget at all.
    const inFlight = autoAttempts(MAX_REREVIEW_ATTEMPTS).map(row => ({
      ...row,
      status: 'queued' as const,
      verdict: null,
      verdictId: null,
    }));
    expect(countConsecutiveAutoRereviews(inFlight)).toBe(0);

    const fake = deps([...inFlight, work()]);
    expect((await ingestPullRequestEvent(request(), fake.value)).disposition).toBe('queued');
  });

  test('a DEFERRED automatic row (verdict other) does not consume the budget either', () => {
    // `classifyVerdict` maps every non-approve/non-changes_requested submit
    // disposition to 'other', and receipts are written for the DEFERRALS
    // checks_pending and transport_error too. Counting those would let a PR
    // whose CI is merely slow, or whose judge host blipped, burn its whole
    // budget without one review having happened.
    const deferred = autoAttempts(MAX_REREVIEW_ATTEMPTS).map(row => ({
      ...row,
      verdict: 'other' as const,
    }));
    expect(countConsecutiveAutoRereviews(deferred)).toBe(0);
  });

  test('a mixed history counts only the judged automatic rows', () => {
    const mixed = [
      // newest: still queued, never judged -- not an attempt
      { ...autoAttempts(1)[0]!, messageId: 'in-flight', verdict: null, verdictId: null },
      // deferred, no judge was reached -- not an attempt
      { ...autoAttempts(1)[0]!, messageId: 'deferred', verdict: 'other' as const },
      // two real judged auto re-reviews -- these ARE attempts
      { ...autoAttempts(1)[0]!, messageId: 'judged-1' },
      { ...autoAttempts(1)[0]!, messageId: 'judged-2' },
      // the operator's look, which stops the walk
      work({ messageId: 'hand-nudge', headSha: 'e'.repeat(40) }),
      ...autoAttempts(3),
    ];
    expect(countConsecutiveAutoRereviews(mixed)).toBe(2);
  });

  test('a non-auto row that only DEFERRED does not reset the budget', () => {
    // Symmetric to the rule above: 'other' is not the operator look the reset
    // represents, so it must not re-arm the budget either.
    const prior = [
      work({ messageId: 'deferred-nudge', headSha: 'd'.repeat(40), verdict: 'other' }),
      ...autoAttempts(MAX_REREVIEW_ATTEMPTS),
      work({ messageId: 'initial' }),
    ];
    expect(countConsecutiveAutoRereviews(prior)).toBe(MAX_REREVIEW_ATTEMPTS);
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

/**
 * The ADAPTER's half of the one-comment-per-head guarantee (#803 review).
 *
 * The tests above pin what ingest does with the seam; these pin the seam
 * itself, which is where the reviewer found two real holes: a single 100-comment
 * page misses a marker on a long thread, and list-then-create races.
 */
describe('#797 -- the cap comment is idempotent for real, not just in the happy case', () => {
  const capInput: CapCommentInput = {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    prNumber: 790,
    headSha: NEW_HEAD,
    body: buildRereviewCapComment(NEW_HEAD, 3),
    marker: rereviewCapCommentMarker(NEW_HEAD),
  };

  /** An octokit whose comment thread spans `pages`, counting every call. */
  function commentOctokit(pages: string[][]): {
    client: () => never;
    created: string[];
    pagesRead: number[];
  } {
    const created: string[] = [];
    const pagesRead: number[] = [];
    const client = {
      issues: {
        listComments: async (input: { page?: number }) => {
          const page = input.page ?? 1;
          pagesRead.push(page);
          return { data: (pages[page - 1] ?? []).map(body => ({ body })) };
        },
        createComment: async (input: { body: string }) => {
          created.push(input.body);
          return { data: {} };
        },
      },
    };
    return { client: () => client as never, created, pagesRead };
  }

  /** 100 unrelated comments -- a full page, forcing the scan to continue. */
  function fullPageOfNoise(tag: string): string[] {
    return Array.from({ length: 100 }, (_, index) => `unrelated comment ${tag}-${index}`);
  }

  test('a marker on PAGE 2 is found, and no duplicate is posted', async () => {
    const octokit = commentOctokit([fullPageOfNoise('p1'), [capInput.marker]]);

    const result = await postCapExhaustedCommentWith(
      { octokit: octokit.client, claim: async () => true },
      capInput
    );

    // The exact hole the reviewer named: pre-fix this scanned page 1 only,
    // saw no marker, and posted a second identical comment.
    expect(result.posted).toBe(false);
    expect(octokit.created).toHaveLength(0);
    expect(octokit.pagesRead).toEqual([1, 2]);
  });

  test('the scan stops at the first SHORT page rather than walking the cap', async () => {
    const octokit = commentOctokit([['just one comment']]);

    await postCapExhaustedCommentWith(
      { octokit: octokit.client, claim: async () => true },
      capInput
    );

    // A short page means the thread ended; the normal cost stays one call.
    expect(octokit.pagesRead).toEqual([1]);
    expect(octokit.created).toHaveLength(1);
  });

  test('the scan is BOUNDED so a pathological thread cannot spend the rate budget', async () => {
    const octokit = commentOctokit(
      Array.from({ length: CAP_COMMENT_MAX_COMMENT_PAGES + 4 }, (_, index) =>
        fullPageOfNoise(`p${index}`)
      )
    );

    await postCapExhaustedCommentWith(
      { octokit: octokit.client, claim: async () => true },
      capInput
    );

    expect(octokit.pagesRead).toHaveLength(CAP_COMMENT_MAX_COMMENT_PAGES);
    // Falling off the end posts rather than staying silent: a duplicate comment
    // is recoverable, a block nobody was told about is the bug being fixed.
    expect(octokit.created).toHaveLength(1);
  });

  test('TWO CONCURRENT calls produce exactly ONE comment', async () => {
    // A durable single-winner claim, standing in for the dispatch store's
    // UNIQUE idempotency_key. Both callers race it; only one may proceed.
    const claimed = new Set<string>();
    const claim = async (input: CapCommentInput): Promise<boolean> => {
      const key = capCommentIdempotencyKey(input);
      // Yield first, so both calls genuinely interleave before either claims --
      // otherwise the test would pass on a purely sequential implementation.
      await Promise.resolve();
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    };
    // The comment thread is EMPTY for both, which is exactly the race: neither
    // marker search can see the other's not-yet-created comment.
    const octokit = commentOctokit([[]]);

    const results = await Promise.all([
      postCapExhaustedCommentWith({ octokit: octokit.client, claim }, capInput),
      postCapExhaustedCommentWith({ octokit: octokit.client, claim }, capInput),
    ]);

    expect(octokit.created).toHaveLength(1);
    expect(results.filter(result => result.posted)).toHaveLength(1);
  });

  test('a DIFFERENT head claims separately, so a later exhaustion is still announced', async () => {
    const claimed = new Set<string>();
    const claim = async (input: CapCommentInput): Promise<boolean> => {
      const key = capCommentIdempotencyKey(input);
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    };
    const octokit = commentOctokit([[]]);

    await postCapExhaustedCommentWith({ octokit: octokit.client, claim }, capInput);
    await postCapExhaustedCommentWith(
      { octokit: octokit.client, claim },
      { ...capInput, headSha: OLD_HEAD, marker: rereviewCapCommentMarker(OLD_HEAD) }
    );

    expect(octokit.created).toHaveLength(2);
    expect(capCommentIdempotencyKey(capInput)).toContain(NEW_HEAD);
  });

  test('losing the claim skips the GitHub calls entirely', async () => {
    const octokit = commentOctokit([[]]);

    const result = await postCapExhaustedCommentWith(
      { octokit: octokit.client, claim: async () => false },
      capInput
    );

    expect(result.posted).toBe(false);
    expect(octokit.pagesRead).toHaveLength(0);
    expect(octokit.created).toHaveLength(0);
  });

  test('a client with no listComments declines rather than posting blind', async () => {
    const created: string[] = [];
    const octokit = (): never =>
      ({ issues: { createComment: async () => created.push('x') } }) as never;

    const result = await postCapExhaustedCommentWith(
      { octokit, claim: async () => true },
      capInput
    );

    expect(result.posted).toBe(false);
    expect(created).toHaveLength(0);
  });
});
