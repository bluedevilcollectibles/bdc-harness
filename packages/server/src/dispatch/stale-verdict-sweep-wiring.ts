/**
 * Real dependency composition for the stale-verdict sweep (bdc-harness #782
 * part 3).
 *
 * `stale-verdict-sweep.ts` is pure and injectable. This module is the ONLY
 * place its dependencies bind to real infrastructure: the dispatch store for
 * the candidate set and the standing verdicts (free), and one narrow GitHub
 * read per surviving candidate for the latest check completion (the only place
 * in #782 that spends rate budget, which is why the sweep is bounded).
 */
import * as dispatch from '@archon/core/db/dispatch';
import { createRealRecheckIngestDeps } from '@archon/overseer/pr-review-check-wiring';
import {
  REVIEW_RECIPIENT,
  parseReviewWorkBody,
  type ReviewRouteConfig,
} from '@archon/overseer/pr-review-wiring';
import { createRealOctokitClient } from '@archon/overseer/adapters/github-real-deps';
import type {
  LatestCheckCompletion,
  StaleVerdictSweepDeps,
  SweepCandidate,
} from './stale-verdict-sweep';

export {
  DEFAULT_STALE_SWEEP_MAX,
  resolveStaleSweepMax,
  runStaleVerdictSweep,
  verdictIsStale,
  type LatestCheckCompletion,
  type StaleVerdictSweepDeps,
  type StaleVerdictSweepResult,
  type SweepCandidate,
} from './stale-verdict-sweep';

/**
 * Build the candidate set from COMPLETED review work items in the local store.
 *
 * A review work item exists for every head the reviewer has been asked about,
 * and carries owner/repo/prNumber/headSha in its body. Terminal items are the
 * ones that may hold a standing verdict; queued and claimed items are still
 * in flight and are excluded, because sweeping a review that has not finished
 * would race the worker for the same row.
 *
 * Deduplicated by (repo, pr, head): a PR reviewed several times at one head has
 * one standing verdict, not several.
 */
export async function listRealSweepCandidates(limit: number): Promise<SweepCandidate[]> {
  const messages = await dispatch.listMessages({ recipient: REVIEW_RECIPIENT, limit: 500 });
  const seen = new Set<string>();
  const candidates: SweepCandidate[] = [];
  for (const message of messages) {
    if (message.task_type !== 'run_review') continue;
    if (message.status !== 'done') continue;
    const body = parseReviewWorkBody(message.body);
    if (!body?.owner || !body.repo || !body.prNumber || !body.headSha) continue;
    const key = `${body.owner}/${body.repo}#${body.prNumber}@${body.headSha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      owner: body.owner,
      repo: body.repo,
      prNumber: body.prNumber,
      headSha: body.headSha,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

interface CheckRunLike {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  completed_at?: string | null;
}

/**
 * The most recently COMPLETED check run at a head, or null.
 *
 * One `checks.listForRef` call, pinned to the exact head -- the same call the
 * evaluator already makes, so the shape and the cost are both known. A run with
 * no `completed_at` cannot be compared against a verdict timestamp and is
 * skipped rather than guessed at.
 */
export function selectLatestCompletion(runs: CheckRunLike[]): LatestCheckCompletion | null {
  let latest: LatestCheckCompletion | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    if (run.id === undefined || run.id === null) continue;
    if (typeof run.completed_at !== 'string' || run.completed_at.length === 0) continue;
    const completedMs = Date.parse(run.completed_at);
    if (!Number.isFinite(completedMs)) continue;
    if (completedMs <= latestMs) continue;
    latestMs = completedMs;
    latest = {
      checkId: `check_run:${run.id}`,
      checkName: run.name ?? 'check',
      conclusion: run.conclusion ?? null,
      completedAt: run.completed_at,
    };
  }
  return latest;
}

export function createRealStaleVerdictSweepDeps(config: ReviewRouteConfig): StaleVerdictSweepDeps {
  // Reuse the recheck ingest's own bindings for the two seams they share, so
  // the sweep and the webhook cannot disagree about what a standing verdict is
  // or how a re-review row is written.
  const recheckDeps = createRealRecheckIngestDeps(config);
  const octokit = createRealOctokitClient();
  return {
    listCandidates: listRealSweepCandidates,
    readStandingVerdict: candidate => recheckDeps.readStandingVerdict(candidate),
    async readLatestCheckCompletion(candidate): Promise<LatestCheckCompletion | null> {
      const runs = await octokit.checks.listForRef({
        owner: candidate.owner,
        repo: candidate.repo,
        ref: candidate.headSha,
        per_page: 100,
      });
      // The shared octokit interface models only the fields the evaluator needs
      // (name/status/conclusion); the live API also returns `id` and
      // `completed_at`, which the staleness comparison requires. Narrow through
      // `unknown` here rather than widening the shared type, so this sweep
      // cannot alter what other callers of that interface are promised.
      const checkRuns = (runs.data.check_runs ?? []) as unknown as CheckRunLike[];
      return selectLatestCompletion(checkRuns);
    },
    enqueueRecheckWork: input => recheckDeps.enqueueRecheckWork(input),
  };
}
