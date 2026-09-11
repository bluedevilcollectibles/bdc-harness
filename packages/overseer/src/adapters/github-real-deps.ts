import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createLogger } from '@archon/paths';
import type {
  DiscoveredPullRequest,
  GitHubClientDeps,
  GitHubOpenPullRequestListInput,
  GitHubPullRequestMergeInput,
  GitHubPullRequestSearchInput,
  PullRequestCheckSummary,
  PullRequestEvidence,
  PullRequestRef,
} from '../types.ts';
import { resolveRequiredContexts } from './required-contexts';
import type {
  AttemptCounterStore,
  REQUIRED_CONTEXTS_BLOCKED_REASON,
  RequiredContextsFailureKind,
} from './required-contexts.ts';
import { createDurableAttemptCounterStore } from './required-contexts-store';

const log = createLogger('overseer/github-real-deps');

const RATE_LIMIT_BACKOFF_MS = 60_000;
let rateLimitBackoffUntil = 0;
let rateLimitLastLoggedAt = 0;

interface FindPullRequestLogger {
  error(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface FindPullRequestOptions {
  logger?: FindPullRequestLogger;
  now?: () => number;
}

function isGitHubRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    message?: unknown;
    response?: { headers?: Record<string, unknown> };
  };
  if (candidate.status !== 403) return false;
  const remaining = candidate.response?.headers?.['x-ratelimit-remaining'];
  return (
    String(remaining) === '0' ||
    (typeof candidate.message === 'string' && /rate limit/i.test(candidate.message))
  );
}

/** The lookup ran and found nothing. A genuine "this PR does not exist". */
const MISSING_EVIDENCE: PullRequestEvidence = {
  exists: false,
  state: 'missing',
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  mergeable: null,
  lookupFailed: false,
};

/**
 * The lookup itself broke (API error, rate limit, bad credentials) so we learned
 * NOTHING about whether a PR exists. Distinct from MISSING_EVIDENCE: both keep the
 * merge door shut, but only this one means "ask again", and conflating them is what
 * let 493 unactioned runs report a confident "no PR" that was never established.
 */
const LOOKUP_FAILED_EVIDENCE: PullRequestEvidence = {
  exists: false,
  state: 'lookup_failed',
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  mergeable: null,
  lookupFailed: true,
};

/**
 * Minimal Octokit surface this module depends on. Kept narrow and structurally
 * typed (not `import type { Octokit }` directly) so tests can pass a plain
 * mock object without constructing a real client.
 */
export interface RealGitHubOctokitLike {
  pulls: {
    list(input: Record<string, unknown>): Promise<{
      data: {
        number: number;
        title: string;
        state: string;
        merged_at?: string | null;
        html_url: string;
        head: { sha: string; ref?: string };
        // Present on the real API; optional here so existing narrow mocks that
        // only exercise the head-branch fast path keep type-checking.
        draft?: boolean;
        base?: { ref?: string };
        body?: string | null;
      }[];
    }>;
    get(input: Record<string, unknown>): Promise<{
      data: {
        number: number;
        title: string;
        state: string;
        merged?: boolean;
        mergeable?: boolean | null;
        additions?: number;
        deletions?: number;
        html_url: string;
        changed_files?: number;
        head: { sha: string };
        base?: { sha: string; ref?: string };
      };
    }>;
    merge(input: {
      owner: string;
      repo: string;
      pull_number: number;
      sha: string;
      merge_method: 'squash';
    }): Promise<{ data: { merged: boolean; sha?: string | null } }>;
    /**
     * Optional so unrelated mocks (e.g. github-qualified-merge.test.ts's
     * createOctokitMock) that never approve keep type-checking. The real
     * approve path guards for its absence and throws loudly.
     */
    /**
     * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 widened `event` from the
     * APPROVE-only literal to the two events a real reviewer needs, and added
     * the optional `body` that REQUEST_CHANGES requires (GitHub rejects a
     * REQUEST_CHANGES review with no body). APPROVE-only callers are
     * unaffected: `body` is optional and 'APPROVE' remains assignable.
     *
     * `commit_id` REQUIRED (WO-HARNESS-OVERSEER-PR-REVIEW-ROUTE-01 stop
     * condition 4, review finding 2026-08-18): without it GitHub binds the
     * review to whatever the head is AT API-CALL TIME, not the exact commit
     * the reviewer evaluated. A push between review-start and submission
     * would silently land an approval on unreviewed code.
     */
    createReview?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      // COMMENT added for #775: the non-approving, non-rejecting event used
      // when the reviewer cannot form a verdict at all.
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      body?: string;
      commit_id: string;
    }): Promise<{ data: { id: number; state: string } }>;
    listReviews?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
      /**
       * 1-based page. REQUIRED to read past review 100: a busy PR's LATEST
       * review -- exactly where a late CHANGES_REQUESTED lands -- falls off the
       * first page, and an unpaginated read cannot see it.
       */
      page?: number;
    }): Promise<{
      data: { user: { login?: string | null } | null; state: string; commit_id: string }[];
    }>;
  };
  /**
   * GraphQL entry point. Optional so narrow test mocks and any REST-only client
   * keep type-checking. When present, PR-first discovery reads GitHub's OWN
   * aggregate `reviewDecision` -- which alone accounts for required approval
   * counts and CODEOWNERS rules that REST reviews cannot express -- instead of
   * deriving a substitute.
   */
  graphql?: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
  search: {
    issuesAndPullRequests(input: Record<string, unknown>): Promise<{
      data: { items: { number: number; pull_request?: unknown; repository_url?: string }[] };
    }>;
  };
  issues?: {
    createComment(input: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { html_url?: string } }>;
    /**
     * Optional: existing issue/PR comments, newest page last. Present on the
     * real Octokit client; omitted by narrow test mocks. Used to make a posted
     * notice idempotent by searching for its marker (#797) -- a caller that
     * cannot read comments must NOT post blind, or a redelivery duplicates it.
     */
    listComments?(input: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page: number;
      page?: number;
    }): Promise<{ data: { body?: string | null }[] }>;
  };
  checks: {
    listForRef(input: Record<string, unknown>): Promise<{
      data: {
        check_runs: { name?: string; status: string; conclusion: string | null }[];
      };
    }>;
  };
  repos?: {
    compareCommits(input: {
      owner: string;
      repo: string;
      base: string;
      head: string;
    }): Promise<{ data: { files?: { filename: string; patch?: string }[] } }>;
    /**
     * Optional: branch-protection required status-check contexts for a branch.
     * Present on the real Octokit client; omitted by narrow test mocks. Returns
     * the enforced context names. GitHub answers 404 BOTH when the branch is
     * unprotected AND when the token cannot see protection (it masks 403 as 404
     * on admin-scoped endpoints), so a failure is never authoritative evidence
     * that no required contexts exist -- callers must treat it as "unknown".
     */
    getAllStatusCheckContexts?(input: {
      owner: string;
      repo: string;
      branch: string;
    }): Promise<{ data: string[] }>;
    /**
     * Optional: repository ruleset rules that apply to a branch. Unlike the
     * admin-scoped protection endpoint, this is readable by the App
     * installation AND the PAT, which is what makes an empty array usable as
     * POSITIVE evidence that a branch enforces nothing.
     */
    getBranchRules?(input: {
      owner: string;
      repo: string;
      branch: string;
    }): Promise<{ data: unknown[] }>;
    /**
     * Optional: the branch itself. `protected: false` is the second half of the
     * positive-unprotected signature (paired with an empty rules array).
     */
    getBranch?(input: {
      owner: string;
      repo: string;
      branch: string;
    }): Promise<{ data: { protected?: boolean; protection?: { enabled?: boolean } } }>;
  };
}

/**
 * COMPILE-TIME GUARD on the method NAMES above (#777 review).
 *
 * `RealGitHubOctokitLike` is a hand-written structural stand-in, and the real
 * clients reach it through `as unknown as RealGitHubOctokitLike` -- a cast that
 * asserts the shape rather than checking it. Two things therefore used to be
 * invisible: a method we name that Octokit does not actually have, and a method
 * Octokit renames out from under us. Either one makes `bindRepoMethod` return
 * `undefined` at runtime, which silently disables positive unprotected-branch
 * detection: the probe never answers, the counter climbs, and a genuinely
 * unprotected base gets BLOCKED instead of resolving to an authoritative empty
 * set. The hand mocks in the tests cannot catch it either, because they
 * implement whatever name we invented.
 *
 * `RealOctokitReposMethodName` is every optional method name we declare, and it
 * is constrained to `keyof RealOctokitRepos`. If a name here does not exist on
 * the installed @octokit/rest, this file fails to compile with a clear error
 * instead of failing quietly in production. Verified 2026-09-08 against
 * @octokit/rest 22.0.1 / plugin-rest-endpoint-methods 17.0.0: `repos` exposes
 * `getBranchRules` (route `GET /repos/{owner}/{repo}/rules/branches/{branch}`).
 * There is no `getRulesForBranch` on this version.
 */
type RealOctokitRepos = InstanceType<typeof Octokit>['repos'];

/**
 * A name that exists on BOTH our stand-in and the real client.
 *
 * Constrained against `keyof RealOctokitRepos` DIRECTLY, not via `Extract`. An
 * earlier cut of this guard used `Extract<ours, theirs>`, which silently DROPS a
 * name the real client lacks instead of rejecting it -- so the bad name simply
 * vanished from the union and everything still compiled. Verified by
 * substituting `getRulesForBranch` and watching tsc exit 0. The constraint below
 * has nowhere to put an unknown name, so it errors instead.
 */
type RealOctokitReposMethodName = keyof RealOctokitRepos;

/**
 * Every name we bind, checked against the real client at COMPILE time.
 *
 * `satisfies` is what does the work: each literal must be assignable to
 * `RealOctokitReposMethodName`, so a method the installed @octokit/rest does not
 * expose -- a typo, an invention, or a name Octokit later renames -- fails the
 * build here rather than returning `undefined` in production.
 */
export const BOUND_REPOS_METHODS = [
  'getAllStatusCheckContexts',
  'getBranchRules',
  'getBranch',
] as const satisfies readonly RealOctokitReposMethodName[];

/**
 * The bound names, additionally required to exist on our own stand-in so
 * `bindRepoMethod` can index it. Both halves are enforced: `satisfies` above
 * pins them to the real client, this pins them to the interface.
 */
export type BoundReposMethodName = (typeof BOUND_REPOS_METHODS)[number] &
  keyof NonNullable<RealGitHubOctokitLike['repos']>;

export interface ExactHeadPullRequestEvidence {
  diff: string;
  checks: { name: string; status: string; conclusion: string | null }[];
  /**
   * Required status-check contexts enforced on the PR's base branch.
   *
   * Tri-state, and the distinction is load-bearing:
   * - `string[]` (possibly empty) -- an AUTHORITATIVE answer. Empty means the
   *   base branch genuinely enforces no required contexts.
   * - `null` -- UNKNOWN. The authoritative set could not be obtained (missing
   *   permission, transient API error, unsupported/unreadable protection
   *   config, or an API surface that cannot answer). The reviewer defers on
   *   `null`; it must never be collapsed into "no required contexts", which
   *   would let one fast completed check trigger review before the rest of the
   *   required suite registers.
   */
  requiredContexts: string[] | null;
  /**
   * Set when the required-contexts lookup has failed on CONSECUTIVE attempts
   * past the configured bound for this head (#775). It is NOT a third value of
   * `requiredContexts`: the set is still unknown, so `requiredContexts` stays
   * `null` and `checksAreTerminal` still fails closed. This flag only tells the
   * reviewer to stop deferring and BLOCK visibly instead -- a PR comment plus
   * an operator escalation, never an approval and never a downgrade to the
   * reported-checks heuristic.
   */
  requiredContextsBlocked?: {
    reason: typeof REQUIRED_CONTEXTS_BLOCKED_REASON;
    attempts: number;
    failureKind: RequiredContextsFailureKind;
  };
}

/**
 * Read review evidence with every ref-addressable call pinned to headSha.
 *
 * `patOctokit` is the PAT-identity client used ONLY as the second identity for
 * the branch-protection lookup. The GitHub App installation lacks that
 * permission (2026-09-07 incident: HTTP 403 "Resource not accessible by
 * integration" on every tick), while the PAT in the same container can read it.
 * Every other call stays on the primary client so review attribution is
 * unchanged. Omit it and the resolver simply has one fewer identity to try.
 */
/**
 * Bind one optional `repos` method to its own client, or return undefined when
 * the client or the method is absent.
 *
 * Octokit's REST methods are plugin-decorated closures that read `this` for the
 * request machinery, so handing the resolver a bare `octokit.repos.getBranch`
 * reference would invoke it detached. Binding here also satisfies
 * `@typescript-eslint/unbound-method`, which flags exactly this hazard.
 */
function bindRepoMethod<K extends BoundReposMethodName>(
  client: RealGitHubOctokitLike | undefined,
  method: K
): NonNullable<NonNullable<RealGitHubOctokitLike['repos']>[K]> | undefined {
  const repos = client?.repos;
  const fn = repos?.[method];
  if (typeof fn !== 'function') return undefined;
  return fn.bind(repos) as NonNullable<NonNullable<RealGitHubOctokitLike['repos']>[K]>;
}

/**
 * @param attemptStore Where the required-contexts deferral counts are kept.
 *   Defaults to the DURABLE store, because this is the long-running reviewer
 *   path: a process-local count resets on every container rebuild and is split
 *   across worker processes, so the bound it feeds would never arrive and the
 *   deferral would still be forever (#777 review). Injectable so tests can
 *   substitute an in-memory store rather than stand up a database.
 */
export function createRealFetchExactHeadPullRequestEvidence(
  octokit: RealGitHubOctokitLike,
  patOctokit?: RealGitHubOctokitLike,
  attemptStore: AttemptCounterStore = createDurableAttemptCounterStore()
): (input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}) => Promise<ExactHeadPullRequestEvidence> {
  return async input => {
    const pr = await octokit.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      head_sha: input.headSha,
    });
    if (pr.data.head.sha !== input.headSha) {
      throw new Error('pr_review_head_moved');
    }
    const baseSha = pr.data.base?.sha;
    if (!baseSha || !octokit.repos) {
      throw new Error('pr_review_diff_api_unavailable');
    }
    const [comparison, checkRuns] = await Promise.all([
      octokit.repos.compareCommits({
        owner: input.owner,
        repo: input.repo,
        base: baseSha,
        head: input.headSha,
      }),
      octokit.checks.listForRef({
        owner: input.owner,
        repo: input.repo,
        ref: input.headSha,
        per_page: 100,
      }),
    ]);
    // Required status-check contexts on the base branch are the authoritative
    // complete-suite signal: without them, one fast check completing before the
    // rest of CI registers could trigger review prematurely.
    //
    // This lookup FAILS CLOSED. Any inability to obtain the authoritative set
    // -- unreadable/absent branch protection (GitHub returns 404 both when a
    // branch is unprotected and when the token lacks admin scope, so 404 is not
    // distinguishable and is NOT evidence of "no required checks"), a transient
    // API error, an API surface that cannot answer, or a non-array payload --
    // yields `null` (UNKNOWN), and the reviewer defers rather than falling back
    // to the weaker reported-checks heuristic. Deferral is retried with backoff
    // by the review worker, so an unknown state re-resolves as soon as the
    // lookup succeeds; it is never silently downgraded to an approval path.
    const baseRef = pr.data.base?.ref;
    const resolution = await resolveRequiredContexts({
      owner: input.owner,
      repo: input.repo,
      baseRef,
      headSha: input.headSha,
      // Every fetcher is bound to its own client. Octokit's REST methods read
      // `this` for the request machinery, so passing the bare method reference
      // would call it detached and throw at request time.
      fetchWithAppClient: bindRepoMethod(octokit, 'getAllStatusCheckContexts'),
      // The App installation lacks the branch-protection permission (2026-09-07
      // incident); the PAT in the same container can read it. Absent when no
      // separate PAT client was supplied.
      fetchWithPatClient: bindRepoMethod(patOctokit, 'getAllStatusCheckContexts'),
      fetchBranchRules:
        bindRepoMethod(octokit, 'getBranchRules') ?? bindRepoMethod(patOctokit, 'getBranchRules'),
      fetchBranch: bindRepoMethod(octokit, 'getBranch') ?? bindRepoMethod(patOctokit, 'getBranch'),
      // Durable by default. The bound only means anything if the count survives
      // this process (#777 review [major]).
      attemptStore,
    });
    // EXHAUSTED does NOT relax `requiredContexts`: the set is still unknown, so
    // it stays `null` and checksAreTerminal still fails closed. The separate
    // flag is what tells the reviewer to stop deferring and block visibly.
    // Collapsing the two would be the silent downgrade this fix exists to
    // prevent (#775).
    const requiredContexts: string[] | null =
      resolution.state === 'known' ? resolution.contexts : null;
    return {
      ...(resolution.state === 'exhausted'
        ? {
            requiredContextsBlocked: {
              reason: resolution.reason,
              attempts: resolution.attempts,
              failureKind: resolution.failureKind,
            },
          }
        : {}),
      diff: (comparison.data.files ?? [])
        .map(file => `--- ${file.filename}\n${file.patch ?? '[binary or patch unavailable]'}`)
        .join('\n'),
      checks: checkRuns.data.check_runs.map((run, index) => ({
        name: run.name?.trim() || `check-${index + 1}`,
        status: run.status,
        conclusion: run.conclusion,
      })),
      requiredContexts,
    };
  };
}

/** Resolve the GitHub token from the standard env vars. No fallback secrets. */
export function resolveGitHubToken(): string {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  if (!token) {
    throw new Error(
      'overseer_real_adapter_missing_github_token: set GH_TOKEN or GITHUB_TOKEN to run Overseer in real mode'
    );
  }
  return token;
}

/** Resolved GitHub App installation-auth configuration. */
export interface GitHubAppAuthConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

/**
 * Resolve GitHub App (installation) auth from env, or null when no App vars are
 * set at all.
 *
 * Precedence contract (see WO-HARNESS-OVERSEER-APP-AUTH-01 sec 4.2 + risk 10):
 * - NONE of the App vars set  -> return null. Caller falls back to the PAT path.
 *   This is the "absent" case, and it is the ONLY case that falls back.
 * - App auth requested but incomplete/broken (any App var set, but the trio does
 *   not fully resolve to a real PEM) -> THROW naming the offending var. We never
 *   silently degrade to the PAT here: a half-configured App downgrading to John's
 *   PAT identity is the exact failure this WO exists to prevent.
 *
 * Private key may come from GITHUB_APP_PRIVATE_KEY (raw PEM contents, with
 * literal "\n" sequences from single-line env packing normalized to newlines) or
 * GITHUB_APP_PRIVATE_KEY_PATH (a file read at resolution time). Inline contents
 * win when both are set.
 */
export function resolveGitHubAppAuth(): GitHubAppAuthConfig | null {
  const appId = (process.env.GITHUB_APP_ID ?? '').trim();
  const installationId = (process.env.GITHUB_APP_INSTALLATION_ID ?? '').trim();
  const privateKeyInline = process.env.GITHUB_APP_PRIVATE_KEY ?? '';
  const privateKeyPath = (process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? '').trim();

  const anyAppVarPresent =
    appId !== '' ||
    installationId !== '' ||
    privateKeyInline.trim() !== '' ||
    privateKeyPath !== '';
  if (!anyAppVarPresent) {
    return null; // Absent -> PAT fallback (the only fallback path).
  }

  // From here App auth was requested; any gap is a loud failure, never a PAT downgrade.
  if (appId === '') {
    throw new Error(
      'overseer_github_app_auth_incomplete: GITHUB_APP_ID is missing but other GITHUB_APP_* vars are set'
    );
  }
  if (installationId === '') {
    throw new Error(
      'overseer_github_app_auth_incomplete: GITHUB_APP_INSTALLATION_ID is missing but other GITHUB_APP_* vars are set'
    );
  }

  let privateKey = privateKeyInline;
  if (privateKey.trim() === '' && privateKeyPath !== '') {
    try {
      privateKey = readFileSync(privateKeyPath, 'utf8');
    } catch (error) {
      throw new Error(
        `overseer_github_app_auth_private_key_unreadable: could not read GITHUB_APP_PRIVATE_KEY_PATH (${privateKeyPath}): ${(error as Error).message}`
      );
    }
  }

  // Normalize single-line "\n"-packed PEMs back to real newlines. A PEM already
  // carrying real newlines (the file-path case) is unaffected by this replace.
  privateKey = privateKey.replace(/\\n/g, '\n').trim();

  if (privateKey === '') {
    throw new Error(
      'overseer_github_app_auth_private_key_missing: set GITHUB_APP_PRIVATE_KEY (PEM contents) or GITHUB_APP_PRIVATE_KEY_PATH'
    );
  }
  // Validate by actually parsing the key material, not just sniffing for a
  // "-----BEGIN" substring. A substring check passes truncated/garbage PEM bodies
  // (or a stray marker inside otherwise-invalid content) that then fail on the
  // FIRST signed API call -- far from this construction site and much harder to
  // diagnose. createPrivateKey throws synchronously on any malformed PEM (missing
  // marker, corrupted base64, truncated body, unsupported format), so a config
  // that resolves here is a key the auth strategy can actually sign JWTs with.
  try {
    createPrivateKey(privateKey);
  } catch (error) {
    throw new Error(
      `overseer_github_app_auth_private_key_malformed: GITHUB_APP_PRIVATE_KEY is not a valid PEM private key (${(error as Error).message})`
    );
  }

  return { appId, installationId, privateKey };
}

/**
 * Octokit constructor options for real mode. App installation auth wins when App
 * vars are complete; otherwise the PAT path. Exposed as a network-free seam so
 * tests can assert which identity was selected without constructing a live
 * client or making an API call.
 */
export type RealOctokitAuthOptions =
  | {
      authStrategy: typeof createAppAuth;
      auth: { appId: string; privateKey: string; installationId: string };
    }
  | { auth: string };

export function resolveRealOctokitAuthOptions(): RealOctokitAuthOptions {
  const appAuth = resolveGitHubAppAuth();
  if (appAuth) {
    return {
      authStrategy: createAppAuth,
      auth: {
        appId: appAuth.appId,
        privateKey: appAuth.privateKey,
        installationId: appAuth.installationId,
      },
    };
  }
  return { auth: resolveGitHubToken() };
}

/**
 * Construct a real Octokit client. Uses GitHub App installation auth when the
 * App env vars are complete (attributing API calls to thinman-overseer[bot]),
 * otherwise falls back to the GH_TOKEN/GITHUB_TOKEN PAT path unchanged.
 */
export function createRealOctokitClient(): RealGitHubOctokitLike {
  return new Octokit(resolveRealOctokitAuthOptions()) as unknown as RealGitHubOctokitLike;
}

/**
 * Construct a PAT-identity Octokit client, or null when no PAT is configured.
 *
 * Used ONLY as the second identity for the branch-protection required-contexts
 * lookup, which the GitHub App installation cannot read. This is deliberately
 * NOT a general fallback client: reviews, comments and merges keep their own
 * identities, and nothing here widens what the PAT is used for.
 */
export function createRealReadOnlyPatOctokitClient(): RealGitHubOctokitLike | null {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  if (!token) return null;
  return new Octokit({ auth: token }) as unknown as RealGitHubOctokitLike;
}

/**
 * M-153 identity separation seam: the MERGE mutation must not run as the
 * Review Gate identity ("review and merge are separate actors", John
 * 2026-08-24). When MERGE_MANAGER_GH_TOKEN is set, merges are executed with
 * that PAT identity while reviews keep the App identity. When it is unset,
 * the merge octokit falls back to the shared resolution -- callers that
 * enforce M-153 must treat that as the single-identity condition and hold.
 */
export const MERGE_MANAGER_GH_TOKEN_ENV = 'MERGE_MANAGER_GH_TOKEN' as const;

export function hasDistinctMergeIdentity(): boolean {
  return Boolean(process.env[MERGE_MANAGER_GH_TOKEN_ENV]);
}

export function createRealMergeOctokitClient(): RealGitHubOctokitLike {
  const mergeToken = process.env[MERGE_MANAGER_GH_TOKEN_ENV];
  if (mergeToken) {
    return new Octokit({ auth: mergeToken }) as unknown as RealGitHubOctokitLike;
  }
  return createRealOctokitClient();
}

export function summarizeChecks(
  checkRuns: { status: string; conclusion: string | null }[]
): PullRequestCheckSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const run of checkRuns) {
    if (run.status !== 'completed') {
      pending += 1;
      continue;
    }
    if (
      run.conclusion === 'success' ||
      run.conclusion === 'neutral' ||
      run.conclusion === 'skipped'
    ) {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return { total: checkRuns.length, passed, failed, pending };
}

/**
 * Real findPullRequest: looks up an open PR by head branch first (fast path),
 * falling back to a WO-ID title/body search (mirrors reconcile.ts's approach)
 * when no headBranch is supplied. Evidence fields are populated only from
 * live API data -- no invented defaults beyond the documented "missing" shape.
 */
export function createRealFindPullRequest(
  octokit: RealGitHubOctokitLike,
  options: FindPullRequestOptions = {}
): (input: GitHubPullRequestSearchInput) => Promise<PullRequestEvidence> {
  const logger = options.logger ?? log;
  const now = options.now ?? Date.now;
  return async (input: GitHubPullRequestSearchInput): Promise<PullRequestEvidence> => {
    if (now() < rateLimitBackoffUntil) return LOOKUP_FAILED_EVIDENCE;
    try {
      // An explicit number is the only UNIQUE key GitHub offers here. When the
      // caller has it (PR-first discovery always does), address the PR directly
      // and skip the branch/WO search entirely -- `pulls.list` by head branch
      // takes `data[0]` of up to 5 matches, so a branch name shared across forks
      // resolves to whichever GitHub happened to order first.
      let prNumber: number | null = input.prNumber ?? null;

      if (prNumber === null && input.headBranch) {
        const list = await octokit.pulls.list({
          owner: input.owner,
          repo: input.repo,
          head: `${input.owner}:${input.headBranch}`,
          state: 'all',
          per_page: 5,
        });
        prNumber = list.data[0]?.number ?? null;
      }

      // 'unknown' is parseWoId's could-not-parse fallback, not a WO id --
      // searching for the literal word would return garbage matches.
      if (prNumber === null && input.woId && input.woId !== 'unknown') {
        const search = await octokit.search.issuesAndPullRequests({
          // Title AND body: lanes title PRs freely (anchor: canary PR #705,
          // 'docs(canary): add e2e merge canary marker' -- WO id only in the
          // body; in:title returned nothing and the run was wrongly closed as
          // 'no PR'. 9th canary defect, 2026-08-26).
          q: `repo:${input.owner}/${input.repo} is:pr "${input.woId}"`,
          per_page: 5,
        });
        const match = search.data.items.find(item => item.pull_request);
        prNumber = match?.number ?? null;
      }

      if (prNumber === null) {
        rateLimitBackoffUntil = 0;
        rateLimitLastLoggedAt = 0;
        return MISSING_EVIDENCE;
      }

      let pr = await octokit.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: prNumber,
      });

      // GitHub computes mergeable ASYNCHRONOUSLY: null means "still computing,
      // check back shortly" (per GitHub's own docs), NOT "unmergeable" -- that's
      // `false`. 12th canary defect (2026-08-26): CANARY-02's judge read
      // mergeable:null moments after checks went green and correctly verdicted
      // `observe` (refusing to guess) -- but nothing ever re-asked, so the PR
      // sat merge-ready-looking forever with no automatic recheck. Poll a few
      // times with short backoff before handing evidence to the judge, so the
      // judge sees GitHub's real answer instead of a transient "don't know yet".
      for (let attempt = 0; pr.data.mergeable === null && attempt < 3; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        pr = await octokit.pulls.get({
          owner: input.owner,
          repo: input.repo,
          pull_number: prNumber,
        });
      }

      const checkRunsResp = await octokit.checks.listForRef({
        owner: input.owner,
        repo: input.repo,
        ref: pr.data.head.sha,
        per_page: 100,
      });
      const checks = summarizeChecks(checkRunsResp.data.check_runs);

      const state = pr.data.merged ? 'merged' : pr.data.state;

      const evidence: PullRequestEvidence = {
        exists: true,
        state,
        checks,
        mergeable: pr.data.mergeable ?? null,
        pr: { owner: input.owner, repo: input.repo, number: pr.data.number },
        prTitle: pr.data.title,
        filesChangedCount: pr.data.changed_files,
        // 16th canary defect (2026-08-26): diffStat was never populated
        // anywhere, so the second-opinion judge saw 'Diff stat:' blank and
        // -- reasonably -- HELD every merge as under-evidenced. GitHub's
        // pulls.get already returns the numbers; render the conventional
        // shortstat line.
        diffStat:
          typeof pr.data.changed_files === 'number'
            ? pr.data.changed_files +
              ' file(s) changed, ' +
              (pr.data.additions ?? 0) +
              ' insertion(s), ' +
              (pr.data.deletions ?? 0) +
              ' deletion(s)'
            : undefined,
        htmlUrl: pr.data.html_url,
        // Provenance anchor: GitHub's own view of the PR head, not run metadata.
        headSha: pr.data.head.sha,
      };
      rateLimitBackoffUntil = 0;
      rateLimitLastLoggedAt = 0;
      return evidence;
    } catch (error) {
      const timestamp = now();
      if (isGitHubRateLimitError(error)) {
        rateLimitBackoffUntil = timestamp + RATE_LIMIT_BACKOFF_MS;
        if (
          timestamp - rateLimitLastLoggedAt >= RATE_LIMIT_BACKOFF_MS ||
          rateLimitLastLoggedAt === 0
        ) {
          rateLimitLastLoggedAt = timestamp;
          logger.warn(
            { err: error, input, backoffMs: RATE_LIMIT_BACKOFF_MS },
            'overseer.github_real_deps.rate_limit_backoff'
          );
        }
        return LOOKUP_FAILED_EVIDENCE;
      }
      // 422 'cannot be searched' = the repo does not exist or this credential
      // (the App installation) has no access to it. PERMANENT for us: a repo
      // the App cannot read is a repo the Merge Manager could never act on.
      // 7th canary defect (2026-08-25): 102 legacy runs pointing at repos
      // outside the App's grant cycled forever as 'transient' failures.
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : undefined;
      if (status === 422) {
        logger.warn(
          { owner: input.owner, repo: input.repo, woId: input.woId },
          'overseer.github_real_deps.repo_unsearchable_permanent'
        );
        return MISSING_EVIDENCE;
      }
      logger.error({ err: error, input }, 'overseer.github_real_deps.find_pull_request_failed');
      return LOOKUP_FAILED_EVIDENCE;
    }
  };
}

/**
 * Real mergePullRequest for the GitHubClientDeps / merge-manager composition.
 *
 * NOTE: this deliberately calls octokit.pulls.merge directly rather than
 * routing through adapters/github-qualified-merge.ts's
 * createGitHubQualifiedMergeAdapter(). That adapter's attemptMerge() takes a
 * QualifiedMergeAdapterRequestV2 -- a permit/proposal/execution/digest-signed
 * request assembled only by the actions/merge-ready.ts assessor flow (a
 * separate, older merge path). merge-manager.ts's own doc comment says it
 * "deliberately does not call the legacy merge-ready assessment path"; wiring
 * this GitHubClientDeps.mergePullRequest through that adapter would require
 * fabricating permit_id/proposal_id/digest fields that mean something real
 * only in that other flow. This function instead composes the qualified
 * merge adapter's httpStatus-based error classification (409/422 =
 * rejected, other transport errors = ambiguous) directly against the plain
 * PR-ref input merge-manager.ts already provides.
 */
export function createRealMergePullRequest(
  octokit: RealGitHubOctokitLike
): (
  input: GitHubPullRequestMergeInput
) => Promise<{ merged: boolean; message?: string; sha?: string }> {
  return async (
    input: GitHubPullRequestMergeInput
  ): Promise<{ merged: boolean; message?: string; sha?: string }> => {
    const pr = await octokit.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.number,
    });
    try {
      const response = await octokit.pulls.merge({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        sha: pr.data.head.sha,
        merge_method: 'squash',
      });
      if (!response.data.merged) {
        return { merged: false, message: 'github_merge_not_merged' };
      }
      return {
        merged: true,
        message: input.commitTitle,
        ...(response.data.sha ? { sha: response.data.sha } : {}),
      };
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : undefined;
      if (status === 409 || status === 422) {
        return { merged: false, message: `github_merge_rejected_${status}` };
      }
      return { merged: false, message: 'github_merge_transport_ambiguous' };
    }
  };
}

/**
 * Real approvePullRequest: submits an APPROVE review via octokit.pulls.createReview.
 *
 * This is the capability the App identity unlocks -- GitHub forbids a user from
 * approving their own PR, and John is the only human in the org, so only a second
 * identity (thinman-overseer[bot]) can record a required-review approval.
 *
 * Self-approval is still rejected by GitHub regardless of identity (an App cannot
 * approve a PR it authored). GitHub returns 422 with a body message containing
 * "own pull request"; we surface that as a stable, usable code
 * ('github_review_self_approval_rejected') rather than letting a raw Octokit
 * error escape -- mirroring createRealMergePullRequest's httpStatus classification.
 */
export function createRealApprovePullRequest(
  octokit: RealGitHubOctokitLike
): (input: PullRequestRef) => Promise<{ approved: boolean; message?: string }> {
  const submit = createRealSubmitPullRequestReview(octokit);
  return async (input: PullRequestRef): Promise<{ approved: boolean; message?: string }> => {
    // PullRequestRef carries no head SHA, and commit_id is now required
    // (stop condition 4): fetch the live head immediately before approving
    // so the review still binds to a real, current commit rather than
    // whatever GitHub would pick if commit_id were omitted.
    let commitId: string;
    try {
      const pr = await octokit.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
      });
      commitId = pr.data.head.sha;
    } catch {
      return { approved: false, message: 'github_review_head_lookup_failed' };
    }
    const result = await submit({ ...input, event: 'APPROVE', commitId });
    return result.message === undefined
      ? { approved: result.submitted }
      : { approved: result.submitted, message: result.message };
  };
}

/** Review events the Overseer App may submit. */
/**
 * COMMENT (added for #775) is the NON-APPROVING, non-rejecting event. It is
 * used when the reviewer cannot form a verdict at all -- the required
 * status-check contexts could not be read after the configured attempt bound --
 * so the PR carries a visible statement of why it is blocked without either
 * approving it or claiming a code finding that was never made.
 */
export type OverseerReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface SubmitPullRequestReviewInput extends PullRequestRef {
  event: OverseerReviewEvent;
  /** Evidence body. REQUIRED and non-empty for REQUEST_CHANGES. */
  body?: string;
  /**
   * REQUIRED. The exact commit the reviewer evaluated. Passed through to
   * GitHub as `commit_id` so the review binds to that commit specifically,
   * not to the PR's head at the moment the API call happens to run.
   */
  commitId: string;
}

export interface SubmitPullRequestReviewResult {
  submitted: boolean;
  message?: string;
}

/**
 * General review submission for the Overseer App identity
 * (WO-HARNESS-OVERSEER-REVIEW-ROUTE-01, XO decision 1 of 2026-08-17).
 *
 * Supports APPROVE and REQUEST_CHANGES -- both are available to a GitHub App
 * installation token holding `pull_requests: write`. A reviewer that cannot
 * reject is not a reviewer, so the non-approving path is a first-class
 * capability rather than a fail-closed-only stub.
 *
 * REQUEST_CHANGES requires a non-empty body: GitHub rejects a changes-requested
 * review with no explanation, and an empty rejection carries no evidence for
 * the author. That precondition is enforced locally, before any network call,
 * and returns the stable code 'github_review_missing_evidence_body'.
 *
 * Error classification mirrors createRealMergePullRequest's httpStatus
 * approach so callers get stable codes instead of raw Octokit errors.
 */
export function createRealSubmitPullRequestReview(
  octokit: RealGitHubOctokitLike
): (input: SubmitPullRequestReviewInput) => Promise<SubmitPullRequestReviewResult> {
  return async (input: SubmitPullRequestReviewInput): Promise<SubmitPullRequestReviewResult> => {
    if (!octokit.pulls.createReview) {
      throw new Error('overseer_real_adapter_missing_review_api');
    }
    const body = input.body?.trim() ?? '';
    // A COMMENT with no body says nothing at all, so it carries the same
    // non-empty precondition as REQUEST_CHANGES.
    if (input.event !== 'APPROVE' && body.length === 0) {
      return { submitted: false, message: 'github_review_missing_evidence_body' };
    }
    const expectedState =
      input.event === 'APPROVE'
        ? 'APPROVED'
        : input.event === 'COMMENT'
          ? 'COMMENTED'
          : 'CHANGES_REQUESTED';
    try {
      const response = await octokit.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        event: input.event,
        commit_id: input.commitId,
        ...(body.length > 0 ? { body } : {}),
      });
      if (response.data.state !== expectedState) {
        return {
          submitted: false,
          message: `github_review_unexpected_state_${response.data.state}`,
        };
      }
      return { submitted: true };
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : undefined;
      const messageValue =
        typeof error === 'object' && error !== null && 'message' in error
          ? (error as { message?: unknown }).message
          : undefined;
      const rawMessage = typeof messageValue === 'string' ? messageValue : '';
      if (status === 422 && /own pull request/i.test(rawMessage)) {
        return { submitted: false, message: 'github_review_self_approval_rejected' };
      }
      if (status === 422) {
        return { submitted: false, message: 'github_review_unprocessable' };
      }
      return { submitted: false, message: 'github_review_transport_ambiguous' };
    }
  };
}

/** Env var naming the Review Gate identity whose approval a candidate requires. */
export const DISCOVERY_REVIEW_GATE_LOGIN_ENV = 'MERGE_MANAGER_REVIEW_GATE_LOGIN' as const;

/** The Overseer App identity. Same default the Merge Manager's Review Gate uses. */
export const DEFAULT_REVIEW_GATE_LOGIN = 'thinman-overseer[bot]' as const;

export function resolveReviewGateLogin(
  raw: string | undefined = process.env[DISCOVERY_REVIEW_GATE_LOGIN_ENV]
): string {
  const trimmed = (raw ?? '').trim();
  return trimmed === '' ? DEFAULT_REVIEW_GATE_LOGIN : trimmed;
}

/** One review as the derivation reads it. `commitId` is the head it was left on. */
export interface ReviewForDecision {
  readonly login: string;
  readonly state: string;
  readonly commitId?: string;
}

export interface DeriveReviewDecisionOptions {
  /** Current PR head. An approval on any other commit does not count. */
  readonly headSha?: string;
  /** Identity that must be among the approvers. Defaults to the env/Overseer bot. */
  readonly reviewGateLogin?: string;
  /**
   * True when the caller could not prove it read EVERY review (a page was
   * dropped, the listing threw). An incomplete set can hide a later
   * CHANGES_REQUESTED, so it can never yield APPROVED.
   */
  readonly reviewsIncomplete?: boolean;
}

/**
 * Derive a PR's review decision CONSERVATIVELY from its individual reviews.
 *
 * THE DEFECT THIS CLOSES (Overseer review of d62d6dd5, [major])
 * ------------------------------------------------------------
 * The previous derivation returned APPROVED whenever any one reviewer's latest
 * state was APPROVED. That is not what GitHub's aggregate `reviewDecision`
 * means, and every gap between the two is in the PERMISSIVE direction -- it
 * admits PRs GitHub still considers review-required:
 *
 *  - REQUIRED APPROVAL COUNT. A branch requiring two approvals reads APPROVED
 *    off one. REST reviews cannot see the requirement at all.
 *  - CODE OWNERS. An approval from someone who owns none of the touched paths
 *    does not satisfy a CODEOWNERS rule, but looked identical here.
 *  - STALE COMMIT. An approval carries the `commit_id` it was left on. After a
 *    push it is stale and GitHub drops it from the aggregate (with dismiss-stale
 *    enabled), yet it still read as APPROVED -- authorizing a merge of code no
 *    one reviewed. This is the sharpest one: it turns discovery into a path
 *    around the Review Gate's own exact-head check.
 *  - PAGINATION. `per_page: 100` unpaginated. Review 101 -- typically the LATEST,
 *    which on a busy PR is where a CHANGES_REQUESTED lands -- was invisible.
 *
 * Since REST cannot answer the first two at all, this derivation does not
 * pretend to reconstruct GitHub's aggregate. It substitutes a STRICTER
 * predicate that the merge path already requires downstream, and only ever
 * errs toward not-approved:
 *
 *   (a) every review is read (see `reviewsIncomplete`),
 *   (b) an APPROVED counts only when its `commitId` equals the current head,
 *   (c) any standing CHANGES_REQUESTED blocks outright,
 *   (d) the Review Gate identity must be among the surviving approvers.
 *
 * (d) is what makes the strictness sound: the Merge Manager's `mergePreconditionMiss`
 * already refuses to merge without an exact-head APPROVED from that identity, so
 * requiring it at discovery admits nothing the merge path would not, and drops
 * PRs it would have refused later anyway. Where this is stricter than GitHub's
 * aggregate the cost is a PR that waits; where it is looser the cost is a wrong
 * merge. Prefer waiting. `createRealListOpenPullRequests` prefers GitHub's real
 * aggregate over this whenever a GraphQL client is available.
 *
 * Returns 'CHANGES_REQUESTED', 'APPROVED', or null. Null means "no decision
 * established" and is never treated as approval by the caller.
 */
export function deriveReviewDecision(
  reviews: readonly ReviewForDecision[],
  options: DeriveReviewDecisionOptions = {}
): string | null {
  const latestByReviewer = new Map<string, ReviewForDecision>();
  for (const review of reviews) {
    const state = review.state.toUpperCase();
    // COMMENTED and PENDING never replace a reviewer's standing verdict --
    // that is GitHub's own rule, and collapsing them would silently clear a
    // CHANGES_REQUESTED when the same reviewer later left a plain comment.
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') continue;
    latestByReviewer.set(review.login.toLowerCase(), { ...review, state });
  }

  const latest = [...latestByReviewer.values()];

  // A standing objection blocks even on an incomplete read: seeing one is
  // proof, unlike not seeing one.
  if (latest.some(review => review.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';

  // Beyond here we would be asserting the ABSENCE of an objection, which an
  // incomplete listing cannot support. Unknown is not approved.
  if (options.reviewsIncomplete) return null;

  // Without a head to compare against, staleness is unknowable -- and an
  // approval that cannot be proven current is not proven at all.
  const headSha = options.headSha;
  if (!headSha) return null;

  const gateLogin = (options.reviewGateLogin ?? resolveReviewGateLogin()).toLowerCase();
  const approvedOnHead = latest.filter(
    review => review.state === 'APPROVED' && review.commitId === headSha
  );
  if (approvedOnHead.length === 0) return null;
  if (!approvedOnHead.some(review => review.login.toLowerCase() === gateLogin)) return null;
  return 'APPROVED';
}

/** Pull a WO id out of a PR title or body, so evidence lookup can search by it. */
export function extractWoId(title: string, body: string | null | undefined): string | undefined {
  const match = /\bWO-[A-Z0-9][A-Z0-9-]*\b/.exec(`${title}\n${body ?? ''}`);
  return match?.[0];
}

/** Hard ceiling on review pages read per PR, so one pathological PR cannot spin the tick. */
const MAX_REVIEW_PAGES = 10;
const REVIEW_PAGE_SIZE = 100;

interface GraphQLReviewDecisionNode {
  number?: number;
  reviewDecision?: string | null;
}

/** Why GitHub's aggregate review decision was not usable for a sweep. */
export type ReviewDecisionUnavailableReason =
  | 'graphql_client_absent'
  | 'graphql_error'
  | 'graphql_empty_response';

export interface ReviewDecisionLookup {
  /**
   * GitHub's aggregate decision per PR number. Populated for every PR whose
   * batch succeeded; a PR missing from this map falls back to the conservative
   * REST derivation. Partial by design -- one failed batch no longer empties
   * the answers the other batches did obtain.
   */
  readonly decisions: Map<number, string | null>;
  /**
   * Set when at least one batch could not be read, so the PRs in THAT batch
   * fall back to the conservative REST derivation. Null on a clean read. Named
   * rather than boolean so the operator log says WHY. When several batches fail
   * for different reasons this reports the first, with the counts below giving
   * the shape.
   */
  readonly unavailableReason: ReviewDecisionUnavailableReason | null;
  /** Error class (constructor name) when `unavailableReason` is 'graphql_error'. */
  readonly errorClass?: string;
  /** GraphQL requests issued for this sweep -- one per batch. */
  readonly batchCount: number;
  /** How many of those batches failed and fell back to REST. */
  readonly failedBatchCount: number;
  /** PR numbers whose batch failed, so the caller can count the degradation. */
  readonly fallbackPrNumbers: readonly number[];
}

/**
 * PRs per GraphQL request.
 *
 * One aliased field per PR in a single unbounded request was the bug (Overseer
 * review of 8ada980c): GitHub costs a query by node count and complexity, so a
 * large alias set is rejected WHOLESALE. With the open-PR listing now paginating
 * to 1000, one bad request could dump every PR in the tick onto the sequential
 * REST path -- up to 1000 round trips, each itself paginated. 50 keeps each
 * query comfortably inside GitHub's limits and bounds the blast radius of any
 * single failure to the PRs in that batch.
 */
const REVIEW_DECISION_BATCH_SIZE = 50;

/**
 * Read GitHub's OWN aggregate `reviewDecision` for the listed PRs.
 *
 * This is the authoritative answer and is preferred over any local derivation,
 * because it is the only source that accounts for required approval COUNTS and
 * CODEOWNERS rules -- neither of which appears anywhere in the REST reviews
 * listing, and both of which the REST derivation was silently ignoring.
 *
 * A PR whose batch fails is simply ABSENT from the decision map, which sends it
 * to the conservative REST derivation -- never to an assumed approval. That
 * fallback is safe, but it is also STRICTER than GitHub's own answer, so it can
 * quietly hold PRs GitHub considers approved (an expired token alone would do
 * it). `unavailableReason` and the per-batch counts therefore travel back to the
 * caller, which logs them once per tick and counts the affected PRs in the
 * heartbeat. A silent degradation to a stricter gate is exactly the kind of
 * invisible stall #758 exists to end.
 *
 * BATCHED at REVIEW_DECISION_BATCH_SIZE. Failures are isolated per batch: the
 * PRs in a rejected request fall back, and every other batch keeps its answers.
 */
export async function fetchReviewDecisions(
  octokit: RealGitHubOctokitLike,
  input: { owner: string; repo: string; prNumbers: readonly number[] }
): Promise<ReviewDecisionLookup> {
  const decisions = new Map<number, string | null>();
  // Nothing to ask about is not a degradation -- there is nothing to fall back for.
  if (input.prNumbers.length === 0) {
    return {
      decisions,
      unavailableReason: null,
      batchCount: 0,
      failedBatchCount: 0,
      fallbackPrNumbers: [],
    };
  }
  if (!octokit.graphql) {
    return {
      decisions,
      unavailableReason: 'graphql_client_absent',
      batchCount: 0,
      failedBatchCount: 0,
      fallbackPrNumbers: [...input.prNumbers],
    };
  }

  const batches: number[][] = [];
  for (let start = 0; start < input.prNumbers.length; start += REVIEW_DECISION_BATCH_SIZE) {
    batches.push([...input.prNumbers.slice(start, start + REVIEW_DECISION_BATCH_SIZE)]);
  }

  let unavailableReason: ReviewDecisionUnavailableReason | null = null;
  let errorClass: string | undefined;
  let failedBatchCount = 0;
  const fallbackPrNumbers: number[] = [];

  for (const batch of batches) {
    // One aliased field per PR: GraphQL has no "pullRequests(numbers:)" filter,
    // so aliasing is how a batch is requested in a single round trip.
    const fields = batch
      .map(number => `  pr${number}: pullRequest(number: ${number}) { number reviewDecision }`)
      .join('\n');
    const query = `query($owner: String!, $repo: String!) {\n  repository(owner: $owner, name: $repo) {\n${fields}\n  }\n}`;

    try {
      // Invoked through `octokit` so a real client method keeps its receiver.
      const response = (await octokit.graphql?.(query, {
        owner: input.owner,
        repo: input.repo,
      })) as { repository?: Record<string, GraphQLReviewDecisionNode | null> } | null;
      const repository = response?.repository;
      if (!repository) {
        // This batch answered nothing usable. Only ITS PRs fall back.
        failedBatchCount += 1;
        fallbackPrNumbers.push(...batch);
        unavailableReason ??= 'graphql_empty_response';
        continue;
      }
      for (const node of Object.values(repository)) {
        if (!node || typeof node.number !== 'number') continue;
        decisions.set(node.number, node.reviewDecision ?? null);
      }
      // A batch that answered, but omitted PRs we asked about, leaves those PRs
      // absent from the map -- which is exactly the fallback signal. Count them
      // so a partially-answering batch is not reported as a clean read.
      const missing = batch.filter(number => !decisions.has(number));
      if (missing.length > 0) {
        fallbackPrNumbers.push(...missing);
        unavailableReason ??= 'graphql_empty_response';
      }
    } catch (error) {
      // A GraphQL failure must not admit anything, and must not discard the
      // batches that DID succeed: only this batch's PRs fall back.
      failedBatchCount += 1;
      fallbackPrNumbers.push(...batch);
      unavailableReason ??= 'graphql_error';
      errorClass ??= error instanceof Error ? error.constructor.name : typeof error;
    }
  }

  return {
    decisions,
    unavailableReason,
    ...(errorClass === undefined ? {} : { errorClass }),
    batchCount: batches.length,
    failedBatchCount,
    fallbackPrNumbers,
  };
}

/**
 * Read EVERY review on a PR, following pages.
 *
 * `per_page: 100` unpaginated was the bug: review 101 is invisible, and on a
 * busy PR the latest review -- where a late CHANGES_REQUESTED lands -- is
 * exactly the one past the first page. `complete` reports whether the whole set
 * was actually read; the derivation refuses to return APPROVED when it was not,
 * because asserting the absence of an objection requires having looked
 * everywhere it could be.
 */
export async function fetchAllPullRequestReviews(
  octokit: RealGitHubOctokitLike,
  input: { owner: string; repo: string; prNumber: number }
): Promise<{ reviews: ReviewForDecision[]; complete: boolean }> {
  if (!octokit.pulls.listReviews) return { reviews: [], complete: false };
  // Called through `octokit.pulls` rather than detached, so a real client method
  // keeps its receiver.
  const listReviews: NonNullable<RealGitHubOctokitLike['pulls']['listReviews']> = args =>
    octokit.pulls.listReviews?.(args) ?? Promise.resolve({ data: [] });

  const reviews: ReviewForDecision[] = [];
  for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
    let batch: Awaited<ReturnType<typeof listReviews>>;
    try {
      batch = await listReviews({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
        per_page: REVIEW_PAGE_SIZE,
        page,
      });
    } catch {
      // A dropped page means an unread review may exist. Return what we have,
      // flagged incomplete, so the derivation cannot conclude APPROVED.
      return { reviews, complete: false };
    }

    const data = batch.data ?? [];
    for (const review of data) {
      reviews.push({
        login: review.user?.login ?? '',
        state: review.state,
        commitId: review.commit_id,
      });
    }
    // A short page is the last page.
    if (data.length < REVIEW_PAGE_SIZE) return { reviews, complete: true };
  }
  // Hit the page ceiling with full pages throughout: more may remain unread.
  return { reviews, complete: false };
}

export interface RealListOpenPullRequestsOptions {
  /** Review Gate identity required among approvers. Defaults to env/Overseer bot. */
  readonly reviewGateLogin?: string;
  /** Injectable for tests; defaults to this module's logger. */
  readonly logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}

/**
 * Hard ceiling on open-PR pages read per repo per tick, so one pathological
 * repo cannot spin the tick. 10 pages x 100 = 1000 open PRs, far above any real
 * repo here (shopops, the busiest, carries ~30 open against master).
 */
const MAX_OPEN_PR_PAGES = 10;
const OPEN_PR_PAGE_SIZE = 100;

/** One page of open PRs as the discovery path consumes them. */
type OpenPullRequestPage = Awaited<ReturnType<RealGitHubOctokitLike['pulls']['list']>>['data'];

/**
 * Read EVERY open PR on the repo, following pages.
 *
 * `per_page: 100` unpaginated was the bug (Overseer review of e729fea5): a repo
 * with more than 100 open PRs silently omits every later page on every tick, so
 * those PRs are never evaluated as merge candidates and never appear anywhere
 * saying why. That is precisely the invisible-candidate failure #758 exists to
 * end, recreated one layer down -- and it fails in the direction that looks
 * exactly like a quiet backlog.
 *
 * `complete` reports whether the whole set was actually read. Unlike the review
 * derivation, an incomplete read here cannot fail closed by excluding anything:
 * the PRs we DID read are still legitimate candidates, and holding them because
 * a later page was unreachable would stall merges for the same "silence" reason.
 * So the partial list is returned and the flag travels with it, to be logged and
 * carried on every discovered PR rather than dropped.
 */
export async function fetchAllOpenPullRequests(
  octokit: RealGitHubOctokitLike,
  input: { owner: string; repo: string }
): Promise<{ pulls: OpenPullRequestPage; complete: boolean }> {
  const pulls: OpenPullRequestPage = [];
  for (let page = 1; page <= MAX_OPEN_PR_PAGES; page += 1) {
    // Called through `octokit.pulls` rather than detached, so a real client
    // method keeps its receiver.
    const batch = await octokit.pulls.list({
      owner: input.owner,
      repo: input.repo,
      state: 'open',
      per_page: OPEN_PR_PAGE_SIZE,
      page,
    });
    const data = batch.data ?? [];
    pulls.push(...data);
    // A short page is the last page.
    if (data.length < OPEN_PR_PAGE_SIZE) return { pulls, complete: true };
  }
  // Hit the page ceiling with full pages throughout: more may remain unread.
  return { pulls, complete: false };
}

/**
 * Real listOpenPullRequests for PR-first merge candidate discovery
 * (bdc-harness#758). Lists open PRs -- following pages, see
 * `fetchAllOpenPullRequests` -- filters to the watched base branches, and
 * resolves each one's review decision.
 *
 * TWO SOURCES, IN ORDER OF AUTHORITY:
 *
 *  1. GitHub's own aggregate `reviewDecision` via GraphQL, batched into a
 *     single query for the whole page of PRs. Preferred whenever a GraphQL
 *     client is present, because it is the ONLY source that accounts for
 *     required approval counts and CODEOWNERS rules -- neither is expressible
 *     in the REST reviews listing at all.
 *  2. Otherwise the conservative REST derivation: every review paginated, only
 *     approvals on the current head counted, any standing CHANGES_REQUESTED
 *     blocking, and the Review Gate identity required among the approvers.
 *
 * Every field is populated from live API data. A PR whose review listing fails,
 * or whose pages could not all be read, gets `reviewDecision: null` -- which
 * excludes it as `review_not_approved` rather than admitting it on an
 * assumption. Failing closed on an unknown review state is the only safe
 * direction for a merge candidate.
 */
export function createRealListOpenPullRequests(
  octokit: RealGitHubOctokitLike,
  options: RealListOpenPullRequestsOptions = {}
): (input: GitHubOpenPullRequestListInput) => Promise<readonly DiscoveredPullRequest[]> {
  return async (input: GitHubOpenPullRequestListInput) => {
    const bases = (input.baseBranches ?? []).map(base => base.trim().toLowerCase()).filter(Boolean);
    const reviewGateLogin = options.reviewGateLogin ?? resolveReviewGateLogin();
    const logger = options.logger ?? log;
    const { pulls: listedPulls, complete: listingComplete } = await fetchAllOpenPullRequests(
      octokit,
      { owner: input.owner, repo: input.repo }
    );

    // ONE line per repo per tick when the ceiling is hit. A truncated listing
    // means real merge candidates were never looked at, which is indistinguish-
    // able from an empty queue unless it is said out loud.
    if (!listingComplete) {
      logger.warn(
        {
          owner: input.owner,
          repo: input.repo,
          pagesRead: MAX_OPEN_PR_PAGES,
          pullsRead: listedPulls.length,
        },
        'merge-coordinator.open_pull_request_listing_truncated'
      );
    }

    const matchesBase = (baseRef: string): boolean =>
      bases.length === 0 || bases.includes(baseRef.trim().toLowerCase());

    // Batch GitHub's authoritative decision for every PR we will actually
    // evaluate. PRs on unwatched bases are excluded upstream on base grounds,
    // so spending query budget on them buys nothing.
    const evaluatedNumbers = listedPulls
      .filter(pr => matchesBase(pr.base?.ref ?? ''))
      .map(pr => pr.number);
    const lookup = await fetchReviewDecisions(octokit, {
      owner: input.owner,
      repo: input.repo,
      prNumbers: evaluatedNumbers,
    });
    const graphqlDecisions = lookup.decisions;

    // ONE line per repo per tick, not one per PR. The fallback derivation is
    // deliberately stricter than GitHub's aggregate, so a GraphQL outage (an
    // expired token is enough) silently TIGHTENS the merge gate: PRs GitHub
    // considers approved start reading `review_not_approved` and simply stop
    // merging. That looks identical to a quiet backlog, which is the exact
    // failure mode #758 exists to end -- so it is said out loud, with the error
    // class and how many PRs it affected.
    //
    // `prsAffected` counts only the PRs whose OWN batch failed, not every PR in
    // the sweep: the query is batched, so a rejected request degrades its 50 and
    // leaves the rest with GitHub's real answer. Reporting the whole sweep here
    // would overstate the outage every time one batch of many failed.
    if (lookup.unavailableReason) {
      logger.warn(
        {
          owner: input.owner,
          repo: input.repo,
          reason: lookup.unavailableReason,
          errorClass: lookup.errorClass,
          prsAffected: lookup.fallbackPrNumbers.length,
          batchCount: lookup.batchCount,
          failedBatchCount: lookup.failedBatchCount,
        },
        'merge-coordinator.review_decision_graphql_unavailable'
      );
    }
    // Per-PR, not per-sweep: a PR absent from the decision map is the one that
    // fell back. Flagging every PR because some other batch failed would report
    // a degraded gate for PRs that got GitHub's authoritative answer.
    const fellBackToRest = new Set(lookup.fallbackPrNumbers);

    const discovered: DiscoveredPullRequest[] = [];
    for (const pr of listedPulls) {
      const baseRef = pr.base?.ref ?? '';
      // Filter bases here rather than via the API's `base` param so that a PR
      // targeting an unwatched base is still COUNTED as evaluated upstream and
      // reports `base_branch_not_watched`, instead of silently not existing --
      // silent absence is the exact failure #758 is about.
      if (!matchesBase(baseRef)) {
        discovered.push({
          owner: input.owner,
          repo: input.repo,
          prNumber: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft === true,
          baseRef,
          headRef: pr.head.ref ?? '',
          headSha: pr.head.sha,
          reviewDecision: null,
          woId: extractWoId(pr.title, pr.body),
          ...(listingComplete ? {} : { listingTruncated: true }),
        });
        continue;
      }

      // GitHub's own answer wins whenever we have it -- it is the aggregate the
      // REST derivation can only approximate.
      let reviewDecision: string | null = null;
      if (graphqlDecisions.has(pr.number)) {
        reviewDecision = graphqlDecisions.get(pr.number) ?? null;
      } else {
        const { reviews, complete } = await fetchAllPullRequestReviews(octokit, {
          owner: input.owner,
          repo: input.repo,
          prNumber: pr.number,
        });
        reviewDecision = deriveReviewDecision(reviews, {
          headSha: pr.head.sha,
          reviewGateLogin,
          reviewsIncomplete: !complete,
        });
      }

      discovered.push({
        owner: input.owner,
        repo: input.repo,
        prNumber: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft === true,
        baseRef,
        headRef: pr.head.ref ?? '',
        headSha: pr.head.sha,
        reviewDecision,
        woId: extractWoId(pr.title, pr.body),
        // Only meaningful for PRs whose decision was actually resolved: a PR on
        // an unwatched base never consults reviews at all, so it is not a
        // fallback casualty and is not counted as one. Set per PR rather than
        // per sweep, so a PR whose own batch succeeded is not mislabelled as
        // degraded because a different batch failed.
        reviewDecisionFromFallback: fellBackToRest.has(pr.number),
        ...(listingComplete ? {} : { listingTruncated: true }),
      });
    }
    return discovered;
  };
}

/**
 * Build the real (non-fake) GitHubClientDeps composition for Overseer. Fails
 * loudly at construction time if the token is missing -- never silently
 * degrades to a stub in real mode.
 */
export function createRealGitHubClientDeps(
  octokit: RealGitHubOctokitLike = createRealOctokitClient()
): GitHubClientDeps {
  return {
    findPullRequest: createRealFindPullRequest(octokit),
    // Merge mutations go through the distinct merge identity when configured
    // (M-153: the merger is never the reviewer).
    mergePullRequest: createRealMergePullRequest(createRealMergeOctokitClient()),
    listPullRequestReviews: async (
      input
    ): Promise<{ login: string; state: string; commitId: string }[]> => {
      if (!octokit.pulls.listReviews) {
        throw new Error('overseer_real_adapter_missing_list_reviews_api');
      }
      const response = await octokit.pulls.listReviews({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        per_page: 100,
      });
      return response.data.map(review => ({
        login: review.user?.login ?? '',
        state: review.state,
        commitId: review.commit_id,
      }));
    },
    commentOnPullRequest: async (input): Promise<{ commented: boolean; url?: string }> => {
      if (!octokit.issues) {
        throw new Error('overseer_real_adapter_missing_issues_api');
      }
      const response = await octokit.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.number,
        body: input.body,
      });
      return { commented: true, url: response.data.html_url };
    },
    approvePullRequest: createRealApprovePullRequest(octokit),
    listOpenPullRequests: createRealListOpenPullRequests(octokit),
  };
}
