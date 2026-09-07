/**
 * Stale-verdict sweep (bdc-harness #782 part 3).
 *
 * THE GAP THIS CLOSES: the webhook path (part 1) only fires when GitHub
 * actually delivers a `check_run`/`workflow_run` completion. Deliveries are
 * lost -- the container restarts mid-flight, the App's event subscription is
 * added after a job already finished, a delivery 500s and GitHub gives up. When
 * that happens the PR is right back in the state John named on 2026-09-07: a
 * standing CHANGES_REQUESTED at a head whose check has since gone green, and
 * nothing to clear it but a human nudge.
 *
 * The sweep is the backstop, not the primary path. On each review-worker
 * heartbeat it looks at open candidate PRs whose latest verdict predates the
 * latest check completion AT THE SAME HEAD, and enqueues exactly one re-review
 * each -- reusing the SAME idempotency rule as the webhook path, so a sweep and
 * a delivery that both notice the same completion produce one row, not two.
 *
 * BOUNDED BY DESIGN. `OVERSEER_STALE_VERDICT_SWEEP_MAX` (default 3) caps how
 * many re-reviews one heartbeat may enqueue. The bound exists because this is
 * the only part of #782 that costs GitHub API budget: deciding whether a
 * verdict is stale requires reading the check runs at that head, and the shared
 * per-user budget is what collapsed a review on #776 in the first place. An
 * unbounded sweep across every open PR every minute would reintroduce exactly
 * the exhaustion this WO is also fixing.
 */
import { createLogger } from '@archon/paths';
import {
  buildRecheckReason,
  recheckCorrelationId,
  recheckIdempotencyKey,
  verdictAuthorizesRecheck,
  type StandingVerdict,
} from '@archon/overseer/pr-review-check-ingest';

const log = createLogger('dispatch/stale-verdict-sweep');

/** Default number of re-reviews one heartbeat may enqueue. */
export const DEFAULT_STALE_SWEEP_MAX = 3;

export function resolveStaleSweepMax(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = Number(env.OVERSEER_STALE_VERDICT_SWEEP_MAX);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_STALE_SWEEP_MAX;
  return Math.min(Math.floor(raw), 50);
}

/** One open PR the sweep may consider, as read from the local store. */
export interface SweepCandidate {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/** The latest completed check at a head, as read from GitHub. */
export interface LatestCheckCompletion {
  /** Stable id of the most recently completed check run at this head. */
  checkId: string;
  checkName: string;
  conclusion: string | null;
  /** When it completed (ISO-8601). */
  completedAt: string;
}

export interface StaleVerdictSweepDeps {
  /**
   * Open PRs with a standing Overseer verdict, newest first. Reads the LOCAL
   * dispatch store -- never GitHub -- so building the candidate set is free.
   */
  listCandidates(limit: number): Promise<SweepCandidate[]>;
  /** The standing verdict at that exact head, or null. Local read. */
  readStandingVerdict(candidate: SweepCandidate): Promise<StandingVerdict | null>;
  /**
   * The most recent completed check at that head, or null when none has
   * completed. THIS IS THE ONE GITHUB READ in the sweep, which is why the
   * per-heartbeat bound is applied before it is ever called.
   */
  readLatestCheckCompletion(candidate: SweepCandidate): Promise<LatestCheckCompletion | null>;
  /** Same enqueue seam the webhook ingest uses; same idempotency contract. */
  enqueueRecheckWork(input: {
    correlationId: string;
    idempotencyKey: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    repeatReason: string;
  }): Promise<{ messageId: string; alreadyExisted: boolean }>;
}

export interface StaleVerdictSweepResult {
  /** Candidates examined (i.e. that survived the local-only filters). */
  examined: number;
  /** Re-reviews actually enqueued as NEW rows. */
  enqueued: number;
  /** Candidates whose re-review row already existed (idempotent no-op). */
  duplicates: number;
}

/**
 * True when the standing verdict is older than the latest check completion at
 * the same head -- i.e. the reviewer spoke, then the evidence changed, and no
 * one told the reviewer.
 *
 * A verdict with no recorded timestamp is NOT treated as stale. Guessing "it
 * must be older" would re-review every PR whose receipt predates the timestamp
 * field, which is a burst of model calls and GitHub reads on evidence that may
 * not have moved at all. Fail closed: an unknown age is not a trigger.
 */
export function verdictIsStale(
  verdict: StandingVerdict,
  completion: LatestCheckCompletion
): boolean {
  if (!verdict.recordedAt) return false;
  const verdictAt = Date.parse(verdict.recordedAt);
  const completedAt = Date.parse(completion.completedAt);
  if (!Number.isFinite(verdictAt) || !Number.isFinite(completedAt)) return false;
  return completedAt > verdictAt;
}

/**
 * Run one bounded sweep. Never throws: a sweep failure must not take down the
 * review worker heartbeat that carries the primary review path.
 */
export async function runStaleVerdictSweep(
  deps: StaleVerdictSweepDeps,
  max: number = resolveStaleSweepMax()
): Promise<StaleVerdictSweepResult> {
  const result: StaleVerdictSweepResult = { examined: 0, enqueued: 0, duplicates: 0 };
  if (max <= 0) return result;

  let candidates: SweepCandidate[];
  try {
    // Read more candidates than the bound: most will be filtered out locally
    // (approved, no verdict, verdict newer than the completion), and only the
    // survivors cost a GitHub read.
    candidates = await deps.listCandidates(Math.max(max * 5, max));
  } catch (error) {
    log.error({ err: error }, 'overseer_stale_verdict_sweep_candidates_failed');
    return result;
  }

  for (const candidate of candidates) {
    if (result.enqueued >= max) break;
    try {
      const verdict = await deps.readStandingVerdict(candidate);
      // Same authorization question as the webhook path, and deliberately the
      // SAME function: an approved PR, or one rejected on a code finding, is
      // never swept. Two copies of this rule would drift.
      if (!verdictAuthorizesRecheck(verdict) || !verdict) continue;
      result.examined += 1;

      const completion = await deps.readLatestCheckCompletion(candidate);
      if (!completion) continue;
      if (!verdictIsStale(verdict, completion)) continue;

      const correlationId = recheckCorrelationId(candidate);
      const enqueued = await deps.enqueueRecheckWork({
        correlationId,
        idempotencyKey: recheckIdempotencyKey({
          owner: candidate.owner,
          repo: candidate.repo,
          prNumber: candidate.prNumber,
          headSha: candidate.headSha,
          checkId: completion.checkId,
        }),
        owner: candidate.owner,
        repo: candidate.repo,
        prNumber: candidate.prNumber,
        headSha: candidate.headSha,
        repeatReason: buildRecheckReason({
          checkName: completion.checkName,
          checkId: completion.checkId,
          headSha: candidate.headSha,
          conclusion: completion.conclusion,
        }),
      });
      if (enqueued.alreadyExisted) {
        // The webhook already handled this completion. Not an error -- it is
        // the idempotency rule doing its job across both paths.
        result.duplicates += 1;
        continue;
      }
      result.enqueued += 1;
      log.info(
        {
          owner: candidate.owner,
          repo: candidate.repo,
          prNumber: candidate.prNumber,
          headSha: candidate.headSha,
          checkId: completion.checkId,
          messageId: enqueued.messageId,
        },
        'overseer_stale_verdict_sweep_enqueued'
      );
    } catch (error) {
      log.error(
        { err: error, owner: candidate.owner, repo: candidate.repo, prNumber: candidate.prNumber },
        'overseer_stale_verdict_sweep_candidate_failed'
      );
    }
  }
  return result;
}
