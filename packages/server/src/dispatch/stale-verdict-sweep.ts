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
 * BOUNDED BY DESIGN. `OVERSEER_STALE_VERDICT_SWEEP_MAX` (default 3) is a budget
 * of CANDIDATES TOUCHED per heartbeat, not of re-reviews enqueued. The bound
 * exists because this is the only part of #782 that costs GitHub API budget:
 * deciding whether a verdict is stale requires reading the check runs at that
 * head, and the shared per-user budget is what collapsed a review on #776 in
 * the first place. An unbounded sweep across every open PR every minute would
 * reintroduce exactly the exhaustion this WO is also fixing.
 *
 * Counting enqueues instead would not bound anything that matters: a heartbeat
 * where every candidate is authorized but not yet stale, or already enqueued by
 * the webhook, produces zero enqueues while still issuing one GitHub read per
 * candidate. So the budget is spent when a candidate is PICKED UP, before its
 * outcome is known, and the single refund is the local-only unsweepable check
 * that issues no read at all.
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

/**
 * Default sweep budget: the number of candidates one heartbeat may TOUCH, and
 * therefore the ceiling on GitHub reads it may make. It is not a cap on
 * enqueues -- a heartbeat that examines three candidates and finds none stale
 * has spent its whole budget and enqueued nothing, which is the correct and
 * intended shape (Overseer review finding, PR #786).
 */
export const DEFAULT_STALE_SWEEP_MAX = 3;

/**
 * Extra candidates listed beyond the budget, to cover slots refunded by the
 * local-only "not sweepable" check. Additive and small on purpose: listing is
 * one local query, but every candidate actually TOUCHED still costs a slot.
 */
const CANDIDATE_LOOKAHEAD = 5;

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

/**
 * How far into the candidate list the next heartbeat starts.
 *
 * WHY A CURSOR EXISTS (Overseer review finding, PR #786 @939d42f7): the local
 * eligibility filter below REFUNDS its budget slot, so a candidate that is
 * approved or code-rejected costs nothing -- but it still consumes a slot in
 * the FETCHED ARRAY, which is only `max + CANDIDATE_LOOKAHEAD` long. With a
 * fixed window, a run of ineligible candidates at the window's start exhausted
 * the array with the budget unspent, and every subsequent heartbeat re-fetched
 * the identical rows. An eligible stale verdict sitting past the window was
 * never examined -- permanently, not just slowly.
 *
 * The cursor makes the window MOVE. Each heartbeat records how many candidates
 * it consumed and starts the next one there, so the sweep walks the whole store
 * across heartbeats instead of re-reading its head forever. The GitHub-read
 * bound is untouched: `max` still caps reads per heartbeat: the cursor changes
 * WHICH candidates a heartbeat sees, never HOW MANY it may touch.
 */
export interface SweepCursor {
  /** Offset into the candidate ordering the next heartbeat resumes at. */
  offset: number;
}

/**
 * Process-local cursor. Deliberately in-memory rather than a database row: the
 * sweep is a backstop whose only cost of restarting at zero is re-walking a
 * bounded list a few heartbeats sooner, which is exactly the pre-cursor
 * behavior and therefore never worse. Persisting it would add a write per
 * heartbeat to buy nothing a restart does not already give back within a minute.
 */
const processCursor: SweepCursor = { offset: 0 };

/** Test seam: reset the module cursor so heartbeats are independent. */
export function resetStaleSweepCursor(): void {
  processCursor.offset = 0;
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
   * Open PRs with a standing Overseer verdict, in a STABLE order. Reads the
   * LOCAL dispatch store -- never GitHub -- so building the candidate set is
   * free.
   *
   * `offset` is how many candidates to skip before returning `limit` of them:
   * it is what lets successive heartbeats walk past a run of ineligible
   * candidates instead of re-reading them forever. The ordering must be stable
   * across calls or the cursor would skip rows rather than advance through
   * them.
   *
   * Returning fewer than `limit` rows means the store is exhausted at that
   * offset, and the caller rewinds the cursor to the start.
   */
  listCandidates(limit: number, offset: number): Promise<SweepCandidate[]>;
  /** The standing verdict at that exact head, or null. Local read. */
  readStandingVerdict(candidate: SweepCandidate): Promise<StandingVerdict | null>;
  /**
   * The most recent completed check at that head, or null when none has
   * completed. THIS IS THE ONE GITHUB READ in the sweep, which is why the
   * per-heartbeat budget is spent before it is ever called -- and why a
   * candidate that reaches this line keeps its slot whatever the answer is.
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
  /**
   * Candidates that survived the local-only filters and therefore cost one
   * GitHub read each. This is the number the budget actually bounds, so it is
   * always <= the configured max.
   */
  examined: number;
  /** Re-reviews actually enqueued as NEW rows. Never bounds the sweep. */
  enqueued: number;
  /** Candidates whose re-review row already existed (idempotent no-op). */
  duplicates: number;
  /**
   * Candidates this heartbeat walked past, INCLUDING the locally-ineligible
   * ones that refunded their budget slot. This is what the cursor advances by,
   * and it is reported so a heartbeat that spent no budget is still visibly
   * making progress through the store.
   */
  consumed: number;
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
  max: number = resolveStaleSweepMax(),
  cursor: SweepCursor = processCursor
): Promise<StaleVerdictSweepResult> {
  const result: StaleVerdictSweepResult = { examined: 0, enqueued: 0, duplicates: 0, consumed: 0 };
  if (max <= 0) return result;

  const startOffset = Math.max(0, cursor.offset);
  let candidates: SweepCandidate[];
  try {
    // Ask for exactly the budget, never a multiple of it. An earlier version
    // over-fetched on the theory that most candidates are filtered out locally
    // and only survivors cost a GitHub read -- but the stopping rule then
    // counted only successful enqueues, so a heartbeat in which every
    // candidate was authorized-but-not-stale (or already enqueued by the
    // webhook) walked the whole over-fetched list and made one GitHub read per
    // candidate. That is `max * 5` reads per heartbeat from a bound advertised
    // as `max`, which inverts the rate-budget guarantee this sweep exists to
    // honor. Overseer review finding on PR #786 @5b53b394.
    //
    // The list is still slightly longer than the budget because the
    // local-only refund below can hand a slot back: a run of approved PRs at
    // the head of the list would otherwise leave the budget unspent with
    // sweepable PRs sitting just past the end. The over-fetch is bounded and
    // additive (not multiplicative), and a listed-but-never-touched candidate
    // costs nothing -- `listCandidates` is a single local query.
    candidates = await deps.listCandidates(max + CANDIDATE_LOOKAHEAD, startOffset);
  } catch (error) {
    log.error({ err: error }, 'overseer_stale_verdict_sweep_candidates_failed');
    return result;
  }

  // EXHAUSTED AT THIS OFFSET: the cursor has walked past the end of the store.
  // Rewind to the start so the next heartbeat re-examines from the top -- rows
  // skipped earlier as ineligible may have acquired a new verdict since, and a
  // cursor that only ever moved forward would stop sweeping entirely once it
  // reached the end.
  if (candidates.length === 0) {
    if (startOffset === 0) return result;
    cursor.offset = 0;
    return result;
  }

  // ONE BUDGET, SPENT ON EVERY CANDIDATE TOUCHED. `remaining` is decremented
  // as each candidate is picked up, before any of its outcomes are known, so a
  // duplicate, a non-stale verdict, a completion-less head and a successful
  // enqueue all cost exactly the same. That is what makes the bound a real
  // ceiling on GitHub reads per heartbeat rather than a ceiling on the one
  // outcome that happens to be cheapest to reach.
  let remaining = max;
  // How many candidates this heartbeat actually walked past, ineligible ones
  // included. This -- not the budget -- is what the cursor advances by, because
  // the starvation being fixed is about ARRAY slots consumed, not budget spent.
  let consumed = 0;

  for (const candidate of candidates) {
    if (remaining <= 0) break;
    remaining -= 1;
    consumed += 1;
    try {
      const verdict = await deps.readStandingVerdict(candidate);
      // Same authorization question as the webhook path, and deliberately the
      // SAME function: an approved PR, or one rejected on a code finding, is
      // never swept. Two copies of this rule would drift.
      //
      // This is the ONE branch that refunds the budget: it is decided entirely
      // from the local store and issues no GitHub read, so letting an
      // unsweepable PR consume a slot would let a backlog of approved PRs
      // starve the sweep without spending any of the budget it is protecting.
      if (!verdictAuthorizesRecheck(verdict) || !verdict) {
        remaining += 1;
        continue;
      }
      result.examined += 1;

      // Past this point a GitHub read has been issued, so the slot stays spent
      // no matter how the candidate turns out.
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

  // ADVANCE THE WINDOW by what this heartbeat actually walked, so the next one
  // resumes past it rather than re-reading the same rows. When the fetched page
  // was shorter than requested we were already at the end of the store, so the
  // cursor rewinds instead of running off into offsets that return nothing.
  result.consumed = consumed;
  const pageWasShort = candidates.length < max + CANDIDATE_LOOKAHEAD;
  const reachedEndOfPage = consumed >= candidates.length;
  cursor.offset = pageWasShort && reachedEndOfPage ? 0 : startOffset + consumed;
  return result;
}
