import { randomUUID } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';
import { appendBoardAuditEvent, resolveBoardRecipient } from './board-authority';
import type { QueryResult } from './adapters/types';
import { withOverseerControlPlaneImmediateTransaction } from './overseer-control-plane-sqlite';
import {
  DispatchNonSystemCapability,
  resolveDispatchSenderCapability,
  type DispatchCreationAuthority,
} from './dispatch-sender-authority';

const log = createLogger('db/dispatch');

export type DispatchTaskType =
  | 'agent_message'
  | 'run_review'
  | 'draft_spec'
  | 'run_report'
  | 'board_motion';
export type DispatchMessageStatus = 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
export type DispatchWorkerStatus = 'available' | 'unavailable';
export type DispatchMessagePriority = 'blocker' | 'normal' | 'heartbeat';
export type DispatchTaskOutcome = 'succeeded' | 'failed' | 'blocked';
export type DispatchRouteDisposition = 'unroutable' | 'superseded';
export type DispatchDeliveryMode =
  | 'worker_poll'
  | 'drain_on_start'
  | 'alias_resolved'
  | 'notify_only';

export interface DispatchMessage {
  id: string;
  correlation_id: string;
  idempotency_key: string;
  task_type: DispatchTaskType;
  sender: string;
  sender_principal_id: string | null;
  recipient: string;
  body: string;
  status: DispatchMessageStatus;
  result_body: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  not_before: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  recipient_alias: 'board' | null;
  motion_id: string | null;
  motion_revision_sha: string | null;
  resolved_recipient: string | null;
  resolved_xo_lease_id: string | null;
  resolved_xo_fencing_token: number | null;
  resolved_at: string | null;
  priority: DispatchMessagePriority;
  task_outcome: DispatchTaskOutcome | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  addressed_at: string | null;
  addressed_by: string | null;
  escalated_tg_at: string | null;
  escalated_sms_at: string | null;
  subject_key: string | null;
  route_disposition: DispatchRouteDisposition | null;
  supersedes_id: string | null;
  repeat_reason: string | null;
}

/**
 * A dispatch message plus the resume token for keyset pagination.
 *
 * `cursor_seq` is the row's effective position in the database-assigned total
 * order (migration 047; `COALESCE(seq, rowid)` on SQLite). Feeding the last
 * row's value back as `afterSeq` resumes strictly after it, which is what makes
 * a walk over the whole store possible despite the 500-row page cap.
 */
export interface SeqCursorMessage extends DispatchMessage {
  cursor_seq: number;
}

export interface DispatchWorker {
  worker_id: string;
  host: string;
  capabilities: Record<string, unknown>;
  max_concurrency: number;
  status: DispatchWorkerStatus;
  registered_at: string;
  last_heartbeat_at: string;
}

interface DispatchMessageRow extends Omit<
  DispatchMessage,
  'fencing_token' | 'resolved_xo_fencing_token'
> {
  fencing_token: number | string;
  resolved_xo_fencing_token: number | string | null;
}

type CompatibleDispatchMessageRow = DispatchMessageRow & {
  sender_principal_id?: string | null;
};

interface DispatchWorkerRow extends Omit<DispatchWorker, 'capabilities'> {
  capabilities: unknown;
}

interface DispatchPrincipalRow {
  principal_id: string;
  delivery_mode: DispatchDeliveryMode;
  active: boolean | number;
}

export type DispatchRecipientAssessment =
  | {
      ok: true;
      canonical_principal: string;
      delivery_mode: DispatchDeliveryMode;
      reason: null;
    }
  | {
      ok: false;
      canonical_principal: string;
      delivery_mode: DispatchDeliveryMode | null;
      reason: 'missing_principal' | 'inactive_principal';
    };

export type DispatchMailboxResult =
  | { ok: true; message: DispatchMessage }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'wrong_mode'
        | 'wrong_recipient'
        | 'not_queued'
        | 'address_before_ack'
        | 'actor_mismatch';
    };

export interface UnroutableQueuedDispatchMessage {
  id: string;
  recipient: string;
  task_type: DispatchTaskType;
  priority: DispatchMessagePriority;
  created_at: string;
}

export type DispatchQueryExecutor = <T>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

export const DEFAULT_WORKER_STALE_AFTER_MS = 120_000;
const DEFAULT_LEASE_DURATION_MS = 300_000;

/**
 * Insertion timestamp, nudged forward when the wall clock has not ticked.
 *
 * This is a NICETY, NOT THE ORDERING GUARANTEE. `created_at` has millisecond
 * resolution while consecutive inserts complete well inside one millisecond
 * (measured: ~100% of back-to-back inserts share a timestamp), so this bump
 * keeps timestamps distinct and readable within a single process. It CANNOT
 * establish a total order, because it is process-local: two concurrent writers
 * (server plus worker, or two server instances) still issue identical values,
 * and a restarted writer can emit timestamps OLDER than rows its predecessor
 * already committed.
 *
 * The actual ordering guarantee is the database-assigned `seq` column
 * (Postgres IDENTITY via migration 047, SQLite rowid) -- the database is the
 * only serialization point every writer shares. Newest-first queries order by
 * (created_at DESC, seq DESC); `seq` is what decides ties.
 */
let lastIssuedNowMs = 0;
function nowIso(): string {
  const wall = Date.now();
  lastIssuedNowMs = wall > lastIssuedNowMs ? wall : lastIssuedNowMs + 1;
  return new Date(lastIssuedNowMs).toISOString();
}

function normalizeTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : normalizeTimestamp(value);
}

function normalizeMessage(row: DispatchMessageRow): DispatchMessage {
  return {
    ...row,
    sender_principal_id: row.sender_principal_id === undefined ? null : row.sender_principal_id,
    created_at: normalizeTimestamp(row.created_at),
    claimed_at: normalizeNullableTimestamp(row.claimed_at),
    completed_at: normalizeNullableTimestamp(row.completed_at),
    not_before: normalizeNullableTimestamp(row.not_before),
    lease_expires_at: normalizeNullableTimestamp(row.lease_expires_at),
    fencing_token: Number(row.fencing_token),
    resolved_xo_fencing_token:
      row.resolved_xo_fencing_token === null || row.resolved_xo_fencing_token === undefined
        ? null
        : Number(row.resolved_xo_fencing_token),
    resolved_at: normalizeNullableTimestamp(row.resolved_at),
    acknowledged_at: normalizeNullableTimestamp(row.acknowledged_at),
    addressed_at: normalizeNullableTimestamp(row.addressed_at),
    escalated_tg_at: normalizeNullableTimestamp(row.escalated_tg_at),
    escalated_sms_at: normalizeNullableTimestamp(row.escalated_sms_at),
  };
}

function canonicalizePrincipal(principal: string): string {
  return principal.trim().toLowerCase();
}

export function normalizeDispatchSubjectKey(value: string): string {
  if (value !== value.trim()) throw new Error('dispatch_subject_key_invalid:whitespace');
  const wo = /^wo:(WO-[A-Z0-9]+(?:-[A-Z0-9]+)*)$/.exec(value);
  if (wo) return `wo:${wo[1]}`;
  // Taskmaster daily digest threads are dated, not GitHub-backed. The shape
  // hardening (M-129 era) forgot them, which silently killed every digest
  // send from 2026-08-25T00:00 onward -- one failed effect per tick, tick
  // health pinned DEGRADED. Bounded shape: digest:YYYY-MM-DD only.
  const digest = /^digest:(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (digest) return `digest:${digest[1]}`;
  const gh =
    /^gh:([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value);
  const owner = gh?.[1];
  const repo = gh?.[2];
  const issue = gh?.[3];
  if (owner && repo && issue)
    return `gh:${owner.toLowerCase()}/${repo.toLowerCase()}#${BigInt(issue).toString()}`;
  throw new Error('dispatch_subject_key_invalid:shape');
}

function isActivePrincipal(row: DispatchPrincipalRow): boolean {
  return row.active === true || row.active === 1;
}

async function getDispatchPrincipal(
  query: DispatchQueryExecutor,
  principalId: string
): Promise<DispatchPrincipalRow | null> {
  const result = await query<DispatchPrincipalRow>(
    'SELECT principal_id, delivery_mode, active FROM dispatch_principals WHERE principal_id = $1',
    [principalId]
  );
  return result.rows[0] ?? null;
}

export async function assessDispatchRecipient(
  recipient: string
): Promise<DispatchRecipientAssessment> {
  return assessDispatchRecipientWithQuery(
    (sql, params) => getDatabase().query(sql, params),
    recipient
  );
}

async function assessDispatchRecipientWithQuery(
  query: DispatchQueryExecutor,
  recipient: string
): Promise<DispatchRecipientAssessment> {
  const canonicalPrincipal = canonicalizePrincipal(recipient);
  const principal = await getDispatchPrincipal(query, canonicalPrincipal);
  if (!principal) {
    return {
      ok: false,
      canonical_principal: canonicalPrincipal,
      delivery_mode: null,
      reason: 'missing_principal',
    };
  }
  if (!isActivePrincipal(principal)) {
    return {
      ok: false,
      canonical_principal: canonicalPrincipal,
      delivery_mode: principal.delivery_mode,
      reason: 'inactive_principal',
    };
  }
  return {
    ok: true,
    canonical_principal: canonicalPrincipal,
    delivery_mode: principal.delivery_mode,
    reason: null,
  };
}

function parseCapabilities(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    log.warn(
      {
        err: err as Error,
        valueType: typeof value,
        valuePreview: typeof value === 'string' ? value.slice(0, 100) : String(value),
      },
      'db.capabilities_parse_failed'
    );
    return {};
  }
}

function normalizeWorker(row: DispatchWorkerRow): DispatchWorker {
  return {
    ...row,
    capabilities: parseCapabilities(row.capabilities),
    max_concurrency: row.max_concurrency,
    registered_at: normalizeTimestamp(row.registered_at),
    last_heartbeat_at: normalizeTimestamp(row.last_heartbeat_at),
  };
}

function addMillisecondsIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function staleCutoffIso(staleAfterMs: number): string {
  return new Date(Date.now() - staleAfterMs).toISOString();
}

export type DispatchSenderContext = DispatchCreationAuthority;
export type { FixedDispatchSystemSender } from './dispatch-sender-authority';

export interface CreateAuthenticatedMessageData {
  correlation_id: string;
  idempotency_key: string;
  task_type: DispatchTaskType;
  recipient: string;
  body: string;
  not_before?: string | null;
  priority?: DispatchMessagePriority;
  recipient_alias?: 'board' | null;
  motion_id?: string | null;
  motion_revision_sha?: string | null;
  subject_key?: string | null;
  repeat_reason?: string | null;
}

function bindSenderContext(context: DispatchSenderContext): {
  sender: string;
  sender_principal_id: string | null;
} {
  if ('kind' in context && context.kind === 'system') {
    const sender = context.sender;
    if (sender !== 'dispatch' && sender !== 'overseer' && sender !== 'taskmaster') {
      throw new Error('dispatch_internal_sender_invalid');
    }
    return {
      sender,
      sender_principal_id: `system:${sender}`,
    };
  }
  if (!(context instanceof DispatchNonSystemCapability)) {
    throw new Error('dispatch_sender_capability_invalid');
  }
  return resolveDispatchSenderCapability(context);
}

export interface TaskmasterNoticeFence {
  taskmasterPausedEpoch: number;
  /**
   * The exact pause state the notice was authorized against. The self-pause
   * notice escapes a soft PAUSED only; a concurrent transition to HARD_PAUSE
   * must refuse the send even at the same epoch.
   */
  taskmasterPausedState: 'PAUSED';
  /**
   * The exact pause scope the notice was authorized against. A concurrent
   * re-pause onto a different scope at the same epoch must refuse the send,
   * because the caller's exemption decision was made against this scope.
   */
  taskmasterPausedScope: string | null;
}

export function createAuthenticatedMessage(
  context: DispatchSenderContext,
  data: CreateAuthenticatedMessageData
): Promise<DispatchMessage>;
export function createAuthenticatedMessage(
  context: DispatchSenderContext,
  data: CreateAuthenticatedMessageData,
  fence: TaskmasterNoticeFence
): Promise<DispatchMessage | null>;
export async function createAuthenticatedMessage(
  context: DispatchSenderContext,
  data: CreateAuthenticatedMessageData,
  fence?: TaskmasterNoticeFence
): Promise<DispatchMessage | null> {
  if ('supersedes_id' in data) throw new Error('dispatch_supersedes_guarded_path_required');
  const bound = bindSenderContext(context);
  const db = getDatabase();
  if (fence !== undefined) {
    if (
      bound.sender_principal_id !== 'system:taskmaster' ||
      !Number.isSafeInteger(fence.taskmasterPausedEpoch) ||
      fence.taskmasterPausedEpoch < 0 ||
      fence.taskmasterPausedState !== 'PAUSED' ||
      data.task_type !== 'agent_message' ||
      data.recipient !== 'duty-officer' ||
      !data.idempotency_key.startsWith('tm:self-pause:')
    ) {
      throw new Error('taskmaster_notice_fence_invalid');
    }
    const enqueue = async (query: DispatchQueryExecutor): Promise<DispatchMessage | null> => {
      // Serialize with resetTaskmaster, through the actual queue insertion.
      // PostgreSQL uses one pinned connection and locks the same singleton.
      const control = await query<{
        pause_state: string;
        pause_scope: string | null;
        epoch: number | string;
      }>(
        'SELECT pause_state, pause_scope, epoch FROM tm_control WHERE id = 1' +
          (db.dialect === 'postgres' ? ' FOR UPDATE' : '')
      );
      const row = control.rows[0];
      // Assert the EXACT state this notice was authorized against, not merely
      // "not RUNNING". A concurrent setPauseState to HARD_PAUSE, or a re-pause
      // onto a different scope, does not increment the epoch, so epoch equality
      // alone would let the notice escape a pause it was never authorized for.
      if (
        row?.pause_state !== fence.taskmasterPausedState ||
        (row.pause_scope ?? null) !== (fence.taskmasterPausedScope ?? null) ||
        Number(row.epoch) !== fence.taskmasterPausedEpoch
      ) {
        return null;
      }
      return createAuthenticatedMessageWithQuery(query, { bound, data });
    };
    return db.dialect === 'sqlite'
      ? withOverseerControlPlaneImmediateTransaction(db, enqueue)
      : db.withTransaction(enqueue);
  }
  return createAuthenticatedMessageWithQuery((sql, params) => db.query(sql, params), {
    bound,
    data,
  });
}

/**
 * SQL expression producing the next `seq` (the database-assigned insertion
 * order; see migration 047 and migrateDispatchSeq).
 *
 * Postgres: the column is an IDENTITY, so DEFAULT draws from its sequence.
 * SQLite: no DEFAULT is possible on a column added by ALTER TABLE, so take one
 * past the current maximum. Both are evaluated by the database inside the
 * INSERT -- which is what makes the order correct across concurrent writers and
 * restarts, as a client clock cannot be -- and both are visible to RETURNING *,
 * unlike an AFTER INSERT trigger.
 *
 * The SQLite maximum is taken over COALESCE(seq, rowid), NOT over seq alone.
 * Review finding (Overseer, PR #800): the write scale and the read scale must
 * be the SAME scale. Newest-first reads order by COALESCE(seq, rowid), so a
 * raw/fixture/import row inserted with seq = NULL has an effective ordering
 * value of its rowid. Computing the next seq from MAX(seq) alone ignored those
 * rows, so a NULL-seq row with a high rowid could tie or outrank the next
 * normally-inserted row -- an undefined tie, breaking the total order this
 * column exists to guarantee.
 */
function seqValueExpression(): string {
  return getDatabase().dialect === 'postgres'
    ? 'DEFAULT'
    : '(SELECT COALESCE(MAX(COALESCE(seq, rowid)), 0) + 1 FROM agent_dispatch_messages)';
}

/**
 * Newest-first ordering expression.
 *
 * `seq` is the ordering key, but rows written by paths that bypass
 * createMessage (raw SQL, fixtures, imports) can carry NULL until the next
 * open heals them. On SQLite those fall back to `rowid`, which is the same
 * insertion counter seq is derived from, so ordering stays defined for every
 * row. Postgres has no rowid, and its IDENTITY default fills seq for every
 * inserter, so the column alone is sufficient there.
 */
function newestFirstOrder(): string {
  return getDatabase().dialect === 'postgres'
    ? 'ORDER BY seq DESC'
    : 'ORDER BY COALESCE(seq, rowid) DESC';
}

async function createAuthenticatedMessageWithQuery(
  query: DispatchQueryExecutor,
  input: {
    bound: { sender: string; sender_principal_id: string | null };
    data: CreateAuthenticatedMessageData;
  },
  supersedesId: string | null = null
): Promise<DispatchMessage> {
  const data = input.data;
  const bound = input.bound;
  const senderPrincipalId = bound.sender_principal_id;
  const sender = bound.sender;

  const existing = await findIdempotentMessage(query, data.idempotency_key, bound);
  const existingRow = existing.rows[0];
  if (existingRow) return normalizeMessage(existingRow);

  const subjectKey =
    data.subject_key == null ? null : normalizeDispatchSubjectKey(data.subject_key);
  const repeatReason = data.repeat_reason?.trim() || null;
  if (subjectKey) {
    const prior = await query<{ id: string }>(
      `SELECT id FROM agent_dispatch_messages WHERE subject_key = $1
       AND (status IN ('done', 'failed') OR task_outcome = 'blocked'
         OR acknowledged_at IS NOT NULL OR addressed_at IS NOT NULL) LIMIT 1`,
      [subjectKey]
    );
    if (prior.rowCount > 0 && !repeatReason) throw new Error('repeat_reason_required');
  }

  const recipientAssessment = await assessDispatchRecipientWithQuery(query, data.recipient);
  if (!recipientAssessment.ok) {
    throw new Error(`dispatch_recipient_rejected:${recipientAssessment.reason}`);
  }
  if (recipientAssessment.canonical_principal === 'board' && data.recipient_alias !== 'board') {
    throw new Error('dispatch_recipient_rejected:board_alias_metadata_required');
  }

  const now = nowIso();
  const result = await query<CompatibleDispatchMessageRow>(
    // `seq` is assigned INLINE, not by an AFTER INSERT trigger: SQLite
    // evaluates RETURNING * before such a trigger fires, so the caller would be
    // handed seq = NULL while the stored row held a value. Assigning it here
    // keeps the returned row and the stored row identical on both engines.
    //
    // The expression is dialect-neutral. On Postgres the column is an IDENTITY
    // (migration 047) whose sequence already produces the next value, so
    // DEFAULT is used; SQLite has no DEFAULT for it, so the next value is read
    // from the table. The subquery runs inside the same statement, and every
    // caller of this path is already serialized by the dispatch write
    // transaction, so it cannot interleave with another insert.
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id, recipient, body, status, created_at, not_before, priority, fencing_token,
      recipient_alias, motion_id, motion_revision_sha, subject_key, repeat_reason, supersedes_id, seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11, 0, $12, $13, $14, $15, $16, $17,
             ${seqValueExpression()})
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      randomUUID(),
      data.correlation_id,
      data.idempotency_key,
      data.task_type,
      sender,
      senderPrincipalId,
      recipientAssessment.canonical_principal,
      data.body,
      now,
      data.not_before ?? null,
      data.priority ?? 'normal',
      data.recipient_alias ?? null,
      data.motion_id ?? null,
      data.motion_revision_sha ?? null,
      subjectKey,
      repeatReason,
      supersedesId,
    ]
  );
  const row = result.rows[0];
  if (row) return normalizeMessage(row);

  const conflict = await findIdempotentMessage(query, data.idempotency_key, bound);
  const conflictRow = conflict.rows[0];
  if (!conflictRow) throw new Error('dispatch_idempotency_namespace_conflict');
  return normalizeMessage(conflictRow);
}

async function findIdempotentMessage(
  query: DispatchQueryExecutor,
  idempotencyKey: string,
  bound: { sender: string; sender_principal_id: string | null }
): Promise<QueryResult<CompatibleDispatchMessageRow>> {
  return query<CompatibleDispatchMessageRow>(
    bound.sender_principal_id === null
      ? `SELECT * FROM agent_dispatch_messages
         WHERE idempotency_key = $1 AND sender_principal_id IS NULL`
      : `SELECT * FROM agent_dispatch_messages
         WHERE idempotency_key = $1 AND sender_principal_id = $2`,
    bound.sender_principal_id === null
      ? [idempotencyKey]
      : [idempotencyKey, bound.sender_principal_id]
  );
}

export async function getMessage(id: string): Promise<DispatchMessage | null> {
  const result = await getDatabase().query<DispatchMessageRow>(
    'SELECT * FROM agent_dispatch_messages WHERE id = $1',
    [id]
  );
  const row = result.rows[0];
  return row ? normalizeMessage(row) : null;
}

/**
 * Messages carrying an EXACT correlation_id, newest-first.
 *
 * EXISTS FOR THE OVERSEER RECHECK PATH (bdc-harness #782). To decide whether a
 * completed check authorizes an automatic re-review, the ingest must read the
 * standing submit receipt for one exact PR head. Those receipts are written to
 * the `operator` recipient with `correlation_id` = the head-bound review
 * correlation id and (on this lineage) no subject_key, so neither the
 * subject_key query nor a `listMessages` page can find them: `listMessages`
 * hard-caps `limit` at 500 with no offset or cursor, while the live store holds
 * thousands of queued operator rows (#761 backlog). A genuinely older receipt
 * -- exactly the one a stale CHANGES_REQUESTED verdict lives in -- sits well
 * outside any single page.
 *
 * Equality, not a prefix: the caller already knows the exact head it is asking
 * about, so an indexed exact match is both cheaper and narrower than a scan.
 */
export async function listMessagesByCorrelationId(filters: {
  correlationId: string;
  recipient?: string;
  limit?: number;
}): Promise<DispatchMessage[]> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 500));
  const params: unknown[] = [filters.correlationId];
  let where = 'correlation_id = $1';
  if (filters.recipient) {
    params.push(canonicalizePrincipal(filters.recipient));
    where += ` AND recipient = $${params.length}`;
  }
  params.push(limit);
  const result = await getDatabase().query<DispatchMessageRow>(
    `SELECT * FROM agent_dispatch_messages
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map(normalizeMessage);
}

/**
 * One keyset page of messages for a recipient, filtered by task_type and status,
 * in ASCENDING order of the database-assigned `seq`.
 *
 * WHY THIS EXISTS (Overseer review finding, PR #786 @45aa739e). The
 * stale-verdict sweep needs to walk EVERY completed review item in the store,
 * but `listMessages` hard-caps `limit` at 500 and offers no offset or cursor.
 * The live store holds ~4,900 dispatch rows and the review recipient alone
 * already holds ~494, so a sweep paging with an in-memory array index re-fetched
 * the same capped page forever: once its cursor passed the candidates inside
 * that page it simply rewound, and any completed review beyond row 500 was
 * permanently unreachable. Same failure class as the one
 * `listMessagesByCorrelationId` above was added to fix.
 *
 * KEYSET, NOT OFFSET. `afterSeq` resumes strictly after a seq the caller has
 * already seen, so each page is a genuinely different slice no matter how many
 * rows were inserted between calls -- an OFFSET would skip or repeat rows as the
 * table grows underneath the walk. `seq` is the database-assigned total order
 * from migration 047, which is precisely why it is a safe resume token: it is
 * assigned at the one serialization point every writer shares, unlike
 * `created_at`, whose millisecond resolution ties on back-to-back inserts.
 *
 * ASCENDING on purpose. The sweep wants oldest-first (the stalest verdicts are
 * the ones most worth revisiting), and an ascending keyset is monotonic: rows
 * inserted during a walk land after the cursor and are picked up on a later
 * pass, never causing a page to shift under it.
 *
 * Filtering task_type and status IN THE QUERY is what makes the page size mean
 * something: the sweep's previous in-memory filter meant a page of 500 could
 * yield only a handful of usable candidates.
 */
export async function listMessagesBySeqCursor(filters: {
  recipient: string;
  task_type?: string;
  status?: DispatchMessageStatus;
  /** Exclusive lower bound: return rows whose ordering value is strictly above. */
  afterSeq?: number;
  limit?: number;
}): Promise<SeqCursorMessage[]> {
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
  // Same effective ordering value the newest-first reads use, so a cursor taken
  // from one is meaningful to the other: on SQLite a raw/fixture/import row can
  // still carry seq = NULL until the next open heals it, and its effective
  // position is its rowid.
  const seqExpression = getDatabase().dialect === 'postgres' ? 'seq' : 'COALESCE(seq, rowid)';
  const params: unknown[] = [canonicalizePrincipal(filters.recipient)];
  const clauses = [`recipient = $${params.length}`];
  if (filters.task_type) {
    params.push(filters.task_type);
    clauses.push(`task_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (typeof filters.afterSeq === 'number') {
    params.push(filters.afterSeq);
    clauses.push(`${seqExpression} > $${params.length}`);
  }
  params.push(limit);
  const result = await getDatabase().query<DispatchMessageRow & { cursor_seq: unknown }>(
    `SELECT *, ${seqExpression} AS cursor_seq FROM agent_dispatch_messages
     WHERE ${clauses.join(' AND ')}
     ORDER BY ${seqExpression} ASC
     LIMIT $${params.length}`,
    params
  );
  // `cursor_seq` is selected explicitly rather than read off the row's `seq`:
  // Postgres returns a BIGINT identity as a STRING through the driver while
  // SQLite returns a number, and `seq` is not part of the DispatchMessage
  // contract. Coercing here keeps that dialect difference out of every caller.
  return result.rows.map(row => ({
    ...normalizeMessage(row),
    cursor_seq: Number(row.cursor_seq),
  }));
}

export async function listMessages(filters: {
  recipient?: string;
  status?: DispatchMessageStatus;
  limit?: number;
  allowBoardAlias?: boolean;
  subject_key?: string;
}): Promise<DispatchMessage[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.recipient) {
    const canonicalRecipient = canonicalizePrincipal(filters.recipient);
    params.push(canonicalRecipient);
    const recipientParam = `$${params.length}`;
    if (filters.allowBoardAlias) {
      const resolved = await resolveDispatchRecipient('board');
      if (resolved.ok && resolved.recipient === canonicalRecipient) {
        clauses.push(
          `(recipient = ${recipientParam} OR (recipient_alias = 'board' AND status = 'queued'))`
        );
      } else {
        if (!resolved.ok && filters.status === 'queued') {
          await recordBoardDeferrals();
        }
        clauses.push(`recipient = ${recipientParam}`);
      }
    } else {
      clauses.push(`recipient = ${recipientParam}`);
    }
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filters.subject_key !== undefined) {
    params.push(normalizeDispatchSubjectKey(filters.subject_key));
    clauses.push(`subject_key = $${params.length}`);
  }
  if (filters.status === 'queued') {
    params.push(nowIso());
    clauses.push(`(not_before IS NULL OR not_before <= $${params.length})`);
    clauses.push('addressed_at IS NULL');
  }
  params.push(Math.max(1, Math.min(filters.limit ?? 100, 500)));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const order =
    filters.subject_key !== undefined
      ? // seq (DB-assigned insertion counter) IS the newest-first key -- not a
        // tiebreak after created_at, which a clock-skewed or restarted writer
        // can set lower than rows inserted before it. collectVerdicts depends
        // on this contract holding across writers.
        newestFirstOrder()
      : filters.status === 'queued'
        ? "ORDER BY CASE priority WHEN 'blocker' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC"
        : 'ORDER BY created_at ASC';
  const result = await getDatabase().query<DispatchMessageRow>(
    `SELECT * FROM agent_dispatch_messages ${where} ${order} LIMIT $${params.length}`,
    params
  );
  return result.rows.map(normalizeMessage);
}

/**
 * Escapes LIKE metacharacters so a caller-supplied prefix matches literally.
 * Pairs with the `ESCAPE '\'` clause on every LIKE built from this helper.
 */
function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

/**
 * Messages whose correlation_id starts with `prefix` and that carry NO
 * subject_key, newest-first.
 *
 * EXISTS FOR THE LEGACY-RECEIPT FALLBACK. subject_key was added to Overseer
 * submit receipts in 2026-09; every receipt written before that is
 * subject_key-less and therefore invisible to a subject_key query, even though
 * it still carries a correlation_id that identifies its pull request.
 *
 * Filtering in SQL rather than paging `listMessages` is load-bearing, not an
 * optimization: `listMessages` hard-caps `limit` at 500 and exposes no offset
 * or cursor, so a client-side scan can neither see past the first page nor
 * page beyond it. With ~2,700 queued operator rows in the live store
 * (bdc-harness #761 backlog) a genuinely old receipt sits far outside that
 * window -- exactly the receipt the fallback needs to find.
 *
 * `subject_key IS NULL` is part of the predicate on purpose: rows that DO have
 * a subject_key are already reachable by the indexed query, so excluding them
 * here keeps this strictly a legacy path and keeps the result set small.
 */
/**
 * Newest-first ordering note: created_at is strictly increasing per writer
 * (see nowIso), so it alone expresses insertion order. The trailing id DESC is
 * only a total-order tiebreak for rows written by different processes within
 * the same millisecond -- id is a random UUID and carries no insertion order,
 * so it must never be the key that decides newest-first on its own.
 */
/**
 * Newest-first ordering: `seq` is the PRIMARY key, not a tiebreak.
 *
 * `seq` is the database-assigned insertion counter (Postgres IDENTITY, SQLite
 * MAX+1). Ordering by `created_at` first and `seq` second is NOT an insertion
 * order: a write from a restarted or clock-skewed process carries an older
 * `created_at` and would sort behind rows inserted before it despite a higher
 * `seq`. Since what these callers want is "which row was written last",
 * `seq DESC` alone answers it, and it is the only key correct across concurrent
 * writers and restarts. `id` is a random UUID and must never decide ordering.
 */
export async function listMessagesByCorrelationPrefixWithoutSubjectKey(filters: {
  recipient: string;
  correlationPrefix: string;
  limit?: number;
}): Promise<DispatchMessage[]> {
  const limit = Math.max(1, Math.min(filters.limit ?? 200, 1000));
  const result = await getDatabase().query<DispatchMessageRow>(
    `SELECT * FROM agent_dispatch_messages
     WHERE recipient = $1
       AND subject_key IS NULL
       AND correlation_id LIKE $2 ESCAPE '\\'
     ${newestFirstOrder()}
     LIMIT $3`,
    [
      canonicalizePrincipal(filters.recipient),
      `${escapeLikeLiteral(filters.correlationPrefix)}%`,
      limit,
    ]
  );
  return result.rows.map(normalizeMessage);
}

export async function resolveDispatchRecipient(recipient: string): Promise<
  | {
      ok: true;
      recipient: string;
      recipient_alias: 'board' | null;
      resolved_xo_lease_id: string | null;
      resolved_xo_fencing_token: number | null;
    }
  | { ok: false; reason: 'no_valid_xo_lease' }
> {
  if (recipient !== 'board') {
    return {
      ok: true,
      recipient,
      recipient_alias: null,
      resolved_xo_lease_id: null,
      resolved_xo_fencing_token: null,
    };
  }
  const resolved = await resolveBoardRecipient();
  if (!resolved.ok) return { ok: false, reason: 'no_valid_xo_lease' };
  return {
    ok: true,
    recipient: resolved.principal_id,
    recipient_alias: 'board',
    resolved_xo_lease_id: resolved.lease_id,
    resolved_xo_fencing_token: resolved.fencing_token,
  };
}

async function recordBoardDeferrals(): Promise<void> {
  const result = await getDatabase().query<
    Pick<DispatchMessageRow, 'id' | 'motion_id' | 'motion_revision_sha'>
  >(
    `SELECT id, motion_id, motion_revision_sha
     FROM agent_dispatch_messages
     WHERE recipient_alias = 'board' AND status = 'queued'
     ORDER BY created_at ASC
     LIMIT 100`
  );
  for (const row of result.rows) {
    await appendBoardAuditEvent({
      event_type: 'board_recipient_deferred',
      actor_principal_id: 'dispatch',
      motion_id: row.motion_id,
      motion_revision_sha: row.motion_revision_sha,
      details: { dispatch_message_id: row.id, reason: 'no_valid_xo_lease' },
    });
  }
}

export async function registerWorker(data: {
  worker_id: string;
  host: string;
  capabilities: Record<string, unknown>;
  max_concurrency: number;
}): Promise<DispatchWorker> {
  const now = nowIso();
  const capabilitiesJson = JSON.stringify(data.capabilities);
  const result = await getDatabase().query<DispatchWorkerRow>(
    `INSERT INTO agent_dispatch_workers
     (worker_id, host, capabilities, max_concurrency, status, registered_at, last_heartbeat_at)
     VALUES ($1, $2, $3, $4, 'available', $5, $5)
     ON CONFLICT (worker_id) DO UPDATE SET
       host = EXCLUDED.host,
       capabilities = EXCLUDED.capabilities,
       max_concurrency = EXCLUDED.max_concurrency,
       status = 'available',
       last_heartbeat_at = EXCLUDED.last_heartbeat_at
     RETURNING *`,
    [data.worker_id, data.host, capabilitiesJson, data.max_concurrency, now]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to register dispatch worker');
  return normalizeWorker(row);
}

export async function heartbeatWorker(data: {
  worker_id: string;
  status?: DispatchWorkerStatus;
}): Promise<DispatchWorker | null> {
  const db = getDatabase();
  const now = nowIso();
  if (db.dialect === 'postgres') {
    const result = await db.query<DispatchWorkerRow>(
      `UPDATE agent_dispatch_workers
       SET status = $2, last_heartbeat_at = $3
       WHERE worker_id = $1
       RETURNING *`,
      [data.worker_id, data.status ?? 'available', now]
    );
    const row = result.rows[0];
    return row ? normalizeWorker(row) : null;
  }

  const result = await db.query(
    `UPDATE agent_dispatch_workers
     SET status = $2, last_heartbeat_at = $3
     WHERE worker_id = $1`,
    [data.worker_id, data.status ?? 'available', now]
  );
  if (result.rowCount !== 1) return null;
  return getWorker(data.worker_id);
}

export async function getWorker(workerId: string): Promise<DispatchWorker | null> {
  const result = await getDatabase().query<DispatchWorkerRow>(
    'SELECT * FROM agent_dispatch_workers WHERE worker_id = $1',
    [workerId]
  );
  const row = result.rows[0];
  return row ? normalizeWorker(row) : null;
}

export async function evaluateWorkerStaleness(
  staleAfterMs = DEFAULT_WORKER_STALE_AFTER_MS
): Promise<number> {
  const result = await getDatabase().query(
    `UPDATE agent_dispatch_workers
     SET status = 'unavailable'
     WHERE status = 'available' AND last_heartbeat_at < $1`,
    [staleCutoffIso(staleAfterMs)]
  );
  return result.rowCount;
}

export async function listWorkers(
  staleAfterMs = DEFAULT_WORKER_STALE_AFTER_MS
): Promise<DispatchWorker[]> {
  await evaluateWorkerStaleness(staleAfterMs);
  const result = await getDatabase().query<DispatchWorkerRow>(
    'SELECT * FROM agent_dispatch_workers ORDER BY worker_id ASC'
  );
  return result.rows.map(normalizeWorker);
}

export async function claimMessage(data: {
  id: string;
  worker_id: string;
  delivery_principal?: string | null;
  leaseDurationMs?: number;
  workerStaleAfterMs?: number;
}): Promise<DispatchMessage | null> {
  const db = getDatabase();
  await evaluateWorkerStaleness(data.workerStaleAfterMs ?? DEFAULT_WORKER_STALE_AFTER_MS);
  const now = nowIso();
  const leaseExpiresAt = addMillisecondsIso(data.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS);
  return db.withTransaction(async txQuery => {
    const worker = await txQuery<DispatchWorkerRow>(
      `SELECT * FROM agent_dispatch_workers
       WHERE worker_id = $1 AND status = 'available' AND last_heartbeat_at >= $2`,
      [data.worker_id, staleCutoffIso(data.workerStaleAfterMs ?? DEFAULT_WORKER_STALE_AFTER_MS)]
    );
    if (worker.rowCount !== 1) return null;

    const existing = await txQuery<DispatchMessageRow>(
      'SELECT * FROM agent_dispatch_messages WHERE id = $1',
      [data.id]
    );
    const row = existing.rows[0];
    if (!row) return null;
    const current = normalizeMessage(row);
    const claimable =
      current.status === 'queued' ||
      (current.status === 'claimed' &&
        current.lease_expires_at !== null &&
        new Date(current.lease_expires_at).getTime() <= Date.now());
    const notBeforeReady =
      current.not_before === null || new Date(current.not_before).getTime() <= Date.now();
    if (!claimable || !notBeforeReady) return null;
    let resolvedRecipient: {
      principal_id: string;
      lease_id: string;
      fencing_token: number;
    } | null = null;
    if (current.recipient_alias === 'board') {
      if (!data.delivery_principal) return null;
      const lease = (
        await txQuery<{
          lease_id: string;
          principal_id: string;
          fencing_token: number | string;
        }>(
          `SELECT lease_id, principal_id, fencing_token
           FROM board_xo_leases
           WHERE id = 1 AND released_at IS NULL AND expires_at > $1`,
          [now]
        )
      ).rows[0];
      if (lease?.principal_id !== data.delivery_principal) return null;
      resolvedRecipient = {
        principal_id: lease.principal_id,
        lease_id: lease.lease_id,
        fencing_token: Number(lease.fencing_token),
      };
    }

    const addressedPrincipalId = canonicalizePrincipal(current.recipient);
    const addressedPrincipal = await getDispatchPrincipal(txQuery, addressedPrincipalId);
    const addressedMode = current.recipient_alias === 'board' ? 'alias_resolved' : 'worker_poll';
    if (
      !addressedPrincipal ||
      !isActivePrincipal(addressedPrincipal) ||
      addressedPrincipal.delivery_mode !== addressedMode
    ) {
      return null;
    }
    const effectivePrincipalId = canonicalizePrincipal(
      resolvedRecipient?.principal_id ?? current.resolved_recipient ?? current.recipient
    );
    const effectivePrincipal =
      effectivePrincipalId === addressedPrincipalId
        ? addressedPrincipal
        : await getDispatchPrincipal(txQuery, effectivePrincipalId);
    if (
      !effectivePrincipal ||
      !isActivePrincipal(effectivePrincipal) ||
      effectivePrincipal.delivery_mode !== 'worker_poll'
    ) {
      return null;
    }

    const expectedFence = current.fencing_token + 1;
    const claimUpdate = await txQuery(
      `UPDATE agent_dispatch_messages
       SET status = 'claimed',
           claimed_at = $2,
           lease_owner = $3,
           lease_expires_at = $4,
           fencing_token = fencing_token + 1,
           resolved_recipient = COALESCE($5, resolved_recipient),
           resolved_xo_lease_id = COALESCE($6, resolved_xo_lease_id),
           resolved_xo_fencing_token = COALESCE($7, resolved_xo_fencing_token),
           resolved_at = CASE WHEN $5 IS NULL THEN resolved_at ELSE $2 END
       WHERE id = $1
         AND (
           status = 'queued'
           OR (status = 'claimed' AND lease_expires_at <= $2)
         )
         AND (not_before IS NULL OR not_before <= $2)
         AND NOT EXISTS (
           SELECT 1 FROM agent_dispatch_messages replacement
           WHERE replacement.supersedes_id = agent_dispatch_messages.id
             AND replacement.status <> 'cancelled'
         )`,
      [
        data.id,
        now,
        data.worker_id,
        leaseExpiresAt,
        resolvedRecipient?.principal_id ?? null,
        resolvedRecipient?.lease_id ?? null,
        resolvedRecipient?.fencing_token ?? null,
      ]
    );
    if (claimUpdate.rowCount !== 1) return null;
    const claimed = await txQuery<DispatchMessageRow>(
      `SELECT * FROM agent_dispatch_messages
       WHERE id = $1 AND status = 'claimed' AND lease_owner = $2 AND fencing_token = $3`,
      [data.id, data.worker_id, expectedFence]
    );
    const claimedRow = claimed.rows[0];
    if (claimedRow?.recipient_alias === 'board' && resolvedRecipient) {
      await txQuery(
        `INSERT INTO board_audit_events (
           id, event_type, actor_principal_id, actor_seat_id, xo_lease_id, xo_fencing_token,
           motion_id, motion_revision_sha, details, created_at
         )
         VALUES ($1, 'board_alias_resolved', $2, NULL, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          resolvedRecipient.principal_id,
          resolvedRecipient.lease_id,
          resolvedRecipient.fencing_token,
          claimedRow.motion_id,
          claimedRow.motion_revision_sha,
          JSON.stringify({ dispatch_message_id: claimedRow.id, worker_id: data.worker_id }),
          now,
        ]
      );
    }
    return claimedRow ? normalizeMessage(claimedRow) : null;
  });
}

function isMailboxDeliveryMode(mode: DispatchDeliveryMode | undefined): boolean {
  return mode === 'drain_on_start' || mode === 'notify_only';
}

async function readMessageInTransaction(
  query: DispatchQueryExecutor,
  id: string
): Promise<DispatchMessage | null> {
  const result = await query<DispatchMessageRow>(
    'SELECT * FROM agent_dispatch_messages WHERE id = $1',
    [id]
  );
  const row = result.rows[0];
  return row ? normalizeMessage(row) : null;
}

async function validateMailboxActor(
  query: DispatchQueryExecutor,
  message: DispatchMessage,
  principalId: string
): Promise<Exclude<DispatchMailboxResult, { ok: true }> | null> {
  const resolvedRecipient = canonicalizePrincipal(message.resolved_recipient ?? message.recipient);
  if (resolvedRecipient !== principalId) return { ok: false, reason: 'wrong_recipient' };
  const recipientPrincipal = await getDispatchPrincipal(query, resolvedRecipient);
  if (
    !recipientPrincipal ||
    !isActivePrincipal(recipientPrincipal) ||
    !isMailboxDeliveryMode(recipientPrincipal.delivery_mode)
  ) {
    return { ok: false, reason: 'wrong_mode' };
  }
  if (message.status !== 'queued') return { ok: false, reason: 'not_queued' };
  return null;
}

function isRetriableMailboxTransactionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('cannot start a transaction within a transaction') ||
    error.message.includes('database is locked') ||
    error.message.includes('SQLITE_BUSY')
  );
}

async function withRetriedMailboxTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetriableMailboxTransactionError(error) || attempt === maxAttempts) throw error;
      await Bun.sleep(attempt * 10);
    }
  }
  throw new Error('mailbox_transaction_retry_exhausted');
}

export async function acknowledgeMessage(data: {
  id: string;
  principal_id: string;
}): Promise<DispatchMailboxResult> {
  const db = getDatabase();
  const principalId = canonicalizePrincipal(data.principal_id);
  const now = nowIso();
  return withRetriedMailboxTransaction(() =>
    db.withTransaction(async txQuery => {
      const message = await readMessageInTransaction(txQuery, data.id);
      if (!message) return { ok: false, reason: 'not_found' };
      const invalid = await validateMailboxActor(txQuery, message, principalId);
      if (invalid) return invalid;
      if (message.acknowledged_by !== null) {
        return message.acknowledged_by === principalId
          ? { ok: true, message }
          : { ok: false, reason: 'actor_mismatch' };
      }

      const update = await txQuery(
        `UPDATE agent_dispatch_messages
       SET acknowledged_at = $2,
           acknowledged_by = $3
       WHERE id = $1
         AND status = 'queued'
         AND acknowledged_at IS NULL
         AND acknowledged_by IS NULL
         AND LOWER(TRIM(COALESCE(resolved_recipient, recipient))) = $3
         AND EXISTS (
           SELECT 1
           FROM dispatch_principals AS recipient_principal
           WHERE recipient_principal.principal_id = LOWER(TRIM(COALESCE(resolved_recipient, recipient)))
             AND CAST(recipient_principal.active AS TEXT) IN ('1', 'true')
             AND recipient_principal.delivery_mode IN ('drain_on_start', 'notify_only')
         )`,
        [data.id, now, principalId]
      );
      const finalMessage = await readMessageInTransaction(txQuery, data.id);
      if (!finalMessage) return { ok: false, reason: 'not_found' };
      const finalInvalid = await validateMailboxActor(txQuery, finalMessage, principalId);
      if (finalInvalid) return finalInvalid;
      if (finalMessage.acknowledged_by === principalId) return { ok: true, message: finalMessage };
      if (update.rowCount === 0 && finalMessage.acknowledged_by === null) {
        return { ok: false, reason: 'actor_mismatch' };
      }
      return { ok: false, reason: 'actor_mismatch' };
    })
  );
}

export async function addressMessage(data: {
  id: string;
  principal_id: string;
}): Promise<DispatchMailboxResult> {
  const db = getDatabase();
  const principalId = canonicalizePrincipal(data.principal_id);
  const now = nowIso();
  return withRetriedMailboxTransaction(() =>
    db.withTransaction(async txQuery => {
      const message = await readMessageInTransaction(txQuery, data.id);
      if (!message) return { ok: false, reason: 'not_found' };
      const invalid = await validateMailboxActor(txQuery, message, principalId);
      if (invalid) return invalid;
      if (message.acknowledged_by === null) return { ok: false, reason: 'address_before_ack' };
      if (message.acknowledged_by !== principalId) return { ok: false, reason: 'actor_mismatch' };
      if (message.addressed_by !== null) {
        return message.addressed_by === principalId
          ? { ok: true, message }
          : { ok: false, reason: 'actor_mismatch' };
      }

      const update = await txQuery(
        `UPDATE agent_dispatch_messages
       SET addressed_at = $2,
           addressed_by = $3
       WHERE id = $1
         AND status = 'queued'
         AND acknowledged_by = $3
         AND addressed_at IS NULL
         AND addressed_by IS NULL
         AND LOWER(TRIM(COALESCE(resolved_recipient, recipient))) = $3
         AND EXISTS (
           SELECT 1
           FROM dispatch_principals AS recipient_principal
           WHERE recipient_principal.principal_id = LOWER(TRIM(COALESCE(resolved_recipient, recipient)))
             AND CAST(recipient_principal.active AS TEXT) IN ('1', 'true')
             AND recipient_principal.delivery_mode IN ('drain_on_start', 'notify_only')
         )`,
        [data.id, now, principalId]
      );
      const finalMessage = await readMessageInTransaction(txQuery, data.id);
      if (!finalMessage) return { ok: false, reason: 'not_found' };
      const finalInvalid = await validateMailboxActor(txQuery, finalMessage, principalId);
      if (finalInvalid) return finalInvalid;
      if (finalMessage.acknowledged_by !== principalId) {
        return { ok: false, reason: 'actor_mismatch' };
      }
      if (finalMessage.addressed_by === principalId) return { ok: true, message: finalMessage };
      if (update.rowCount === 0 && finalMessage.addressed_by === null) {
        return { ok: false, reason: 'actor_mismatch' };
      }
      return { ok: false, reason: 'actor_mismatch' };
    })
  );
}

interface UnroutableQueuedDispatchMessageRow extends Omit<
  UnroutableQueuedDispatchMessage,
  'created_at'
> {
  created_at: unknown;
}

export async function listUnroutableQueuedMessages(
  query?: DispatchQueryExecutor
): Promise<UnroutableQueuedDispatchMessage[]> {
  const execute =
    query ??
    (<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> =>
      getDatabase().query<T>(sql, params));
  const result = await execute<UnroutableQueuedDispatchMessageRow>(
    `SELECT message.id, message.recipient, message.task_type, message.priority, message.created_at
     FROM agent_dispatch_messages AS message
     LEFT JOIN dispatch_principals AS principal
       ON principal.principal_id = LOWER(TRIM(message.recipient))
     WHERE message.status = 'queued'
       AND message.recipient_alias IS NULL
       AND (principal.principal_id IS NULL OR CAST(principal.active AS TEXT) IN ('0', 'false'))
     ORDER BY message.created_at ASC`
  );
  return result.rows.map(row => ({
    ...row,
    created_at: normalizeTimestamp(row.created_at),
  }));
}

export async function postResult(data: {
  id: string;
  worker_id: string;
  fencing_token: number;
  result_body: string;
  status?: 'done' | 'failed';
  task_outcome?: DispatchTaskOutcome | null;
}): Promise<DispatchMessage | null> {
  const db = getDatabase();
  const now = nowIso();
  let status = data.status ?? 'done';
  let outcome: DispatchTaskOutcome | null =
    data.task_outcome === undefined ? (status === 'failed' ? 'failed' : null) : data.task_outcome;
  if (outcome === 'failed' || outcome === 'blocked') status = 'failed';
  if (outcome === 'succeeded' && (status !== 'done' || data.result_body.trim() === ''))
    outcome = status === 'failed' ? 'failed' : null;
  if (db.dialect === 'postgres') {
    const result = await db.query<DispatchMessageRow>(
      `UPDATE agent_dispatch_messages
       SET status = $4,
           result_body = $5,
           completed_at = $6,
           lease_expires_at = NULL,
           task_outcome = $7
       WHERE id = $1
         AND lease_owner = $2
         AND fencing_token = $3
         AND status = 'claimed'
       RETURNING *`,
      [data.id, data.worker_id, data.fencing_token, status, data.result_body, now, outcome]
    );
    const row = result.rows[0];
    const message = row ? normalizeMessage(row) : null;
    if (message)
      await attemptDispatchOutcomeNotice(message, process.env.DISPATCH_PHASE1_ACTIVATED_AT);
    return message;
  }

  const result = await db.query(
    `UPDATE agent_dispatch_messages
     SET status = $4,
         result_body = $5,
         completed_at = $6,
         lease_expires_at = NULL,
         task_outcome = $7
     WHERE id = $1
       AND lease_owner = $2
       AND fencing_token = $3
       AND status = 'claimed'`,
    [data.id, data.worker_id, data.fencing_token, status, data.result_body, now, outcome]
  );
  if (result.rowCount !== 1) return null;
  const message = await getMessage(data.id);
  if (message)
    await attemptDispatchOutcomeNotice(message, process.env.DISPATCH_PHASE1_ACTIVATED_AT);
  return message;
}

/**
 * Extends the lease on a claimed message without changing its fencing token.
 *
 * WO-HARNESS-ACP-DISPATCH-SLICE-01 (M-118 ruling order 4): lease renewal is a
 * mandatory acceptance criterion. Before this, a lease was set once at claim
 * time and never extended, so any agent run longer than the lease duration
 * became silently reclaimable by another worker while still executing.
 *
 * Guards are deliberately identical to postResult: only the current lease
 * owner, holding the current fencing token, on a message still in 'claimed',
 * may renew. The fencing token is NOT incremented -- renewal is not a new
 * claim, and bumping it would invalidate the caller's own in-flight token.
 */
export async function renewMessageLease(data: {
  id: string;
  worker_id: string;
  fencing_token: number;
  leaseDurationMs?: number;
}): Promise<DispatchMessage | null> {
  const db = getDatabase();
  const leaseExpiresAt = addMillisecondsIso(data.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS);
  if (db.dialect === 'postgres') {
    const result = await db.query<DispatchMessageRow>(
      `UPDATE agent_dispatch_messages
       SET lease_expires_at = $4
       WHERE id = $1
         AND lease_owner = $2
         AND fencing_token = $3
         AND status = 'claimed'
       RETURNING *`,
      [data.id, data.worker_id, data.fencing_token, leaseExpiresAt]
    );
    const row = result.rows[0];
    return row ? normalizeMessage(row) : null;
  }

  const result = await db.query(
    `UPDATE agent_dispatch_messages
     SET lease_expires_at = $4
     WHERE id = $1
       AND lease_owner = $2
       AND fencing_token = $3
       AND status = 'claimed'`,
    [data.id, data.worker_id, data.fencing_token, leaseExpiresAt]
  );
  if (result.rowCount !== 1) return null;
  return getMessage(data.id);
}

/**
 * Returns a claimed message to the queued state so it can be reviewed again on
 * a later worker tick.
 *
 * WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01 (Option B): the PR-review
 * worker defers review until CI checks on the bound head are terminal. When
 * checks are still pending it must release its claim rather than post a
 * terminal result -- otherwise the item is either orphaned (never rediscovered
 * by the queued-only worker query) or collapsed into a REQUEST_CHANGES.
 *
 * Guards are identical in shape to renewMessageLease/postResult: only the
 * current lease owner, holding the current fencing token, on a message still in
 * 'claimed', may release it. The fencing token is NOT bumped -- the next
 * claimMessage bumps it itself. Only lease_owner/lease_expires_at are cleared,
 * matching cancelMessage's precedent; claimed_at is left as-is (claimMessage
 * unconditionally overwrites it on the next successful claim).
 *
 * `not_before` schedules a backoff: a released item is not reclaimable (nor
 * visible to listMessages with status 'queued') until that time passes, which
 * is how the review worker avoids hammering the checks API every tick.
 */
export async function releaseMessage(data: {
  id: string;
  worker_id: string;
  fencing_token: number;
  not_before?: string | null;
}): Promise<DispatchMessage | null> {
  const db = getDatabase();
  const notBefore = data.not_before ?? null;
  if (db.dialect === 'postgres') {
    const result = await db.query<DispatchMessageRow>(
      `UPDATE agent_dispatch_messages
       SET status = 'queued',
           lease_owner = NULL,
           lease_expires_at = NULL,
           not_before = $4
       WHERE id = $1
         AND lease_owner = $2
         AND fencing_token = $3
         AND status = 'claimed'
       RETURNING *`,
      [data.id, data.worker_id, data.fencing_token, notBefore]
    );
    const row = result.rows[0];
    return row ? normalizeMessage(row) : null;
  }

  const result = await db.query(
    `UPDATE agent_dispatch_messages
     SET status = 'queued',
         lease_owner = NULL,
         lease_expires_at = NULL,
         not_before = $4
     WHERE id = $1
       AND lease_owner = $2
       AND fencing_token = $3
       AND status = 'claimed'`,
    [data.id, data.worker_id, data.fencing_token, notBefore]
  );
  if (result.rowCount !== 1) return null;
  return getMessage(data.id);
}

/**
 * Fenced claimed-to-queued deferral with a bounded future `not_before`.
 *
 * WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Section 7 names `deferMessage()`
 * as the transition the review worker uses when it must come back later rather
 * than post a terminal result. That transition already exists as
 * `releaseMessage`, built under WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01
 * with precisely the guards Section 9 and Test 3 require -- only the current
 * lease owner, holding the current fencing token, on a row still `claimed`; the
 * body, exact-head identity, subject_key and repeat_reason are preserved; the
 * fence is bumped by the NEXT claim, not by the deferral.
 *
 * This is therefore a NAMED ALIAS, not a second implementation. Duplicating the
 * SQL would mean two transitions that could drift apart on the single row that
 * carries an in-flight review, which is exactly the class of bug fencing exists
 * to prevent. `deferUntil` is required here (unlike `releaseMessage`'s optional
 * `not_before`) because a deferral with no clock is an immediate re-claim and
 * would spin the worker against the same unfinished evidence every tick.
 */
export async function deferMessage(data: {
  id: string;
  worker_id: string;
  fencing_token: number;
  defer_until: string;
}): Promise<DispatchMessage | null> {
  return releaseMessage({
    id: data.id,
    worker_id: data.worker_id,
    fencing_token: data.fencing_token,
    not_before: data.defer_until,
  });
}

export type DispatchMutationResult =
  | { ok: true; message: DispatchMessage }
  | {
      ok: false;
      reason: 'not_found' | 'actor_mismatch' | 'terminal' | 'superseded' | 'not_queued';
    };

export async function cancelMessage(data: {
  id: string;
  sender: string;
}): Promise<DispatchMutationResult> {
  const db = getDatabase();
  const now = nowIso();
  return db.withTransaction(async query => {
    const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const found = await query<DispatchMessageRow>(
      `SELECT * FROM agent_dispatch_messages WHERE id = $1${lock}`,
      [data.id]
    );
    if (!found.rows[0]) return { ok: false, reason: 'not_found' };
    const current = normalizeMessage(found.rows[0]);
    if (canonicalizePrincipal(current.sender) !== canonicalizePrincipal(data.sender))
      return { ok: false, reason: 'actor_mismatch' };
    if (current.route_disposition === 'superseded') return { ok: false, reason: 'superseded' };
    if (current.status === 'cancelled') return { ok: true, message: current };
    if (current.status !== 'queued' && current.status !== 'claimed')
      return { ok: false, reason: 'terminal' };
    const update = await query(
      `UPDATE agent_dispatch_messages
       SET status = 'cancelled',
           completed_at = $2,
           lease_expires_at = NULL, lease_owner = NULL
       WHERE id = $1 AND status IN ('queued', 'claimed')`,
      [data.id, now]
    );
    if (update.rowCount !== 1) return { ok: false, reason: 'terminal' };
    const final = await query<DispatchMessageRow>(
      'SELECT * FROM agent_dispatch_messages WHERE id = $1',
      [data.id]
    );
    const message = final.rows[0] ? normalizeMessage(final.rows[0]) : null;
    return message?.status === 'cancelled'
      ? { ok: true, message }
      : { ok: false, reason: 'terminal' };
  });
}

export async function supersedeMessage(data: {
  id: string;
  sender_context: DispatchSenderContext;
  replacement: CreateAuthenticatedMessageData;
}): Promise<DispatchMutationResult> {
  const bound = bindSenderContext(data.sender_context);
  const db = getDatabase();
  return db.withTransaction(async query => {
    const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const found = await query<DispatchMessageRow>(
      `SELECT * FROM agent_dispatch_messages WHERE id = $1${lock}`,
      [data.id]
    );
    if (!found.rows[0]) return { ok: false, reason: 'not_found' };
    const source = normalizeMessage(found.rows[0]);
    if (source.sender_principal_id !== null) {
      if (source.sender_principal_id !== bound.sender_principal_id)
        return { ok: false, reason: 'actor_mismatch' };
    } else if (canonicalizePrincipal(source.sender) !== canonicalizePrincipal(bound.sender)) {
      return { ok: false, reason: 'actor_mismatch' };
    }
    if (source.status !== 'queued' || source.claimed_at || source.acknowledged_at)
      return { ok: false, reason: 'not_queued' };
    const existingReplacement = await query<DispatchMessageRow>(
      'SELECT * FROM agent_dispatch_messages WHERE supersedes_id = $1',
      [data.id]
    );
    if (existingReplacement.rows[0])
      return { ok: true, message: normalizeMessage(existingReplacement.rows[0]) };
    const replacement = await createAuthenticatedMessageWithQuery(
      query,
      {
        bound,
        data: data.replacement,
      },
      data.id
    );
    const update = await query(
      `UPDATE agent_dispatch_messages SET status = 'cancelled', route_disposition = 'superseded',
      completed_at = $2 WHERE id = $1 AND status = 'queued'`,
      [data.id, nowIso()]
    );
    if (update.rowCount !== 1) throw new Error('dispatch_supersede_lost_race');
    return { ok: true, message: replacement };
  });
}

export type DispatchEscalationLeg = 'telegram' | 'sms';

export async function claimDispatchEscalation(data: {
  id: string;
  leg: DispatchEscalationLeg;
  now?: string;
}): Promise<DispatchMessage | null> {
  const column = data.leg === 'telegram' ? 'escalated_tg_at' : 'escalated_sms_at';
  const threshold = data.leg === 'telegram' ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const now = data.now ?? nowIso();
  const cutoff = new Date(new Date(now).getTime() - threshold).toISOString();
  const result = await getDatabase().query(
    `UPDATE agent_dispatch_messages SET ${column} = $2 WHERE id = $1 AND ${column} IS NULL
     AND priority = 'blocker' AND COALESCE(resolved_recipient, recipient) = 'xo'
     AND addressed_at IS NULL AND status <> 'cancelled'
     AND (route_disposition IS NULL OR route_disposition <> 'superseded')
     AND sender_principal_id IS NOT NULL
     AND created_at <= $3`,
    [data.id, now, cutoff]
  );
  return result.rowCount === 1 ? getMessage(data.id) : null;
}

export async function releaseDispatchEscalationClaim(data: {
  id: string;
  leg: DispatchEscalationLeg;
  claimed_at: string;
}): Promise<boolean> {
  const column = data.leg === 'telegram' ? 'escalated_tg_at' : 'escalated_sms_at';
  const result = await getDatabase().query(
    `UPDATE agent_dispatch_messages SET ${column} = NULL WHERE id = $1 AND ${column} = $2`,
    [data.id, data.claimed_at]
  );
  return result.rowCount === 1;
}

export async function ensureXoEscalationHandoffs(activatedAt: string): Promise<number> {
  if (!Number.isFinite(Date.parse(activatedAt))) return 0;
  const rows = await getDatabase().query<DispatchMessageRow>(
    `SELECT source.* FROM agent_dispatch_messages source
     WHERE source.created_at >= $1 AND source.priority = 'blocker'
       AND source.sender_principal_id IS NOT NULL
       AND LOWER(TRIM(COALESCE(source.resolved_recipient, source.recipient))) <> 'xo'
       AND source.addressed_at IS NULL
       AND source.status <> 'cancelled'
       AND (source.route_disposition IS NULL OR source.route_disposition <> 'superseded')
       AND NOT EXISTS (SELECT 1 FROM agent_dispatch_messages handoff
         WHERE handoff.idempotency_key = 'xo-handoff:' || source.id
           AND handoff.sender_principal_id = 'system:dispatch') LIMIT 100`,
    [activatedAt]
  );
  let created = 0;
  for (const row of rows.rows) {
    const source = normalizeMessage(row);
    try {
      await createAuthenticatedMessage(
        { kind: 'system', sender: 'dispatch' },
        {
          correlation_id: source.correlation_id,
          idempotency_key: `xo-handoff:${source.id}`,
          task_type: 'agent_message',
          recipient: 'xo',
          priority: 'blocker',
          subject_key: source.subject_key,
          repeat_reason: source.subject_key ? 'system XO escalation handoff' : null,
          body: JSON.stringify({ source_id: source.id, kind: 'xo_escalation_handoff' }),
        }
      );
      created++;
    } catch {
      log.warn(
        { sourceId: source.id, failureClass: 'handoff_create_rejected' },
        'dispatch_xo_handoff_failed'
      );
    }
  }
  return created;
}

export async function listEligibleXoEscalations(activatedAt: string): Promise<DispatchMessage[]> {
  if (!Number.isFinite(Date.parse(activatedAt))) return [];
  const result = await getDatabase().query<DispatchMessageRow>(
    `SELECT * FROM agent_dispatch_messages WHERE created_at >= $1 AND priority = 'blocker'
       AND LOWER(TRIM(COALESCE(resolved_recipient, recipient))) = 'xo'
       AND addressed_at IS NULL AND status <> 'cancelled'
       AND (route_disposition IS NULL OR route_disposition <> 'superseded')
       AND sender_principal_id IS NOT NULL
     ORDER BY created_at ASC LIMIT 100`,
    [activatedAt]
  );
  return result.rows.map(normalizeMessage);
}

/** Deterministic crash-gap owner; `outcome-notice:<id>` prevents duplicate notices. */
async function attemptDispatchOutcomeNotice(
  source: DispatchMessage,
  activatedAt: string | undefined
): Promise<boolean> {
  if (
    !activatedAt ||
    !Number.isFinite(Date.parse(activatedAt)) ||
    source.created_at < new Date(activatedAt).toISOString() ||
    source.sender === 'dispatch' ||
    source.sender_principal_id == null ||
    !(['done', 'failed'] as DispatchMessageStatus[]).includes(source.status) ||
    source.task_outcome === 'succeeded'
  )
    return false;
  try {
    await createAuthenticatedMessage(
      { kind: 'system', sender: 'dispatch' },
      {
        correlation_id: source.correlation_id,
        idempotency_key: `outcome-notice:${source.id}`,
        task_type: 'agent_message',
        recipient: source.sender,
        priority: 'blocker',
        subject_key: source.subject_key,
        repeat_reason: source.subject_key ? 'system outcome notice' : null,
        body: JSON.stringify({
          source_id: source.id,
          status: source.status,
          task_outcome: source.task_outcome,
        }),
      }
    );
    return true;
  } catch {
    log.warn(
      { sourceId: source.id, failureClass: 'outcome_notice_create_rejected' },
      'dispatch_outcome_notice_failed'
    );
    return false;
  }
}

export async function reconcileDispatchOutcomeNotices(activatedAt: string): Promise<number> {
  if (!Number.isFinite(Date.parse(activatedAt))) return 0;
  const candidates = await getDatabase().query<DispatchMessageRow>(
    `SELECT source.* FROM agent_dispatch_messages source WHERE source.created_at >= $1
     AND source.sender <> 'dispatch'
     AND source.sender_principal_id IS NOT NULL
     AND source.status IN ('done', 'failed')
     AND (source.task_outcome IS NULL OR source.task_outcome IN ('failed', 'blocked'))
     AND NOT EXISTS (SELECT 1 FROM agent_dispatch_messages notice
       WHERE notice.idempotency_key = 'outcome-notice:' || source.id
         AND notice.sender_principal_id = 'system:dispatch') LIMIT 100`,
    [activatedAt]
  );
  let created = 0;
  for (const row of candidates.rows) {
    if (await attemptDispatchOutcomeNotice(normalizeMessage(row), activatedAt)) created++;
  }
  return created;
}
