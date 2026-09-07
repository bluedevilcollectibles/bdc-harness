import type { IndependentReviewFinding, ReviewAgentIdentity } from './independent-review-evidence';
import { assertCandidateIsCurrentHead } from './independent-review-evidence';

/**
 * CHECKS_UNAVAILABLE (#775) is TERMINAL and NON-APPROVING: the required
 * status-check contexts could not be read after the configured attempt bound,
 * so no verdict can be formed and deferring further would park the PR forever.
 * It is distinct from CHECKS_PENDING (retry later) and from REQUEST_CHANGES
 * (a real code finding) -- nothing was found wrong with the code; the reviewer
 * simply could not see what CI is mandatory.
 */
export type PrReviewVerdict =
  | 'APPROVE'
  | 'REQUEST_CHANGES'
  | 'INDETERMINATE'
  | 'CHECKS_PENDING'
  | 'CHECKS_UNAVAILABLE';

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
  for (const binary of ladder) {
    if (!nonEmpty(binary)) continue;
    try {
      const result = await deps.invokeModel(binary, prompt);
      if (result.timedOut) {
        lastError = `model_timeout:${binary}`;
        continue;
      }
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
    }
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

export async function invokeConfiguredReviewModel(
  binary: string,
  prompt: string,
  timeoutMs = 60_000
): Promise<PrReviewModelResult> {
  const argv =
    binary === 'codex'
      ? ['bunx', '@openai/codex', 'exec', '--skip-git-repo-check', prompt]
      : [binary, '-p', prompt];
  const subprocess = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  let timeout: Timer | undefined;
  const timeoutResult = new Promise<PrReviewModelResult>(resolve => {
    timeout = setTimeout(() => {
      subprocess.kill();
      resolve({ exitCode: 124, stdout: '', timedOut: true });
    }, timeoutMs);
  });
  const processResult = (async (): Promise<PrReviewModelResult> => {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    const payload = stdout.trim().length > 0 ? stdout : stderr;
    return { exitCode, stdout: normalizeModelOutput(binary, payload), timedOut: false };
  })();
  const result = await Promise.race([processResult, timeoutResult]);
  if (timeout) clearTimeout(timeout);
  return result;
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
