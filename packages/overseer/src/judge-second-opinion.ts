import type { GrokDispositionReceipt, GrokJudgeEvidence } from './types.ts';
import { recordSpawnOutcome } from './model-resource-health.js';
import { createLogger } from '@archon/paths';

const log = createLogger('overseer/judge-second-opinion');

const DEFAULT_TIMEOUT_MS = 60_000;

interface GrokSpawnResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

interface JudgeWithGrokOptions {
  timeoutMs?: number;
  spawn?: (prompt: string) => Promise<GrokSpawnResult>;
  recordOutcome?: typeof recordSpawnOutcome;
}

export function parseGrokVerdict(stdout: string): 'approve' | 'hold' {
  const match = /^VERDICT:\s*(APPROVE|HOLD)\s*$/.exec(stdout.trim());
  return match?.[1] === 'APPROVE' ? 'approve' : 'hold';
}

export async function judgeWithGrok(
  evidence: GrokJudgeEvidence,
  options: JudgeWithGrokOptions = {}
): Promise<GrokDispositionReceipt> {
  const prompt = buildGrokPrompt(evidence);
  const spawn =
    options.spawn ??
    ((input: string): Promise<GrokSpawnResult> =>
      spawnGrok(input, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const binary = secondOpinionBinary();
  let spawnReturned = false;

  try {
    const result = await spawn(prompt);
    spawnReturned = true;
    try {
      await (options.recordOutcome ?? recordSpawnOutcome)(binary, result, 'judge-second-opinion');
    } catch (error) {
      log.error(
        { binary, err: error as Error },
        'overseer.judge_second_opinion.resource_health_record_failed'
      );
    }
    if (result.timedOut) return receipt(evidence, 'hold', 'judge_timeout');
    if (result.exitCode !== 0) return receipt(evidence, 'hold', 'judge_exit_nonzero');
    const verdict = parseGrokVerdict(result.stdout);
    if (verdict === 'approve') return receipt(evidence, 'approve', 'judge_approve');
    if (/^VERDICT:\s*HOLD\s*$/.test(result.stdout.trim())) {
      return receipt(evidence, 'hold', 'judge_hold');
    }
    return receipt(evidence, 'hold', 'judge_output_invalid');
  } catch (error) {
    if (!spawnReturned) {
      try {
        await (options.recordOutcome ?? recordSpawnOutcome)(
          binary,
          { exitCode: -1, timedOut: false },
          'judge-second-opinion'
        );
      } catch (recordError) {
        log.error(
          { binary, err: recordError as Error },
          'overseer.judge_second_opinion.resource_health_record_failed'
        );
      }
    }
    log.error({ binary, err: error as Error }, 'overseer.judge_second_opinion.spawn_failed');
    return receipt(evidence, 'hold', 'judge_error');
  }
}

function receipt(
  evidence: GrokJudgeEvidence,
  disposition: GrokDispositionReceipt['disposition'],
  reason: GrokDispositionReceipt['reason']
): GrokDispositionReceipt {
  return {
    schemaVersion: 'overseer-grok-merge-disposition-v1',
    disposition,
    reason,
    woId: evidence.woId,
    prNumber: evidence.prNumber,
    headSha: evidence.headSha,
    baseSha: evidence.baseSha,
    evidenceDigest: evidence.evidenceDigest,
    operator: evidence.operator,
  };
}

function buildGrokPrompt(evidence: GrokJudgeEvidence): string {
  // 16th canary defect (2026-08-26): the original prompt gave the judge NO
  // criteria -- just APPROVE-or-HOLD with 'HOLD means an operator should
  // review'. A reasoning model at temperature answered that invitation
  // non-deterministically: identical evidence flipped between APPROVE and
  // HOLD across calls, and the merge gate coin-flipped closed. The judge's
  // only unique duty is the SMELL TEST -- every hard rule (green checks,
  // approval on the exact head, base wall, mergeability) is enforced by the
  // deterministic gates around it. So the prompt now states the contract:
  // approve unless a NAMED red flag is present.
  return [
    'You are the merge disposition judge for the BDC Overseer.',
    'Return exactly one verdict line: VERDICT: APPROVE or VERDICT: HOLD.',
    'Your APPROVE only advances the candidate to deterministic gates that independently verify green checks, review approval on the exact head SHA, and branch rules; it never performs a merge itself.',
    'Default to APPROVE. Return HOLD only if a specific red flag is present in the evidence below, and only these count as red flags:',
    '- any failed or pending check',
    '- zero files changed',
    '- the PR title clearly unrelated to the WO id',
    '- a diff scale wildly inconsistent with the WO (e.g. thousands of files for a docs WO)',
    'Absence of optional detail (empty diff stat, unknown conclusion) is NOT a red flag -- the deterministic gates own completeness.',
    '',
    `WO: ${evidence.woId}`,
    `PR: #${evidence.prNumber} ${evidence.prTitle}`,
    `Head SHA: ${evidence.headSha}`,
    `Base SHA: ${evidence.baseSha}`,
    `Evidence digest: ${evidence.evidenceDigest}`,
    `Operator: ${evidence.operator.identity} provider=${evidence.operator.provider} model_family=${evidence.operator.modelFamily}`,
    `Checks: total=${evidence.checksSummary.total}, passed=${evidence.checksSummary.passed}, failed=${evidence.checksSummary.failed}, pending=${evidence.checksSummary.pending}, conclusion=${evidence.checksSummary.conclusion ?? 'unknown'}`,
    `Files changed: ${evidence.filesChangedCount}`,
    `Diff stat: ${evidence.diffStat}`,
  ].join('\n');
}

/**
 * Binary selection mirrors the primary judge ladder's env knob
 * (OVERSEER_JUDGE_LADDER, judge-first.ts) rather than duplicating a second
 * independent config surface. 13th canary defect (2026-08-26): this
 * second-opinion gate is a SEPARATE spawn site from the primary judge and
 * stayed hardcoded to 'grok' after #716 gave the primary judge a codex
 * fallback -- CANARY-02 got a real merge_candidate verdict from the primary
 * judge, then died here on grok's exit 1 (xAI credits exhausted) with no
 * fallback. Reads the SAME env var so one flip recovers both sites.
 */
function secondOpinionBinary(): string {
  const raw = process.env.OVERSEER_JUDGE_LADDER ?? 'grok';
  const first = raw.split(',')[0]?.trim();
  return first && first.length > 0 ? first : 'grok';
}

/**
 * Reduce a CLI wrapper's stdout to the model's own answer before parsing.
 *
 * 14th canary defect (2026-08-26): `bunx @openai/codex exec` wraps the answer
 * in echoed prompt text, a bubblewrap warning, and trailing token accounting.
 * parseGrokVerdict deliberately demands the WHOLE output be a bare verdict
 * line -- that strictness is a prompt-injection guard (an APPROVE followed by
 * trailing instructions must yield HOLD) and must NOT be loosened. So the
 * wrapper framing is stripped HERE, where we know the exact shape we invoked,
 * and the parser keeps judging a clean payload as strictly as ever.
 *
 * codex exec emits the answer after a lone `codex` marker line and stops at
 * `tokens used`. Anything unexpected falls through unchanged, so an
 * unrecognized shape still fails closed at the parser.
 */
export function normalizeWrapperStdout(binary: string, stdout: string): string {
  if (binary !== 'codex') return stdout;
  const lines = stdout.split(/\r?\n/);
  const start = lines.lastIndexOf('codex');
  if (start === -1) return stdout;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^tokens used/i.test(line.trim()));
  const body = end === -1 ? rest : rest.slice(0, end);
  return body.join('\n').trim();
}

async function spawnGrok(prompt: string, timeoutMs: number): Promise<GrokSpawnResult> {
  const binary = secondOpinionBinary();
  const argv =
    binary === 'codex'
      ? ['bunx', '@openai/codex', 'exec', '--skip-git-repo-check', prompt]
      : [binary, '-p', prompt];
  const subprocess = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timeout: Timer | undefined;
  const timeoutResult = new Promise<GrokSpawnResult>(resolve => {
    timeout = setTimeout(() => {
      subprocess.kill();
      resolve({ exitCode: 124, stdout: '', timedOut: true });
    }, timeoutMs);
  });

  const processResult = (async (): Promise<GrokSpawnResult> => {
    // Capture BOTH streams. 15th canary defect (2026-08-26): with no TTY,
    // `bunx @openai/codex exec` writes its ENTIRE output -- verdict included
    // -- to stderr; stdout arrives empty with exit 0, so every judgment
    // parsed as HOLD. (Shell repros hid this behind 2>&1.) stdout wins when
    // non-empty; stderr is the fallback payload, run through the same
    // normalizer + strict parser, so fail-closed semantics are unchanged.
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    const payload = stdout.trim().length > 0 ? stdout : stderr;
    return { exitCode, stdout: normalizeWrapperStdout(binary, payload), timedOut: false };
  })();

  const result = await Promise.race([processResult, timeoutResult]);
  if (timeout) clearTimeout(timeout);
  return result;
}
