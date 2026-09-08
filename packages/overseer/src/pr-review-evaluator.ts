import { chmod, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndependentReviewFinding, ReviewAgentIdentity } from './independent-review-evidence';
import { assertCandidateIsCurrentHead } from './independent-review-evidence';

/**
 * CHECKS_UNAVAILABLE (#775) is TERMINAL and NON-APPROVING: the required
 * status-check contexts could not be read after the configured attempt bound,
 * so no verdict can be formed and deferring further would park the PR forever.
 * It is distinct from CHECKS_PENDING (retry later) and from REQUEST_CHANGES
 * (a real code finding) -- nothing was found wrong with the code; the reviewer
 * simply could not see what CI is mandatory.
 *
 * TRANSPORT_ERROR is NON-TERMINAL and NON-JUDGING: the judge process could not
 * be reached at all (argument-list-too-long, spawn failure, timeout), so no
 * evidence was ever read by a model and no verdict formed. It is distinct from
 * INDETERMINATE (terminal -- the model looked and could not decide) and from
 * CHECKS_PENDING (CI still running).
 *
 * The distinction IS the bug this fixes. Passing the whole prompt as one argv
 * element hit Linux MAX_ARG_STRLEN (131,072 bytes per argument) on any PR whose
 * diff exceeded roughly 128 KB; Bun.spawn raised E2BIG, both ladder binaries
 * failed identically, and `indeterminate()` was returned -- a TERMINAL
 * non-approving verdict posted as CHANGES_REQUESTED with no stated reason.
 * Observed live 2026-09-07 on bdc-harness #776 (139,527-byte diff) and #786
 * (140,491), three times each. A transport failure says nothing about the code,
 * so it defers and retries instead of blocking the PR.
 */
export type PrReviewVerdict =
  | 'APPROVE'
  | 'REQUEST_CHANGES'
  | 'INDETERMINATE'
  | 'CHECKS_PENDING'
  | 'CHECKS_UNAVAILABLE'
  | 'TRANSPORT_ERROR';

export interface PrReviewInput {
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  wo_id?: string;
}

export interface PrReviewCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PrReviewResult {
  verdict: PrReviewVerdict;
  findings: IndependentReviewFinding[];
  reviewed_head_sha: string;
  reviewer: ReviewAgentIdentity;
  acceptance_criteria_available: boolean;
  error?: string;
  /**
   * Set only on TRANSPORT_ERROR. Milliseconds the caller should wait before
   * re-attempting. The judge process was never reached, so retrying is the
   * correct response -- but not instantly, or a persistent spawn failure would
   * spin the worker every tick.
   */
  retry_after_ms?: number;
}

export interface PrReviewModelResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

export interface PrReviewDeps {
  reviewer: ReviewAgentIdentity;
  /**
   * `requiredContexts` is the set of required status-check contexts the
   * repository enforces on the PR's base branch (branch-protection
   * `required_status_checks.contexts`). It is the authoritative complete-suite
   * signal: the reviewer must wait until every required context has actually
   * reported AND completed, not merely until the check runs that happen to
   * exist so far are done.
   *
   * Three distinct states -- do NOT conflate them:
   * - non-empty `string[]`: authoritative set; wait for all of it.
   * - empty `string[]`: authoritative "this branch enforces nothing"; the
   *   reported-checks heuristic is then the only signal available.
   * - `null`: UNKNOWN -- the evidence source tried and could not obtain the
   *   authoritative set (permission, transient error, unreadable protection).
   *   The reviewer DEFERS. Failing open here would let one fast completed check
   *   trigger review before the remaining required CI registers.
   *
   * Omitting the field entirely is reserved for evidence sources that do not
   * model required contexts at all (unit-test doubles, non-GitHub sources); it
   * is a static property of the source, not a runtime failure, and falls back
   * to the reported-checks heuristic. The real GitHub adapter always sets it
   * explicitly to `string[] | null`.
   */
  fetchEvidence(
    input: PrReviewInput
  ): Promise<{ diff: string; checks: PrReviewCheck[]; requiredContexts?: string[] | null }>;
  fetchAcceptanceCriteria(woId: string): Promise<string | null>;
  invokeModel(binary: string, prompt: string): Promise<PrReviewModelResult>;
  ladder?: readonly string[];
}

interface ParsedReviewVerdict {
  verdict: Exclude<PrReviewVerdict, 'INDETERMINATE' | 'CHECKS_PENDING' | 'CHECKS_UNAVAILABLE'>;
  findings: IndependentReviewFinding[];
  reviewed_head_sha: string;
}

const FINDING_SEVERITIES = new Set(['blocker', 'major', 'minor', 'note']);

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Strictly parse the model's complete JSON response. Invalid output fails closed. */
export function parseReviewVerdict(stdout: string): ParsedReviewVerdict | null {
  try {
    const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value.verdict !== 'APPROVE' && value.verdict !== 'REQUEST_CHANGES') ||
      !nonEmpty(value.reviewed_head_sha) ||
      !Array.isArray(value.findings)
    ) {
      return null;
    }
    const findings: IndependentReviewFinding[] = [];
    for (const candidate of value.findings) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      const finding = candidate as Record<string, unknown>;
      if (
        !nonEmpty(finding.scope) ||
        !nonEmpty(finding.summary) ||
        !FINDING_SEVERITIES.has(String(finding.severity))
      ) {
        return null;
      }
      findings.push({
        scope: finding.scope.trim(),
        severity: finding.severity as IndependentReviewFinding['severity'],
        summary: finding.summary.trim(),
      });
    }
    if (
      value.verdict === 'REQUEST_CHANGES' &&
      !findings.some(finding => finding.severity === 'blocker' || finding.severity === 'major')
    ) {
      return null;
    }
    return {
      verdict: value.verdict,
      findings,
      reviewed_head_sha: value.reviewed_head_sha.trim(),
    };
  } catch {
    return null;
  }
}

export function buildReviewPrompt(input: {
  request: PrReviewInput;
  diff: string;
  checks: PrReviewCheck[];
  acceptanceCriteria: string | null;
}): string {
  return [
    'You are an independent pull-request code reviewer.',
    'Evaluate the exact-head code diff, check/test results, security implications, authorized scope, and stated acceptance criteria.',
    'Report blocking issues as severity blocker or major. Advisory issues use minor or note.',
    'Return only one JSON object with this exact shape:',
    '{"verdict":"APPROVE|REQUEST_CHANGES","findings":[{"scope":"non-empty","severity":"blocker|major|minor|note","summary":"non-empty"}],"reviewed_head_sha":"exact input SHA"}',
    'Use REQUEST_CHANGES only with at least one blocker or major finding. Never approve when checks fail or a stated acceptance criterion is unmet.',
    '',
    `Repository: ${input.request.owner}/${input.request.repo}`,
    `Pull request: ${input.request.pr_number}`,
    `Exact head SHA: ${input.request.head_sha}`,
    `Work order: ${input.request.wo_id ?? 'unavailable'}`,
    `Acceptance criteria: ${input.acceptanceCriteria ?? 'unavailable; evaluate diff and checks only'}`,
    `Checks: ${JSON.stringify(input.checks)}`,
    'Diff:',
    input.diff,
  ].join('\n');
}

function indeterminate(
  input: PrReviewInput,
  deps: PrReviewDeps,
  acceptanceCriteriaAvailable: boolean,
  error: string
): PrReviewResult {
  return {
    verdict: 'INDETERMINATE',
    findings: [],
    reviewed_head_sha: input.head_sha,
    reviewer: deps.reviewer,
    acceptance_criteria_available: acceptanceCriteriaAvailable,
    error,
  };
}

/**
 * Default backoff before a transport-failed review is re-attempted. Kept short
 * relative to the worker tick: the usual cause (a transient spawn failure, a
 * busy judge host) clears quickly, and a genuinely permanent one is visible in
 * the receipt reason rather than hidden behind a long wait.
 */
export const TRANSPORT_ERROR_RETRY_MS = 60_000;

/**
 * Error text fragments that mark a failure of TRANSPORT rather than of
 * judgment: the judge process was never successfully reached, so nothing about
 * the code was evaluated.
 *
 * E2BIG / 'argument list too long' is the anchor case -- see the
 * TRANSPORT_ERROR doc comment. The spawn-family codes are included because a
 * missing or unlaunchable binary is the same class of failure from the PR's
 * point of view: no review happened, so no verdict may be posted at the head.
 */
const TRANSPORT_ERROR_PATTERNS: readonly RegExp[] = [
  /e2big/i,
  /argument list too long/i,
  /enoent/i,
  /eacces/i,
  /enomem/i,
  /eagain/i,
  /spawn/i,
  /failed to (?:spawn|start)/i,
  /posix_spawn/i,
];

/**
 * True when an error raised out of the model seam is a transport failure.
 *
 * Deliberately conservative: an unrecognized error still maps to INDETERMINATE,
 * so a real judgment failure (bad output, refused request) can never become an
 * endless deferral loop.
 */
export function isTransportError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const haystack = `${code} ${message}`;
  return TRANSPORT_ERROR_PATTERNS.some(pattern => pattern.test(haystack));
}

/**
 * Build the non-terminal TRANSPORT_ERROR result.
 *
 * `findings` is empty and `approved` is never derived from this verdict: the
 * judge was never reached, so it says nothing about the code. The submit path
 * must not collapse it into `approved: false`, which would post
 * REQUEST_CHANGES on argument-size grounds -- the same class of bug as the
 * CHECKS_PENDING collapse this codebase already fixed.
 */
function transportError(
  input: PrReviewInput,
  deps: PrReviewDeps,
  acceptanceCriteriaAvailable: boolean,
  error: string
): PrReviewResult {
  return {
    verdict: 'TRANSPORT_ERROR',
    findings: [],
    reviewed_head_sha: input.head_sha,
    reviewer: deps.reviewer,
    acceptance_criteria_available: acceptanceCriteriaAvailable,
    error,
    retry_after_ms: TRANSPORT_ERROR_RETRY_MS,
  };
}

/**
 * The safe, postable half of an evaluator error string.
 *
 * Evaluator errors are shaped `code:detail` (`model_error:E2BIG ...`,
 * `model_timeout:codex`, `evidence_error:<api message>`). Only the code before
 * the FIRST colon may ever reach GitHub: the detail half carries model output,
 * API messages, and binary names that can embed tokens or provider internals.
 * Reduced to a conservative identifier charset so a malformed error can never
 * smuggle text through.
 */
export function reviewErrorCode(error: string | undefined): string | null {
  if (!nonEmpty(error)) return null;
  const code = error.split(':', 1)[0]?.trim() ?? '';
  return /^[a-z0-9_]{1,40}$/.test(code) ? code : null;
}

/**
 * Terminality of a PR's check suite for review purposes.
 *
 * The reviewer must not judge "did the tests pass" while checks are still
 * queued/in_progress -- that is the bug this WO fixes. But a subtler race also
 * has to be closed: GitHub's `checks.listForRef` only returns check runs that
 * have ALREADY been created. Early in a push the required suite may not have
 * registered yet, so one fast-completing check would make "every reported check
 * is completed" true and trigger review before the rest of CI even appears.
 *
 * When `requiredContexts` is a known set (branch-protection required status
 * checks on the base branch) it is the authoritative complete-suite signal:
 * terminal only when EVERY required context has reported a check run AND every
 * reported check has completed. A required context that has not shown up yet
 * (or one that is present but still in_progress) keeps the suite non-terminal.
 *
 * `null` means the authoritative set could NOT be obtained. That is never
 * terminal: we defer rather than fall back to the reported-checks heuristic,
 * because a missing permission, a transient API error, or an unreadable
 * protection config would otherwise let one fast completed check trigger review
 * before the remaining required CI registers -- reintroducing the exact
 * early-review bug this WO closes. Deferral is retried with backoff by the
 * review worker, so an unknown state resolves as soon as the lookup succeeds.
 *
 * An empty set, or an omitted argument from an evidence source that does not
 * model required contexts, falls back to the weaker heuristic (at least one
 * check reported and all reported checks completed) -- the only signal
 * available when nothing is enforced. Every repo in scope has enforced required
 * checks, so the fallback is not exercised in production today.
 */
export function checksAreTerminal(
  checks: PrReviewCheck[],
  requiredContexts?: readonly string[] | null
): boolean {
  // UNKNOWN required set -- fail closed. Must be checked before any heuristic.
  if (requiredContexts === null) return false;
  // A reported check that is still queued/in_progress means the suite is mid
  // flight regardless of what is required -- never terminal.
  const allReportedCompleted = checks.every(check => check.status === 'completed');
  if (requiredContexts !== undefined && requiredContexts.length > 0) {
    const completedNames = new Set(
      checks.filter(check => check.status === 'completed').map(check => check.name)
    );
    return allReportedCompleted && requiredContexts.every(context => completedNames.has(context));
  }
  return checks.length > 0 && allReportedCompleted;
}

function checksPending(input: PrReviewInput, deps: PrReviewDeps): PrReviewResult {
  return {
    verdict: 'CHECKS_PENDING',
    findings: [],
    reviewed_head_sha: input.head_sha,
    reviewer: deps.reviewer,
    acceptance_criteria_available: false,
    error: 'checks_pending',
  };
}

export async function evaluatePullRequest(
  input: PrReviewInput,
  deps: PrReviewDeps
): Promise<PrReviewResult> {
  if (!nonEmpty(deps.reviewer.provider) || !nonEmpty(deps.reviewer.model)) {
    return indeterminate(input, deps, false, 'reviewer_identity_missing');
  }

  let evidence: {
    diff: string;
    checks: PrReviewCheck[];
    requiredContexts?: string[] | null;
    requiredContextsBlocked?: { reason: string; attempts: number; failureKind: string };
  };
  try {
    evidence = await deps.fetchEvidence(input);
  } catch (error) {
    return indeterminate(input, deps, false, `evidence_error:${errorMessage(error)}`);
  }

  // BOUNDED DEFERRAL, ESCALATING (#775). The required-contexts lookup has now
  // failed on consecutive attempts past its bound. Stop deferring -- but do NOT
  // proceed to the reported-checks heuristic, which would approve on evidence
  // the reviewer just admitted it cannot see. Terminal and non-approving; the
  // submit path turns this into a PR comment plus an operator escalation.
  //
  // Checked BEFORE checksAreTerminal so the outcome cannot depend on what the
  // reported checks happen to say: green reported checks with unknown mandatory
  // contexts must block exactly like red ones.
  if (evidence.requiredContextsBlocked) {
    return {
      verdict: 'CHECKS_UNAVAILABLE',
      findings: [],
      reviewed_head_sha: input.head_sha,
      reviewer: deps.reviewer,
      acceptance_criteria_available: false,
      error: `${evidence.requiredContextsBlocked.reason}:attempts=${evidence.requiredContextsBlocked.attempts}:reason=${evidence.requiredContextsBlocked.failureKind}`,
    };
  }

  // Defer (never REQUEST_CHANGES) until CI checks on the exact head are
  // terminal. Terminality is judged against the repo's required status-check
  // contexts when known, so a fast single check cannot trigger review before
  // the rest of the required suite has registered; when that set is UNKNOWN
  // (`null`) we defer too. `requiredContexts` is passed through verbatim -- it
  // must NOT be coalesced (e.g. `?? []`), which would erase the unknown state
  // and silently fail open. The model is not invoked in this branch.
  if (!checksAreTerminal(evidence.checks, evidence.requiredContexts)) {
    return checksPending(input, deps);
  }

  let acceptanceCriteria: string | null = null;
  if (input.wo_id) {
    try {
      acceptanceCriteria = await deps.fetchAcceptanceCriteria(input.wo_id);
    } catch {
      acceptanceCriteria = null;
    }
  }
  const acceptanceCriteriaAvailable = nonEmpty(acceptanceCriteria);
  const prompt = buildReviewPrompt({
    request: input,
    diff: evidence.diff,
    checks: evidence.checks,
    acceptanceCriteria,
  });
  const ladder = deps.ladder ?? defaultReviewLadder();
  let lastError = 'model_unavailable';
  // TRANSPORT vs JUDGMENT across the whole ladder.
  //
  // Deferral requires that EVERY rung failed on transport. A single
  // non-transport failure anywhere makes the whole attempt TERMINAL
  // (INDETERMINATE), because a judgment failure that deferred would retry
  // forever and never post a verdict.
  //
  // Two distinct ways a rung can prove the failure is NOT purely transport:
  //   - `reachedAnyRung`: the process ran and returned output to judge, so
  //     anything after that (bad output, non-zero exit) is judgment.
  //   - `nonTransportFailure`: the rung threw, but `isTransportError` says the
  //     throw was not a transport problem -- e.g. `401 unauthorized`. Nothing
  //     was returned, so `reachedAnyRung` stays false, yet retrying forever is
  //     still wrong because the error will recur.
  //
  // Review findings (Overseer, PR #790 then #799): a sticky "saw transport"
  // flag was wrong twice over. First a dead rung (codex ENOENT) outvoted a
  // later rung that ran and returned invalid output; `reachedAnyRung` fixed
  // that. Then a dead rung still outvoted a later rung that threw a
  // NON-transport error (ENOENT then 401), because a throw sets neither flag --
  // which `nonTransportFailure` fixes. Both flags are set-once and never
  // cleared, so rung ORDER cannot change the classification.
  let reachedAnyRung = false;
  let nonTransportFailure = false;
  let transportFailure: string | null = null;
  for (const binary of ladder) {
    if (!nonEmpty(binary)) continue;
    try {
      const result = await deps.invokeModel(binary, prompt);
      if (result.timedOut) {
        // A timeout is transport, not judgment: the process started but never
        // delivered anything to judge, so this rung was not reached.
        lastError = `model_timeout:${binary}`;
        transportFailure ??= lastError;
        continue;
      }
      // The process ran and returned. Whatever happens below is judgment.
      reachedAnyRung = true;
      if (result.exitCode !== 0) {
        lastError = `model_exit_nonzero:${binary}`;
        continue;
      }
      const parsed = parseReviewVerdict(result.stdout);
      if (!parsed) {
        lastError = `model_output_invalid:${binary}`;
        continue;
      }
      try {
        assertCandidateIsCurrentHead(input.head_sha, parsed.reviewed_head_sha);
      } catch {
        return indeterminate(input, deps, acceptanceCriteriaAvailable, 'reviewed_head_mismatch');
      }
      return {
        ...parsed,
        reviewer: { provider: deps.reviewer.provider, model: binary },
        acceptance_criteria_available: acceptanceCriteriaAvailable,
      };
    } catch (error) {
      lastError = `model_error:${errorMessage(error)}`;
      if (isTransportError(error)) {
        // E2BIG and friends: the process never ran, so this rung was not reached.
        transportFailure ??= lastError;
      } else {
        // A real error from a rung that was reachable (401, refused request,
        // provider fault). Retrying cannot help, so this makes the attempt
        // terminal even if another rung failed on transport.
        nonTransportFailure = true;
      }
    }
  }
  // Defer ONLY when every rung failed on transport: nothing was ever judged
  // (`reachedAnyRung`) and nothing threw a non-transport error
  // (`nonTransportFailure`). Either one makes the outcome terminal.
  if (transportFailure && !reachedAnyRung && !nonTransportFailure) {
    return transportError(input, deps, acceptanceCriteriaAvailable, transportFailure);
  }
  return indeterminate(input, deps, acceptanceCriteriaAvailable, lastError);
}

function defaultReviewLadder(): string[] {
  return (process.env.OVERSEER_JUDGE_LADDER ?? 'grok')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

/** Existing judge CLI convention, exposed for the real dependency composition. */
export function configuredReviewIdentity(): ReviewAgentIdentity {
  const model = defaultReviewLadder()[0] ?? 'grok';
  return { provider: 'cli', model };
}

/** Default judge wall clock; override with OVERSEER_REVIEW_MODEL_TIMEOUT_MS. */
export const DEFAULT_REVIEW_MODEL_TIMEOUT_MS = 60_000;

export function resolveReviewModelTimeoutMs(
  env: Record<string, string | undefined> = process.env
): number {
  const parsed = Number(env.OVERSEER_REVIEW_MODEL_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_MODEL_TIMEOUT_MS;
}

/**
 * How one judge binary receives the review prompt.
 *
 * NEVER as an argv element. Linux caps a SINGLE argument at MAX_ARG_STRLEN
 * (131,072 bytes; verified in archon-app-1 alongside ARG_MAX 2,097,152), and
 * the prompt is a header plus the checks JSON plus the FULL diff -- so every PR
 * with a diff over roughly 128 KB failed with E2BIG on both rungs and the
 * reviewer returned INDETERMINATE with no stated reason (#776, #786,
 * 2026-09-07). Neither transport below has any size limit.
 *
 * - `codex exec`: with no positional PROMPT, "instructions are read from stdin"
 *   (`codex exec --help`, verified in the container 2026-09-07; matches the
 *   board skill's 2026-07-26 finding). Written to the child's stdin pipe.
 * - `grok`: `--prompt-file <PATH>` -- "Single-turn prompt from a file"
 *   (`grok --help`, verified in the container 2026-09-07). The prompt is
 *   written to a temp file and the PATH is passed, which is a short argument.
 *   `-p/--single` takes the prompt inline and is exactly what must be avoided.
 */
interface ReviewModelTransport {
  argv: string[];
  /** Written to the child's stdin when set. */
  stdinPrompt?: string;
  /** Temp file holding the prompt; removed after the process settles. */
  promptFile?: string;
  /** Private 0700 directory containing `promptFile`; removed with it. */
  promptDir?: string;
}

/** Owner-only directory (rwx------). */
const PROMPT_DIR_MODE = 0o700;
/** Owner-only file (rw-------). */
const PROMPT_FILE_MODE = 0o600;

/**
 * Write the prompt to a file only the running user can read.
 *
 * Review finding (Overseer, PR #790): the prompt embeds the FULL private diff
 * and the acceptance criteria. Writing it straight into the shared system temp
 * directory with default permissions leaves it world-readable under a typical
 * 022 umask, exposing repository contents to any other local user or process
 * for as long as the judge runs.
 *
 * `mkdtemp` creates the directory atomically and exclusively -- no
 * predictable-name race, and no pre-existing path can be hijacked. The mode is
 * then set explicitly rather than trusted to the umask, and the file is written
 * before its mode is tightened, so the window is inside a 0700 directory the
 * whole time.
 */
async function writePrivatePromptFile(
  prompt: string
): Promise<{ promptFile: string; promptDir: string }> {
  const promptDir = await mkdtemp(join(tmpdir(), 'overseer-review-'));
  await chmod(promptDir, PROMPT_DIR_MODE);
  const promptFile = join(promptDir, 'prompt.txt');
  await writeFile(promptFile, prompt, { mode: PROMPT_FILE_MODE });
  await chmod(promptFile, PROMPT_FILE_MODE);
  return { promptFile, promptDir };
}

/** Exported for the permission test; not part of the review API surface. */
export async function buildReviewModelTransport(
  binary: string,
  prompt: string
): Promise<ReviewModelTransport> {
  if (binary === 'codex') {
    return {
      argv: ['bunx', '@openai/codex', 'exec', '--skip-git-repo-check'],
      stdinPrompt: prompt,
    };
  }
  const { promptFile, promptDir } = await writePrivatePromptFile(prompt);
  return { argv: [binary, '--prompt-file', promptFile], promptFile, promptDir };
}

export async function invokeConfiguredReviewModel(
  binary: string,
  prompt: string,
  timeoutMs = resolveReviewModelTimeoutMs()
): Promise<PrReviewModelResult> {
  const transport = await buildReviewModelTransport(binary, prompt);
  try {
    return await runReviewModelProcess(transport, binary, timeoutMs);
  } finally {
    // Always in a finally: the prompt holds the private diff, so it must not
    // outlive the judge process on any path -- success, throw, or timeout.
    if (transport.promptFile) {
      try {
        await unlink(transport.promptFile);
      } catch {
        // Best effort: a leaked temp prompt is far less bad than a throw that
        // would reclassify a successful review as a model_error.
      }
    }
    if (transport.promptDir) {
      try {
        await rm(transport.promptDir, { recursive: true, force: true });
      } catch {
        // Same rationale: cleanup never changes the review's outcome.
      }
    }
  }
}

/**
 * The subset of a spawned child this module uses. Declared so a test can supply
 * a double -- notably one that never READS stdin, which is the only way to
 * exercise the pipe back-pressure path deterministically.
 */
export interface ReviewModelChild {
  stdin: unknown;
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
  exited: Promise<number>;
  kill(): void;
}

export type ReviewModelSpawn = (argv: string[], stdinMode: 'ignore' | 'pipe') => ReviewModelChild;

const defaultReviewModelSpawn: ReviewModelSpawn = (argv, stdinMode) =>
  Bun.spawn(argv, {
    stdin: stdinMode,
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as ReviewModelChild;

/** Exported for the back-pressure test; not part of the review API surface. */
export async function runReviewModelProcess(
  transport: ReviewModelTransport,
  binary: string,
  timeoutMs: number,
  spawn: ReviewModelSpawn = defaultReviewModelSpawn
): Promise<PrReviewModelResult> {
  const subprocess = spawn(transport.argv, transport.stdinPrompt === undefined ? 'ignore' : 'pipe');

  // ARM THE WALL CLOCK FIRST -- before any stdin delivery.
  //
  // Writing the prompt is itself a blocking operation that can hang forever: a
  // child that starts but never READS stdin fills the OS pipe buffer (~64 KB on
  // Linux) and the write back-pressures, so `await stdin.end()` never settles.
  // The prompt here is a full PR diff, routinely far larger than that buffer.
  // Arming the timer after the write -- as this did -- meant
  // OVERSEER_REVIEW_MODEL_TIMEOUT_MS bounded only the model's THINKING time, not
  // the call, and a non-consuming child hung the review worker indefinitely with
  // no timeout, no verdict and no deferral.
  let timeout: Timer | undefined;
  let timedOut = false;
  const timeoutResult = new Promise<PrReviewModelResult>(resolve => {
    timeout = setTimeout(() => {
      timedOut = true;
      // Kill the child AND tear down the writer. Killing alone is not enough:
      // the pending write is parked on a pipe whose reader is gone, so the
      // writer must be destroyed for the awaited write to settle (as an
      // EPIPE/abort rejection, swallowed below) instead of hanging on.
      subprocess.kill();
      destroyStdin(subprocess.stdin);
      resolve({ exitCode: 124, stdout: '', timedOut: true });
    }, timeoutMs);
  });

  // Deliver the prompt WITHOUT awaiting it here: the delivery promise races the
  // timeout alongside the process itself, so a stalled write can never outlive
  // the wall clock. Its rejection is handled inside deliverStdin, which keeps a
  // child that exits early (EPIPE on a closed pipe) from surfacing as an
  // unhandled rejection.
  const delivery =
    transport.stdinPrompt === undefined
      ? Promise.resolve()
      : deliverStdin(subprocess.stdin, transport.stdinPrompt);

  const processResult = (async (): Promise<PrReviewModelResult> => {
    // Never block on delivery completing: a child may legitimately exit before
    // consuming the whole prompt, which settles this as an EPIPE no-op.
    void delivery;
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    const payload = stdout.trim().length > 0 ? stdout : stderr;
    // A kill fired by the timeout also settles `exited`; report that as the
    // timeout it is rather than as a spurious non-zero exit.
    if (timedOut) return { exitCode: 124, stdout: '', timedOut: true };
    return { exitCode, stdout: normalizeModelOutput(binary, payload), timedOut: false };
  })();
  const result = await Promise.race([processResult, timeoutResult]);
  if (timeout) clearTimeout(timeout);
  // The child must never outlive this call: on the timeout path the kill above
  // already fired, but a race won by processResult can still leave the writer
  // parked if the child exited without draining stdin.
  destroyStdin(subprocess.stdin);
  return result;
}

/**
 * Write the prompt to the child and close the pipe so it sees EOF.
 *
 * Rejections are swallowed on purpose. Once the child is gone -- killed by the
 * timeout, or exited early having read only part of the prompt -- the pending
 * write fails with EPIPE/ERR_STREAM_DESTROYED. That is expected, is not a
 * review failure, and must not surface as an unhandled rejection (which crashes
 * the worker under Bun's default handler).
 */
async function deliverStdin(stdin: unknown, prompt: string): Promise<void> {
  const writer = stdin as {
    write(chunk: string): unknown;
    end(): unknown;
  } | null;
  if (!writer) return;
  try {
    await writer.write(prompt);
    await writer.end();
  } catch {
    // Child gone or pipe torn down -- see above.
  }
}

/**
 * Force the stdin pipe closed so any write parked on back-pressure settles.
 *
 * Killing the child is not sufficient on its own: the awaiting write stays
 * pending until the writer itself is torn down. Every method is attempted
 * defensively because the concrete stdin object differs between Bun's
 * FileSink and a test double, and cleanup must never throw into the result path.
 */
function destroyStdin(stdin: unknown): void {
  const writer = stdin as {
    destroy?: () => unknown;
    end?: () => unknown;
    close?: () => unknown;
  } | null;
  if (!writer) return;
  for (const method of ['destroy', 'end', 'close'] as const) {
    try {
      writer[method]?.();
    } catch {
      // Best effort: teardown never changes the review's outcome.
    }
  }
}

function normalizeModelOutput(binary: string, stdout: string): string {
  if (binary !== 'codex') return stdout;
  const lines = stdout.split(/\r?\n/);
  const start = lines.lastIndexOf('codex');
  if (start === -1) return stdout;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^tokens used/i.test(line.trim()));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 120) : 'unknown_error';
}
