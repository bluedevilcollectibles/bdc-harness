/**
 * Required status-check context resolution for the PR reviewer.
 *
 * INCIDENT 2026-09-07 (archon-app-1 at dev c8e7a409, bdc-harness #775): every
 * PR review deferred forever. `createRealFetchExactHeadPullRequestEvidence`
 * asked GitHub for the base branch's required status-check contexts with the
 * GitHub App installation client. That client does not hold the permission, so
 * every tick logged
 *
 *   RequestError "Resource not accessible by integration" (HTTP 403) on
 *   GET /repos/<owner>/<repo>/branches/<base>/protection/required_status_checks/contexts
 *
 * `requiredContexts` came back `null` (UNKNOWN), `checksAreTerminal` failed
 * closed on `null`, and the review worker released the claim with disposition
 * `checks_pending` and retried on the next tick -- forever. run_review rows
 * reached fencing_token 240 without ever producing a verdict.
 *
 * Three independent defects, fixed here as three independent layers:
 *
 * 1. IDENTITY. The PAT in the same container CAN read that endpoint (for
 *    bdc-harness/dev it returns ["docker-build","test (ubuntu-latest)"]). The
 *    resolver therefore tries the App client and, on a permission failure,
 *    retries with the PAT client. An explicit env override
 *    (OVERSEER_REQUIRED_CONTEXTS_JSON) short-circuits both when configured.
 *
 * 2. GENUINELY UNPROTECTED BRANCHES. bdc-xo `main` really is unprotected
 *    (branches/main reports protected:false; the rules endpoint returns []; the
 *    protection endpoint answers 404 "Branch not protected"). The old adapter
 *    mapped that 404 to `null`, so a repo with nothing to wait for deferred
 *    forever. A 404 ALONE is still not evidence -- GitHub masks 403 as 404 on
 *    admin-scoped endpoints -- so "unprotected" is only concluded from POSITIVE
 *    evidence: the rules endpoint (readable by both identities) returns an
 *    empty array AND the branch reports protected:false. Positive evidence
 *    yields an authoritative EMPTY set, which routes to the reported-checks
 *    heuristic because an empty required set is a real answer.
 *
 * 3. BOUNDEDNESS THAT ESCALATES, NEVER DOWNGRADES. Even with both identities,
 *    an unresolvable lookup must not park a PR forever. After N consecutive
 *    UNKNOWN attempts for the same head
 *    (OVERSEER_REQUIRED_CONTEXTS_MAX_ATTEMPTS, default 5) the resolver reports
 *    EXHAUSTED. The reviewer then produces a VISIBLE TERMINAL outcome: a PR
 *    review COMMENT saying the contexts could not be read, the non-approving
 *    disposition `blocked_required_contexts_unavailable`, and an operator
 *    escalation -- never an approval.
 *
 *    EXHAUSTED deliberately does NOT fall back to the reported-checks
 *    heuristic. A silent downgrade would turn "we cannot see what CI is
 *    required" into "whatever CI reported is good enough", which is the
 *    fail-open path the original fail-closed design existed to prevent: a PR
 *    whose one reported check is green but whose mandatory contexts never ran
 *    would sail through. Boundedness here buys VISIBILITY (a human is told),
 *    not permission. The heuristic stays reserved for POSITIVE unprotected
 *    evidence, where an empty required set is an answer rather than an absence
 *    of one.
 */
import { createLogger } from '@archon/paths';

const log = createLogger('overseer/required-contexts');

/** Env var holding a JSON object of "owner/repo@base" -> string[] contexts. */
export const REQUIRED_CONTEXTS_OVERRIDE_ENV = 'OVERSEER_REQUIRED_CONTEXTS_JSON' as const;

/** Env var holding the consecutive-UNKNOWN attempt bound before blocking. */
export const REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV =
  'OVERSEER_REQUIRED_CONTEXTS_MAX_ATTEMPTS' as const;

/** Default bound when the env var is unset or unparseable. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Stable log/receipt code for the terminal blocked outcome. */
export const REQUIRED_CONTEXTS_BLOCKED_REASON = 'required_contexts_unavailable_blocked' as const;

/** Which identity or probe produced an authoritative answer. */
export type RequiredContextsSource =
  | 'env_override'
  | 'app_client'
  | 'pat_client'
  | 'unprotected_branch';

/**
 * Why the lookup could not be answered. Surfaced verbatim in the PR comment so
 * whoever reads it knows whether to fix a PERMISSION (grant the App the scope,
 * or supply the PAT) or to wait out a TRANSIENT API fault.
 */
export type RequiredContextsFailureKind = 'permission' | 'transient';

/**
 * Outcome of resolving the required status-check contexts for one base branch.
 *
 * The three states are NOT interchangeable, and collapsing any two of them is
 * the bug class this module exists to prevent:
 * - `known`     -- an authoritative set (possibly empty). Gate on it.
 * - `unknown`   -- could not be obtained. Fail closed: DEFER and retry.
 * - `exhausted` -- could not be obtained, repeatedly, past the configured
 *                  bound. BLOCK the review visibly (PR comment + operator
 *                  escalation). Never an approval, and never a downgrade to
 *                  the reported-checks heuristic.
 */
export type RequiredContextsResolution =
  | { state: 'known'; contexts: string[]; source: RequiredContextsSource }
  | { state: 'unknown'; reason: string; failureKind: RequiredContextsFailureKind }
  | {
      state: 'exhausted';
      reason: typeof REQUIRED_CONTEXTS_BLOCKED_REASON;
      attempts: number;
      failureKind: RequiredContextsFailureKind;
    };

/** Fetches the enforced contexts for one branch. Rejects on any API failure. */
export type StatusCheckContextsFetcher = (input: {
  owner: string;
  repo: string;
  branch: string;
}) => Promise<{ data: string[] }>;

/**
 * Reads POSITIVE evidence that a branch is unprotected. Both probes are
 * readable by the App installation and by the PAT, which is exactly why they --
 * and not a bare 404 on the admin-scoped protection endpoint -- are what we are
 * allowed to conclude "unprotected" from.
 */
export interface UnprotectedBranchProbes {
  /** GET /repos/{owner}/{repo}/rules/branches/{branch} -- [] means no rules apply. */
  fetchBranchRules?: (input: {
    owner: string;
    repo: string;
    branch: string;
  }) => Promise<{ data: unknown[] }>;
  /** GET /repos/{owner}/{repo}/branches/{branch} -- protected:false is the second half. */
  fetchBranch?: (input: {
    owner: string;
    repo: string;
    branch: string;
  }) => Promise<{ data: { protected?: boolean; protection?: { enabled?: boolean } } }>;
}

export interface ResolveRequiredContextsInput extends UnprotectedBranchProbes {
  owner: string;
  repo: string;
  baseRef: string | null | undefined;
  /**
   * Head SHA under review. Only used to key the consecutive-attempt counter, so
   * a new push starts the bound over rather than inheriting a stale count.
   */
  headSha: string;
  /** App-identity fetcher. Absent when the client cannot answer at all. */
  fetchWithAppClient?: StatusCheckContextsFetcher;
  /** PAT-identity fetcher. Absent when no PAT is configured in this process. */
  fetchWithPatClient?: StatusCheckContextsFetcher;
}

interface AttemptCounterEntry {
  headSha: string;
  attempts: number;
}

/**
 * Consecutive-UNKNOWN counts, keyed by owner/repo@base and holding the head the
 * count belongs to. MODULE scope on purpose: `createRealSubmitDeps` (and with
 * it the evidence fetcher closure) is constructed fresh for every claimed
 * message by the review worker, so a closure-local counter would reset on every
 * tick and the bound would never be reached.
 */
const unknownAttempts = new Map<string, AttemptCounterEntry>();

/** Test seam: drop all attempt state. */
export function resetRequiredContextsAttemptCounters(): void {
  unknownAttempts.clear();
}

/**
 * One-shot log de-duplication for the "which identity answered" line. The
 * reviewer runs on a tick; logging the winning client every tick is noise that
 * buried the 403 for nine days.
 */
const loggedSources = new Set<string>();

/** Test seam: forget which source lines have already been logged. */
export function resetRequiredContextsSourceLog(): void {
  loggedSources.clear();
}

function branchKey(owner: string, repo: string, baseRef: string): string {
  return `${owner}/${repo}@${baseRef}`;
}

function normalizeContexts(data: unknown): string[] | null {
  if (!Array.isArray(data)) return null;
  return data
    .filter((context): context is string => typeof context === 'string')
    .map(context => context.trim())
    .filter(Boolean);
}

/**
 * True when the error is GitHub refusing on PERMISSION grounds -- the App-lacks-
 * scope signature from the incident. 404 is included because GitHub masks 403 as
 * 404 on admin-scoped endpoints (an unprotected branch answers 404 too, so a 404
 * is never authoritative evidence that nothing is required -- it only means "ask
 * the other identity").
 */
export function isPermissionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; message?: unknown };
  if (candidate.status === 403 || candidate.status === 404) return true;
  return (
    typeof candidate.message === 'string' &&
    /resource not accessible by integration|not accessible by personal access token/i.test(
      candidate.message
    )
  );
}

/**
 * True when GitHub answered the protection endpoint with the literal
 * "Branch not protected" 404. That exact message is only emitted for a real
 * unprotected branch; a permission-masked 404 carries "Not Found" instead. Even
 * so this is a HINT, not a conclusion -- `hasPositiveUnprotectedEvidence` still
 * has to agree before an empty set is returned.
 */
export function isBranchNotProtectedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; message?: unknown };
  if (candidate.status !== 404) return false;
  return typeof candidate.message === 'string' && /branch not protected/i.test(candidate.message);
}

/**
 * Ask the two App-and-PAT-readable endpoints whether the branch is genuinely
 * unprotected. Returns true ONLY on the full positive signature: the rules
 * endpoint returns an empty array AND the branch reports protected:false. Any
 * probe that errors, is unavailable, or disagrees returns false -- absence of
 * evidence is never evidence of absence.
 */
async function hasPositiveUnprotectedEvidence(
  input: ResolveRequiredContextsInput,
  baseRef: string
): Promise<boolean> {
  const { owner, repo, fetchBranchRules, fetchBranch } = input;
  if (!fetchBranchRules || !fetchBranch) return false;
  try {
    const [rules, branch] = await Promise.all([
      fetchBranchRules({ owner, repo, branch: baseRef }),
      fetchBranch({ owner, repo, branch: baseRef }),
    ]);
    if (!Array.isArray(rules?.data) || rules.data.length > 0) return false;
    const data = branch?.data;
    if (!data || typeof data !== 'object') return false;
    // protected:true, or an enabled protection block, contradicts the rules read.
    if (data.protected === true) return false;
    if (data.protection?.enabled === true) return false;
    return data.protected === false || data.protection?.enabled === false;
  } catch (error) {
    log.warn(
      { err: error, owner, repo, baseRef },
      'overseer.required_contexts.unprotected_probe_failed'
    );
    return false;
  }
}

/** Parse the env override into a lookup map. Malformed input is ignored, loudly. */
export function parseRequiredContextsOverride(
  raw: string | undefined
): Map<string, string[]> | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.warn(
      { err: error, env: REQUIRED_CONTEXTS_OVERRIDE_ENV },
      'overseer.required_contexts.override_unparseable_ignored'
    );
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn(
      { env: REQUIRED_CONTEXTS_OVERRIDE_ENV },
      'overseer.required_contexts.override_not_an_object_ignored'
    );
    return null;
  }
  const map = new Map<string, string[]>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const contexts = normalizeContexts(value);
    if (contexts === null) {
      log.warn(
        { env: REQUIRED_CONTEXTS_OVERRIDE_ENV, key },
        'overseer.required_contexts.override_entry_not_an_array_ignored'
      );
      continue;
    }
    // An explicitly empty array is a legitimate override meaning "nothing is
    // required here" -- it must survive into the map, so size alone can never
    // be the emptiness test below.
    map.set(key, contexts);
  }
  return map.size > 0 ? map : null;
}

/** Read the configured attempt bound. Non-positive or unparseable falls back to the default. */
export function resolveMaxAttempts(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    log.warn(
      { env: REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV, value: raw },
      'overseer.required_contexts.max_attempts_invalid_using_default'
    );
    return DEFAULT_MAX_ATTEMPTS;
  }
  return parsed;
}

function logSourceOnce(key: string, fields: Record<string, unknown>, message: string): void {
  if (loggedSources.has(key)) return;
  loggedSources.add(key);
  log.info(fields, message);
}

/**
 * Resolve the base branch's required status-check contexts.
 *
 * Order: env override -> App client -> PAT client (on permission failure only)
 * -> positive-unprotected probes -> UNKNOWN (fail closed, retry) -> EXHAUSTED
 * once the consecutive-UNKNOWN bound for this head is passed.
 */
export async function resolveRequiredContexts(
  input: ResolveRequiredContextsInput,
  env: NodeJS.ProcessEnv = process.env
): Promise<RequiredContextsResolution> {
  const { owner, repo, baseRef, headSha } = input;
  if (!baseRef) {
    return deferOrBlock(
      `${owner}/${repo}@<no-base-ref>`,
      headSha,
      'base_ref_unavailable',
      'transient',
      env
    );
  }
  const key = branchKey(owner, repo, baseRef);

  const override = parseRequiredContextsOverride(env[REQUIRED_CONTEXTS_OVERRIDE_ENV]);
  const overrideContexts = override?.get(key);
  // `!== undefined`, not truthiness: an override of [] is an authoritative
  // "nothing is required", and treating it as absent would send a deliberately
  // unblocked branch back to the API that could not answer.
  if (overrideContexts !== undefined) {
    unknownAttempts.delete(key);
    logSourceOnce(
      `override:${key}`,
      { owner, repo, baseRef, contexts: overrideContexts, source: 'env_override' },
      'overseer.required_contexts.resolved'
    );
    return { state: 'known', contexts: overrideContexts, source: 'env_override' };
  }

  const attempts: { source: 'app_client' | 'pat_client'; fetch: StatusCheckContextsFetcher }[] = [];
  if (input.fetchWithAppClient) {
    attempts.push({ source: 'app_client', fetch: input.fetchWithAppClient });
  }
  if (input.fetchWithPatClient) {
    attempts.push({ source: 'pat_client', fetch: input.fetchWithPatClient });
  }

  let lastReason = attempts.length === 0 ? 'protection_api_unavailable' : 'lookup_failed';
  let failureKind: RequiredContextsFailureKind = attempts.length === 0 ? 'permission' : 'transient';

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const response = await attempt.fetch({ owner, repo, branch: baseRef });
      const contexts = normalizeContexts(response?.data);
      if (contexts === null) {
        lastReason = 'non_array_payload';
        failureKind = 'transient';
        continue;
      }
      unknownAttempts.delete(key);
      logSourceOnce(
        `${attempt.source}:${key}`,
        { owner, repo, baseRef, contexts, source: attempt.source },
        'overseer.required_contexts.resolved'
      );
      return { state: 'known', contexts, source: attempt.source };
    } catch (error) {
      const permission = isPermissionFailure(error);
      lastReason = permission ? 'permission_denied' : 'lookup_failed';
      failureKind = permission ? 'permission' : 'transient';
      const hasNextIdentity = index + 1 < attempts.length;
      // Only a PERMISSION failure justifies retrying under the other identity.
      // A 5xx or a network fault is not an identity problem, and re-asking as a
      // different principal would just double the load on a struggling API.
      if (!permission || !hasNextIdentity) {
        log.warn(
          { err: error, owner, repo, baseRef, source: attempt.source, reason: lastReason },
          'overseer.required_contexts.lookup_failed'
        );
        break;
      }
      log.warn(
        { err: error, owner, repo, baseRef, source: attempt.source },
        'overseer.required_contexts.permission_denied_trying_next_identity'
      );
    }
  }

  // No identity could read the protection endpoint. Before deferring, ask
  // whether the branch is genuinely unprotected -- bdc-xo main is, and mapping
  // that to UNKNOWN is what parked its PRs forever. An authoritative EMPTY set
  // is a real answer, not a fallback: it says "nothing is required here".
  if (await hasPositiveUnprotectedEvidence(input, baseRef)) {
    unknownAttempts.delete(key);
    logSourceOnce(
      `unprotected:${key}`,
      { owner, repo, baseRef, source: 'unprotected_branch', lastReason },
      'overseer.required_contexts.branch_unprotected_no_required_contexts'
    );
    return { state: 'known', contexts: [], source: 'unprotected_branch' };
  }

  return deferOrBlock(key, headSha, lastReason, failureKind, env);
}

/**
 * Fail closed (DEFER) until the consecutive-UNKNOWN bound for this head is
 * passed, then report EXHAUSTED so the reviewer can BLOCK visibly.
 *
 * EXHAUSTED never carries a set of contexts and never routes to the heuristic:
 * the caller must treat it as a terminal, non-approving outcome.
 */
function deferOrBlock(
  key: string,
  headSha: string,
  reason: string,
  failureKind: RequiredContextsFailureKind,
  env: NodeJS.ProcessEnv
): RequiredContextsResolution {
  const maxAttempts = resolveMaxAttempts(env[REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]);
  const existing = unknownAttempts.get(key);
  // A new head restarts the bound: the previous head's failures say nothing
  // about this one, and inheriting them would block a fresh PR immediately.
  const attempts = existing?.headSha === headSha ? existing.attempts + 1 : 1;
  unknownAttempts.set(key, { headSha, attempts });

  if (attempts >= maxAttempts) {
    log.error(
      {
        key,
        headSha,
        attempts,
        maxAttempts,
        lastReason: reason,
        failureKind,
        reason: REQUIRED_CONTEXTS_BLOCKED_REASON,
      },
      'overseer.required_contexts.unavailable_blocking_review'
    );
    return {
      state: 'exhausted',
      reason: REQUIRED_CONTEXTS_BLOCKED_REASON,
      attempts,
      failureKind,
    };
  }

  log.warn(
    { key, headSha, attempts, maxAttempts, reason, failureKind },
    'overseer.required_contexts.unknown_deferring_review'
  );
  return { state: 'unknown', reason, failureKind };
}
