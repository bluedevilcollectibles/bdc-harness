import { describe, expect, test } from 'bun:test';
import { checkEvidence, checkExpectations, type EvidenceSpec } from './expectations';
import type { TmExpectation } from '@archon/core/db/taskmaster';

const base: TmExpectation = {
  id: 'expectation-1',
  dispatch_ref: 'original',
  recipient: 'xo',
  evidence_json: JSON.stringify({ kind: 'dispatch_reply_exists', correlation_id: 'c1' }),
  due_at: new Date(0).toISOString(),
  on_absence: 'redispatch',
  max_retries: 2,
  retries: 0,
  status: 'pending',
  evidence_pointer: null,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

describe('expectation evidence', () => {
  test('issue_comment_exists returns the comment URL pointer', async () => {
    const result = await checkEvidence(
      { kind: 'issue_comment_exists', repo: 'x/y', number: 1, marker: 'CLAIM' },
      {
        fetch: (() =>
          Promise.resolve(
            new Response(
              JSON.stringify([
                { body: 'CLAIM', html_url: 'https://example/comment', user: { login: 'xo' } },
              ]),
              { status: 200 }
            )
          )) as typeof fetch,
      }
    );
    expect(result).toEqual({ ok: true, pointer: 'https://example/comment' });
  });

  test('all declarative DB evidence kinds produce pointers', async () => {
    const query = async <T>() => ({ rows: [{ id: 'row-1', lease_id: 'lease-1' } as T] });
    for (const spec of [
      { kind: 'lease_holder_is', name: 'holder' },
      { kind: 'dispatch_reply_exists', correlation_id: 'c', classification: 'succeeded' },
      { kind: 'db_row_exists', table: 'safe_table', where: { id: 1 } },
    ] as EvidenceSpec[])
      expect((await checkEvidence(spec, { query })).ok).toBe(true);
  });

  test('db_row_exists renders a null predicate as IS NULL, not column = $n', async () => {
    let seen = '';
    const query = async <T>(sql: string, params?: unknown[]) => {
      seen = sql;
      // A NULL column never satisfies `column = $n`, so the old rendering made
      // every valid null predicate report absent.
      expect(params).toEqual([1]);
      return { rows: [{ id: 1 } as T] };
    };
    const result = await checkEvidence(
      { kind: 'db_row_exists', table: 'safe_table', where: { id: 1, archived_at: null } },
      { query }
    );
    expect(seen).toContain('archived_at IS NULL');
    expect(seen).not.toContain('archived_at = $');
    expect(result.ok).toBe(true);
  });

  test('db_row_exists renders an array predicate as IN, so a status set is expressible', async () => {
    let seen = '';
    let bound: unknown[] | undefined;
    const query = async <T>(sql: string, params?: unknown[]) => {
      seen = sql;
      bound = params;
      return { rows: [] as T[] };
    };
    const result = await checkEvidence(
      {
        kind: 'db_row_exists',
        table: 'remote_agent_workflow_runs',
        where: { id: 'run-1', status: ['completed'] },
      },
      { query }
    );
    expect(seen).toContain('status IN ($2)');
    expect(bound).toEqual(['run-1', 'completed']);
    expect(result.ok).toBe(false);
  });

  test('db_row_exists renders an empty IN list as an unsatisfiable predicate', async () => {
    let seen = '';
    const query = async <T>(sql: string) => {
      seen = sql;
      return { rows: [] as T[] };
    };
    await checkEvidence(
      { kind: 'db_row_exists', table: 'safe_table', where: { status: [] } },
      { query }
    );
    expect(seen).toContain('1 = 0');
    expect(seen).not.toContain('IN ()');
  });

  test('an admitted-but-unfinished cascade run does NOT satisfy the cascade evidence', async () => {
    // The admission row exists (admission is what creates it) but the run has
    // not reached a successful terminal status. This must NOT be evidence.
    const rows = [{ id: 'cascade-1', status: 'running' }];
    const query = async <T>(sql: string, params?: unknown[]) => {
      const [id, ...statuses] = (params ?? []) as string[];
      const matched = rows.filter(
        row => row.id === id && (statuses.length === 0 || statuses.includes(row.status))
      );
      expect(sql).toContain('status IN (');
      return { rows: matched as T[] };
    };
    const spec: EvidenceSpec = {
      kind: 'db_row_exists',
      table: 'remote_agent_workflow_runs',
      where: { id: 'cascade-1', status: ['completed'] },
    };
    expect((await checkEvidence(spec, { query })).ok).toBe(false);
    rows[0]!.status = 'failed';
    expect((await checkEvidence(spec, { query })).ok).toBe(false);
    rows[0]!.status = 'completed';
    expect((await checkEvidence(spec, { query })).ok).toBe(true);
  });
});

describe('expectation supervisor', () => {
  test('missing original dispatch gives up instead of remaining perpetually due', async () => {
    const calls: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [base],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => calls.push('failed'),
      getMessage: async () => null,
      markGivenUp: async (_id, reason) => calls.push(`given_up:${reason}`),
    });
    expect(calls).toEqual(['failed', 'given_up:original dispatch missing: original']);
  });

  test('give_up policy records a terminal state at the deadline', async () => {
    const calls: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [{ ...base, on_absence: 'give_up' }],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => calls.push('failed'),
      markGivenUp: async (_id, reason) => calls.push(`given_up:${reason}`),
    });
    expect(calls).toEqual(['failed', 'given_up:evidence absent at deadline']);
  });

  test('expectation_absent_evidence_fails_and_acts', async () => {
    const calls: string[] = [];
    const keys: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [base],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {
        calls.push('failed');
      },
      claimRedispatchAttempt: async () => {
        calls.push('retry');
        return 1;
      },
      getMessage: async () => ({
        id: 'original',
        correlation_id: 'c1',
        idempotency_key: 'old',
        task_type: 'agent_message',
        sender: 'taskmaster',
        sender_principal_id: 'system:taskmaster',
        recipient: 'xo',
        body: 'work',
        status: 'done',
        result_body: null,
        created_at: new Date().toISOString(),
        claimed_at: null,
        completed_at: null,
        not_before: null,
        lease_owner: null,
        lease_expires_at: null,
        fencing_token: 0,
        recipient_alias: null,
        motion_id: null,
        motion_revision_sha: null,
        resolved_recipient: null,
        resolved_xo_lease_id: null,
        resolved_xo_fencing_token: null,
        resolved_at: null,
        priority: 'normal',
        task_outcome: null,
        acknowledged_at: null,
        acknowledged_by: null,
        addressed_at: null,
        addressed_by: null,
        escalated_tg_at: null,
        escalated_sms_at: null,
        subject_key: null,
        route_disposition: null,
        supersedes_id: null,
        repeat_reason: null,
      }),
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'retry' } as never;
      },
    });
    expect(calls).toEqual(['failed', 'retry']);
    expect(keys[0]).not.toBe('old');
  });

  test('retry_cap_then_escalate_never_loops', async () => {
    let row = { ...base };
    const sends: string[] = [];
    const deps = {
      listDueExpectations: async () => (row.status === 'escalated' ? [] : [row]),
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {},
      getMessage: async () =>
        ({
          id: 'original',
          correlation_id: 'c1',
          task_type: 'agent_message',
          recipient: 'xo',
          body: 'work',
          priority: 'normal',
          subject_key: null,
        }) as never,
      createTask: async (_context: never, data: { idempotency_key: string }) => {
        sends.push(data.idempotency_key);
        return { id: `d-${sends.length}` } as never;
      },
      claimRedispatchAttempt: async (_id: string, expected: number) => {
        if (row.retries !== expected || row.retries >= row.max_retries) return null;
        row = {
          ...row,
          retries: row.retries + 1,
          due_at: new Date(0).toISOString(),
          status: 'failed',
        };
        return row.retries;
      },
      markEscalated: async () => {
        row = { ...row, status: 'escalated' };
      },
      retryDelayMs: 0,
    };
    await checkExpectations(new Date(), deps as never);
    await checkExpectations(new Date(), deps as never);
    await checkExpectations(new Date(), deps as never);
    await checkExpectations(new Date(), deps as never);
    // Deterministic keys mean a replayed attempt is the SAME key, so distinct
    // retry keys is the real count of attempts.
    expect(new Set(sends.filter(key => key.includes(':retry:'))).size).toBe(2);
    expect(sends.filter(key => key.endsWith(':escalate'))).toHaveLength(1);
  });

  test('the redispatch idempotency key is deterministic in (expectation, attempt)', async () => {
    const keys: string[] = [];
    const deps = {
      listDueExpectations: async () => [base],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {},
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context: never, data: { idempotency_key: string }) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      claimRedispatchAttempt: async () => 1,
      retryDelayMs: 0,
    };
    // Two independent runs of the SAME attempt must produce the SAME key.
    // Fails on the old behaviour, which appended a fresh randomUUID each time.
    await checkExpectations(new Date(), deps as never);
    await checkExpectations(new Date(), deps as never);
    expect(keys).toEqual([
      'tm:expectation:expectation-1:retry:1',
      'tm:expectation:expectation-1:retry:1',
    ]);
  });

  test('a tick that loses the claim does not send', async () => {
    const keys: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [base],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {},
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      // An overlapping tick already advanced the counter.
      claimRedispatchAttempt: async () => null,
      retryDelayMs: 0,
    } as never);
    expect(keys).toEqual([]);
  });

  test('two concurrent ticks over one CAS-backed counter send exactly one attempt', async () => {
    let retries = 0;
    const keys: string[] = [];
    const deps = {
      listDueExpectations: async () => [{ ...base, retries }],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {},
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context: never, data: { idempotency_key: string }) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      // Stands in for the real compare-and-set in the DAL.
      claimRedispatchAttempt: async (_id: string, expected: number) => {
        if (retries !== expected) return null;
        retries += 1;
        return retries;
      },
      retryDelayMs: 0,
    };
    await Promise.all([
      checkExpectations(new Date(), deps as never),
      checkExpectations(new Date(), deps as never),
    ]);
    // Fails on the old behaviour: both ticks sent, and both incremented.
    expect(keys).toEqual(['tm:expectation:expectation-1:retry:1']);
    expect(retries).toBe(1);
  });

  test('losing the failed transition skips the redispatch entirely', async () => {
    const keys: string[] = [];
    const claims: number[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [base],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      // Another tick already closed this row as met between the snapshot and
      // now, so the conditional UPDATE matches nothing.
      markFailed: async () => false,
      claimRedispatchAttempt: async () => {
        claims.push(1);
        return 1;
      },
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      retryDelayMs: 0,
    } as never);
    // Fails on the old behaviour: markFailed returned void, its result was
    // ignored, and the tick redispatched work that had already succeeded.
    expect(keys).toEqual([]);
    expect(claims).toEqual([]);
  });

  test('losing the failed transition skips the escalation too', async () => {
    const keys: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [{ ...base, on_absence: 'escalate', max_retries: 0 }],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => false,
      markEscalated: async () => true,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      retryDelayMs: 0,
    } as never);
    // No operator blocker for an expectation another tick already verified.
    expect(keys).toEqual([]);
  });

  test('losing the met transition does not throw or double-close', async () => {
    const closes: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [base],
      checkEvidence: async () => ({ ok: true, pointer: 'https://example/proof' }),
      markMet: async (_id: string, pointer: string) => {
        closes.push(pointer);
        return false;
      },
      retryDelayMs: 0,
    } as never);
    expect(closes).toEqual(['https://example/proof']);
  });

  test('a stale tick that loses the claim sends nothing, not even a replay', async () => {
    const keys: string[] = [];
    await checkExpectations(new Date(), {
      // retries=1 means the recovery replay would fire if the claim were not
      // checked first.
      listDueExpectations: async () => [{ ...base, retries: 1 }],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      claimRedispatchAttempt: async () => null,
      retryDelayMs: 0,
    } as never);
    // The claim is checked BEFORE the replay, so a tick that lost the race puts
    // no message on the wire at all.
    expect(keys).toEqual([]);
  });

  test('a crash between the claim and the send is recovered under the same key', async () => {
    const keys: string[] = [];
    // The prior tick claimed attempt 1 and died before sending: retries=1 is
    // durable, but no dispatch row exists for attempt 1.
    const crashed: TmExpectation = { ...base, retries: 1, status: 'failed' };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [crashed],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {},
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      claimRedispatchAttempt: async () => 2,
      retryDelayMs: 0,
    } as never);
    // Attempt 1 is replayed under its own deterministic key (a no-op at the
    // dispatch DAL if it did land), and attempt 2 is the newly claimed one.
    // The count was never lost and attempt 1 can never be double-sent.
    expect(keys).toEqual([
      'tm:expectation:expectation-1:retry:1',
      'tm:expectation:expectation-1:retry:2',
    ]);
  });
});
