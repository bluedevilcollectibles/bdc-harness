/**
 * Taskmaster Slice 1 rules (WO-HARNESS-TASKMASTER-SLICE1-01, M-133).
 *
 * Pure functions only: thread classification and next-action computation.
 * No I/O, no clock reads -- the caller injects `now`.
 *
 * Nudge clocks per the ratified Q1 numbers: 30min P0/customer, 4h P1,
 * 24h P2-P3. Exceptions (undelivered ratified rulings, unclaimed P0s) act
 * on the tick that confirms eligibility; ordinary nudges require the same
 * proposal to be eligible on TWO consecutive ticks before acting.
 *
 * NOTE (Rule 17): the WO spec cites duty_officer.ts as the source of the
 * idle/stale math, but the live file contains transport + content-guard code
 * only -- no staleness classification exists there to port. The math here is
 * implemented directly from spec Section 8's ratified nudge clocks.
 *
 * M-155 WO 3 (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01): ordinary nudges are
 * composed from the tm_adoption projection (title, owner, blocker, next
 * action) and are content-gated -- bare staleness with no known next action
 * no longer sends. deliver_ruling and escalate_p0 are content-EXEMPT
 * (governance facts, not item state) and still fire without an adoption row.
 * Threads whose two most recent graded sends were both 'noise' are suppressed
 * until their adoption content hash changes (durable state in tm_suppression).
 */
import { createHash } from 'crypto';
import type { TmAdoptionRow } from '@archon/core/db/taskmaster';
import type { FireEligibilityEvidence } from './fire-eligibility';
import { WO_ID_RE } from './guard';

export type ThreadPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ThreadClass = 'ready' | 'stale' | 'blocked' | 'healthy';
export type TmActionType = 'deliver_ruling' | 'nudge' | 'escalate_p0' | 'digest' | 'fire_cauldron';

export type FireEvidence = FireEligibilityEvidence;

export interface ThreadSnapshot {
  /** Stable reference, e.g. "gh:owner/repo#123" or "dispatch:<message-id>" */
  ref: string;
  priority: ThreadPriority;
  /** Customer-facing threads use the P0 clock regardless of priority. */
  isCustomerFacing?: boolean;
  /** ISO timestamp of last observed activity on the thread. */
  lastActivityAt: string;
  /** Blocked threads are watched, never nudged (John's decision surface). */
  isBlocked?: boolean;
  /** Hold labels withhold fire without changing ordinary nudge classification. */
  isHeld?: boolean;
  /** Ratified ruling sitting undelivered for this thread's seat. */
  undeliveredRulingId?: string;
  /** P0 with no assignee/claim. */
  isUnclaimedP0?: boolean;
  /** No assignee and no claim status, at any priority. */
  isUnclaimed?: boolean;
  /** Recipient seat for any message about this thread. */
  recipient: string;
}

export interface ActionProposal {
  type: TmActionType;
  threadRef: string;
  recipient: string;
  body: string;
  idempotencyKey: string;
  /** True for the exception classes that act on the confirming tick. */
  actsImmediately: boolean;
  /**
   * Defense-in-depth marker (M-155 WO 3): set only when a caller constructs a
   * proposal whose body could not be content-completed. computeNextAction
   * never emits it (incomplete content yields NO proposal); the guard rejects
   * any flagged proposal with the ORDINARY 'content_incomplete' reason.
   */
  contentIncomplete?: boolean;
  /** Mechanical evidence required before the non-message fire effect is admitted. */
  fireEvidence?: FireEvidence;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Ratified Q1 nudge clocks. P1 tightened 4h -> 2h by John's cadence ruling
 * 2026-08-24 ("these need to be frequent, and I know we might have to
 * adjust") -- paired with TASKMASTER_INTERVAL_MS 3600000 -> 900000 on the
 * host. The 40% useful-rate floor is the guardrail: faster-and-noisy trips
 * it sooner, so frequency cannot silently become flood.
 */
export const NUDGE_CLOCK_MS: Record<ThreadPriority, number> = {
  P0: 30 * MINUTE_MS,
  P1: 2 * HOUR_MS,
  P2: 24 * HOUR_MS,
  P3: 24 * HOUR_MS,
};

export const CUSTOMER_CLOCK_MS = 30 * MINUTE_MS;

/**
 * M-155 ruling, open item Q3: "the proposed 40%-of-graded floor with
 * auto-PAUSE stands as the working number". When the useful rate over graded
 * actions in the journal lookback window falls below this floor, the loop
 * pauses ITSELF (scope='effects') instead of continuing to emit noise. The
 * floor was slated for WO-RUNTIME-RESTORE-01 and verified ABSENT from the
 * shipped code on 2026-08-24 -- this implements the ratified working number.
 */
export const USEFUL_RATE_FLOOR = 0.4;

/**
 * Minimum graded sample before the floor can trip. Prevents a single early
 * noise grade (1 noise / 0 useful = 0%) from pausing a freshly-resumed loop
 * before it has produced enough graded evidence to judge.
 */
export const USEFUL_RATE_MIN_GRADED = 5;

/**
 * Pure floor test: true when the graded sample is large enough AND the
 * useful share of graded actions is strictly below USEFUL_RATE_FLOOR.
 * Exactly 40% does not breach (the ruling says "floor", not "must exceed").
 */
export function usefulRateFloorBreached(usefulCount: number, noiseCount: number): boolean {
  const graded = usefulCount + noiseCount;
  if (graded < USEFUL_RATE_MIN_GRADED) return false;
  return usefulCount / graded < USEFUL_RATE_FLOOR;
}

/** Max automated interventions per item per 24h (ratified budget). */
export const MAX_INTERVENTIONS_PER_ITEM_24H = 3;

export function nudgeClockMs(
  thread: Pick<ThreadSnapshot, 'priority' | 'isCustomerFacing'>
): number {
  if (thread.isCustomerFacing) return CUSTOMER_CLOCK_MS;
  return NUDGE_CLOCK_MS[thread.priority];
}

/** Classify a thread at `nowMs` (epoch millis). */
export function classifyThread(thread: ThreadSnapshot, nowMs: number): ThreadClass {
  if (thread.isBlocked) return 'blocked';
  if (thread.undeliveredRulingId || thread.isUnclaimedP0) return 'ready';
  const lastActivityMs = Date.parse(thread.lastActivityAt);
  if (Number.isNaN(lastActivityMs)) {
    // Unparseable activity timestamp: treat as healthy rather than guessing
    // staleness from garbage. The read layer logs the anomaly.
    return 'healthy';
  }
  const idleMs = nowMs - lastActivityMs;
  return idleMs >= nudgeClockMs(thread) ? 'stale' : 'healthy';
}

/** Minimal graded-journal shape consumed by the pure suppression check. */
export interface GradedActionLike {
  thread_ref: string;
  grade: string | null;
  graded_at: string | null;
}

/** Minimal tm_suppression shape consumed by the pure suppression check. */
export interface SuppressionLike {
  suppressed_until_hash: string;
}

export interface NextActionContext {
  /** Automated interventions already journaled for this item in last 24h. */
  interventionsLast24h: number;
  nowMs: number;
  /**
   * Content-bearing tm_adoption row for this thread's canonical ref (M-155
   * WO 3). Optional so the function stays pure and table-testable -- the
   * caller in loop.ts supplies the row; no I/O, no clock, no DAL handle here.
   */
  adoption?: TmAdoptionRow;
  /** Graded journal rows for this thread's canonical ref (suppression input). */
  grades?: readonly GradedActionLike[];
  /** Durable tm_suppression row for this thread's canonical ref, if any. */
  suppression?: SuppressionLike;
  fireEligible?: boolean;
  fireLane?: 'claude' | 'codex' | 'xai' | null;
  fireHolding?: boolean;
  fireEscalate?: boolean;
  customerP0Exempt?: boolean;
  fireEvidence?: FireEvidence;
}

/**
 * Stable hash over the adoption fields a human would act on: title, owner,
 * blocked state/reason, next action, last movement. Excludes
 * evidence_observed_at and attempt counts -- those move without the work
 * moving. Suppression lifts when this hash changes.
 */
export function adoptionContentHash(adoption: TmAdoptionRow): string {
  const content = JSON.stringify({
    title: adoption.title,
    owner_login: adoption.owner_login,
    is_blocked: adoption.is_blocked,
    blocked_reason: adoption.blocked_reason,
    next_action: adoption.next_action,
    last_movement_at: adoption.last_movement_at,
  });
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Noise suppression (Section 6/7): true when this thread should NOT be
 * nudged because its own grader has already called the last two sends noise
 * and the adoption content has not moved since.
 *
 * - With a durable suppression row: suppressed exactly while the live
 *   content hash still equals suppressed_until_hash (hash change = the work
 *   moved = suppression lifts).
 * - Without a row (first trigger): the two most recent GRADED rows for the
 *   ref must both be 'noise'. Ungraded rows (grade IS NULL) never count --
 *   the audit found 757 ungraded sends and none of them is evidence of
 *   anything. Adoption movement recorded after the later noise grade lifts
 *   the presumption ("unchanged since the later of them").
 *
 * Pure: the caller supplies the grade rows and the suppression row.
 */
export function isSuppressedByNoise(
  _threadRef: string,
  grades: readonly GradedActionLike[],
  adoption: TmAdoptionRow | undefined,
  suppression?: SuppressionLike
): boolean {
  if (!adoption) return false;
  const liveHash = adoptionContentHash(adoption);
  if (suppression) return suppression.suppressed_until_hash === liveHash;
  // NOTE: `grades` is ALREADY scoped to this thread's canonical ref by both
  // call sites (loop.ts groups journal rows via canonicalizeThreadRef before
  // passing them in). Re-filtering on the raw g.thread_ref here silently
  // discarded every legacy/case-variant reference for the same thread, so
  // canonical grouping never actually suppressed repeated noise.
  const graded = grades
    .filter(g => g.grade !== null && g.graded_at !== null)
    .sort((a, b) => Date.parse(b.graded_at ?? '') - Date.parse(a.graded_at ?? ''));
  if (graded.length < 2) return false;
  if (graded[0].grade !== 'noise' || graded[1].grade !== 'noise') return false;
  const laterGradeMs = Date.parse(graded[0].graded_at ?? '');
  const movementMs = adoption.last_movement_at ? Date.parse(adoption.last_movement_at) : NaN;
  if (Number.isFinite(movementMs) && Number.isFinite(laterGradeMs) && movementMs > laterGradeMs) {
    return false;
  }
  return true;
}

/** Human-readable "how long since real movement" from last_movement_at. */
function describeMovement(lastMovementAt: string | null, nowMs: number): string {
  const movementMs = lastMovementAt ? Date.parse(lastMovementAt) : NaN;
  if (!Number.isFinite(movementMs)) return 'No movement has been recorded yet';
  const idleMs = Math.max(0, nowMs - movementMs);
  const hours = Math.floor(idleMs / HOUR_MS);
  if (hours < 1) return 'Last movement under an hour ago';
  if (hours < 48) return `Last movement ${hours}h ago`;
  return `Last movement ${Math.floor(hours / 24)} days ago`;
}

/** Canonical GitHub URL for an adoption row. */
function adoptionIssueUrl(adoption: TmAdoptionRow): string {
  return `https://github.com/${adoption.repo}/issues/${adoption.issue_number}`;
}

/**
 * Compose a content-complete nudge body from the adoption row, or null when
 * the row cannot support one (null means INELIGIBLE -- the caller must not
 * send; the item stays visible on the register instead).
 *
 * Ineligible when the row lacks a title, or lacks BOTH a blocked reason and
 * a next action (Section 6 row 5: bare staleness with no known next action
 * no longer sends -- 355 of 384 graded nudges in the audited corpus were
 * exactly this class).
 */
export function composeNudgeBody(
  thread: ThreadSnapshot,
  adoption: TmAdoptionRow | undefined,
  nowMs: number
): string | null {
  if (!adoption) return null;
  const title = adoption.title?.trim();
  if (!title) return null;
  const blockedReason = adoption.blocked_reason?.trim() || null;
  const nextAction = adoption.next_action?.trim() || null;
  if (!blockedReason && !nextAction) return null;
  const owner = adoption.owner_login?.trim() || 'UNKNOWN';
  const why = blockedReason ? `Blocked: ${blockedReason}` : `Next action: ${nextAction}`;
  return (
    `Nudge (${thread.priority}): "${title}" -- owner: ${owner}. ${why}. ` +
    `${describeMovement(adoption.last_movement_at, nowMs)}. ${adoptionIssueUrl(adoption)} ` +
    'Reply on the issue starting with [PROGRESS] or [BLOCKED] so the ' +
    'source-of-truth change can be verified.'
  );
}

/** Seats a blocked_reason can name to make a blocked item nudge-eligible (Section 6 row 3). */
const SEAT_NAMES = ['xo', 'major-build', 'captain-ci', 'operator'] as const;

function blockedReasonNamesSeat(adoption: TmAdoptionRow | undefined): boolean {
  const reason = adoption?.blocked_reason?.toLowerCase() ?? '';
  if (!reason) return false;
  return SEAT_NAMES.some(seat => reason.includes(seat));
}

/**
 * Compute at most ONE typed proposal for a thread, or null for no-op.
 * Priority order within a thread (unchanged): ruling delivery > P0
 * escalation > nudge.
 *
 * Content policy (M-155 WO 3, Section 6): deliver_ruling and escalate_p0 are
 * content-EXEMPT -- an undelivered ratified ruling and an unclaimed P0 are
 * governance facts, not item state, and a null title must never suppress
 * them (deliberate, do not "fix"). Ordinary nudges are strictly gated: no
 * content-complete body -> NO proposal (register only, never a send).
 */
export function computeNextAction(
  thread: ThreadSnapshot,
  classification: ThreadClass,
  context: NextActionContext
): ActionProposal | null {
  const adoption = context.adoption;
  // Section 6 row 3: a blocked item is watched, never nudged -- unless its
  // blocked_reason names a seat that can unblock it (full content required).
  const blockedSeatNudge = classification === 'blocked' && blockedReasonNamesSeat(adoption);
  if (classification === 'blocked' && !blockedSeatNudge) return null;
  if (context.interventionsLast24h >= MAX_INTERVENTIONS_PER_ITEM_24H) return null;

  if (thread.undeliveredRulingId) {
    const titleNote = adoption?.title ? ` Item: "${adoption.title}".` : '';
    return {
      type: 'deliver_ruling',
      threadRef: thread.ref,
      recipient: thread.recipient,
      body:
        `Ratified ruling ${thread.undeliveredRulingId} is addressed to you and has no ` +
        'delivery record. Please acknowledge it via the dispatch mailbox and act on it. ' +
        `Thread: ${thread.ref}.${titleNote}`,
      idempotencyKey: `tm:deliver_ruling:${thread.undeliveredRulingId}`,
      actsImmediately: true,
    };
  }

  if (
    (thread.isUnclaimed ?? thread.isUnclaimedP0) &&
    classification !== 'blocked' &&
    !thread.isHeld
  ) {
    const bucket = Math.floor(context.nowMs / NUDGE_CLOCK_MS.P0);
    if (
      context.fireEligible &&
      context.fireEvidence?.expectedSpec &&
      !context.fireEscalate &&
      (context.fireLane || context.customerP0Exempt)
    ) {
      const lane = context.fireLane ?? 'claude';
      return {
        type: 'fire_cauldron',
        threadRef: thread.ref,
        recipient: 'operator',
        body: `Start governed Cauldron work for ${context.fireEvidence.woId} on ${lane} lane.`,
        idempotencyKey: `tm:fire:${thread.ref}:${bucket}`,
        actsImmediately: true,
        fireEvidence: context.fireEvidence,
      };
    }
    if (
      thread.isUnclaimedP0 &&
      context.fireEligible &&
      context.fireEvidence &&
      context.fireHolding
    ) {
      return null;
    }
  }

  if (classification === 'healthy') return null;

  if (thread.isUnclaimedP0) {
    const bucket = Math.floor(context.nowMs / NUDGE_CLOCK_MS.P0);
    const woId = adoption?.title?.match(WO_ID_RE);
    const title = woId?.index === 0 ? woId[0] : adoption?.title;
    const titleNote = title ? `"${title}" (${thread.ref})` : thread.ref;
    const age = describeMovement(
      adoption?.last_movement_at ?? thread.lastActivityAt,
      context.nowMs
    );
    return {
      type: 'escalate_p0',
      threadRef: thread.ref,
      recipient: 'operator',
      body:
        `Unclaimed P0: ${titleNote} [${thread.priority}] has no owner. ${age}. ` +
        "This is an escalation for John's attention; no automated assignment " +
        'is made (Slice 1 has no assignment authority).' +
        (adoption ? ` ${adoptionIssueUrl(adoption)}` : ''),
      idempotencyKey: `tm:escalate_p0:${thread.ref}:${bucket}`,
      actsImmediately: true,
    };
  }

  if (classification === 'stale' || blockedSeatNudge) {
    // Noise suppression: the grader already called this thread's sends noise
    // and its content has not moved -- stay quiet until the work moves.
    if (isSuppressedByNoise(thread.ref, context.grades ?? [], adoption, context.suppression)) {
      return null;
    }
    const clock = nudgeClockMs(thread);
    const bucket = Math.floor(context.nowMs / clock);
    // Section 6 rows 4-5: no content-complete body -> NO proposal. This
    // includes a missing adoption row entirely (composeNudgeBody returns null
    // for it): content policy cannot be evaluated without content, so nothing
    // is sent or journaled -- the item stays visible on the register (WO 2)
    // instead of triggering a contentless reminder.
    const body = composeNudgeBody(thread, adoption, context.nowMs);
    if (body === null) return null;
    return {
      type: 'nudge',
      threadRef: thread.ref,
      recipient: thread.recipient,
      body,
      idempotencyKey: `tm:nudge:${thread.ref}:${bucket}`,
      actsImmediately: false,
    };
  }

  return null;
}
