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
  SweepCursor,
} from './stale-verdict-sweep';

export {
  DEFAULT_STALE_SWEEP_MAX,
  createMemorySweepCursor,
  resolveStaleSweepMax,
  runStaleVerdictSweep,
  verdictIsStale,
  type LatestCheckCompletion,
  type StaleVerdictSweepDeps,
  type StaleVerdictSweepResult,
  type SweepCandidate,
  type SweepCursor,
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
 *
 * KEYSET PAGINATION IN THE QUERY (Overseer review finding, PR #786 @45aa739e).
 * An earlier version fetched one `listMessages` page -- hard-capped at 500 rows
 * -- and applied the caller's offset to it afterwards, in memory. The live
 * store holds ~4,900 dispatch rows and the review recipient alone already holds
 * ~494, so the walk could never see past that first page: once the offset
 * passed the candidates inside it, the sweep rewound and every completed review
 * beyond row 500 was permanently unreachable. `afterSeq` is therefore pushed
 * into the query as an exclusive lower bound on the database-assigned `seq`
 * (migration 047), and `task_type`/`status` are filtered there too so a page of
 * `limit` rows yields up to `limit` usable candidates instead of a handful.
 *
 * DEDUPE IS STILL IN MEMORY, and is safe there BECAUSE the walk is ordered and
 * forward-only: duplicates of one (repo, pr, head) are collapsed within a page,
 * and a duplicate that straddles a page boundary costs at most one redundant
 * candidate on the next heartbeat -- bounded, and never a skipped row. Doing it
 * in SQL would need a window function over a mixed-dialect schema for no gain.
 *
 * ELIGIBILITY IS NOT FILTERED HERE, and cannot be: a candidate's disposition
 * lives on a separate `pr_review_submit_receipt` row addressed to `operator`,
 * not on the review work item this reads, so no single query over this table
 * can express "changes_requested only". That is precisely why the caller needs
 * a moving cursor -- the ineligible rows must be walked past, and something has
 * to remember how far.
 */
export async function listRealSweepCandidates(
  limit: number,
  afterSeq = 0
): Promise<SweepCandidate[]> {
  // Over-fetch the raw page: dedupe and body-parse both drop rows, and the
  // caller asked for `limit` USABLE candidates. Bounded by the DAL's own cap.
  const messages = await dispatch.listMessagesBySeqCursor({
    recipient: REVIEW_RECIPIENT,
    task_type: 'run_review',
    status: 'done',
    afterSeq,
    limit: Math.min(500, Math.max(limit * 4, 50)),
  });
  const seen = new Set<string>();
  const candidates: SweepCandidate[] = [];
  for (const message of messages) {
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
      cursorSeq: message.cursor_seq,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/**
 * The production cursor: a database row that survives archon-app-1 rebuilds.
 *
 * A process-local cursor rewinds to the head of the store on every restart, so
 * a store larger than one process lifetime's worth of heartbeats would never be
 * fully walked -- the same reason the required-contexts attempt counters had to
 * become durable in migration 048. Both reads and writes are fail-soft inside
 * the DAL; a cursor fault degrades to re-walking, never to a failed heartbeat.
 */
export function createDurableSweepCursor(): SweepCursor {
  return {
    read: async (): Promise<number> => {
      const db = await import('@archon/core/db/overseer-sweep-cursor');
      return db.readStaleSweepCursor();
    },
    write: async (afterSeq: number): Promise<void> => {
      const db = await import('@archon/core/db/overseer-sweep-cursor');
      await db.writeStaleSweepCursor(afterSeq);
    },
  };
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
    listCandidates: (limit, afterSeq) => listRealSweepCandidates(limit, afterSeq),
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
