/**
 * Judge-first decision core (Motion M-99, WO-HARNESS-OVERSEER-V2-JUDGE-FIRST-01).
 *
 * Every terminal run gets model eyes on a bounded evidence envelope, and every
 * read leaves a row. Thinking is never gated; only DOING is (tier-map.ts).
 *
 * Judge health is FAIL-LOUD (binding term 2): transport death, unparseable
 * output, and missing evidence are distinct operational alarm states with
 * model-ladder retry -- NEVER converted into a semantic verdict. This module
 * deliberately does NOT reuse judge-second-opinion.ts, whose collapse of every
 * failure mode into a cautious-looking HOLD is the defect both design-round
 * seats independently identified as the killer.
 *
 * Cost containment (design round, binding): bounded envelope (fixed schema,
 * capped event tail), terminal-only judging, and claim-before-call idempotency
 * (db layer).
 */

import { createHash } from 'crypto';
import { createLogger } from '@archon/paths';
import type { OverseerWorkflowEvent, PullRequestEvidence, WatchedRunRecord } from './types.ts';
import { recordSpawnOutcome } from './model-resource-health.js';

const log = createLogger('overseer/judge-first');

const DEFAULT_TIMEOUT_MS = 120_000;
const EVENT_TAIL_LIMIT = 20;
const EVENT_MESSAGE_CAP = 400;

export const SEMANTIC_VERDICTS = [
  'healthy',
  'merge_candidate',
  'failed_genuine',
  'duplicate_work',
  'needs_human',
  'observe',
] as const;
export type SemanticVerdict = (typeof SEMANTIC_VERDICTS)[number];

export type JudgeHealthState =
  | 'judge_unavailable'
  | 'judge_invalid_output'
  | 'evidence_unavailable';

export interface JudgeEvidenceEnvelope {
  runId: string;
  woId: string;
  status: string;
  repository: string;
  headBranch: string | null;
  headSha: string;
  pr: {
    exists: boolean;
    state: string;
    mergeable: boolean | null;
    lookupFailed: boolean;
    checks: PullRequestEvidence['checks'];
    url: string | null;
  };
  /** Classifier output, demoted to advisory hint fields (binding term: no gate). */
  hint: { action: string; errorClass: string | null; reason: string };
  eventTail: { type: string; step: string | null; at: string; message: string }[];
}

export interface JudgeVerdictOutcome {
  kind: 'verdict';
  verdict: SemanticVerdict;
  confidence: number;
  proposedAction: string;
  proposedTier: number;
  reason: string;
  model: string;
  modelRung: number;
}

export interface JudgeAlarmOutcome {
  kind: JudgeHealthState;
  reason: string;
  model?: string;
  modelRung?: number;
}

export type JudgeOutcome = JudgeVerdictOutcome | JudgeAlarmOutcome;

export interface JudgeSpawnResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

export interface JudgeFirstOptions {
  /** Ladder rung binaries, cheapest first. Default: env OVERSEER_JUDGE_LADDER or ['grok']. */
  ladder?: string[];
  timeoutMs?: number;
  spawn?: (binary: string, prompt: string) => Promise<JudgeSpawnResult>;
  recordOutcome?: typeof recordSpawnOutcome;
}

export function defaultJudgeLadder(): string[] {
  const raw = process.env.OVERSEER_JUDGE_LADDER ?? 'grok';
  const rungs = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return rungs.length > 0 ? rungs : ['grok'];
}

function truncate(value: string, cap: number): string {
  return value.length > cap ? `${value.slice(0, cap)}...` : value;
}

function eventMessage(data: Record<string, unknown>): string {
  const candidates = [data.error, data.message, data.stderr, data.output, data.reason];
  const found = candidates.find(value => typeof value === 'string' && value.trim());
  if (typeof found === 'string') return found;
  try {
    return JSON.stringify(data);
  } catch {
    return '[unserializable event data]';
  }
}

/**
 * Build the bounded evidence envelope. Fixed schema, last N events, truncated
 * messages -- never a full transcript dump (cost containment is load-bearing).
 */
export function buildEvidenceEnvelope(
  record: WatchedRunRecord,
  events: OverseerWorkflowEvent[]
): JudgeEvidenceEnvelope {
  const tail = events.slice(-EVENT_TAIL_LIMIT).map(event => ({
    type: event.event_type,
    step: event.step_name,
    at: event.created_at ?? '',
    message: truncate(eventMessage(event.data), EVENT_MESSAGE_CAP),
  }));
  return {
    runId: record.runId,
    woId: record.woId,
    status: record.status,
    repository: record.owner && record.repo ? `${record.owner}/${record.repo}` : 'unknown',
    headBranch: record.headBranch ?? null,
    headSha: record.prEvidence.headSha ?? '',
    pr: {
      exists: record.prEvidence.exists,
      state: record.prEvidence.state,
      mergeable: record.prEvidence.mergeable,
      lookupFailed: record.prEvidence.lookupFailed ?? false,
      checks: record.prEvidence.checks,
      url: record.prEvidence.htmlUrl ?? null,
    },
    hint: {
      action: record.action,
      errorClass: record.errorClass ?? null,
      reason: record.reason,
    },
    eventTail: tail,
  };
}

export function envelopeDigest(envelope: JudgeEvidenceEnvelope): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

export function buildJudgePrompt(envelope: JudgeEvidenceEnvelope): string {
  return [
    'You are the Overseer judge for the BDC Cauldron build harness. A workflow run has',
    'reached a terminal state. Read the evidence holistically and return a verdict.',
    '',
    'Respond with EXACTLY one JSON object and nothing else, using this schema:',
    '{"verdict":"healthy|merge_candidate|failed_genuine|duplicate_work|needs_human|observe",',
    ' "confidence":0.0-1.0,',
    ' "proposed_action":"verdict_write|comment_findings|flag_merge_ready|escalate_with_evidence|none",',
    ' "reason":"one or two sentences citing the load-bearing evidence"}',
    '',
    'Do NOT emit an authority tier. Every action in the list above is a notify-class',
    'action that requires no elevated authority, and the code assigns the required tier',
    'independently. Judge WHAT is true; the tier is not yours to set.',
    '',
    'Guidance: merge_candidate ONLY when a green, open, mergeable PR exists for this',
    'run; failed_genuine when the run failed and no salvageable work exists;',
    'duplicate_work when the evidence shows this WO already has an equivalent open PR;',
    'needs_human when evidence conflicts or the failure shape is unrecognized;',
    'observe/healthy for uneventful terminal runs. The deterministic classifier hint',
    'below is ADVISORY ONLY -- you may contradict it, and say so in reason when you do.',
    '',
    'EVIDENCE ENVELOPE (JSON):',
    JSON.stringify(envelope, null, 2),
  ].join('\n');
}

interface ParsedJudgeVerdict {
  verdict: SemanticVerdict;
  confidence: number;
  proposedAction: string;
  proposedTier: number;
  reason: string;
}

/**
 * Extract the FIRST complete JSON object from stdout by balancing braces.
 *
 * A `lastIndexOf('}')` scan spans everything between the first `{` and the last
 * `}`, which is only correct when exactly one object is present. Grok emits its
 * verdict object TWICE, concatenated (verified 2026-07-30 against the live
 * container: 197 bytes, the same object back to back), so the naive span
 * produced `{...}{...}` -- invalid JSON, and every real verdict was discarded as
 * judge_invalid_output while the model was answering correctly. String-aware so
 * a brace inside `reason` cannot end the scan early.
 */
function firstJsonObject(stdout: string): string | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i += 1) {
    const char = stdout[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return stdout.slice(start, i + 1);
    }
  }
  return null;
}

/** Strict parse: first complete JSON object in stdout, validated field by field. */
export function parseJudgeOutput(stdout: string): ParsedJudgeVerdict | null {
  const candidate = firstJsonObject(stdout);
  if (!candidate) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (typeof verdict !== 'string' || !(SEMANTIC_VERDICTS as readonly string[]).includes(verdict)) {
    return null;
  }
  const confidence = obj.confidence;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return null;
  const proposedAction = typeof obj.proposed_action === 'string' ? obj.proposed_action : 'none';
  // The model is no longer asked for a tier, and any tier it volunteers is IGNORED.
  //
  // Live evidence 2026-07-31: of 194 verdicts, 80 proposed tier 1 and 8 proposed tier 2
  // on notify-class actions, and stricter-of-two correctly refused 88 Tier 0 actions --
  // including all 27 flag_merge_ready on 47 real merge candidates. The tier law was
  // right; asking a model "how sensitive is this?" and then treating the answer as an
  // authority floor was not. Direction of the failure was safe (inflation can only
  // suppress, never widen), but it silently suppressed correct action.
  //
  // Code owns the floor via requiredTierForAction, which still fails closed to MAX_TIER
  // for unknown action kinds -- so dropping this field cannot widen authority. M-99
  // binding term 4's "stricter wins" is preserved with the model's side pinned at 0.
  const proposedTier = 0;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return { verdict: verdict as SemanticVerdict, confidence, proposedAction, proposedTier, reason };
}

async function spawnJudgeBinary(
  binary: string,
  prompt: string,
  timeoutMs: number
): Promise<JudgeSpawnResult> {
  // Per-binary invocation: grok takes -p <prompt>; codex uses its exec
  // subcommand (M-48 fallback rung, John 2026-08-26: "Give it to codex" --
  // added when the xAI team ran out of credits and the single-rung ladder
  // left the judge with no path to a verdict). parseJudgeOutput scans for
  // the first JSON object, so codex's surrounding chatter is tolerated.
  // 'codex' is not a container binary -- the CLI runs via bunx with the
  // mounted /root/.codex/auth.json (live-verified 2026-08-26: returns clean
  // JSON through `bunx @openai/codex exec`).
  const argv =
    binary === 'codex'
      ? ['bunx', '@openai/codex', 'exec', '--skip-git-repo-check', prompt]
      : [binary, '-p', prompt];
  const subprocess = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timeout: Timer | undefined;
  const timeoutResult = new Promise<JudgeSpawnResult>(resolve => {
    timeout = setTimeout(() => {
      subprocess.kill();
      resolve({ exitCode: 124, stdout: '', timedOut: true });
    }, timeoutMs);
  });
  const processResult = (async (): Promise<JudgeSpawnResult> => {
    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);
    return { exitCode, stdout, timedOut: false };
  })();
  const result = await Promise.race([processResult, timeoutResult]);
  if (timeout) clearTimeout(timeout);
  return result;
}

/**
 * Judge a terminal run through the model ladder. Rungs are tried cheapest
 * first; each distinct failure mode is tracked separately so the exhausted
 * outcome reports what actually happened (transport death vs invalid output),
 * not a blended guess.
 */
export async function judgeTerminalRun(
  envelope: JudgeEvidenceEnvelope,
  options: JudgeFirstOptions = {}
): Promise<JudgeOutcome> {
  const ladder = options.ladder ?? defaultJudgeLadder();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn =
    options.spawn ??
    ((binary: string, prompt: string): Promise<JudgeSpawnResult> =>
      spawnJudgeBinary(binary, prompt, timeoutMs));

  const prompt = buildJudgePrompt(envelope);
  let sawInvalidOutput = false;
  let lastModel: string | undefined;
  let lastRung = -1;

  for (let rung = 0; rung < ladder.length; rung += 1) {
    const binary = ladder[rung];
    if (!binary) continue;
    lastModel = binary;
    lastRung = rung;
    let spawnReturned = false;
    try {
      const result = await spawn(binary, prompt);
      spawnReturned = true;
      try {
        await (options.recordOutcome ?? recordSpawnOutcome)(binary, result, 'judge-first');
      } catch (error) {
        log.error(
          { binary, err: error as Error },
          'overseer.judge_first.resource_health_record_failed'
        );
      }
      if (result.timedOut || result.exitCode !== 0) {
        log.error(
          {
            runId: envelope.runId,
            rung,
            binary,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          },
          'overseer.judge_first.rung_unavailable'
        );
        continue;
      }
      const parsed = parseJudgeOutput(result.stdout);
      if (!parsed) {
        sawInvalidOutput = true;
        log.error(
          { runId: envelope.runId, rung, binary, stdoutPreview: result.stdout.slice(0, 200) },
          'overseer.judge_first.rung_invalid_output'
        );
        continue;
      }
      return {
        kind: 'verdict',
        verdict: parsed.verdict,
        confidence: parsed.confidence,
        proposedAction: parsed.proposedAction,
        proposedTier: parsed.proposedTier,
        reason: parsed.reason,
        model: binary,
        modelRung: rung,
      };
    } catch (error) {
      if (!spawnReturned) {
        try {
          await (options.recordOutcome ?? recordSpawnOutcome)(
            binary,
            { exitCode: -1, timedOut: false },
            'judge-first'
          );
        } catch (recordError) {
          log.error(
            { binary, err: recordError as Error },
            'overseer.judge_first.resource_health_record_failed'
          );
        }
      }
      log.error(
        { err: error as Error, runId: envelope.runId, rung, binary },
        'overseer.judge_first.rung_spawn_failed'
      );
      continue;
    }
  }

  // Ladder exhausted: an ALARM, never a semantic verdict (binding term 2).
  return {
    kind: sawInvalidOutput ? 'judge_invalid_output' : 'judge_unavailable',
    reason: sawInvalidOutput
      ? `all ${ladder.length} ladder rung(s) returned unparseable output`
      : `all ${ladder.length} ladder rung(s) unavailable (spawn failure, timeout, or nonzero exit)`,
    model: lastModel,
    modelRung: lastRung >= 0 ? lastRung : undefined,
  };
}
