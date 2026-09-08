/**
 * Merge provenance: bind the PR being merged to the run that actually produced it.
 *
 * Why this exists (John, 2026-07-23): the merge manager should only act on runs it
 * actually oversaw through Cauldron. Before this module, `createMergeManager` would
 * merge any `WatchedRunRecord` the judge approved -- the record's `owner`/`repo`/
 * `headBranch` were taken on faith, so a valid runId paired with an unrelated branch
 * would have been merged.
 *
 * The trust model is the whole point:
 *
 *   - `metadata` on a run row (including `headBranch`, `head_sha`) is AGENT-WRITTEN.
 *     Verifying agent metadata against agent metadata proves nothing.
 *   - `working_path` is ENGINE-WRITTEN when the run is created (see core/db/workflows.ts).
 *     An agent does not author it. That makes the run's own worktree the one artifact
 *     record we can bind to.
 *
 * So provenance asks: does the branch tip inside THIS RUN'S worktree equal the head SHA
 * GitHub reports for the PR we are about to merge? Both sides are independent of agent
 * metadata: one comes from the engine-created worktree on disk, the other from the
 * GitHub API.
 *
 * Fails closed. Any missing input -- no working path, worktree already swept, git error,
 * absent PR head SHA -- yields `verified: false` and the merge is held, never merged.
 */

import { createLogger } from '@archon/paths';
import { isPullRequestDiscoveredCandidate } from './merge-candidate-discovery';
import type { WatchedRunRecord } from './types.ts';

const log = createLogger('overseer/merge-provenance');

export type MergeProvenanceReason =
  | 'verified'
  | 'no_run'
  | 'working_path_missing'
  | 'worktree_unavailable'
  | 'run_head_sha_unresolved'
  | 'pr_head_sha_missing'
  | 'head_sha_mismatch';

export interface MergeProvenanceResult {
  readonly verified: boolean;
  readonly reason: MergeProvenanceReason;
  /** Tip SHA read from the run's own worktree, when resolvable. */
  readonly runHeadSha: string | null;
  /** Head SHA GitHub reports for the PR, when known. */
  readonly prHeadSha: string | null;
}

export interface MergeProvenanceDeps {
  /**
   * Resolve the tip commit SHA of the run's worktree. Returns null when the worktree
   * is gone (the 2026-07-17 orphan sweep reaps them) or git cannot read it.
   */
  readonly readWorktreeHeadSha: (workingPath: string) => Promise<string | null>;
}

/**
 * Default worktree reader: ask git for the tip of the run's own worktree.
 * `rev-parse HEAD` inside `workingPath` is exactly "what commit did this run leave".
 * Any non-zero exit (worktree swept, not a repo, git missing) resolves to null so the
 * caller fails closed.
 */
export async function readWorktreeHeadShaWithGit(workingPath: string): Promise<string | null> {
  try {
    const subprocess = Bun.spawn(['git', '-C', workingPath, 'rev-parse', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      subprocess.exited,
    ]);
    if (exitCode !== 0) return null;
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function normalizeSha(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  return /^[0-9a-f]{7,40}$/.test(trimmed) ? trimmed : null;
}

/**
 * Compare two SHAs that may differ in length (abbreviated vs full). Equality is
 * prefix-based on the shorter of the two, which is how git itself resolves them.
 */
function shasMatch(left: string, right: string): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return longer.startsWith(shorter);
}

/**
 * Verify that `prHeadSha` is a commit this run actually produced.
 *
 * @param record       the watched run, carrying the engine-written `workingPath`
 * @param prHeadSha    head SHA as reported by GitHub for the candidate PR
 */
export async function verifyMergeProvenance(
  record: WatchedRunRecord,
  prHeadSha: string | null | undefined,
  deps: MergeProvenanceDeps
): Promise<MergeProvenanceResult> {
  const normalizedPrSha = normalizeSha(prHeadSha);

  // NO RUN AT ALL (John, 2026-09-07: "always merge on green, you do not need to
  // ask me"). A PR-first discovered candidate is a pull request found by
  // sweeping GitHub; there is no Cauldron run behind it and therefore no
  // engine-written worktree. Provenance asks "which commit did THIS RUN
  // produce" -- a question with no subject here, so it could only ever answer
  // `working_path_missing` and hold the PR forever, recreating the exact
  // deadlock #758 was written to clear.
  //
  // This is the ABSENCE of a run, not an unverifiable one, and the two must not
  // be conflated: a real run whose worktree was swept still fails closed below,
  // because for it the question is real and we merely could not read the answer.
  // `isPullRequestDiscoveredCandidate` requires BOTH the synthetic runId prefix
  // and the discovery metadata, so a run-derived record cannot reach this branch
  // by losing a field.
  //
  // Every other authorization rule is untouched: exact-head approval by the
  // Review Gate identity, all required checks SUCCESS, CLEAN mergeable state,
  // allowed bases, the production-effect hold, and the Grok judge all still
  // apply to these candidates.
  if (isPullRequestDiscoveredCandidate(record)) {
    log.info(
      { runId: record.runId, woId: record.woId, prHeadSha: normalizedPrSha },
      'merge_provenance.no_run -- PR-discovered candidate has no originating run; not a hold'
    );
    return {
      verified: true,
      reason: 'no_run',
      runHeadSha: null,
      prHeadSha: normalizedPrSha,
    };
  }

  const workingPath = record.workingPath?.trim();
  if (!workingPath) {
    log.warn(
      { runId: record.runId, woId: record.woId },
      'merge_provenance.working_path_missing -- run has no engine-written worktree path'
    );
    return {
      verified: false,
      reason: 'working_path_missing',
      runHeadSha: null,
      prHeadSha: normalizedPrSha,
    };
  }

  let worktreeSha: string | null;
  try {
    worktreeSha = normalizeSha(await deps.readWorktreeHeadSha(workingPath));
  } catch {
    worktreeSha = null;
  }

  if (!worktreeSha) {
    log.warn(
      { runId: record.runId, woId: record.woId, workingPath },
      'merge_provenance.worktree_unavailable -- cannot read run worktree head (swept or unreadable)'
    );
    return {
      verified: false,
      reason: 'worktree_unavailable',
      runHeadSha: null,
      prHeadSha: normalizedPrSha,
    };
  }

  if (!normalizedPrSha) {
    log.warn(
      { runId: record.runId, woId: record.woId },
      'merge_provenance.pr_head_sha_missing -- GitHub did not report a PR head SHA'
    );
    return {
      verified: false,
      reason: 'pr_head_sha_missing',
      runHeadSha: worktreeSha,
      prHeadSha: null,
    };
  }

  if (!shasMatch(worktreeSha, normalizedPrSha)) {
    log.warn(
      {
        runId: record.runId,
        woId: record.woId,
        runHeadSha: worktreeSha,
        prHeadSha: normalizedPrSha,
      },
      'merge_provenance.head_sha_mismatch -- PR was not produced by this run'
    );
    return {
      verified: false,
      reason: 'head_sha_mismatch',
      runHeadSha: worktreeSha,
      prHeadSha: normalizedPrSha,
    };
  }

  return {
    verified: true,
    reason: 'verified',
    runHeadSha: worktreeSha,
    prHeadSha: normalizedPrSha,
  };
}
