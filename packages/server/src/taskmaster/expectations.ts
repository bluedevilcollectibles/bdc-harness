import { createLogger } from '@archon/paths';
import { getDatabase } from '@archon/core';
import {
  createAuthenticatedMessage,
  getMessage,
  type CreateAuthenticatedMessageData,
  type DispatchMessage,
} from '@archon/core/db/dispatch';
import * as taskmasterDb from '@archon/core/db/taskmaster';

const log = createLogger('taskmaster/expectations');
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000;

export type EvidenceSpec =
  | { kind: 'issue_comment_exists'; repo: string; number: number; author?: string; marker?: string }
  | { kind: 'label_present'; repo: string; number: number; label: string }
  | { kind: 'pr_opened'; repo: string; head_branch?: string; title_prefix?: string }
  | { kind: 'lease_holder_is'; name: string }
  | { kind: 'dispatch_reply_exists'; correlation_id: string; classification?: string }
  | {
      kind: 'db_row_exists';
      table: string;
      /**
       * Column predicates. A scalar is an equality test; `null` is an IS NULL
       * test (SQL NULL never satisfies `column = $n`, so a null predicate
       * rendered as equality is always absent -- review finding [minor]); an
       * array is an IN test, which is how a "terminal successful outcome"
       * predicate is expressed without a bespoke evidence kind.
       */
      where: Record<string, EvidenceScalar | readonly EvidenceScalar[] | null>;
    };

type EvidenceScalar = string | number | boolean;

export interface EvidenceResult {
  ok: boolean;
  pointer: string | null;
}

export interface ExpectationDeps {
  fetch?: typeof fetch;
  // Generic result typing keeps evidence implementations free of unsafe casts.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query?: <T>(sql: string, params?: unknown[]) => Promise<{ rows: readonly T[] }>;
  listDueExpectations?: typeof taskmasterDb.listDueExpectations;
  /**
   * The transition hooks report whether THIS caller won the conditional UPDATE.
   * `undefined` is accepted so a double that does not model contention still
   * compiles; only an explicit `false` is treated as a lost race, so an
   * unmodelled double behaves as the sole writer it is.
   */
  markMet?: (id: string, evidencePointer: string) => Promise<boolean | undefined>;
  markFailed?: (id: string) => Promise<boolean | undefined>;
  claimRedispatchAttempt?: typeof taskmasterDb.claimRedispatchAttempt;
  /**
   * Claims the recovery replay and moves the evidence deadline in one write.
   * `undefined` is accepted so a double that does not model contention still
   * compiles; only an explicit `false` is treated as a lost claim.
   */
  claimRecoveryReplay?: (
    id: string,
    expectedRetries: number,
    dueAt: string,
    expectedDueAt: string
  ) => Promise<boolean | undefined>;
  /**
   * Claims the right to send the operator escalation by moving the row to the
   * intermediate non-terminal 'escalating' state. Exclusive, so a worker that
   * loses it never sends.
   */
  claimEscalation?: (id: string, evidencePointer?: string) => Promise<boolean | undefined>;
  markEscalated?: (id: string, evidencePointer?: string) => Promise<boolean | undefined>;
  markGivenUp?: (id: string, reason: string) => Promise<boolean | undefined>;
  getMessage?: (id: string) => Promise<DispatchMessage | null>;
  createTask?: typeof createAuthenticatedMessage;
  /**
   * Existence probe for an already-claimed attempt's deterministic key. Returns
   * null when no taskmaster-sent dispatch row carries that key, which is the
   * signal that a claimed attempt was never actually sent.
   */
  findEffectByIdempotencyKey?: (
    key: string
  ) => Promise<{ id: string; status: string; createdAt: string } | null>;
  checkEvidence?: (spec: EvidenceSpec) => Promise<EvidenceResult>;
  retryDelayMs?: number;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function checkEvidence(
  spec: EvidenceSpec,
  deps: Pick<ExpectationDeps, 'fetch' | 'query'> = {}
): Promise<EvidenceResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const query =
    deps.query ??
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    (<T>(sql: string, params?: unknown[]): Promise<{ rows: readonly T[] }> =>
      getDatabase().query<T>(sql, params));
  if (spec.kind === 'issue_comment_exists') {
    const response = await fetchImpl(
      `https://api.github.com/repos/${spec.repo}/issues/${spec.number}/comments?per_page=100`,
      { headers: githubHeaders() }
    );
    if (!response.ok) throw new Error(`expectation_github_read_failed:${response.status}`);
    const comments = (await response.json()) as {
      html_url?: string;
      body?: string;
      user?: { login?: string };
    }[];
    const match = comments.find(
      comment =>
        (!spec.author || comment.user?.login?.toLowerCase() === spec.author.toLowerCase()) &&
        (!spec.marker || comment.body?.includes(spec.marker))
    );
    return { ok: Boolean(match), pointer: match?.html_url ?? null };
  }
  if (spec.kind === 'label_present') {
    const response = await fetchImpl(
      `https://api.github.com/repos/${spec.repo}/issues/${spec.number}`,
      { headers: githubHeaders() }
    );
    if (!response.ok) throw new Error(`expectation_github_read_failed:${response.status}`);
    const issue = (await response.json()) as {
      html_url?: string;
      labels?: (string | { name?: string })[];
    };
    const ok = (issue.labels ?? []).some(
      label =>
        (typeof label === 'string' ? label : label.name)?.toLowerCase() === spec.label.toLowerCase()
    );
    return { ok, pointer: ok ? (issue.html_url ?? null) : null };
  }
  if (spec.kind === 'pr_opened') {
    const qualifier = spec.head_branch
      ? `head:${spec.head_branch}`
      : `in:title ${spec.title_prefix ?? ''}`;
    const response = await fetchImpl(
      `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${spec.repo} is:pr is:open ${qualifier}`)}`,
      { headers: githubHeaders() }
    );
    if (!response.ok) throw new Error(`expectation_github_read_failed:${response.status}`);
    const result = (await response.json()) as {
      items?: { html_url?: string; title?: string }[];
    };
    const match = result.items?.find(
      item => !spec.title_prefix || item.title?.startsWith(spec.title_prefix)
    );
    return { ok: Boolean(match), pointer: match?.html_url ?? null };
  }
  if (spec.kind === 'lease_holder_is') {
    const result = await query<{ lease_id: string }>(
      'SELECT lease_id FROM board_xo_leases WHERE holder_id = $1 AND released_at IS NULL AND expires_at > $2 LIMIT 1',
      [spec.name, new Date().toISOString()]
    );
    return {
      ok: result.rows.length > 0,
      pointer: result.rows[0] ? `board_xo_leases:${result.rows[0].lease_id}` : null,
    };
  }
  if (spec.kind === 'dispatch_reply_exists') {
    const params: unknown[] = [spec.correlation_id];
    let sql =
      "SELECT id FROM agent_dispatch_messages WHERE correlation_id = $1 AND status = 'done'";
    if (spec.classification) {
      params.push(spec.classification);
      sql += ' AND task_outcome = $2';
    }
    sql += ' LIMIT 1';
    const result = await query<{ id: string }>(sql, params);
    return {
      ok: result.rows.length > 0,
      pointer: result.rows[0] ? `dispatch:${result.rows[0].id}` : null,
    };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.table)) throw new Error('expectation_db_table_invalid');
  const entries = Object.entries(spec.where);
  if (entries.some(([column]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)))
    throw new Error('expectation_db_column_invalid');
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of entries) {
    if (value === null) {
      // SQL NULL is never equal to anything, including a null bind parameter.
      clauses.push(`${column} IS NULL`);
      continue;
    }
    if (Array.isArray(value)) {
      // An empty IN list can never match; render it as an explicitly false
      // predicate rather than emitting invalid `IN ()`.
      if (value.length === 0) {
        clauses.push('1 = 0');
        continue;
      }
      const placeholders = value.map(item => {
        params.push(item);
        return `$${String(params.length)}`;
      });
      clauses.push(`${column} IN (${placeholders.join(', ')})`);
      continue;
    }
    params.push(value);
    clauses.push(`${column} = $${String(params.length)}`);
  }
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM ${spec.table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} LIMIT 1`,
    params
  );
  return {
    ok: result.rows.length > 0,
    pointer: result.rows.length ? `${spec.table}:${JSON.stringify(spec.where)}` : null,
  };
}

/**
 * The idempotency key for one redispatch attempt. DETERMINISTIC in
 * (expectation id, attempt number) -- no random component -- which is what
 * makes replaying a claimed-but-unsent attempt safe: the dispatch DAL is
 * idempotent on this key, so a replay of an attempt that did land reuses the
 * existing row instead of sending twice.
 */
function redispatchKey(expectationId: string, attempt: number): string {
  return `tm:expectation:${expectationId}:retry:${String(attempt)}`;
}

/**
 * Does a taskmaster-sent dispatch row already carry this idempotency key?
 *
 * Deliberately defined here rather than imported from ./loop, which already
 * imports checkExpectations from this module -- reusing that export would make
 * the two files circular. The predicate matches loop.ts's
 * defaultFindEffectByIdempotencyKey exactly, including the system:taskmaster
 * sender scoping, so the two agree on what "already sent" means.
 */
export async function defaultFindEffectByIdempotencyKey(
  key: string,
  deps: Pick<ExpectationDeps, 'query'> = {}
): Promise<{ id: string; status: string; createdAt: string } | null> {
  const query =
    deps.query ??
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    (<T>(sql: string, params?: unknown[]): Promise<{ rows: readonly T[] }> =>
      getDatabase().query<T>(sql, params));
  const result = await query<{ id: string; status: string; created_at: string }>(
    `SELECT id, status, created_at FROM agent_dispatch_messages
      WHERE idempotency_key = $1
        AND sender_principal_id = 'system:taskmaster'
      LIMIT 1`,
    [key]
  );
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status, createdAt: row.created_at } : null;
}

/** Send (or idempotently replay) one redispatch attempt. Returns the key used. */
async function sendRedispatch(
  expectation: taskmasterDb.TmExpectation,
  original: DispatchMessage,
  attempt: number,
  deps: ExpectationDeps
): Promise<string> {
  const key = redispatchKey(expectation.id, attempt);
  const data: CreateAuthenticatedMessageData = {
    correlation_id: original.correlation_id,
    idempotency_key: key,
    task_type: original.task_type,
    recipient: original.recipient,
    body: original.body,
    priority: original.priority,
    subject_key: original.subject_key,
    repeat_reason: `expectation:${expectation.id}:retry:${String(attempt)}`,
  };
  await (deps.createTask ?? createAuthenticatedMessage)(
    { kind: 'system', sender: 'taskmaster' },
    data
  );
  return key;
}

export async function checkExpectations(now: Date, deps: ExpectationDeps = {}): Promise<void> {
  const list = deps.listDueExpectations ?? taskmasterDb.listDueExpectations;
  const active = await list(now.toISOString());
  for (const expectation of active) {
    let evidence: EvidenceResult;
    try {
      evidence = await (
        deps.checkEvidence ??
        ((spec: EvidenceSpec): Promise<EvidenceResult> => checkEvidence(spec, deps))
      )(JSON.parse(expectation.evidence_json) as EvidenceSpec);
    } catch (error) {
      log.warn(
        { err: error as Error, expectationId: expectation.id },
        'taskmaster.expectation_check_failed'
      );
      continue;
    }
    if (evidence.ok) {
      const closed = await (deps.markMet ?? taskmasterDb.markMet)(
        expectation.id,
        evidence.pointer ?? 'verified'
      );
      // Evidence observed twice is not an error, but only one tick closes the
      // row. The loser must not re-close it.
      if (closed === false)
        log.warn({ expectationId: expectation.id }, 'taskmaster.expectation_met_transition_lost');
      continue;
    }
    // An 'escalating' row is an escalation this system already authorized and
    // owes: the claim was won, but the send was never confirmed. It must go
    // straight to the replay -- past the deadline check (the deadline is long
    // gone and irrelevant now) and past redispatch recovery (the retry budget
    // is spent; that is why it is escalating at all). Falling through either of
    // those is how the owed escalation would be lost.
    if (expectation.status !== 'escalating') {
      if (now.getTime() < Date.parse(expectation.due_at)) continue;
    }

    // RECOVERY FIRST, AND INDEPENDENT OF CLAIMING ANYTHING.
    //
    // An attempt is PAID FOR the moment it is claimed: the counter advanced, so
    // the budget was spent. If the worker then crashed before the send, that
    // attempt exists only as a number in the row -- no dispatch row carries its
    // deterministic key. Replaying it is not a new attempt, it is finishing the
    // one already bought.
    //
    // This ran nested inside the new-claim branch until this repair, which made
    // it unreachable in exactly the case that matters most: an expectation that
    // crashed after claiming its LAST allowed attempt (retries == max_retries)
    // failed the `retries < max_retries` guard on the outer branch, so it
    // escalated with its final paid-for attempt never dispatched. The same
    // nesting also spent the next retry before replaying the previous one, and
    // let a replay failure strand a freshly claimed attempt.
    //
    // A crashed attempt is NOT a failure -- it was never sent, so no deadline
    // can have elapsed on it. Recovery therefore precedes markFailed, replays
    // the key, and stops the tick there; the evidence deadline is re-judged on
    // a later tick against an attempt that was actually dispatched.
    if (
      expectation.status !== 'escalating' &&
      expectation.on_absence === 'redispatch' &&
      expectation.retries > 0
    ) {
      const claimedKey = redispatchKey(expectation.id, expectation.retries);
      const findEffect = deps.findEffectByIdempotencyKey ?? defaultFindEffectByIdempotencyKey;
      let alreadySent: boolean;
      try {
        alreadySent = (await findEffect(claimedKey)) !== null;
      } catch (error) {
        // Unknown is not "absent": replaying blind here could double-send if
        // the row does exist. Leave the expectation active and retry the read
        // on the next tick.
        log.warn(
          { err: error as Error, expectationId: expectation.id, idempotencyKey: claimedKey },
          'taskmaster.expectation_recovery_probe_failed'
        );
        continue;
      }
      if (!alreadySent) {
        const original = await (deps.getMessage ?? getMessage)(expectation.dispatch_ref);
        if (!original) {
          log.error({ expectationId: expectation.id }, 'taskmaster.expectation_dispatch_missing');
          await (deps.markGivenUp ?? taskmasterDb.markGivenUp)(
            expectation.id,
            `original dispatch missing: ${expectation.dispatch_ref}`
          );
          continue;
        }
        // MOVE THE DEADLINE WITH THE REPLAY, NOT AFTER IT.
        //
        // Recovery only runs once due_at has elapsed, so replaying without
        // advancing it left the row instantly overdue: the next tick would call
        // the just-recovered dispatch a failure and burn another retry, or
        // escalate, without ever granting the configured response interval.
        // This also serves as the exclusive claim for the replay -- two ticks
        // seeing the same unsent attempt cannot both send, and a tick racing a
        // concurrent markMet loses here and sends nothing.
        const recoveryDueAt = new Date(
          now.getTime() + (deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
        ).toISOString();
        const claimedRecovery = await (
          deps.claimRecoveryReplay ?? taskmasterDb.claimRecoveryReplay
        )(expectation.id, expectation.retries, recoveryDueAt, expectation.due_at);
        if (claimedRecovery === false) {
          log.warn(
            { expectationId: expectation.id, idempotencyKey: claimedKey },
            'taskmaster.expectation_recovery_claim_lost'
          );
          continue;
        }
        await sendRedispatch(expectation, original, expectation.retries, deps);
        log.warn(
          {
            expectationId: expectation.id,
            idempotencyKey: claimedKey,
            attempt: expectation.retries,
            dueAt: recoveryDueAt,
          },
          'taskmaster.expectation_redispatch_recovered'
        );
        continue;
      }
    }

    // An 'escalating' row skips the failure/give-up/redispatch decisions
    // entirely: that decision was already made and the escalation was already
    // claimed, so the only thing owed is the replay below. Note markFailed
    // would refuse it anyway ('escalating' is not in the active set), but
    // falling through would log a misleading transition-lost and `continue`,
    // which is precisely how the owed escalation would be dropped.
    if (expectation.status !== 'escalating') {
      // EVERY follow-on action below is gated on winning this transition. A
      // tick that loses it is stale: another tick has already marked this
      // expectation met, escalated or given up, and acting on a snapshot taken
      // before that would regress a terminal state and fire an external action
      // (a redispatch or an operator escalation) for work that is already
      // closed.
      const claimedFailure = await (deps.markFailed ?? taskmasterDb.markFailed)(expectation.id);
      if (claimedFailure === false) {
        log.warn(
          { expectationId: expectation.id },
          'taskmaster.expectation_failed_transition_lost'
        );
        continue;
      }
      if (expectation.on_absence === 'give_up') {
        await (deps.markGivenUp ?? taskmasterDb.markGivenUp)(
          expectation.id,
          'evidence absent at deadline'
        );
        continue;
      }
    }
    if (
      expectation.status !== 'escalating' &&
      expectation.on_absence === 'redispatch' &&
      expectation.retries < expectation.max_retries
    ) {
      const original = await (deps.getMessage ?? getMessage)(expectation.dispatch_ref);
      if (!original) {
        log.error({ expectationId: expectation.id }, 'taskmaster.expectation_dispatch_missing');
        await (deps.markGivenUp ?? taskmasterDb.markGivenUp)(
          expectation.id,
          `original dispatch missing: ${expectation.dispatch_ref}`
        );
        continue;
      }
      const dueAt = new Date(
        now.getTime() + (deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
      ).toISOString();
      // CLAIM BEFORE THE SEND. The counter advances atomically, bounded by
      // max_retries, under a compare-and-set on BOTH the retry count and the
      // active status this tick observed. An overlapping tick finds the counter
      // already advanced -- or the row already closed as met -- loses the
      // claim, and must not send.
      //
      // By the time control reaches here, the previously claimed attempt is
      // CONFIRMED SENT (the recovery step above returned without replaying) and
      // its evidence is still absent past the deadline. Only then is buying
      // another attempt the right move.
      const attempt = await (deps.claimRedispatchAttempt ?? taskmasterDb.claimRedispatchAttempt)(
        expectation.id,
        expectation.retries,
        dueAt
      );
      if (attempt === null) {
        log.warn(
          { expectationId: expectation.id, observedRetries: expectation.retries },
          'taskmaster.expectation_redispatch_claim_lost'
        );
        continue;
      }

      // If this send throws, the attempt stays claimed but unsent -- which is
      // precisely the state the recovery step above is built to finish on the
      // next tick, under this same deterministic key.
      const key = await sendRedispatch(expectation, original, attempt, deps);
      log.warn(
        { expectationId: expectation.id, idempotencyKey: key, attempt },
        'taskmaster.expectation_redispatched'
      );
      continue;
    }
    // TWO-PHASE ESCALATION: claim -> send -> confirm.
    //
    // Both single-phase orderings are broken, in mirror-image ways:
    //
    //  - send THEN transition: markFailed is not an exclusive claim ('failed'
    //    is itself in the active set, so failed -> failed succeeds) and winning
    //    it does not lock the row (markMet permits failed -> met). A worker
    //    could therefore put an operator blocker on the wire for an expectation
    //    another worker had already verified, and the losing transition
    //    afterwards could not retract that external action.
    //  - transition THEN send: the row is terminal the instant the transition
    //    commits, so a send that throws -- or a crash right after it -- loses
    //    the escalation forever, because listDueExpectations would never select
    //    the row again.
    //
    // Claiming the intermediate NON-terminal 'escalating' state gives both
    // guarantees at once. The claim is exclusive, so a worker that loses it
    // never sends; and 'escalating' is still selectable, so an unconfirmed send
    // is replayed on a later tick under the deterministic escalation key --
    // which the dispatch DAL dedupes, so exactly one operator task exists.
    // Only a confirmed send advances the row to terminal 'escalated'.
    //
    // This is the same shape the redispatch path already uses: claim a
    // non-terminal state, act, and let the tick finish an unconfirmed action.
    const escalationPointer = `tm:expectation:${expectation.id}:escalate`;
    if (expectation.status !== 'escalating') {
      const claimed = await (deps.claimEscalation ?? taskmasterDb.claimEscalation)(
        expectation.id,
        escalationPointer
      );
      if (claimed === false) {
        log.warn(
          { expectationId: expectation.id },
          'taskmaster.expectation_escalated_transition_lost'
        );
        continue;
      }
    }
    // If this send throws, the row stays 'escalating' and a later tick replays
    // it under this same deterministic key. Nothing is lost and nothing is
    // duplicated.
    await (deps.createTask ?? createAuthenticatedMessage)(
      { kind: 'system', sender: 'taskmaster' },
      {
        correlation_id: `tm-expectation-${expectation.id}`,
        idempotency_key: escalationPointer,
        task_type: 'agent_message',
        recipient: 'operator',
        priority: 'blocker',
        body: `Taskmaster expectation exhausted: ${JSON.stringify(expectation)}`,
      }
    );
    // Confirmed sent: close the row.
    const escalated = await (deps.markEscalated ?? taskmasterDb.markEscalated)(
      expectation.id,
      escalationPointer
    );
    if (escalated === false) {
      log.warn({ expectationId: expectation.id }, 'taskmaster.expectation_escalated_confirm_lost');
      continue;
    }
    log.error({ expectationId: expectation.id }, 'taskmaster.expectation_escalated');
  }
}
