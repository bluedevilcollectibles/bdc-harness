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
      event: 'APPROVE' | 'REQUEST_CHANGES';
      body?: string;
      commit_id: string;
    }): Promise<{ data: { id: number; state: string } }>;
    listReviews?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
    }): Promise<{
      data: { user: { login?: string | null } | null; state: string; commit_id: string }[];
    }>;
  };
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
  };
}

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
}

/** Read review evidence with every ref-addressable call pinned to headSha. */
export function createRealFetchExactHeadPullRequestEvidence(
  octokit: RealGitHubOctokitLike
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
    let requiredContexts: string[] | null = null;
    if (!baseRef || !octokit.repos.getAllStatusCheckContexts) {
      log.warn(
        {
          owner: input.owner,
          repo: input.repo,
          baseRef: baseRef ?? null,
          reason: !baseRef ? 'base_ref_unavailable' : 'protection_api_unavailable',
        },
        'overseer.github_real_deps.required_contexts_unknown_deferring_review'
      );
    } else {
      try {
        const contexts = await octokit.repos.getAllStatusCheckContexts({
          owner: input.owner,
          repo: input.repo,
          branch: baseRef,
        });
        if (Array.isArray(contexts.data)) {
          requiredContexts = contexts.data.map(context => context.trim()).filter(Boolean);
        } else {
          log.warn(
            { owner: input.owner, repo: input.repo, baseRef, reason: 'non_array_payload' },
            'overseer.github_real_deps.required_contexts_unknown_deferring_review'
          );
        }
      } catch (error) {
        log.warn(
          { err: error, owner: input.owner, repo: input.repo, baseRef, reason: 'lookup_failed' },
          'overseer.github_real_deps.required_contexts_unknown_deferring_review'
        );
      }
    }
    return {
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

function summarizeChecks(
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
      let prNumber: number | null = null;

      if (input.headBranch) {
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
export type OverseerReviewEvent = 'APPROVE' | 'REQUEST_CHANGES';

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
    if (input.event === 'REQUEST_CHANGES' && body.length === 0) {
      return { submitted: false, message: 'github_review_missing_evidence_body' };
    }
    const expectedState = input.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
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

/**
 * Aggregate a PR's review decision from its individual reviews (bdc-harness#758).
 *
 * GitHub exposes `reviewDecision` only on the GraphQL PullRequest type; the REST
 * listing this adapter uses does not carry it, so it is DERIVED here using the
 * same rule GitHub applies: only each reviewer's LATEST state counts, a single
 * outstanding CHANGES_REQUESTED beats any number of approvals, and COMMENTED /
 * DISMISSED / PENDING states do not constitute a decision.
 *
 * Returns null when no reviewer has left an APPROVED or CHANGES_REQUESTED state.
 * Null means "no decision recorded", never "approved" -- the caller treats
 * anything other than the literal 'APPROVED' as not approved.
 */
export function deriveReviewDecision(
  reviews: readonly { login: string; state: string }[]
): string | null {
  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    const state = review.state.toUpperCase();
    // COMMENTED and PENDING never replace a reviewer's standing verdict --
    // that is GitHub's own rule, and collapsing them would silently clear a
    // CHANGES_REQUESTED when the same reviewer later left a plain comment.
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') continue;
    latestByReviewer.set(review.login.toLowerCase(), state);
  }
  const states = [...latestByReviewer.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (states.includes('APPROVED')) return 'APPROVED';
  return null;
}

/** Pull a WO id out of a PR title or body, so evidence lookup can search by it. */
export function extractWoId(title: string, body: string | null | undefined): string | undefined {
  const match = /\bWO-[A-Z0-9][A-Z0-9-]*\b/.exec(`${title}\n${body ?? ''}`);
  return match?.[0];
}

/**
 * Real listOpenPullRequests for PR-first merge candidate discovery
 * (bdc-harness#758). Lists open PRs, filters to the watched base branches, and
 * derives each one's review decision from its reviews.
 *
 * Every field is populated from live API data. A PR whose review listing fails
 * gets `reviewDecision: null` -- which excludes it as `review_not_approved`
 * rather than admitting it on an assumption. Failing closed on an unknown
 * review state is the only safe direction for a merge candidate.
 */
export function createRealListOpenPullRequests(
  octokit: RealGitHubOctokitLike
): (input: GitHubOpenPullRequestListInput) => Promise<readonly DiscoveredPullRequest[]> {
  return async (input: GitHubOpenPullRequestListInput) => {
    const bases = (input.baseBranches ?? []).map(base => base.trim().toLowerCase()).filter(Boolean);
    const listed = await octokit.pulls.list({
      owner: input.owner,
      repo: input.repo,
      state: 'open',
      per_page: 100,
    });
    const discovered: DiscoveredPullRequest[] = [];
    for (const pr of listed.data) {
      const baseRef = pr.base?.ref ?? '';
      // Filter bases here rather than via the API's `base` param so that a PR
      // targeting an unwatched base is still COUNTED as evaluated upstream and
      // reports `base_branch_not_watched`, instead of silently not existing --
      // silent absence is the exact failure #758 is about.
      if (bases.length > 0 && !bases.includes(baseRef.trim().toLowerCase())) {
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
        });
        continue;
      }

      let reviewDecision: string | null = null;
      if (octokit.pulls.listReviews) {
        try {
          const reviews = await octokit.pulls.listReviews({
            owner: input.owner,
            repo: input.repo,
            pull_number: pr.number,
            per_page: 100,
          });
          reviewDecision = deriveReviewDecision(
            reviews.data.map(review => ({
              login: review.user?.login ?? '',
              state: review.state,
            }))
          );
        } catch {
          // Unknown review state stays unknown, and unknown is not approved.
          reviewDecision = null;
        }
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
