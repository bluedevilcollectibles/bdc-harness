import { randomUUID } from 'crypto';
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
      where: Record<string, string | number | boolean | null>;
    };

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
  markMet?: typeof taskmasterDb.markMet;
  markFailed?: typeof taskmasterDb.markFailed;
  incrementRetry?: typeof taskmasterDb.incrementRetry;
  markEscalated?: typeof taskmasterDb.markEscalated;
  markGivenUp?: typeof taskmasterDb.markGivenUp;
  getMessage?: (id: string) => Promise<DispatchMessage | null>;
  createTask?: typeof createAuthenticatedMessage;
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
  const clauses = entries.map(([column], index) => `${column} = $${index + 1}`);
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM ${spec.table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} LIMIT 1`,
    entries.map(([, value]) => value)
  );
  return {
    ok: result.rows.length > 0,
    pointer: result.rows.length ? `${spec.table}:${JSON.stringify(spec.where)}` : null,
  };
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
      await (deps.markMet ?? taskmasterDb.markMet)(expectation.id, evidence.pointer ?? 'verified');
      continue;
    }
    if (now.getTime() < Date.parse(expectation.due_at)) continue;
    await (deps.markFailed ?? taskmasterDb.markFailed)(expectation.id);
    if (expectation.on_absence === 'give_up') {
      await (deps.markGivenUp ?? taskmasterDb.markGivenUp)(
        expectation.id,
        'evidence absent at deadline'
      );
      continue;
    }
    if (expectation.on_absence === 'redispatch' && expectation.retries < expectation.max_retries) {
      const original = await (deps.getMessage ?? getMessage)(expectation.dispatch_ref);
      if (!original) {
        log.error({ expectationId: expectation.id }, 'taskmaster.expectation_dispatch_missing');
        await (deps.markGivenUp ?? taskmasterDb.markGivenUp)(
          expectation.id,
          `original dispatch missing: ${expectation.dispatch_ref}`
        );
        continue;
      }
      const key = `tm:expectation:${expectation.id}:retry:${expectation.retries + 1}:${randomUUID()}`;
      const data: CreateAuthenticatedMessageData = {
        correlation_id: original.correlation_id,
        idempotency_key: key,
        task_type: original.task_type,
        recipient: original.recipient,
        body: original.body,
        priority: original.priority,
        subject_key: original.subject_key,
        repeat_reason: `expectation:${expectation.id}:retry:${expectation.retries + 1}`,
      };
      await (deps.createTask ?? createAuthenticatedMessage)(
        { kind: 'system', sender: 'taskmaster' },
        data
      );
      const dueAt = new Date(
        now.getTime() + (deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
      ).toISOString();
      await (deps.incrementRetry ?? taskmasterDb.incrementRetry)(expectation.id, dueAt);
      log.warn(
        { expectationId: expectation.id, idempotencyKey: key },
        'taskmaster.expectation_redispatched'
      );
      continue;
    }
    const escalation = await (deps.createTask ?? createAuthenticatedMessage)(
      { kind: 'system', sender: 'taskmaster' },
      {
        correlation_id: `tm-expectation-${expectation.id}`,
        idempotency_key: `tm:expectation:${expectation.id}:escalate`,
        task_type: 'agent_message',
        recipient: 'operator',
        priority: 'blocker',
        body: `Taskmaster expectation exhausted: ${JSON.stringify(expectation)}`,
      }
    );
    await (deps.markEscalated ?? taskmasterDb.markEscalated)(
      expectation.id,
      `dispatch:${escalation.id}`
    );
    log.error({ expectationId: expectation.id }, 'taskmaster.expectation_escalated');
  }
}
