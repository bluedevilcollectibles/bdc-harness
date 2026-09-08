/**
 * #798 -- the INDETERMINATE reason must survive to somewhere a human reads it.
 *
 * Before this, `evaluatePullRequest` computed a precise reason
 * (`model_timeout:codex`, `model_output_invalid:grok`, `reviewed_head_mismatch`)
 * and `createRealSubmitDeps.runReviewer` threw it away. Three INDETERMINATE
 * verdicts on 2026-09-08 (#777 twice, #790 once) were undiagnosable: the PR body
 * carried a fixed sentence, the receipt carried only a disposition, and nothing
 * was logged, so nobody could tell a timed-out judge from an unparseable answer.
 *
 * Three surfaces, three audiences, three redaction levels -- that split is what
 * these tests pin:
 *   PUBLIC PR body -> the code, plus a binary name when the suffix IS one.
 *   OPERATOR receipt -> the full reason and the judge's stderr tail.
 *   OPERATOR log     -> one structured line per evaluation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rootLogger } from '@archon/paths';
import {
  buildIndeterminateSummary,
  createRealSubmitDeps,
  publicReviewReason,
} from '../pr-review-wiring.ts';
import { runAndSubmitReview } from '../pr-review-submit.ts';
import type { ReviewerVerdict, SubmitDeps } from '../pr-review-submit.ts';
import {
  MAX_JUDGE_STDERR_BYTES,
  evaluatePullRequest,
  runReviewModelProcess,
} from '../pr-review-evaluator.ts';
import type {
  PrReviewDeps,
  PrReviewInput,
  PrReviewResult,
  ReviewModelChild,
} from '../pr-review-evaluator.ts';
import type { RealGitHubOctokitLike } from '../adapters/github-real-deps.ts';

const HEAD = 'a'.repeat(40);

// Log capture: the same pino-destination swap judge-first.test.ts uses. The
// structured line is a DELIVERABLE of #798, not incidental output, so it is
// asserted on rather than trusted.
interface LogDestination {
  write(chunk: string): unknown;
}

const loggerStreamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
  symbol => String(symbol) === 'Symbol(pino.stream)'
)!;
const loggerDestination = (rootLogger as unknown as Record<symbol, LogDestination>)[
  loggerStreamSymbol
];
const originalLogWrite = loggerDestination.write.bind(loggerDestination);

afterEach(() => {
  loggerDestination.write = originalLogWrite;
});

function captureLogOutput(): string[] {
  const chunks: string[] = [];
  loggerDestination.write = (chunk: string): boolean => {
    chunks.push(chunk);
    return true;
  };
  return chunks;
}

const work = {
  correlationId: 'pr-review:thinmansoftware/bdc-harness#42@' + HEAD,
  messageId: 'message-1',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 42,
  headSha: HEAD,
  author: 'contributor',
};

function submitOctokit(): RealGitHubOctokitLike {
  return {
    pulls: {
      get: async () => ({ data: { head: { sha: HEAD } } }),
      createReview: async () => ({ data: { id: 1, state: 'CHANGES_REQUESTED' } }),
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

const evaluatorInput: PrReviewInput = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  pr_number: 42,
  head_sha: HEAD,
};

function evaluatorDeps(overrides: Partial<PrReviewDeps> = {}): PrReviewDeps {
  return {
    reviewer: { provider: 'test-provider', model: 'codex' },
    fetchEvidence: async () => ({
      diff: '+ a change',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    }),
    fetchAcceptanceCriteria: async () => null,
    invokeModel: async () => ({ exitCode: 0, stdout: '', timedOut: true }),
    ladder: ['codex'],
    ...overrides,
  };
}

describe('#798 -- the reason reaches the review body', () => {
  test('an INDETERMINATE body states the reason, naming the judge that timed out', () => {
    const summary = buildIndeterminateSummary('model_timeout:codex');
    // The stop condition verbatim: the author of the PR can read WHICH judge
    // failed and HOW, not just that "something" was indeterminate.
    expect(summary).toContain('Reason: model_timeout:codex');
    expect(summary).toContain('could not reach a determinate verdict');
  });

  test('the naming is limited to codes whose suffix IS a ladder binary', () => {
    expect(publicReviewReason('model_exit_nonzero:grok')).toBe('model_exit_nonzero:grok');
    expect(publicReviewReason('model_output_invalid:codex')).toBe('model_output_invalid:codex');
    // evidence_error and model_error carry API/exception text this code did not
    // construct. They degrade to the bare code -- never the detail half.
    expect(publicReviewReason('model_error:token=super-secret')).toBe('model_error');
    expect(publicReviewReason('evidence_error:Bad credentials for ghp_xxx')).toBe('evidence_error');
  });

  test('a hostile suffix on a binary-suffix code cannot smuggle text into the body', () => {
    // A binary name is a short identifier. Anything else -- spaces, an embedded
    // token, a newline -- fails the charset test and falls back to the code.
    const summary = buildIndeterminateSummary('model_timeout:codex ghp_realtokenvalue here');
    expect(summary).not.toContain('ghp_realtokenvalue');
    expect(summary).toContain('Reason: model_timeout');
  });

  test('an unparseable error still yields a body, with no Reason detail invented', () => {
    const summary = buildIndeterminateSummary(undefined);
    expect(summary).not.toContain('Reason:');
    expect(summary).toContain('could not reach a determinate verdict');
  });
});

describe('#798 -- the reason reaches the submit receipt', () => {
  /** Captures the receipt the submit path writes, which is the operator record. */
  function capturingSubmitDeps(verdict: ReviewerVerdict): {
    deps: SubmitDeps;
    receipts: Record<string, unknown>[];
  } {
    const receipts: Record<string, unknown>[] = [];
    return {
      receipts,
      deps: {
        reviewerIdentity: 'review-app[bot]',
        runReviewer: async () => verdict,
        submitReview: async () => ({ submitted: true }),
        currentHeadSha: async () => HEAD,
        recordReceipt: async input => {
          receipts.push(input as unknown as Record<string, unknown>);
        },
      },
    };
  }

  test('the receipt for an INDETERMINATE result carries reason model_timeout:codex', async () => {
    const { deps, receipts } = capturingSubmitDeps({
      approved: false,
      summary: buildIndeterminateSummary('model_timeout:codex'),
      reviewedHeadSha: HEAD,
      reasonDetail: 'model_timeout:codex',
      ladderTried: ['codex', 'grok'],
    });

    const outcome = await runAndSubmitReview(work, deps);

    expect(outcome.disposition).toBe('changes_requested');
    expect(receipts).toHaveLength(1);
    // The stop condition: an operator draining the dispatch inbox sees the
    // reason without reading source or correlating container logs by hand.
    expect(receipts[0]?.reasonDetail).toBe('model_timeout:codex');
    expect(receipts[0]?.ladderTried).toEqual(['codex', 'grok']);
  });

  test('the judge stderr tail rides the receipt and never the PR body', async () => {
    const stderr = 'codex: fatal: provider returned 500 (internal)';
    let postedBody = '';
    const { deps, receipts } = capturingSubmitDeps({
      approved: false,
      summary: buildIndeterminateSummary('model_exit_nonzero:codex'),
      reviewedHeadSha: HEAD,
      reasonDetail: 'model_exit_nonzero:codex',
      judgeStderr: { codex: stderr },
    });
    deps.submitReview = async input => {
      postedBody = input.body;
      return { submitted: true };
    };

    await runAndSubmitReview(work, deps);

    expect(receipts[0]?.judgeStderr).toEqual({ codex: stderr });
    // The whole point of the operator/public split: stderr is diagnostic gold
    // and also the most likely place a failing CLI echoes a credential.
    expect(postedBody).not.toContain('provider returned 500');
    expect(postedBody).toContain('Reason: model_exit_nonzero:codex');
  });

  test('a verdict carrying no diagnostics writes the pre-#798 receipt shape', async () => {
    const { deps, receipts } = capturingSubmitDeps({
      approved: true,
      summary: 'No blocking findings.',
      reviewedHeadSha: HEAD,
    });

    await runAndSubmitReview(work, deps);

    expect(receipts[0]).not.toHaveProperty('reasonDetail');
    expect(receipts[0]).not.toHaveProperty('judgeStderr');
    expect(receipts[0]).not.toHaveProperty('ladderTried');
  });
});

describe('#798 -- the wiring forwards what the evaluator found', () => {
  test('runReviewer carries the evaluator error and stderr onto the verdict', async () => {
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      evaluate: async () =>
        reviewResult({
          verdict: 'INDETERMINATE',
          error: 'model_timeout:codex',
          ladder_tried: ['codex'],
          duration_ms: 61_000,
          judge_stderr: { codex: 'thinking...' },
        }),
    });

    const verdict = await deps.runReviewer(work);

    expect(verdict.reasonDetail).toBe('model_timeout:codex');
    expect(verdict.judgeStderr).toEqual({ codex: 'thinking...' });
    expect(verdict.ladderTried).toEqual(['codex']);
    expect(verdict.summary).toContain('Reason: model_timeout:codex');
  });

  test('a deferral verdict forwards its reason too, so a silent defer is diagnosable', async () => {
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      patOctokit: null,
      evaluate: async () =>
        reviewResult({
          verdict: 'TRANSPORT_ERROR',
          error: 'model_error:E2BIG argument list too long',
          retry_after_ms: 60_000,
          ladder_tried: ['codex', 'grok'],
        }),
    });

    const verdict = await deps.runReviewer(work);

    expect(verdict.transportError).toBe(true);
    expect(verdict.reasonDetail).toBe('model_error:E2BIG argument list too long');
    expect(verdict.ladderTried).toEqual(['codex', 'grok']);
  });
});

describe('#798 -- one structured log line per evaluation', () => {
  test('emits overseer_pr_review_verdict with the verdict, reason and ladder', async () => {
    const logs = captureLogOutput();
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      evaluate: async () =>
        reviewResult({
          verdict: 'INDETERMINATE',
          error: 'model_timeout:codex',
          ladder_tried: ['codex', 'grok'],
          duration_ms: 61_000,
          judge_stderr: { codex: 'timed out' },
        }),
    });

    await deps.runReviewer(work);

    const line = logs
      .map(chunk => JSON.parse(chunk) as Record<string, unknown>)
      .find(entry => entry.msg === 'overseer_pr_review_verdict');
    expect(line).toBeDefined();
    expect(line?.correlationId).toBe(work.correlationId);
    expect(line?.verdict).toBe('INDETERMINATE');
    // The FULL reason is safe in a container log -- that is the operator
    // surface. Only the PR body gets the redacted form.
    expect(line?.reason).toBe('model_timeout:codex');
    expect(line?.ladderTried).toEqual(['codex', 'grok']);
    expect(line?.durationMs).toBe(61_000);
    // The stderr TEXT stays out of the log line; only which rungs produced it.
    expect(line?.judgeStderrRungs).toEqual(['codex']);
    expect(JSON.stringify(line)).not.toContain('timed out');
  });

  test('the line is emitted for a deferral too, not only for terminal verdicts', async () => {
    const logs = captureLogOutput();
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      patOctokit: null,
      evaluate: async () => reviewResult({ verdict: 'CHECKS_PENDING', error: 'checks_pending' }),
    });

    await deps.runReviewer(work);

    // A silent defer was the other half of the blind spot: the PR simply sat
    // there with no review and no record of why.
    const line = logs
      .map(chunk => JSON.parse(chunk) as Record<string, unknown>)
      .find(entry => entry.msg === 'overseer_pr_review_verdict');
    expect(line?.verdict).toBe('CHECKS_PENDING');
    expect(line?.reason).toBe('checks_pending');
  });
});

describe('#798 -- the evaluator collects the diagnostics in the first place', () => {
  test('a timed-out ladder reports which rungs were tried and their stderr', async () => {
    const result = await evaluatePullRequest(
      evaluatorInput,
      evaluatorDeps({
        ladder: ['codex', 'grok'],
        invokeModel: async binary => ({
          exitCode: 124,
          stdout: '',
          timedOut: true,
          stderrTail: `${binary} produced no output`,
        }),
      })
    );

    expect(result.verdict).toBe('TRANSPORT_ERROR');
    expect(result.error).toBe('model_timeout:codex');
    expect(result.ladder_tried).toEqual(['codex', 'grok']);
    expect(result.judge_stderr).toEqual({
      codex: 'codex produced no output',
      grok: 'grok produced no output',
    });
    expect(typeof result.duration_ms).toBe('number');
  });

  test('a rung that returns unparseable output has its stderr captured', async () => {
    const result = await evaluatePullRequest(
      evaluatorInput,
      evaluatorDeps({
        ladder: ['codex'],
        invokeModel: async () => ({
          exitCode: 0,
          stdout: 'not json at all',
          timedOut: false,
          stderrTail: 'warning: model refused the schema',
        }),
      })
    );

    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toBe('model_output_invalid:codex');
    expect(result.judge_stderr).toEqual({ codex: 'warning: model refused the schema' });
  });

  test('a successful review carries no stderr map at all', async () => {
    const result = await evaluatePullRequest(
      evaluatorInput,
      evaluatorDeps({
        ladder: ['codex'],
        invokeModel: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: JSON.stringify({
            verdict: 'APPROVE',
            findings: [],
            reviewed_head_sha: HEAD,
          }),
        }),
      })
    );

    expect(result.verdict).toBe('APPROVE');
    expect(result.judge_stderr).toBeUndefined();
  });

  test('the captured stderr is the TAIL, bounded to 2 KB', async () => {
    // A failing CLI prints its usage banner first and the real error last, so
    // the tail is the diagnostic half. Bounding it keeps a runaway judge from
    // writing megabytes into every receipt.
    const huge = 'x'.repeat(MAX_JUDGE_STDERR_BYTES * 3) + 'THE-ACTUAL-ERROR';
    const result = await evaluatePullRequest(
      evaluatorInput,
      evaluatorDeps({
        ladder: ['codex'],
        invokeModel: async () => ({
          exitCode: 3,
          stdout: '',
          timedOut: false,
          stderrTail: huge,
        }),
      })
    );

    const captured = result.judge_stderr?.codex ?? '';
    expect(captured.length).toBe(MAX_JUDGE_STDERR_BYTES);
    expect(captured.endsWith('THE-ACTUAL-ERROR')).toBe(true);
  });
});

describe('#798 -- the process runner surfaces stderr', () => {
  function child(stdout: string, stderr: string, exitCode: number): ReviewModelChild {
    return {
      stdin: null,
      stdout: new Response(stdout).body,
      stderr: new Response(stderr).body,
      exited: Promise.resolve(exitCode),
      kill: () => {},
    };
  }

  test('stderr is reported even when stdout also had content', async () => {
    // The pre-#798 code read stderr ONLY as a stdout fallback, so a rung that
    // printed a diagnostic alongside real output lost it entirely.
    const result = await runReviewModelProcess({ argv: ['judge'] }, 'judge', 1_000, () =>
      child('{"verdict":"APPROVE"}', 'deprecation: --flag is going away', 1)
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('APPROVE');
    expect(result.stderrTail).toBe('deprecation: --flag is going away');
  });

  test('a timeout still reports whatever stderr had arrived before the kill', async () => {
    const result = await runReviewModelProcess({ argv: ['judge'] }, 'judge', 5, () => ({
      stdin: null,
      stdout: new Response('').body,
      stderr: new Response('judge: starting up').body,
      // Never settles on its own -- the wall clock is what ends this call.
      exited: new Promise<number>(() => {}),
      kill: () => {},
    }));

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.stderrTail).toBe('judge: starting up');
  });
});
