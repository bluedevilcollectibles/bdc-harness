/**
 * Taskmaster Slice 1 DAL (WO-HARNESS-TASKMASTER-SLICE1-01, M-133).
 *
 * Persistence for the deterministic taskmaster loop: action journal
 * (row-first discipline), singleton pause/epoch control, provider health
 * samples with expiry, and usage observations where a failed meter is
 * recorded as is_unknown=1 -- never as zero available capacity.
 *
 * All sends still go through the dispatch DAL (createAuthenticatedMessage in
 * ./dispatch.ts). This module never writes agent_dispatch_messages.
 */
import { randomUUID } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';
import type { QueryResult } from './adapters/types';
import {
  withOverseerControlPlaneImmediateTransaction,
  type OverseerControlPlaneQuery,
} from './overseer-control-plane-sqlite';

const log = createLogger('db/taskmaster');

export type TmActionType = 'deliver_ruling' | 'nudge' | 'escalate_p0' | 'digest' | 'fire_cauldron';
export type TmActionOutcome =
  | 'pending'
  | 'sent'
  | 'parked'
  | 'deferred'
  | 'rejected'
  | 'expired'
  | 'failed';
export type TmGrade = 'useful' | 'noise' | 'harmful';
export type TmPauseState = 'RUNNING' | 'PAUSED' | 'HARD_PAUSE';
export type TmHealthState = 'healthy' | 'degraded' | 'dark' | 'unknown';
export type TmUsageConfidence = 'high' | 'low' | 'none';
export type TmExpectationAbsence = 'redispatch' | 'escalate' | 'give_up';
export type TmExpectationStatus = 'pending' | 'met' | 'failed' | 'escalated' | 'given_up';

export interface TmExpectation {
  id: string;
  dispatch_ref: string;
  recipient: string;
  evidence_json: string;
  due_at: string;
  on_absence: TmExpectationAbsence;
  max_retries: number;
  retries: number;
  status: TmExpectationStatus;
  evidence_pointer: string | null;
  created_at: string;
  updated_at: string;
}

export interface TmJournalEntry {
  id: string;
  created_at: string;
  thread_ref: string;
  action_type: TmActionType;
  proposal_json: string;
  idempotency_key: string | null;
  before_hash: string | null;
  proof_predicate: string | null;
  proof_deadline_at: string | null;
  outcome: TmActionOutcome;
  graded_at: string | null;
  grade: TmGrade | null;
}

export interface TmControlState {
  pause_state: TmPauseState;
  pause_scope: string | null;
  pause_reason: string | null;
  pause_actor: string | null;
  epoch: number;
  updated_at: string;
}

export interface TmHealthSample {
  provider: string;
  state: TmHealthState;
  sampled_at: string;
  expires_at: string;
  evidence: string | null;
}

export interface TmUsageSample {
  id: string;
  provider: string;
  window_kind: string;
  source: string;
  observed_at: string;
  value_json: string | null;
  confidence: TmUsageConfidence | null;
  is_unknown: number;
}

interface TmJournalRow extends Omit<
  TmJournalEntry,
  'created_at' | 'proof_deadline_at' | 'graded_at'
> {
  created_at: string | Date;
  proof_deadline_at: string | Date | null;
  graded_at: string | Date | null;
}

interface TmControlRow extends Omit<TmControlState, 'epoch' | 'updated_at'> {
  epoch: number | string;
  updated_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIso(value: string | Date | null): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function normalizeJournal(row: TmJournalRow): TmJournalEntry {
  return {
    ...row,
    created_at: toIso(row.created_at),
    proof_deadline_at: toNullableIso(row.proof_deadline_at),
    graded_at: toNullableIso(row.graded_at),
  };
}

function normalizeControl(row: TmControlRow): TmControlState {
  return {
    pause_state: row.pause_state,
    pause_scope: row.pause_scope,
    pause_reason: row.pause_reason,
    pause_actor: row.pause_actor,
    epoch: Number(row.epoch),
    updated_at: toIso(row.updated_at),
  };
}

function normalizeExpectation(row: TmExpectation): TmExpectation {
  return {
    ...row,
    max_retries: row.max_retries,
    retries: row.retries,
    due_at: toIso(row.due_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export async function registerExpectation(data: {
  dispatch_ref: string;
  recipient: string;
  evidence_json: string;
  due_at: string;
  on_absence: TmExpectationAbsence;
  max_retries: number;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await getDatabase().query(
    `INSERT INTO tm_expectations
     (id, dispatch_ref, recipient, evidence_json, due_at, on_absence, max_retries,
      retries, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'pending', $8, $8)`,
    [
      id,
      data.dispatch_ref,
      data.recipient,
      data.evidence_json,
      data.due_at,
      data.on_absence,
      data.max_retries,
      now,
    ]
  );
  return id;
}

/** Active expectations are returned even before due_at so success can close early. */
export async function listDueExpectations(_now: string): Promise<TmExpectation[]> {
  const result = await getDatabase().query<TmExpectation>(
    "SELECT * FROM tm_expectations WHERE status IN ('pending', 'failed') ORDER BY due_at ASC"
  );
  return result.rows.map(normalizeExpectation);
}

/**
 * The only statuses an expectation can be transitioned OUT of.
 *
 * `met`, `escalated` and `given_up` are TERMINAL: once a tick has closed an
 * expectation, no other tick may reopen or overwrite it. Every transition below
 * names this set (or a narrower one) in its WHERE clause, so a stale worker
 * cannot regress a closed row -- and, because each returns rowCount, cannot
 * silently proceed to the external action that transition was gating either.
 */
const ACTIVE_EXPECTATION_STATUSES = ['pending', 'failed'] as const;

/**
 * Conditional state transition. The prior status is named in the WHERE clause
 * and the affected-row count IS the answer: true means this caller owns the
 * transition, false means another tick got there first and the caller must not
 * perform whatever external action the transition was gating.
 *
 * A plain `UPDATE ... WHERE id = $1` (the pre-repair shape) let two overlapping
 * ticks stamp conflicting statuses onto the same row -- one verifying evidence
 * and marking it met, the other stamping failed over the top and redispatching
 * work that had already succeeded.
 */
async function transitionExpectation(
  id: string,
  status: TmExpectationStatus,
  fromStatuses: readonly TmExpectationStatus[],
  evidencePointer?: string | null
): Promise<boolean> {
  const placeholders = fromStatuses.map((_, index) => `$${String(index + 4)}`).join(', ');
  const result = await getDatabase().query(
    `UPDATE tm_expectations
        SET status = $1, evidence_pointer = $2, updated_at = $3
      WHERE id = $${String(fromStatuses.length + 4)}
        AND status IN (${placeholders})`,
    [status, evidencePointer ?? null, new Date().toISOString(), ...fromStatuses, id]
  );
  return result.rowCount === 1;
}

/**
 * Close an expectation as met. Returns false when another tick already closed
 * it -- evidence arriving twice is not an error, but the second observer must
 * not re-close the row.
 */
export async function markMet(id: string, evidencePointer: string): Promise<boolean> {
  return transitionExpectation(id, 'met', ACTIVE_EXPECTATION_STATUSES, evidencePointer);
}

/**
 * Record that the deadline passed with no evidence. Conditioned on the row
 * still being active, so a concurrent tick that has already marked it met (or
 * escalated it, or given up on it) cannot be overwritten with `failed`.
 * Returns false when the row was already closed; the caller MUST then skip the
 * redispatch/escalate work that follows.
 */
export async function markFailed(id: string): Promise<boolean> {
  return transitionExpectation(id, 'failed', ACTIVE_EXPECTATION_STATUSES);
}

// NOTE: there is deliberately no unconditional incrementRetry(). It existed
// until this repair and was exactly the unsafe primitive the review flagged --
// a blind `WHERE id = $1` that let a stale tick advance the counter on a row
// another tick had already closed. claimRedispatchAttempt() is the only way to
// advance retries, and it is a compare-and-set. Do not reintroduce a
// non-conditional variant.

/**
 * Atomically CLAIM the next redispatch attempt (WO review finding: redispatch
 * was neither atomic nor idempotent).
 *
 * The counter is advanced BEFORE the send, under a compare-and-set on BOTH the
 * retry count and the active status the caller observed, and bounded by
 * max_retries in the same statement. Consequences the caller relies on:
 *
 *  - Two overlapping ticks: only one UPDATE matches `retries = $expected`;
 *    the loser gets null and MUST NOT send. No double-dispatch.
 *  - A tick that raced a successful verification: the row is already `met`, so
 *    it is no longer in the active set, no row matches, and no redispatch is
 *    sent for work that has already succeeded. The retry-counter CAS alone did
 *    NOT prevent this -- the status predicate is what closes it.
 *  - A crash after the claim and before the send: the count is already
 *    advanced, so the budget can never be exceeded and the count is never
 *    lost. The caller replays the attempt under its deterministic
 *    idempotency key, so recovery cannot double-send either.
 *  - retries >= max_retries: no row matches, null is returned, and the caller
 *    falls through to escalation instead of looping.
 *
 * Returns the claimed attempt number (1-based), or null when the claim lost.
 */
export async function claimRedispatchAttempt(
  id: string,
  expectedRetries: number,
  dueAt: string
): Promise<number | null> {
  // ONE statement decides the claim, and its affected-row count IS the answer.
  //
  // Doing this as an UPDATE followed by a separate SELECT would be wrong even
  // inside a transaction on some engines and is outright unusable here: two
  // ticks would both re-read expected+1 and both believe they won. Wrapping it
  // in withTransaction is also not an option -- the sqlite adapter runs on a
  // single connection and rejects a nested BEGIN, so a caller that already
  // holds a transaction would crash.
  //
  // A conditional UPDATE needs neither: on Postgres the row lock serializes the
  // two writers and the loser's `retries = $expected` predicate no longer
  // matches; on the single-connection sqlite adapter the statement is atomic by
  // construction. rowCount is 1 for the winner and 0 for everyone else.
  const activePlaceholders = ACTIVE_EXPECTATION_STATUSES.map(
    (_, index) => `$${String(index + 5)}`
  ).join(', ');
  const result = await getDatabase().query(
    `UPDATE tm_expectations
        SET status = 'failed', retries = retries + 1, due_at = $1, updated_at = $2
      WHERE id = $3
        AND retries = $4
        AND retries < max_retries
        AND status IN (${activePlaceholders})`,
    [dueAt, new Date().toISOString(), id, expectedRetries, ...ACTIVE_EXPECTATION_STATUSES]
  );
  return result.rowCount === 1 ? expectedRetries + 1 : null;
}
/**
 * Close an expectation as escalated to a human. Conditioned on the row still
 * being active so a tick cannot escalate an expectation another tick has
 * already verified as met. Returns false when the row was already closed.
 */
export async function markEscalated(id: string, evidencePointer?: string): Promise<boolean> {
  return transitionExpectation(id, 'escalated', ACTIVE_EXPECTATION_STATUSES, evidencePointer);
}

/**
 * Close an expectation as abandoned, with the reason as the pointer.
 * Conditioned on the row still being active for the same reason as
 * markEscalated. Returns false when the row was already closed.
 */
export async function markGivenUp(id: string, reason: string): Promise<boolean> {
  return transitionExpectation(id, 'given_up', ACTIVE_EXPECTATION_STATUSES, reason);
}

export async function getExpectationCounts(): Promise<Record<TmExpectationStatus, number>> {
  const counts: Record<TmExpectationStatus, number> = {
    pending: 0,
    met: 0,
    failed: 0,
    escalated: 0,
    given_up: 0,
  };
  const result = await getDatabase().query<{ status: TmExpectationStatus; count: number | string }>(
    'SELECT status, COUNT(*) AS count FROM tm_expectations GROUP BY status'
  );
  for (const row of result.rows) counts[row.status] = Number(row.count);
  return counts;
}

/**
 * Record a taskmaster action in the journal. ROW FIRST, always -- the loop
 * calls this BEFORE attempting any external effect, then updates the outcome
 * afterwards via updateActionOutcome().
 */
export async function recordAction(data: {
  thread_ref: string;
  action_type: TmActionType;
  proposal_json: string;
  idempotency_key?: string | null;
  before_hash?: string | null;
  proof_predicate?: string | null;
  proof_deadline_at?: string | null;
  outcome: TmActionOutcome;
}): Promise<TmJournalEntry> {
  const db = getDatabase();
  const idempotencyKey = data.idempotency_key ?? null;
  if (idempotencyKey) {
    const existing = await getActionByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
  }

  let result: QueryResult<TmJournalRow>;
  try {
    result = await db.query<TmJournalRow>(
      `INSERT INTO tm_journal
       (id, created_at, thread_ref, action_type, proposal_json, idempotency_key,
        before_hash, proof_predicate, proof_deadline_at, outcome)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       WHERE $6 IS NULL OR NOT EXISTS (
         SELECT 1 FROM tm_journal WHERE idempotency_key = $6
       )
       RETURNING *`,
      [
        randomUUID(),
        new Date().toISOString(),
        data.thread_ref,
        data.action_type,
        data.proposal_json,
        idempotencyKey,
        data.before_hash ?? null,
        data.proof_predicate ?? null,
        data.proof_deadline_at ?? null,
        data.outcome,
      ]
    );
  } catch (error) {
    if (!idempotencyKey) throw error;
    const raced = await getActionByIdempotencyKey(idempotencyKey);
    if (raced) return raced;
    throw error;
  }
  const row = result.rows[0];
  if (!row && idempotencyKey) {
    const existing = await getActionByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
  }
  if (!row) throw new Error('Failed to record taskmaster action');
  return normalizeJournal(row);
}

interface ResetAuditData {
  actor: string;
  reason: string | null;
  previousEpoch: number;
  newEpoch: number;
  transitioned: boolean;
}

async function insertResetAudit(
  query: OverseerControlPlaneQuery,
  data: ResetAuditData
): Promise<TmJournalEntry> {
  const result = await query<TmJournalRow>(
    `INSERT INTO tm_journal (id, created_at, thread_ref, action_type, proposal_json, outcome)
     VALUES ($1, $2, 'taskmaster:reset', 'digest', $3, 'sent') RETURNING *`,
    [
      randomUUID(),
      new Date().toISOString(),
      JSON.stringify({
        audit_type: 'taskmaster_reset',
        actor: data.actor,
        reason: data.reason,
        previous_epoch: data.previousEpoch,
        new_epoch: data.newEpoch,
        transitioned: data.transitioned,
      }),
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to record taskmaster reset audit');
  return normalizeJournal(row);
}

/** Record one audit row for every operator reset invocation. */
export async function recordResetAudit(data: ResetAuditData): Promise<TmJournalEntry> {
  const db = getDatabase();
  return insertResetAudit(db.query.bind(db), data);
}

/** Execute the resume endpoint's idempotent reset sequence. */
export async function resetTaskmaster(data: { actor: string; reason: string | null }): Promise<{
  control: TmControlState;
  expiredProposals: number;
  audit: TmJournalEntry;
}> {
  const db = getDatabase();
  const reset = async (
    query: OverseerControlPlaneQuery
  ): Promise<{
    control: TmControlState;
    expiredProposals: number;
    audit: TmJournalEntry;
  }> => {
    await query(
      `INSERT INTO tm_control (id, pause_state, epoch, updated_at)
       VALUES (1, 'RUNNING', 0, $1) ON CONFLICT (id) DO NOTHING`,
      [new Date().toISOString()]
    );
    const previousResult = await query<TmControlRow>(
      'SELECT * FROM tm_control WHERE id = 1' + (db.dialect === 'postgres' ? ' FOR UPDATE' : '')
    );
    const previousRow = previousResult.rows[0];
    if (!previousRow) throw new Error('tm_control singleton missing during reset');
    const previous = normalizeControl(previousRow);
    const expired = await query(
      "UPDATE tm_journal SET outcome = 'expired' WHERE outcome IN ('parked', 'pending')"
    );
    const transition = await query(
      `UPDATE tm_control SET pause_state = 'RUNNING', epoch = epoch + 1, updated_at = $1
       WHERE id = 1 AND pause_state <> 'RUNNING'`,
      [new Date().toISOString()]
    );
    const transitioned = transition.rowCount === 1;
    // updated_at bounds the useful-rate epoch window. A repeated RUNNING
    // reset must not move it forward and discard accumulated grade evidence.
    await query(
      `UPDATE tm_control SET pause_scope = NULL, pause_reason = NULL,
       pause_actor = $1 WHERE id = 1`,
      [data.actor]
    );
    const current = await query<TmControlRow>('SELECT * FROM tm_control WHERE id = 1');
    const currentRow = current.rows[0];
    if (!currentRow) throw new Error('tm_control singleton missing after reset');
    const control = normalizeControl(currentRow);
    const audit = await insertResetAudit(query, {
      actor: data.actor,
      reason: data.reason,
      previousEpoch: previous.epoch,
      newEpoch: control.epoch,
      transitioned,
    });
    return { control, expiredProposals: expired.rowCount, audit };
  };
  // Reuse the existing SQLite writer-lock/async-serialization primitive;
  // PostgreSQL pins a pool connection and locks the singleton inside its transaction.
  return db.dialect === 'sqlite'
    ? withOverseerControlPlaneImmediateTransaction(db, reset)
    : db.withTransaction(reset);
}

/** Read one logical action by stable idempotency key without a time window. */
export async function getActionByIdempotencyKey(key: string): Promise<TmJournalEntry | null> {
  const result = await getDatabase().query<TmJournalRow>(
    'SELECT * FROM tm_journal WHERE idempotency_key = $1 ORDER BY created_at ASC LIMIT 1',
    [key]
  );
  const row = result.rows[0];
  return row ? normalizeJournal(row) : null;
}

/**
 * Update the outcome of a previously recorded action (post-effect). When
 * `proposalJson` is supplied it is rewritten atomically alongside the outcome
 * -- used when a mid-tick pause re-tags a ROW-FIRST row as parked/reason=paused
 * so the parked provenance survives, not just the outcome flip.
 */
export async function updateActionOutcome(
  id: string,
  outcome: TmActionOutcome,
  proposalJson?: string
): Promise<TmJournalEntry | null> {
  // The sqlite adapter rejects UPDATE ... RETURNING; mutate then re-read.
  const db = getDatabase();
  if (proposalJson === undefined) {
    await db.query('UPDATE tm_journal SET outcome = $1 WHERE id = $2', [outcome, id]);
  } else {
    await db.query('UPDATE tm_journal SET outcome = $1, proposal_json = $2 WHERE id = $3', [
      outcome,
      proposalJson,
      id,
    ]);
  }
  const result = await db.query<TmJournalRow>('SELECT * FROM tm_journal WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? normalizeJournal(row) : null;
}

/**
 * Grade a sent action after its external effect is verified in the SOR.
 * Grading is a verification write, not a self-report -- the caller must
 * have observed the effect independently before calling this.
 */
export async function gradeAction(id: string, grade: TmGrade): Promise<TmJournalEntry | null> {
  const db = getDatabase();
  await db.query('UPDATE tm_journal SET grade = $1, graded_at = $2 WHERE id = $3', [
    grade,
    new Date().toISOString(),
    id,
  ]);
  const result = await db.query<TmJournalRow>('SELECT * FROM tm_journal WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? normalizeJournal(row) : null;
}

/** List journal actions created at or after the given ISO timestamp. */
export async function getActionsSince(
  sinceIso: string,
  threadRef?: string
): Promise<TmJournalEntry[]> {
  const params: unknown[] = [sinceIso];
  let sql = 'SELECT * FROM tm_journal WHERE created_at >= $1';
  if (threadRef) {
    params.push(threadRef);
    sql += ' AND thread_ref = $2';
  }
  sql += ' ORDER BY created_at ASC';
  const result = await getDatabase().query<TmJournalRow>(sql, params);
  return result.rows.map(normalizeJournal);
}

/**
 * Expire parked proposals (used on resume: epoch increments and stale
 * proposals are expired rather than replayed). Returns the count expired.
 */
export async function expireParkedActions(): Promise<number> {
  const db = getDatabase();
  const pending = await db.query<{ id: string }>(
    "SELECT id FROM tm_journal WHERE outcome IN ('parked', 'pending')"
  );
  if (pending.rows.length === 0) return 0;
  await db.query(
    "UPDATE tm_journal SET outcome = 'expired' WHERE outcome IN ('parked', 'pending')"
  );
  return pending.rows.length;
}

/** Read the singleton pause/epoch control row, creating it if absent. */
export async function getPauseState(): Promise<TmControlState> {
  const db = getDatabase();
  const result = await db.query<TmControlRow>('SELECT * FROM tm_control WHERE id = 1');
  const row = result.rows[0];
  if (row) return normalizeControl(row);
  // Defensive: seed the singleton if a fresh database lacks it.
  const inserted = await db.query<TmControlRow>(
    `INSERT INTO tm_control (id, pause_state, epoch, updated_at)
     VALUES (1, 'RUNNING', 0, $1)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [new Date().toISOString()]
  );
  const seeded = inserted.rows[0];
  if (seeded) return normalizeControl(seeded);
  const reread = await db.query<TmControlRow>('SELECT * FROM tm_control WHERE id = 1');
  const rereadRow = reread.rows[0];
  if (!rereadRow) throw new Error('tm_control singleton missing after seed attempt');
  return normalizeControl(rereadRow);
}

/**
 * Set pause state for direct control/circuit callers. An explicit epoch
 * increment invalidates older in-flight proposals. The resume endpoint uses
 * resetTaskmaster instead to atomically transition, expire and audit.
 */
export async function setPauseState(data: {
  pause_state: TmPauseState;
  pause_scope?: string | null;
  pause_reason?: string | null;
  pause_actor: string;
  incrementEpoch?: boolean;
}): Promise<TmControlState> {
  await getPauseState(); // ensure singleton exists
  const db = getDatabase();
  await db.query(
    `UPDATE tm_control
     SET pause_state = $1,
         pause_scope = $2,
         pause_reason = $3,
         pause_actor = $4,
         epoch = epoch + $5,
         updated_at = $6
     WHERE id = 1`,
    [
      data.pause_state,
      data.pause_scope ?? null,
      data.pause_reason ?? null,
      data.pause_actor,
      data.incrementEpoch ? 1 : 0,
      new Date().toISOString(),
    ]
  );
  const result = await db.query<TmControlRow>('SELECT * FROM tm_control WHERE id = 1');
  const row = result.rows[0];
  if (!row) throw new Error('Failed to update tm_control');
  log.info(
    { pauseState: row.pause_state, epoch: Number(row.epoch), actor: data.pause_actor },
    'taskmaster.pause_state_updated'
  );
  return normalizeControl(row);
}

/** Upsert a provider health sample with expiry. */
export async function upsertHealthSample(data: {
  provider: string;
  state: TmHealthState;
  expires_at: string;
  evidence?: string | null;
}): Promise<TmHealthSample> {
  const sampledAt = new Date().toISOString();
  const result = await getDatabase().query<TmHealthSample>(
    `INSERT INTO tm_health (provider, state, sampled_at, expires_at, evidence)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider) DO UPDATE SET
       state = EXCLUDED.state,
       sampled_at = EXCLUDED.sampled_at,
       expires_at = EXCLUDED.expires_at,
       evidence = EXCLUDED.evidence
     RETURNING *`,
    [data.provider, data.state, sampledAt, data.expires_at, data.evidence ?? null]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to upsert taskmaster health sample');
  return { ...row, sampled_at: toIso(row.sampled_at), expires_at: toIso(row.expires_at) };
}

/**
 * Read a provider health sample. Returns null when absent OR expired --
 * an expired sample is not evidence of anything.
 */
export async function getHealthSample(provider: string): Promise<TmHealthSample | null> {
  const result = await getDatabase().query<TmHealthSample>(
    'SELECT * FROM tm_health WHERE provider = $1',
    [provider]
  );
  const row = result.rows[0];
  if (!row) return null;
  const expiresAt = toIso(row.expires_at);
  if (Date.parse(expiresAt) <= Date.now()) return null;
  return { ...row, sampled_at: toIso(row.sampled_at), expires_at: expiresAt };
}

/**
 * Record one usage observation. A failed meter MUST be recorded with
 * is_unknown=1 and a null value -- never as a numeric zero.
 */
export async function recordUsageSample(data: {
  provider: string;
  window_kind: string;
  source: string;
  value_json?: string | null;
  confidence?: TmUsageConfidence | null;
  is_unknown: boolean;
}): Promise<TmUsageSample> {
  const result = await getDatabase().query<TmUsageSample>(
    `INSERT INTO tm_usage_sample
     (id, provider, window_kind, source, observed_at, value_json, confidence, is_unknown)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      randomUUID(),
      data.provider,
      data.window_kind,
      data.source,
      new Date().toISOString(),
      data.value_json ?? null,
      data.confidence ?? null,
      data.is_unknown ? 1 : 0,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to record taskmaster usage sample');
  return { ...row, observed_at: toIso(row.observed_at), is_unknown: row.is_unknown };
}

/** Read the newest usage observations for one provider/window. */
export async function getRecentUsageSamples(
  provider: string,
  windowKind: string,
  limit: number
): Promise<TmUsageSample[]> {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const result = await getDatabase().query<TmUsageSample>(
    `SELECT * FROM tm_usage_sample
     WHERE provider = $1 AND window_kind = $2
     ORDER BY observed_at DESC
     LIMIT $3`,
    [provider, windowKind, boundedLimit]
  );
  return result.rows.map(row => ({
    ...row,
    observed_at: toIso(row.observed_at),
    is_unknown: row.is_unknown,
  }));
}

// ---------------------------------------------------------------------------
// Adoption projection (WO-HARNESS-TASKMASTER-ADOPTION-PROJECTION-01, M-155 WO 1)
// Disposable snapshot rebuilt from GitHub. Commit flips meta + retires prior
// snapshot rows atomically via withTransaction.
// ---------------------------------------------------------------------------

export type TmAdoptionMarkerKind = 'PROGRESS' | 'BLOCKED';
export type TmAdoptionMovementKind = 'closed' | 'assigned' | 'status_label' | 'progress_comment';

export interface TmAdoptionRow {
  thread_ref: string;
  snapshot_id: string;
  repo: string;
  issue_number: number;
  title: string | null;
  priority: string;
  labels_json: string;
  owner_login: string | null;
  is_blocked: number;
  blocked_reason: string | null;
  next_action: string | null;
  latest_marker_kind: TmAdoptionMarkerKind | null;
  latest_marker_at: string | null;
  state: string | null;
  last_movement_at: string | null;
  last_movement_kind: TmAdoptionMovementKind | null;
  attempts_24h: number;
  attempts_total: number;
  evidence_observed_at: string | null;
  source_updated_at: string;
}

export interface TmAdoptionMeta {
  id: number;
  committed_snapshot_id: string | null;
  rebuilt_at: string | null;
  row_count: number | null;
  source_commit: string | null;
  complete: number;
}

interface TmAdoptionDbRow extends Omit<
  TmAdoptionRow,
  'issue_number' | 'is_blocked' | 'attempts_24h' | 'attempts_total'
> {
  issue_number: number | string;
  is_blocked: number | string;
  attempts_24h: number | string;
  attempts_total: number | string;
}

interface TmAdoptionMetaDbRow extends Omit<TmAdoptionMeta, 'id' | 'row_count' | 'complete'> {
  id: number | string;
  row_count: number | string | null;
  complete: number | string;
}

function normalizeAdoption(row: TmAdoptionDbRow): TmAdoptionRow {
  return {
    thread_ref: row.thread_ref,
    snapshot_id: row.snapshot_id,
    repo: row.repo,
    issue_number: Number(row.issue_number),
    title: row.title,
    priority: row.priority,
    labels_json: row.labels_json,
    owner_login: row.owner_login,
    is_blocked: Number(row.is_blocked),
    blocked_reason: row.blocked_reason,
    next_action: row.next_action,
    latest_marker_kind: row.latest_marker_kind,
    latest_marker_at: row.latest_marker_at,
    state: row.state,
    last_movement_at: row.last_movement_at,
    last_movement_kind: row.last_movement_kind,
    attempts_24h: Number(row.attempts_24h),
    attempts_total: Number(row.attempts_total),
    evidence_observed_at: row.evidence_observed_at,
    source_updated_at: row.source_updated_at,
  };
}

function normalizeAdoptionMeta(row: TmAdoptionMetaDbRow): TmAdoptionMeta {
  return {
    id: Number(row.id),
    committed_snapshot_id: row.committed_snapshot_id,
    rebuilt_at: row.rebuilt_at,
    row_count: row.row_count === null || row.row_count === undefined ? null : Number(row.row_count),
    source_commit: row.source_commit,
    complete: Number(row.complete),
  };
}

/** Open a fresh adoption snapshot. Returns the new snapshot_id. */
export async function beginAdoptionSnapshot(): Promise<string> {
  // Ensure the singleton meta row exists on a fresh database.
  await getDatabase().query(
    `INSERT INTO tm_adoption_meta (id) VALUES (1)
     ON CONFLICT (id) DO NOTHING`
  );
  return randomUUID();
}

/** Upsert one adoption row under an in-flight snapshot_id. */
export async function upsertAdoptionRow(
  snapshotId: string,
  row: Omit<TmAdoptionRow, 'snapshot_id'>
): Promise<void> {
  await getDatabase().query(
    `INSERT INTO tm_adoption (
       thread_ref, snapshot_id, repo, issue_number, title, priority, labels_json,
       owner_login, is_blocked, blocked_reason, next_action, latest_marker_kind,
       latest_marker_at, state, last_movement_at, last_movement_kind,
       attempts_24h, attempts_total, evidence_observed_at, source_updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12,
       $13, $14, $15, $16,
       $17, $18, $19, $20
     )
     ON CONFLICT (snapshot_id, thread_ref) DO UPDATE SET
       repo = EXCLUDED.repo,
       issue_number = EXCLUDED.issue_number,
       title = EXCLUDED.title,
       priority = EXCLUDED.priority,
       labels_json = EXCLUDED.labels_json,
       owner_login = EXCLUDED.owner_login,
       is_blocked = EXCLUDED.is_blocked,
       blocked_reason = EXCLUDED.blocked_reason,
       next_action = EXCLUDED.next_action,
       latest_marker_kind = EXCLUDED.latest_marker_kind,
       latest_marker_at = EXCLUDED.latest_marker_at,
       state = EXCLUDED.state,
       last_movement_at = EXCLUDED.last_movement_at,
       last_movement_kind = EXCLUDED.last_movement_kind,
       attempts_24h = EXCLUDED.attempts_24h,
       attempts_total = EXCLUDED.attempts_total,
       evidence_observed_at = EXCLUDED.evidence_observed_at,
       source_updated_at = EXCLUDED.source_updated_at`,
    [
      row.thread_ref,
      snapshotId,
      row.repo,
      row.issue_number,
      row.title,
      row.priority,
      row.labels_json,
      row.owner_login,
      row.is_blocked,
      row.blocked_reason,
      row.next_action,
      row.latest_marker_kind,
      row.latest_marker_at,
      row.state,
      row.last_movement_at,
      row.last_movement_kind,
      row.attempts_24h,
      row.attempts_total,
      row.evidence_observed_at,
      row.source_updated_at,
    ]
  );
}

/**
 * Atomically flip the committed snapshot pointer and retire prior-snapshot
 * rows. Uses the adapter withTransaction helper -- two unwrapped sequential
 * queries are NOT atomic on pooled Postgres.
 */
export async function commitAdoptionSnapshot(
  snapshotId: string,
  sourceCommit?: string | null
): Promise<void> {
  const db = getDatabase();
  const countResult = await db.query<{ cnt: number | string }>(
    'SELECT COUNT(*) AS cnt FROM tm_adoption WHERE snapshot_id = $1',
    [snapshotId]
  );
  const rowCount = Number(countResult.rows[0]?.cnt ?? 0);
  const nowIso = new Date().toISOString();

  await db.withTransaction(async query => {
    await query(
      `UPDATE tm_adoption_meta
          SET committed_snapshot_id = $1, rebuilt_at = $2, row_count = $3,
              source_commit = $4, complete = 1
        WHERE id = 1`,
      [snapshotId, nowIso, rowCount, sourceCommit ?? null]
    );
    await query('DELETE FROM tm_adoption WHERE snapshot_id <> $1', [snapshotId]);
  });
}

/** Drop partial rows for an abandoned in-flight snapshot. */
export async function abandonAdoptionSnapshot(snapshotId: string): Promise<void> {
  await getDatabase().query('DELETE FROM tm_adoption WHERE snapshot_id = $1', [snapshotId]);
}

export interface TmAdoptionFilter {
  priority?: string;
  owner_login?: string | null;
  blocked?: boolean;
}

function buildAdoptionPredicates(
  snapshotId: string,
  filter?: TmAdoptionFilter
): { where: string; params: unknown[] } {
  const predicates = ['snapshot_id = $1'];
  const params: unknown[] = [snapshotId];
  if (filter?.priority !== undefined) {
    params.push(filter.priority);
    predicates.push(`priority = $${String(params.length)}`);
  }
  if (filter && 'owner_login' in filter) {
    if (filter.owner_login === null) {
      predicates.push('owner_login IS NULL');
    } else if (filter.owner_login !== undefined) {
      params.push(filter.owner_login);
      predicates.push(`owner_login = $${String(params.length)}`);
    }
  }
  if (filter?.blocked !== undefined) {
    params.push(filter.blocked ? 1 : 0);
    predicates.push(`is_blocked = $${String(params.length)}`);
  }
  return { where: predicates.join(' AND '), params };
}

/** Read rows from the currently committed snapshot only. */
export async function getAdoption(filter?: TmAdoptionFilter): Promise<TmAdoptionRow[]> {
  const meta = await getAdoptionMeta();
  if (!meta?.committed_snapshot_id) return [];
  const { where, params } = buildAdoptionPredicates(meta.committed_snapshot_id, filter);
  const result = await getDatabase().query<TmAdoptionDbRow>(
    `SELECT * FROM tm_adoption WHERE ${where} ORDER BY thread_ref ASC`,
    params
  );
  return result.rows.map(normalizeAdoption);
}

/** Count rows in the committed snapshot using the same predicates as getAdoption. */
export async function getAdoptionCount(filter?: TmAdoptionFilter): Promise<number> {
  const meta = await getAdoptionMeta();
  if (!meta?.committed_snapshot_id) return 0;
  const { where, params } = buildAdoptionPredicates(meta.committed_snapshot_id, filter);
  const result = await getDatabase().query<{ cnt: number | string }>(
    `SELECT COUNT(*) AS cnt FROM tm_adoption WHERE ${where}`,
    params
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

/** Count committed rows whose GitHub evidence has not been observed yet. */
export async function getAdoptionPartialCount(): Promise<number> {
  const meta = await getAdoptionMeta();
  if (!meta?.committed_snapshot_id) return 0;
  const result = await getDatabase().query<{ cnt: number | string }>(
    `SELECT COUNT(*) AS cnt FROM tm_adoption
      WHERE snapshot_id = $1 AND evidence_observed_at IS NULL`,
    [meta.committed_snapshot_id]
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

/** Count unaddressed Taskmaster messages for XO; normalized matching intentionally scans. */
export async function getUnaddressedXoCount(): Promise<number> {
  // No normalized covering index exists; accept the growing-table scan for correctness.
  const result = await getDatabase().query<{ cnt: number | string }>(
    `SELECT COUNT(*) AS cnt FROM agent_dispatch_messages
      WHERE LOWER(TRIM(sender)) = 'taskmaster'
        AND LOWER(TRIM(recipient)) = 'xo'
        AND addressed_at IS NULL`
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

/** Read the singleton adoption meta row, or null if absent. */
export async function getAdoptionMeta(): Promise<TmAdoptionMeta | null> {
  const result = await getDatabase().query<TmAdoptionMetaDbRow>(
    'SELECT * FROM tm_adoption_meta WHERE id = 1'
  );
  const row = result.rows[0];
  return row ? normalizeAdoptionMeta(row) : null;
}

// ---------------------------------------------------------------------------
// Noise suppression (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01, M-155 WO 3)
// Durable standalone table -- NEVER touched by the adoption refresh cycle.
// Storing this on tm_adoption would not work: commitAdoptionSnapshot deletes
// every prior-snapshot row on each refresh, so the state would reset per tick.
// ---------------------------------------------------------------------------

export interface TmSuppressionRow {
  /** Canonical thread ref (post canonicalizeThreadRef). */
  thread_ref: string;
  /** adoptionContentHash at the moment suppression was recorded. */
  suppressed_until_hash: string;
  suppressed_at: string;
  noise_grade_count: number;
}

interface TmSuppressionDbRow extends Omit<TmSuppressionRow, 'suppressed_at' | 'noise_grade_count'> {
  suppressed_at: string | Date;
  noise_grade_count: number | string;
}

/** Read all suppression rows, keyed by canonical thread_ref. One read per tick. */
export async function getSuppression(): Promise<Map<string, TmSuppressionRow>> {
  const result = await getDatabase().query<TmSuppressionDbRow>('SELECT * FROM tm_suppression');
  const byRef = new Map<string, TmSuppressionRow>();
  for (const row of result.rows) {
    byRef.set(row.thread_ref, {
      thread_ref: row.thread_ref,
      suppressed_until_hash: row.suppressed_until_hash,
      suppressed_at: toIso(row.suppressed_at),
      noise_grade_count: Number(row.noise_grade_count),
    });
  }
  return byRef;
}

/** Upsert a suppression row for a canonical thread ref. */
export async function setSuppression(threadRef: string, hash: string): Promise<void> {
  await getDatabase().query(
    `INSERT INTO tm_suppression (thread_ref, suppressed_until_hash, suppressed_at, noise_grade_count)
     VALUES ($1, $2, $3, 2)
     ON CONFLICT (thread_ref) DO UPDATE SET
       suppressed_until_hash = EXCLUDED.suppressed_until_hash,
       suppressed_at = EXCLUDED.suppressed_at`,
    [threadRef, hash, new Date().toISOString()]
  );
}

/** Delete a suppression row (suppression lift: the work moved). */
export async function clearSuppression(threadRef: string): Promise<void> {
  await getDatabase().query('DELETE FROM tm_suppression WHERE thread_ref = $1', [threadRef]);
}
