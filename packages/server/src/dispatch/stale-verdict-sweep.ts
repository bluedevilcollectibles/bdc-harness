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

/**
 * One open PR the sweep may consider, as read from the local store.
 *
 * `cursorSeq` is the database-assigned position of the review work item this
 * candidate came from. It is the resume token: the sweep records the highest
 * one it consumed and the next heartbeat asks for rows strictly after it.
 */
export interface SweepCandidate {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  cursorSeq: number;
}

/**
 * One page of the walk: the candidates that parsed, PLUS how far the underlying
 * query actually got.
 *
 * WHY THE RAW POSITION IS PART OF THE CONTRACT (Overseer review finding, PR
 * #786 @e80159e4). `listCandidates` used to return a bare array, so a page whose
 * rows all failed parse/validation was indistinguishable from the end of the
 * store: the caller rewound the cursor to 0 and the walk restarted, forever,
 * never reaching valid rows sitting beyond the malformed ones.
 *
 * Not hypothetical -- live store, read 2026-09-08: 8 of 423 completed
 * `run_review` rows already have unparseable or incomplete bodies. The discard
 * path is exercised in production today.
 *
 * So the page reports both:
 *  - `lastRawSeq`: the position of the last RAW row the query returned, whether
 *    or not it parsed. This is what the cursor advances to, so discarded rows
 *    are walked PAST rather than re-read every heartbeat.
 *  - `rawCount`: how many raw rows the query returned. ZERO of these -- never
 *    zero candidates -- is what "end of store" means.
 */
export interface SweepCandidatePage {
  candidates: SweepCandidate[];
  /** Position of the last raw row in the page; 0 when the page was empty. */
  lastRawSeq: number;
  /** Raw rows the query returned, before parse/validation and dedupe. */
  rawCount: number;
  /** Raw rows dropped by parse/validation failure. Surfaced for visibility. */
  discarded: number;
}

/**
 * Where the walk resumes, as a KEYSET rather than an array index.
 *
 * WHY A CURSOR EXISTS AT ALL (Overseer review finding, PR #786 @939d42f7): the
 * local eligibility filter below REFUNDS its budget slot, so an approved or
 * code-rejected candidate costs no GitHub read -- but it still consumes a slot
 * in the fetched page. With a fixed window, a run of ineligible candidates
 * exhausted the page with the budget unspent, and every later heartbeat
 * re-fetched the identical rows.
 *
 * WHY IT IS A KEYSET AND PERSISTED (second Overseer finding, @45aa739e): the
 * first fix used an in-memory array index against a page that `listMessages`
 * hard-caps at 500 rows, applying the offset only AFTER that page was fetched.
 * The live store holds ~4,900 dispatch rows, so the walk could never see past
 * the first page: once the index passed the candidates inside it, the sweep
 * rewound. And a process-local cursor rewinds on every archon-app-1 rebuild
 * anyway. So the resume token is now the database-assigned `seq` of the last
 * row consumed, pushed into the query itself and persisted across restarts --
 * each page is a genuinely different slice of the store.
 *
 * The GitHub-read bound is untouched throughout: `max` still caps reads per
 * heartbeat. The cursor changes WHICH candidates a heartbeat sees, never HOW
 * MANY it may touch.
 */
export interface SweepCursor {
  /** Read the persisted resume token, or 0 to start at the head of the store. */
  read(): Promise<number>;
  /** Persist the resume token reached by this heartbeat. */
  write(afterSeq: number): Promise<void>;
}

/**
 * An in-memory cursor, for tests and for any caller with no database.
 *
 * Production uses the durable one (`createDurableSweepCursor` in the wiring):
 * a cursor that resets on restart cannot walk a store larger than what one
 * process lifetime covers, which is the failure this exists to prevent.
 */
export function createMemorySweepCursor(initial = 0): SweepCursor {
  let afterSeq = initial;
  return {
    read: async (): Promise<number> => afterSeq,
    write: async (next: number): Promise<void> => {
      afterSeq = next;
    },
  };
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
   * Open PRs with a standing Overseer verdict, ascending by `cursorSeq`. Reads
   * the LOCAL dispatch store -- never GitHub -- so building the candidate set
   * is free.
   *
   * `afterSeq` is an EXCLUSIVE lower bound pushed into the query, not an offset
   * applied to an already-fetched page: that is what makes each page a
   * genuinely different slice of a store far larger than any one page.
   *
   * Returns a PAGE, not a bare list, because the two questions the caller must
   * distinguish -- "did we reach the end of the store" and "did anything in
   * this page parse" -- have different answers (#786 review @e80159e4).
   */
  listCandidates(limit: number, afterSeq: number): Promise<SweepCandidatePage>;
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
   * ones that refunded their budget slot. Reported so a heartbeat that spent no
   * budget is still visibly making progress through the store.
   */
  consumed: number;
  /**
   * The resume token this heartbeat ended on: the position the walk advanced
   * to, or 0 when the walk wrapped at the end of the store.
   */
  afterSeq: number;
  /**
   * Raw rows this heartbeat's page dropped for unparseable or incomplete
   * bodies. Non-zero means the store holds malformed review items -- the walk
   * still advances past them, but they are worth seeing.
   */
  discarded: number;
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
  cursor: SweepCursor = createMemorySweepCursor()
): Promise<StaleVerdictSweepResult> {
  const result: StaleVerdictSweepResult = {
    examined: 0,
    enqueued: 0,
    duplicates: 0,
    consumed: 0,
    afterSeq: 0,
    discarded: 0,
  };
  if (max <= 0) return result;

  let startAfterSeq: number;
  try {
    startAfterSeq = Math.max(0, await cursor.read());
  } catch (error) {
    // A cursor that cannot be read restarts the walk at the head of the store:
    // wasteful, never wrong, and still bounded by the per-heartbeat budget.
    log.warn({ err: error }, 'overseer_stale_verdict_sweep_cursor_read_failed');
    startAfterSeq = 0;
  }
  result.afterSeq = startAfterSeq;

  let page: SweepCandidatePage;
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
    page = await deps.listCandidates(max + CANDIDATE_LOOKAHEAD, startAfterSeq);
  } catch (error) {
    log.error({ err: error }, 'overseer_stale_verdict_sweep_candidates_failed');
    return result;
  }
  const candidates = page.candidates;
  result.discarded = page.discarded;

  // A malformed run must be VISIBLE. Rows are dropped silently otherwise, and a
  // sweep that quietly examines nothing looks identical to a healthy one.
  if (page.discarded > 0) {
    log.warn(
      { discarded: page.discarded, rawCount: page.rawCount, afterSeq: startAfterSeq },
      'overseer_stale_verdict_sweep_discarded_unparseable_rows'
    );
  }

  // END OF THE STORE means the QUERY RETURNED NOTHING -- never "nothing
  // parsed". Conflating the two is what let a page of unparseable rows rewind
  // the cursor to 0 on every heartbeat, so valid candidates sitting beyond
  // those rows were unreachable forever (#786 review @e80159e4).
  if (page.rawCount === 0) {
    if (startAfterSeq !== 0) {
      await safeWriteCursor(cursor, 0);
      result.afterSeq = 0;
    }
    return result;
  }

  // RAW ROWS EXIST BUT NONE PARSED: advance PAST them rather than rewinding, so
  // the next heartbeat resumes beyond the malformed block instead of re-reading
  // it. This is the branch the finding named.
  if (candidates.length === 0) {
    await safeWriteCursor(cursor, page.lastRawSeq);
    result.afterSeq = page.lastRawSeq;
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
  // included -- the starvation being fixed is about page slots consumed, not
  // budget spent.
  let consumed = 0;
  // The resume token: the position of the LAST candidate consumed. Tracked
  // separately from `consumed` because the cursor must be a real database
  // position, not a count -- that is what lets the next page be a different
  // slice of a store far larger than one page.
  let lastSeq = startAfterSeq;

  for (const candidate of candidates) {
    if (remaining <= 0) break;
    remaining -= 1;
    consumed += 1;
    lastSeq = candidate.cursorSeq;
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

  // ADVANCE THE WALK to the last position actually consumed, so the next
  // heartbeat asks for rows strictly after it rather than re-reading this slice.
  //
  // WHICH POSITION depends on whether the budget stopped us mid-page. If we
  // walked every candidate the page offered, advance to the last RAW row --
  // that carries the cursor past any unparseable rows trailing the last good
  // candidate, which is the whole point of tracking the raw position. If the
  // budget ran out first, advance only to the last candidate actually examined,
  // because the rows after it have NOT been looked at and must not be skipped.
  //
  // END-OF-STORE is judged on RAW rows against the requested limit, never on
  // candidate count: with rows being discarded, a completely full raw page can
  // still yield only a handful of candidates, and comparing those would rewind
  // the walk while the store still had rows left.
  result.consumed = consumed;
  const walkedWholePage = consumed >= candidates.length;
  const pageWasShort = page.rawCount < max + CANDIDATE_LOOKAHEAD;
  const nextAfterSeq = walkedWholePage
    ? pageWasShort
      ? 0 // Short raw page fully walked: the store is exhausted, restart.
      : page.lastRawSeq
    : lastSeq;
  await safeWriteCursor(cursor, nextAfterSeq);
  result.afterSeq = nextAfterSeq;
  return result;
}

/**
 * Persist the resume token without ever failing the heartbeat.
 *
 * A cursor that cannot be written leaves the sweep repeating one page, which
 * the next successful write corrects. Losing a backstop's place is never worth
 * taking down the review worker tick that carries the primary review path.
 */
async function safeWriteCursor(cursor: SweepCursor, afterSeq: number): Promise<void> {
  try {
    await cursor.write(afterSeq);
  } catch (error) {
    log.warn({ err: error, afterSeq }, 'overseer_stale_verdict_sweep_cursor_write_failed');
  }
}
