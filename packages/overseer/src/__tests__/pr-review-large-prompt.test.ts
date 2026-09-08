/**
 * Regression tests for bdc-harness #789 -- the Overseer reviewer returned
 * INDETERMINATE (posted as CHANGES_REQUESTED with no stated reason) on every PR
 * whose review prompt exceeded Linux MAX_ARG_STRLEN, because the whole prompt
 * was passed as ONE argv element and Bun.spawn raised E2BIG.
 *
 * Three properties are pinned here:
 *  1. A prompt far larger than the 131,072-byte single-argument limit reaches
 *     the model intact and produces a real verdict.
 *  2. An E2BIG out of the model seam defers (TRANSPORT_ERROR / transport_error)
 *     instead of posting a verdict at the head, and names the reason CODE.
 *  3. The posted summary carries the error code and never the error detail.
 */
import { describe, expect, test } from 'bun:test';
import { rm, stat } from 'node:fs/promises';
import {
  buildReviewModelTransport,
  evaluatePullRequest,
  isTransportError,
  resolveReviewModelTimeoutMs,
  reviewErrorCode,
  runReviewModelProcess,
  DEFAULT_REVIEW_MODEL_TIMEOUT_MS,
  type PrReviewDeps,
  type PrReviewInput,
  type ReviewModelChild,
} from '../pr-review-evaluator.ts';
import { buildIndeterminateSummary } from '../pr-review-wiring.ts';
import { runAndSubmitReview, type ReviewWorkItem, type SubmitDeps } from '../pr-review-submit.ts';

const HEAD = 'cccccccccccccccccccccccccccccccccccccccc';

/** Comfortably past Linux MAX_ARG_STRLEN (131,072 bytes). */
const LARGE_DIFF = `+${'a'.repeat(200_000)}`;

const input: PrReviewInput = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  pr_number: 776,
  head_sha: HEAD,
};

function verdictJson(): string {
  return JSON.stringify({ verdict: 'APPROVE', findings: [], reviewed_head_sha: HEAD });
}

function deps(overrides: Partial<PrReviewDeps> = {}): PrReviewDeps {
  return {
    reviewer: { provider: 'cli', model: 'grok' },
    fetchEvidence: async () => ({
      diff: LARGE_DIFF,
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    }),
    fetchAcceptanceCriteria: async () => null,
    invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: verdictJson() }),
    ladder: ['grok'],
    ...overrides,
  };
}

/** The exact error Bun.spawn raises when a single argument is too long. */
function e2bigError(): Error {
  const error = new Error('spawn bunx E2BIG: argument list too long') as Error & { code: string };
  error.code = 'E2BIG';
  return error;
}

describe('#789 -- a 200 KB diff reaches the model intact', () => {
  test('the full diff is delivered to the model seam and yields a real verdict', async () => {
    let observedPrompt = '';
    const result = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async (_binary, prompt) => {
          observedPrompt = prompt;
          return { exitCode: 0, timedOut: false, stdout: verdictJson() };
        },
      })
    );

    // The whole diff arrived -- not truncated to fit an argument limit.
    expect(observedPrompt).toContain(LARGE_DIFF);
    expect(Buffer.byteLength(observedPrompt, 'utf8')).toBeGreaterThan(131_072);
    // And it produced a REAL verdict, not the INDETERMINATE the bug produced.
    expect(result.verdict).toBe('APPROVE');
    expect(result.error).toBeUndefined();
  });
});

describe('#789 -- E2BIG defers instead of blocking the PR', () => {
  test('an E2BIG from every rung yields TRANSPORT_ERROR, not INDETERMINATE', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({
        ladder: ['codex', 'grok'],
        invokeModel: async () => {
          throw e2bigError();
        },
      })
    );

    expect(result.verdict).toBe('TRANSPORT_ERROR');
    expect(result.findings).toEqual([]);
    expect(reviewErrorCode(result.error)).toBe('model_error');
    expect(result.retry_after_ms).toBeGreaterThan(0);
  });

  test('a timeout on every rung also defers rather than judging', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({ invokeModel: async () => ({ exitCode: 124, timedOut: true, stdout: '' }) })
    );

    expect(result.verdict).toBe('TRANSPORT_ERROR');
    expect(reviewErrorCode(result.error)).toBe('model_timeout');
  });

  test('a later rung succeeding after an E2BIG still produces a real verdict', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({
        ladder: ['codex', 'grok'],
        invokeModel: async binary => {
          if (binary === 'codex') throw e2bigError();
          return { exitCode: 0, timedOut: false, stdout: verdictJson() };
        },
      })
    );

    expect(result.verdict).toBe('APPROVE');
  });

  test('a judgment failure is still terminal -- unparseable output stays INDETERMINATE', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({ invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: 'not json' }) })
    );

    // An unrecognized failure must NOT become an endless deferral loop.
    expect(result.verdict).toBe('INDETERMINATE');
    expect(reviewErrorCode(result.error)).toBe('model_output_invalid');
  });
});

describe('#789 -- a reached rung makes the failure terminal, not a deferral', () => {
  test('codex ENOENT then grok invalid output is INDETERMINATE, not TRANSPORT_ERROR', async () => {
    // Review finding (Overseer, PR #790): a permanently dead first rung used to
    // dominate a later rung that actually ran, so a genuine judgment failure
    // was classified as transport and retried forever instead of posting a
    // verdict.
    const result = await evaluatePullRequest(
      input,
      deps({
        ladder: ['codex', 'grok'],
        invokeModel: async binary => {
          if (binary === 'codex') {
            const error = new Error('spawn codex ENOENT') as Error & { code: string };
            error.code = 'ENOENT';
            throw error;
          }
          return { exitCode: 0, timedOut: false, stdout: 'not json' };
        },
      })
    );

    expect(result.verdict).toBe('INDETERMINATE');
    expect(reviewErrorCode(result.error)).toBe('model_output_invalid');
    expect(result.retry_after_ms).toBeUndefined();
  });

  test('a dead rung before a nonzero-exit rung is also terminal', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({
        ladder: ['codex', 'grok'],
        invokeModel: async binary => {
          if (binary === 'codex') throw e2bigError();
          return { exitCode: 3, timedOut: false, stdout: 'refused' };
        },
      })
    );

    expect(result.verdict).toBe('INDETERMINATE');
    expect(reviewErrorCode(result.error)).toBe('model_exit_nonzero');
  });

  test('a dead rung followed by a timed-out rung still defers -- neither was reached', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({
        ladder: ['codex', 'grok'],
        invokeModel: async binary => {
          if (binary === 'codex') throw e2bigError();
          return { exitCode: 124, timedOut: true, stdout: '' };
        },
      })
    );

    expect(result.verdict).toBe('TRANSPORT_ERROR');
    // The FIRST transport failure is reported, and it is still a deferral
    // because no rung ever returned anything to judge.
    expect(reviewErrorCode(result.error)).toBe('model_error');
  });
});

describe('#789 -- the timeout bounds stdin delivery, not just model thinking', () => {
  /** Linux pipe buffer; a write past this blocks until the child reads. */
  const PIPE_BUFFER = 64 * 1024;
  const OVERSIZED_PROMPT = 'x'.repeat(200_000);

  /**
   * A child that STARTS but never READS stdin -- the deadlock case. Its writer
   * resolves until the pipe buffer fills, then parks forever, exactly as a real
   * pipe back-pressures. `exited` never settles on its own either, so the only
   * thing that can end the call is the wall clock.
   */
  function nonConsumingChild(): ReviewModelChild & {
    killed: boolean;
    destroyed: boolean;
    written: number;
  } {
    let buffered = 0;
    const child = {
      killed: false,
      destroyed: false,
      written: 0,
      stdin: {
        async write(chunk: string): Promise<number> {
          child.written += chunk.length;
          buffered += chunk.length;
          if (buffered <= PIPE_BUFFER) return chunk.length;
          // Pipe full and nobody reading: park until the writer is destroyed.
          return new Promise<number>((resolve, reject) => {
            pendingWrite = { resolve, reject };
          });
        },
        async end(): Promise<void> {},
        destroy(): void {
          child.destroyed = true;
          // A destroyed writer must settle the parked write, or the awaiting
          // caller hangs even after the child is killed.
          pendingWrite?.reject(new Error('EPIPE: write after destroy'));
          pendingWrite = undefined;
        },
      },
      stdout: null,
      stderr: null,
      exited: new Promise<number>(() => {}), // never exits on its own
      kill(): void {
        child.killed = true;
      },
    };
    let pendingWrite: { resolve: (n: number) => void; reject: (e: Error) => void } | undefined;
    return child;
  }

  test('a child that never reads stdin still times out within the wall clock', async () => {
    const child = nonConsumingChild();
    const started = Date.now();

    const result = await runReviewModelProcess(
      { argv: ['codex'], stdinPrompt: OVERSIZED_PROMPT },
      'codex',
      250,
      () => child
    );

    // Before the fix this never returned: the timer was armed only AFTER
    // `await stdin.end()`, which parked on the full pipe forever.
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The child is killed AND the writer torn down, so the parked write settles.
    expect(child.killed).toBe(true);
    expect(child.destroyed).toBe(true);
    // The prompt genuinely exceeded the pipe buffer -- otherwise the write
    // would never have blocked and this test would prove nothing.
    expect(child.written).toBeGreaterThan(PIPE_BUFFER);
  });

  test('a child that exits early mid-write leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
      event.preventDefault?.();
    };
    // Bun surfaces unhandled rejections on the global; a leaked EPIPE here
    // would crash the review worker in production.
    globalThis.addEventListener?.('unhandledrejection', onUnhandled as EventListener);
    try {
      let rejectWrite: ((error: Error) => void) | undefined;
      const child: ReviewModelChild = {
        stdin: {
          write: (): Promise<number> =>
            new Promise<number>((_resolve, reject) => {
              rejectWrite = reject;
            }),
          end: async (): Promise<void> => {},
          destroy: (): void => rejectWrite?.(new Error('EPIPE: broken pipe')),
        },
        stdout: null,
        stderr: null,
        // Exits immediately, before the write can finish.
        exited: Promise.resolve(0),
        kill: (): void => {},
      };

      const result = await runReviewModelProcess(
        { argv: ['codex'], stdinPrompt: OVERSIZED_PROMPT },
        'codex',
        5_000,
        () => child
      );

      // The early exit is reported normally, not as a timeout...
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      // ...and the EPIPE from the abandoned write was swallowed.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.removeEventListener?.('unhandledrejection', onUnhandled as EventListener);
    }
  });

  test('a normally-consuming child is unaffected', async () => {
    const child: ReviewModelChild = {
      stdin: {
        write: async (chunk: string): Promise<number> => chunk.length,
        end: async (): Promise<void> => {},
      },
      stdout: new Response(verdictJson()).body,
      stderr: null,
      exited: Promise.resolve(0),
      kill: (): void => {},
    };

    const result = await runReviewModelProcess(
      { argv: ['codex'], stdinPrompt: OVERSIZED_PROMPT },
      'grok',
      5_000,
      () => child
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('APPROVE');
  });
});

describe('#789 -- the prompt file is not world-readable', () => {
  test('grok prompts live in a 0700 dir as a 0600 file, removed after the run', async () => {
    const transport = await buildReviewModelTransport('grok', 'private diff contents');
    expect(transport.promptFile).toBeDefined();
    expect(transport.promptDir).toBeDefined();
    // The prompt travels as a short PATH argument, never as the prompt itself.
    expect(transport.argv).toEqual(['grok', '--prompt-file', transport.promptFile!]);
    expect(await Bun.file(transport.promptFile!).text()).toBe('private diff contents');

    // Unix permission bits are not implemented on Windows, where the mode is
    // synthesized -- assert them only where they are real.
    if (process.platform !== 'win32') {
      const fileMode = (await stat(transport.promptFile!)).mode & 0o777;
      const dirMode = (await stat(transport.promptDir!)).mode & 0o777;
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
      // Explicitly: no group or other access to either.
      expect(fileMode & 0o077).toBe(0);
      expect(dirMode & 0o077).toBe(0);
    }

    await rm(transport.promptDir!, { recursive: true, force: true });
  });

  test('codex uses stdin and writes no prompt file at all', async () => {
    const transport = await buildReviewModelTransport('codex', 'private diff contents');
    expect(transport.stdinPrompt).toBe('private diff contents');
    expect(transport.promptFile).toBeUndefined();
    expect(transport.promptDir).toBeUndefined();
    // The prompt is absent from argv -- the whole point of the fix.
    expect(transport.argv.join(' ')).not.toContain('private diff contents');
  });

  test('two concurrent prompts never share a path', async () => {
    const [a, b] = await Promise.all([
      buildReviewModelTransport('grok', 'a'),
      buildReviewModelTransport('grok', 'b'),
    ]);
    expect(a.promptDir).not.toBe(b.promptDir);
    expect(await Bun.file(a.promptFile!).text()).toBe('a');
    expect(await Bun.file(b.promptFile!).text()).toBe('b');
    await rm(a.promptDir!, { recursive: true, force: true });
    await rm(b.promptDir!, { recursive: true, force: true });
  });
});

describe('#789 -- transport classification is conservative', () => {
  test('recognizes spawn-class failures', () => {
    expect(isTransportError(e2bigError())).toBe(true);
    expect(isTransportError(new Error('spawn ENOENT'))).toBe(true);
    expect(isTransportError(new Error('argument list too long'))).toBe(true);
  });

  test('does not treat a judgment or auth failure as transport', () => {
    expect(isTransportError(new Error('model refused the request'))).toBe(false);
    expect(isTransportError(new Error('401 unauthorized'))).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
  });
});

describe('#789 -- the posted summary names the code and leaks nothing', () => {
  test('appends the reason code to the INDETERMINATE summary', () => {
    const summary = buildIndeterminateSummary('model_output_invalid:grok');
    expect(summary).toContain('could not reach a determinate verdict');
    expect(summary).toContain('model_output_invalid');
  });

  test('never carries the detail half of the error', () => {
    const secret = 'model_error:token=super-secret-provider-detail';
    const summary = buildIndeterminateSummary(secret);
    expect(summary).toContain('model_error');
    expect(summary).not.toContain('super-secret');
    expect(summary).not.toContain('token=');
    expect(summary).not.toContain(secret);
  });

  test('a malformed error contributes no code at all', () => {
    expect(reviewErrorCode('no-colon-but-hyphens-and-spaces here')).toBeNull();
    expect(reviewErrorCode('  ')).toBeNull();
    expect(reviewErrorCode(undefined)).toBeNull();
    expect(buildIndeterminateSummary('Bearer ghp_realtokenvalue')).not.toContain('ghp_');
  });
});

describe('#789 -- the judge timeout is configurable', () => {
  test('defaults to 60s and honours OVERSEER_REVIEW_MODEL_TIMEOUT_MS', () => {
    expect(resolveReviewModelTimeoutMs({})).toBe(DEFAULT_REVIEW_MODEL_TIMEOUT_MS);
    expect(resolveReviewModelTimeoutMs({ OVERSEER_REVIEW_MODEL_TIMEOUT_MS: '180000' })).toBe(
      180_000
    );
    // Junk and non-positive values fall back rather than disabling the wall.
    expect(resolveReviewModelTimeoutMs({ OVERSEER_REVIEW_MODEL_TIMEOUT_MS: 'soon' })).toBe(
      DEFAULT_REVIEW_MODEL_TIMEOUT_MS
    );
    expect(resolveReviewModelTimeoutMs({ OVERSEER_REVIEW_MODEL_TIMEOUT_MS: '0' })).toBe(
      DEFAULT_REVIEW_MODEL_TIMEOUT_MS
    );
  });
});

describe('#789 -- submit defers a transport error instead of posting', () => {
  const work: ReviewWorkItem = {
    correlationId: 'correlation-789',
    messageId: 'message-789',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    prNumber: 776,
    headSha: HEAD,
    author: 'contributor',
  };

  function submitDeps(overrides: Partial<SubmitDeps> = {}): {
    deps: SubmitDeps;
    submitted: unknown[];
    receipts: unknown[];
  } {
    const submitted: unknown[] = [];
    const receipts: unknown[] = [];
    const base: SubmitDeps = {
      reviewerIdentity: 'thinman-overseer[bot]',
      runReviewer: async () => ({
        approved: false,
        summary: '',
        reviewedHeadSha: HEAD,
        transportError: true,
        reasonCode: 'model_error',
        retryAfterMs: 60_000,
      }),
      submitReview: async submission => {
        submitted.push(submission);
        return { submitted: true };
      },
      currentHeadSha: async () => HEAD,
      recordReceipt: async receipt => {
        receipts.push(receipt);
      },
      ...overrides,
    };
    return { deps: base, submitted, receipts };
  }

  test('posts no review and reports transport_error with the reason code', async () => {
    const { deps: submit, submitted, receipts } = submitDeps();
    const outcome = await runAndSubmitReview(work, submit);

    expect(outcome.disposition).toBe('transport_error');
    expect(outcome.reason).toBe('review_transport_error:model_error');
    expect(outcome.retryAfterMs).toBe(60_000);
    // Nothing was posted to GitHub -- the PR is not blocked by a review that
    // never happened.
    expect(submitted).toHaveLength(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ disposition: 'transport_error' });
  });

  test('the receipt reason carries no error detail', async () => {
    const { deps: submit } = submitDeps({
      runReviewer: async () => ({
        approved: false,
        summary: '',
        reviewedHeadSha: HEAD,
        transportError: true,
        reasonCode: 'model_error',
      }),
    });
    const outcome = await runAndSubmitReview(work, submit);

    expect(outcome.reason).not.toContain('E2BIG:');
    expect(outcome.reason).not.toContain('token');
  });

  test('a transport error is classified before the stale-head gate', async () => {
    // Nothing was evaluated, so `reviewedHeadSha` is meaningless here. It must
    // not be misreported as stale_head, which is a TERMINAL disposition.
    const { deps: submit } = submitDeps({
      runReviewer: async () => ({
        approved: false,
        summary: '',
        reviewedHeadSha: '',
        transportError: true,
        reasonCode: 'model_timeout',
      }),
    });
    const outcome = await runAndSubmitReview(work, submit);

    expect(outcome.disposition).toBe('transport_error');
  });
});
