import { describe, expect, test } from 'bun:test';
import {
  checkEvidence,
  checkExpectations,
  EvidenceProbeCapped,
  nextPageUrl,
  renderEscalationBody,
  type EvidenceSpec,
} from './expectations';
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
  registered_by: 'taskmaster',
  self_supervised: 0,
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

  test('issue_comment_exists paginates: 150 comments, match on page 2', async () => {
    // REGRESSION. A single per_page=100 read reported evidence on any issue
    // past 100 comments as ABSENT -- and absence drives a redispatch or an
    // operator escalation for work that actually succeeded.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      body: `noise ${String(i)}`,
      html_url: `https://example/c${String(i)}`,
      user: { login: 'someone' },
    }));
    const page2 = [
      ...Array.from({ length: 49 }, (_, i) => ({
        body: `more noise ${String(i)}`,
        html_url: `https://example/d${String(i)}`,
        user: { login: 'someone' },
      })),
      { body: 'CLAIM', html_url: 'https://example/the-claim', user: { login: 'xo' } },
    ];
    const requested: string[] = [];
    const result = await checkEvidence(
      { kind: 'issue_comment_exists', repo: 'x/y', number: 1, marker: 'CLAIM' },
      {
        fetch: ((url: string) => {
          requested.push(url);
          const onPage2 = url.includes('page=2');
          return Promise.resolve(
            new Response(JSON.stringify(onPage2 ? page2 : page1), {
              status: 200,
              // Only page 1 advertises a next page.
              headers: onPage2
                ? {}
                : { link: '<https://api.github.com/x?per_page=100&page=2>; rel="next"' },
            })
          );
        }) as unknown as typeof fetch,
      }
    );
    expect(result).toEqual({ ok: true, pointer: 'https://example/the-claim' });
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain('page=2');
  });

  test('issue_comment_exists raises UNKNOWN when the page cap is hit with more pages left', async () => {
    // REGRESSION. Exhausting the cap while GitHub still advertises a next page
    // used to return a bare { ok: false } -- indistinguishable from proven
    // absence, so the supervisor would redispatch or escalate for an
    // expectation whose evidence may sit one page further on.
    const noise = Array.from({ length: 100 }, (_, i) => ({
      body: `noise ${String(i)}`,
      html_url: `https://example/c${String(i)}`,
      user: { login: 'someone' },
    }));
    const requested: string[] = [];
    await expect(
      checkEvidence(
        { kind: 'issue_comment_exists', repo: 'x/y', number: 7, marker: 'CLAIM' },
        {
          fetch: ((url: string) => {
            requested.push(url);
            // 21 pages advertised: every page keeps offering a next one, so the
            // cap binds before the search is exhausted.
            return Promise.resolve(
              new Response(JSON.stringify(noise), {
                status: 200,
                headers: { link: '<https://api.github.com/x?per_page=100&page=99>; rel="next"' },
              })
            );
          }) as unknown as typeof fetch,
        }
      )
    ).rejects.toBeInstanceOf(EvidenceProbeCapped);
    // Bounded: it stopped at the cap rather than following pages forever.
    expect(requested).toHaveLength(20);
  });

  test('issue_comment_exists reports absent after exhausting 2 pages with no match', async () => {
    const noise = Array.from({ length: 100 }, (_, i) => ({
      body: `noise ${String(i)}`,
      html_url: `https://example/c${String(i)}`,
      user: { login: 'someone' },
    }));
    const requested: string[] = [];
    const result = await checkEvidence(
      { kind: 'issue_comment_exists', repo: 'x/y', number: 1, marker: 'CLAIM' },
      {
        fetch: ((url: string) => {
          requested.push(url);
          const onPage2 = url.includes('page=2');
          return Promise.resolve(
            new Response(JSON.stringify(noise), {
              status: 200,
              headers: onPage2
                ? {}
                : { link: '<https://api.github.com/x?per_page=100&page=2>; rel="next"' },
            })
          );
        }) as unknown as typeof fetch,
      }
    );
    expect(result).toEqual({ ok: false, pointer: null });
    // Both pages were actually read before declaring absence.
    expect(requested).toHaveLength(2);
  });

  test('issue_comment_exists stops at the first match without reading later pages', async () => {
    // Every skipped request is GitHub rate budget preserved.
    const requested: string[] = [];
    const result = await checkEvidence(
      { kind: 'issue_comment_exists', repo: 'x/y', number: 1, marker: 'CLAIM' },
      {
        fetch: ((url: string) => {
          requested.push(url);
          return Promise.resolve(
            new Response(
              JSON.stringify([
                { body: 'CLAIM', html_url: 'https://example/early', user: { login: 'xo' } },
              ]),
              {
                status: 200,
                // A next page exists, but the match is on this one.
                headers: { link: '<https://api.github.com/x?per_page=100&page=2>; rel="next"' },
              }
            )
          );
        }) as unknown as typeof fetch,
      }
    );
    expect(result).toEqual({ ok: true, pointer: 'https://example/early' });
    expect(requested).toHaveLength(1);
  });

  test('nextPageUrl parses rel="next" and returns null on the last page', async () => {
    expect(
      nextPageUrl('<https://api.github.com/x?page=2>; rel="next", <https://x?page=9>; rel="last"')
    ).toBe('https://api.github.com/x?page=2');
    // Last page: GitHub sends prev/first only.
    expect(
      nextPageUrl('<https://x?page=1>; rel="prev", <https://x?page=1>; rel="first"')
    ).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
    expect(nextPageUrl('')).toBeNull();
    // rel="next" must not be matched inside another rel value.
    expect(nextPageUrl('<https://x?page=3>; rel="nextish"')).toBeNull();
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
    // Models the dispatch table: a key is "sent" once createTask has written
    // it, which is what the recovery probe reads.
    const sentKeys = new Set<string>();
    const deps = {
      listDueExpectations: async () => (row.status === 'escalated' ? [] : [row]),
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {},
      findEffectByIdempotencyKey: async (key: string) =>
        sentKeys.has(key)
          ? { id: `sent-${key}`, status: 'queued', createdAt: new Date(0).toISOString() }
          : null,
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
        sentKeys.add(data.idempotency_key);
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
      claimEscalation: async () => true,
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
      listDueExpectations: async () => [{ ...base, retries: 1 }],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      // Attempt 1 is confirmed sent, so recovery does not fire and the tick
      // goes on to try to buy attempt 2 -- which it loses.
      findEffectByIdempotencyKey: async () => ({
        id: 'sent-1',
        status: 'queued',
        createdAt: new Date(0).toISOString(),
      }),
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      claimRedispatchAttempt: async () => null,
      retryDelayMs: 0,
    } as never);
    // A tick that lost the claim puts no message on the wire at all.
    expect(keys).toEqual([]);
  });

  test('a crash between the claim and the send is recovered under the same key', async () => {
    const keys: string[] = [];
    const claims: number[] = [];
    // The prior tick claimed attempt 1 and died before sending: retries=1 is
    // durable, but no dispatch row carries attempt 1's key.
    const crashed: TmExpectation = { ...base, retries: 1, status: 'failed' };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [crashed],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {
        throw new Error('markFailed must not run: a never-sent attempt is not a failure');
      },
      findEffectByIdempotencyKey: async () => null,
      claimRecoveryReplay: async () => true,
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      claimRedispatchAttempt: async () => {
        claims.push(1);
        return 2;
      },
      retryDelayMs: 0,
    } as never);
    // ONLY attempt 1 is replayed, and NO new attempt is claimed. Recovery is
    // finishing an attempt already paid for, not buying another one -- the old
    // behaviour spent retry 2 just to replay retry 1.
    expect(keys).toEqual(['tm:expectation:expectation-1:retry:1']);
    expect(claims).toEqual([]);
  });

  test('a crash after claiming the LAST attempt is replayed, not escalated', async () => {
    // THE REGRESSION THIS REPAIR IS FOR. retries === max_retries, so the
    // outer `retries < max_retries` guard is false: the old code skipped
    // recovery entirely and escalated with the final paid-for attempt never
    // dispatched.
    const keys: string[] = [];
    const escalations: string[] = [];
    const lastAttemptCrashed: TmExpectation = {
      ...base,
      retries: 2,
      max_retries: 2,
      status: 'failed',
    };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [lastAttemptCrashed],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      claimEscalation: async () => true,
      markEscalated: async () => {
        escalations.push('escalated');
        return true;
      },
      findEffectByIdempotencyKey: async () => null,
      claimRecoveryReplay: async () => true,
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      claimRedispatchAttempt: async () => null,
      retryDelayMs: 0,
    } as never);
    // Exactly one send: the final attempt, under its own key. No escalation yet
    // -- the seat has not been given its last chance until the message lands.
    expect(keys).toEqual(['tm:expectation:expectation-1:retry:2']);
    expect(escalations).toEqual([]);
  });

  test('evidence met between markFailed and the escalation send blocks the blocker', async () => {
    // THE ESCALATION ORDERING RACE. markFailed is NOT an exclusive claim
    // (failed -> failed is permitted) and winning it does not lock the row
    // (markMet permits failed -> met). A concurrent worker verifies the
    // evidence in that window; this worker must NOT put an operator blocker on
    // the wire, because a losing markEscalated afterwards could not retract it.
    const keys: string[] = [];
    const order: string[] = [];
    let rowClosedAsMet = false;
    const exhausted: TmExpectation = { ...base, retries: 2, max_retries: 2, status: 'failed' };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [exhausted],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {
        order.push('markFailed');
        // The concurrent worker lands its markMet right here.
        rowClosedAsMet = true;
        return true;
      },
      findEffectByIdempotencyKey: async () => ({
        id: 'sent-2',
        status: 'queued',
        createdAt: new Date(0).toISOString(),
      }),
      claimEscalation: async () => {
        order.push('claimEscalation');
        // Conditional on the active set: the row is now 'met', so this loses.
        return rowClosedAsMet ? false : true;
      },
      markEscalated: async () => {
        order.push('markEscalated');
        return true;
      },
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        order.push(`send:${data.idempotency_key}`);
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      retryDelayMs: 0,
    } as never);
    // NO escalation dispatch row is created. Fails on the old behaviour, which
    // sent first and only then discovered the transition was lost.
    expect(keys).toEqual([]);
    // The claim is acquired BEFORE any send is attempted, and losing it stops
    // the tick before both the send and the terminal confirm.
    expect(order).toEqual(['markFailed', 'claimEscalation']);
  });

  test('a won escalation claims, then sends, then confirms', async () => {
    const order: string[] = [];
    const exhausted: TmExpectation = { ...base, retries: 2, max_retries: 2, status: 'failed' };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [exhausted],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      findEffectByIdempotencyKey: async () => ({
        id: 'sent-2',
        status: 'queued',
        createdAt: new Date(0).toISOString(),
      }),
      claimEscalation: async () => {
        order.push('claimEscalation');
        return true;
      },
      markEscalated: async () => {
        order.push('markEscalated');
        return true;
      },
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        order.push(`send:${data.idempotency_key}`);
        return { id: 'd' } as never;
      },
      retryDelayMs: 0,
    } as never);
    // The terminal transition comes LAST, only once the send is confirmed.
    expect(order).toEqual([
      'claimEscalation',
      'send:tm:expectation:expectation-1:escalate',
      'markEscalated',
    ]);
  });

  test('an escalation send that throws is replayed by the next tick, exactly once', async () => {
    // THE ROUND-5 FINDING. Marking the row terminal before the send meant a
    // send that threw left a terminal row that listDueExpectations would never
    // select again -- the escalation was lost forever. The intermediate
    // 'escalating' state stays selectable so the tick can finish it.
    const sends: string[] = [];
    const operatorTasks = new Set<string>();
    let status: TmExpectation['status'] = 'failed';
    let failNextSend = true;
    const deps = {
      listDueExpectations: async () =>
        status === 'escalated' ? [] : [{ ...base, retries: 2, max_retries: 2, status }],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      findEffectByIdempotencyKey: async () => ({
        id: 'sent-2',
        status: 'queued',
        createdAt: new Date(0).toISOString(),
      }),
      claimEscalation: async () => {
        status = 'escalating';
        return true;
      },
      markEscalated: async () => {
        status = 'escalated';
        return true;
      },
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context: never, data: { idempotency_key: string }) => {
        sends.push(data.idempotency_key);
        if (failNextSend) {
          failNextSend = false;
          throw new Error('dispatch unavailable');
        }
        // Deterministic key: the dispatch DAL dedupes, so a replay of a send
        // that DID land would reuse the row rather than create a second task.
        operatorTasks.add(data.idempotency_key);
        return { id: 'd' } as never;
      },
      retryDelayMs: 0,
    };

    // Tick 1: claim wins, send throws. The row is left 'escalating', NOT
    // terminal, and no operator task exists yet.
    await expect(checkExpectations(new Date(), deps as never)).rejects.toThrow(
      'dispatch unavailable'
    );
    expect(status).toBe('escalating');
    expect(operatorTasks.size).toBe(0);

    // Tick 2: the row is still selected, the send is replayed under the SAME
    // deterministic key, and only now does the row go terminal.
    await checkExpectations(new Date(), deps as never);
    expect(status).toBe('escalated');
    expect([...operatorTasks]).toEqual(['tm:expectation:expectation-1:escalate']);

    // Tick 3: terminal, so nothing more happens.
    await checkExpectations(new Date(), deps as never);
    expect(sends).toEqual([
      'tm:expectation:expectation-1:escalate',
      'tm:expectation:expectation-1:escalate',
    ]);
    // EXACTLY ONE operator task exists across the whole arc.
    expect(operatorTasks.size).toBe(1);
  });

  test('a replayed escalation does not re-claim, re-fail, or burn a retry', async () => {
    // An 'escalating' row goes straight to the replay: past the deadline check,
    // past redispatch recovery, past markFailed and the give-up branch. Those
    // decisions were already made when the escalation was claimed.
    const calls: string[] = [];
    const escalating: TmExpectation = {
      ...base,
      retries: 2,
      max_retries: 2,
      status: 'escalating',
      // Deliberately NOT yet due: an owed escalation ignores the deadline.
      due_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [escalating],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {
        calls.push('markFailed');
        return true;
      },
      claimEscalation: async () => {
        calls.push('claimEscalation');
        return true;
      },
      claimRedispatchAttempt: async () => {
        calls.push('claimRedispatchAttempt');
        return 3;
      },
      claimRecoveryReplay: async () => {
        calls.push('claimRecoveryReplay');
        return true;
      },
      markEscalated: async () => {
        calls.push('markEscalated');
        return true;
      },
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        calls.push(`send:${data.idempotency_key}`);
        return { id: 'd' } as never;
      },
      retryDelayMs: 0,
    } as never);
    // No re-claim, no markFailed, no retry burned -- just the replay and the
    // terminal confirm.
    expect(calls).toEqual(['send:tm:expectation:expectation-1:escalate', 'markEscalated']);
  });

  test('evidence arriving while escalating still closes the row as met', async () => {
    // An escalation being owed does not override real evidence: if the work
    // succeeded after all, met wins and no blocker is sent.
    const calls: string[] = [];
    // The fake honours the REAL DAL transition rule rather than returning true
    // unconditionally. An always-true markMet stub is what let this test pass
    // while the DAL underneath refused escalating -> met; the doubles must
    // model the constraint they stand in for.
    const ACTIVE_OR_ESCALATING = ['pending', 'failed', 'escalating'];
    let status: TmExpectation['status'] = 'escalating';
    let row: TmExpectation = { ...base, retries: 2, max_retries: 2, status };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [row],
      checkEvidence: async () => ({ ok: true, pointer: 'https://example/proof' }),
      markMet: async () => {
        calls.push('markMet');
        if (!ACTIVE_OR_ESCALATING.includes(status)) return false;
        status = 'met';
        row = { ...row, status };
        return true;
      },
      claimEscalation: async () => {
        calls.push('claimEscalation');
        return true;
      },
      markEscalated: async () => {
        calls.push('markEscalated');
        return true;
      },
      createTask: async (_context, data) => {
        calls.push(`send:${data.idempotency_key}`);
        return { id: 'd' } as never;
      },
      retryDelayMs: 0,
    } as never);
    // The close succeeds and nothing else runs: no escalation claim, no
    // pending-escalation replay send, no terminal escalate.
    expect(calls).toEqual(['markMet']);
    expect(status).toBe('met');
  });

  test('recovery advances the deadline, so a tick inside the interval does nothing', async () => {
    // Recovery only runs after due_at has elapsed. If the replay does not move
    // the deadline, the next tick instantly judges the recovered dispatch a
    // failure and burns another retry or escalates, never granting the
    // configured response interval.
    const RESPONSE_INTERVAL_MS = 15 * 60 * 1000;
    const t0 = new Date('2026-09-08T00:00:00.000Z');
    const keys: string[] = [];
    const claims: string[] = [];
    // due_at already elapsed; attempt 1 claimed but never sent.
    let row: TmExpectation = {
      ...base,
      retries: 1,
      max_retries: 2,
      status: 'failed',
      due_at: new Date(t0.getTime() - 1000).toISOString(),
    };
    const sentKeys = new Set<string>();
    const deps = {
      listDueExpectations: async () => [row],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {
        claims.push('markFailed');
        return true;
      },
      claimEscalation: async () => true,
      markEscalated: async () => {
        claims.push('markEscalated');
        return true;
      },
      findEffectByIdempotencyKey: async (key: string) =>
        sentKeys.has(key)
          ? { id: 'sent', status: 'queued', createdAt: new Date(0).toISOString() }
          : null,
      claimRecoveryReplay: async (_id: string, _expected: number, dueAt: string) => {
        claims.push('claimRecoveryReplay');
        row = { ...row, due_at: dueAt };
        return true;
      },
      claimRedispatchAttempt: async () => {
        claims.push('claimRedispatchAttempt');
        return 2;
      },
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context: never, data: { idempotency_key: string }) => {
        keys.push(data.idempotency_key);
        sentKeys.add(data.idempotency_key);
        return { id: 'd' } as never;
      },
      retryDelayMs: RESPONSE_INTERVAL_MS,
    };

    // Tick 1: recovers the unsent attempt and moves the deadline forward.
    await checkExpectations(t0, deps as never);
    expect(keys).toEqual(['tm:expectation:expectation-1:retry:1']);
    expect(claims).toEqual(['claimRecoveryReplay']);
    expect(Date.parse(row.due_at)).toBe(t0.getTime() + RESPONSE_INTERVAL_MS);

    // Tick 2, INSIDE the response interval: does nothing at all. No retry
    // burned, no escalation, no send. Fails on the old behaviour, where the
    // stale elapsed deadline made this tick act immediately.
    await checkExpectations(new Date(t0.getTime() + 60_000), deps as never);
    expect(keys).toEqual(['tm:expectation:expectation-1:retry:1']);
    expect(claims).toEqual(['claimRecoveryReplay']);

    // Tick 3, AFTER the interval with evidence still absent: now it acts.
    await checkExpectations(new Date(t0.getTime() + RESPONSE_INTERVAL_MS + 1000), deps as never);
    expect(claims).toContain('markFailed');
    expect(keys).toContain('tm:expectation:expectation-1:retry:2');
  });

  test('a tick that loses the recovery claim replays nothing', async () => {
    const keys: string[] = [];
    const crashed: TmExpectation = { ...base, retries: 1, status: 'failed' };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [crashed],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      findEffectByIdempotencyKey: async () => null,
      // A concurrent tick already recovered this attempt (or marked it met).
      claimRecoveryReplay: async () => false,
      markFailed: async () => {
        throw new Error('markFailed must not run when the recovery claim is lost');
      },
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      retryDelayMs: 0,
    } as never);
    expect(keys).toEqual([]);
  });

  test('once the last attempt is confirmed sent and evidence stays absent, it escalates', async () => {
    // The tick after the recovery above: attempt 2 now HAS a dispatch row, the
    // retry budget is spent, so the expectation escalates to a human.
    const keys: string[] = [];
    const escalations: string[] = [];
    const exhausted: TmExpectation = { ...base, retries: 2, max_retries: 2, status: 'failed' };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [exhausted],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      claimEscalation: async () => true,
      markEscalated: async () => {
        escalations.push('escalated');
        return true;
      },
      findEffectByIdempotencyKey: async () => ({
        id: 'sent-2',
        status: 'queued',
        createdAt: new Date(0).toISOString(),
      }),
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      claimRedispatchAttempt: async () => null,
      retryDelayMs: 0,
    } as never);
    // No retry send; one operator escalation on the deterministic escalate key.
    expect(keys).toEqual(['tm:expectation:expectation-1:escalate']);
    expect(escalations).toEqual(['escalated']);
  });

  test('recovery then escalation across two ticks sends the last attempt exactly once', async () => {
    // The full arc, driven end to end: crash on the final attempt -> tick A
    // replays it and moves the deadline -> tick B, AFTER the response interval
    // with evidence still absent, escalates. The recipient gets its configured
    // window before the blocker is raised.
    const RESPONSE_INTERVAL_MS = 15 * 60 * 1000;
    const t0 = new Date('2026-09-08T00:00:00.000Z');
    const keys: string[] = [];
    const escalations: string[] = [];
    const sentKeys = new Set<string>();
    let row: TmExpectation = {
      ...base,
      retries: 2,
      max_retries: 2,
      status: 'failed',
      due_at: new Date(t0.getTime() - 1000).toISOString(),
    };
    const deps = {
      listDueExpectations: async () => [row],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      claimEscalation: async () => true,
      markEscalated: async () => {
        escalations.push('escalated');
        return true;
      },
      findEffectByIdempotencyKey: async (key: string) =>
        sentKeys.has(key)
          ? { id: 'sent', status: 'queued', createdAt: new Date(0).toISOString() }
          : null,
      claimRecoveryReplay: async (_id: string, _expected: number, dueAt: string) => {
        row = { ...row, due_at: dueAt };
        return true;
      },
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context: never, data: { idempotency_key: string }) => {
        keys.push(data.idempotency_key);
        sentKeys.add(data.idempotency_key);
        return { id: 'd' } as never;
      },
      claimRedispatchAttempt: async () => null,
      retryDelayMs: RESPONSE_INTERVAL_MS,
    };
    // Tick A: recover the unsent final attempt, deadline moves forward.
    await checkExpectations(t0, deps as never);
    expect(keys).toEqual(['tm:expectation:expectation-1:retry:2']);
    expect(escalations).toEqual([]);

    // A tick inside the interval must do nothing -- no escalation yet.
    await checkExpectations(new Date(t0.getTime() + 60_000), deps as never);
    expect(keys).toEqual(['tm:expectation:expectation-1:retry:2']);
    expect(escalations).toEqual([]);

    // Tick B, past the interval: evidence still absent, so escalate.
    await checkExpectations(new Date(t0.getTime() + RESPONSE_INTERVAL_MS + 1000), deps as never);
    expect(keys).toEqual([
      'tm:expectation:expectation-1:retry:2',
      'tm:expectation:expectation-1:escalate',
    ]);
    // Exactly one send of the final attempt across every tick.
    expect(keys.filter(key => key === 'tm:expectation:expectation-1:retry:2')).toHaveLength(1);
    expect(escalations).toEqual(['escalated']);
  });

  test('a replay failure leaves the attempt recoverable rather than stranded', async () => {
    // If the replay send throws, the attempt stays claimed-but-unsent, which is
    // exactly the state the next tick's recovery step is built to finish. No
    // new attempt is bought and nothing is escalated.
    const claims: number[] = [];
    const crashed: TmExpectation = { ...base, retries: 1, status: 'failed' };
    await expect(
      checkExpectations(new Date(), {
        listDueExpectations: async () => [crashed],
        checkEvidence: async () => ({ ok: false, pointer: null }),
        findEffectByIdempotencyKey: async () => null,
        claimRecoveryReplay: async () => true,
        getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
        createTask: async () => {
          throw new Error('dispatch unavailable');
        },
        claimRedispatchAttempt: async () => {
          claims.push(1);
          return 2;
        },
        retryDelayMs: 0,
      } as never)
    ).rejects.toThrow('dispatch unavailable');
    expect(claims).toEqual([]);
  });

  test('a capped evidence probe does nothing this tick and leaves the row untouched', async () => {
    // The supervisor half of the cap fix: an UNKNOWN probe must not be treated
    // as absence. No markFailed, no redispatch, no escalation, no close -- the
    // row stays exactly as it was and the deadline is re-judged next tick.
    const calls: string[] = [];
    const keys: string[] = [];
    const row: TmExpectation = { ...base, retries: 1, max_retries: 2, status: 'failed' };
    const snapshot = { ...row };
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [row],
      checkEvidence: async () => {
        throw new EvidenceProbeCapped('x/y', 7, 20);
      },
      markMet: async () => {
        calls.push('markMet');
        return true;
      },
      markFailed: async () => {
        calls.push('markFailed');
        return true;
      },
      markGivenUp: async () => {
        calls.push('markGivenUp');
        return true;
      },
      claimEscalation: async () => {
        calls.push('claimEscalation');
        return true;
      },
      markEscalated: async () => {
        calls.push('markEscalated');
        return true;
      },
      claimRedispatchAttempt: async () => {
        calls.push('claimRedispatchAttempt');
        return 2;
      },
      claimRecoveryReplay: async () => {
        calls.push('claimRecoveryReplay');
        return true;
      },
      findEffectByIdempotencyKey: async () => null,
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      retryDelayMs: 0,
    } as never);
    // Nothing was attempted at all -- not even a state transition.
    expect(calls).toEqual([]);
    // Nothing was put on the wire: no redispatch, no operator blocker.
    expect(keys).toEqual([]);
    // The row is byte-for-byte what it was.
    expect(row).toEqual(snapshot);
  });

  test('an unreadable recovery probe does not blind-replay', async () => {
    // Unknown is not absent: if the existence probe throws, replaying could
    // double-send. The tick leaves the row active and retries next time.
    const keys: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [{ ...base, retries: 1 }],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {
        throw new Error('markFailed must not run when the probe is unreadable');
      },
      findEffectByIdempotencyKey: async () => {
        throw new Error('database unavailable');
      },
      getMessage: async () => ({ id: 'original', correlation_id: 'c1' }) as never,
      createTask: async (_context, data) => {
        keys.push(data.idempotency_key);
        return { id: 'd' } as never;
      },
      claimRedispatchAttempt: async () => 2,
      retryDelayMs: 0,
    } as never);
    expect(keys).toEqual([]);
  });
});

describe('escalation reaches a human (bdc-xo#2007)', () => {
  // THE DEFECT: on 2026-09-11 both expectations that had ever escalated
  // (46f94406, faa69079) sent a blocker to recipient 'operator', and it was
  // auto-acknowledged and auto-addressed inside two seconds. Measured on the
  // live database that day: operator had 3,535 messages and 9 unaddressed,
  // 258 of them addressed under five seconds; 'xo' had 1,089 messages, 153
  // unaddressed, and ZERO addressed under five seconds. 'operator' is also
  // structurally ineligible for the Telegram and SMS legs, which
  // claimDispatchEscalation gates on recipient = 'xo'.
  const escalating = {
    ...base,
    id: 'exp-escalate',
    on_absence: 'escalate' as const,
    max_retries: 0,
    due_at: new Date(0).toISOString(),
  };

  test('escalates to xo, not operator', async () => {
    const sent: { recipient: string; priority: string; body: string }[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [escalating],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      claimEscalation: async () => true,
      markEscalated: async () => true,
      createTask: async (_context, data) => {
        sent.push({
          recipient: data.recipient,
          priority: data.priority as string,
          body: data.body,
        });
        return { id: 'd' } as never;
      },
    } as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.recipient).toBe('xo');
    expect(sent[0]?.priority).toBe('blocker');
  });

  test('escalation body is readable without opening the database', async () => {
    const sent: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [
        {
          ...escalating,
          recipient: 'fable-cursor',
          registered_by: 'xo',
          evidence_json: JSON.stringify({
            kind: 'pr_opened',
            repo: 'thinmansoftware/fuelglass',
          }),
        },
      ],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      claimEscalation: async () => true,
      markEscalated: async () => true,
      createTask: async (_context, data) => {
        sent.push(data.body);
        return { id: 'd' } as never;
      },
    } as never);
    const body = sent[0] ?? '';
    // The four things that decide what a human does next.
    expect(body).toContain('an open PR in thinmansoftware/fuelglass');
    expect(body).toContain('fable-cursor');
    expect(body).toContain('Registered by:  xo');
    expect(body).toContain('exp-escalate');
    // NOT a JSON column dump, which is what it used to be.
    expect(body).not.toContain('evidence_json');
  });

  test('a self-supervised escalation says so in the body', async () => {
    const sent: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [
        { ...escalating, registered_by: 'grok', recipient: 'grok', self_supervised: 1 },
      ],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => true,
      claimEscalation: async () => true,
      markEscalated: async () => true,
      createTask: async (_context, data) => {
        sent.push(data.body);
        return { id: 'd' } as never;
      },
    } as never);
    expect(sent[0]).toContain('SELF-SUPERVISED');
  });

  test('every evidence kind renders a phrase, never [object Object]', () => {
    const specs: EvidenceSpec[] = [
      { kind: 'issue_comment_exists', repo: 'a/b', number: 7, author: 'xo', marker: 'DONE' },
      { kind: 'label_present', repo: 'a/b', number: 7, label: 'status:review' },
      { kind: 'pr_opened', repo: 'a/b', head_branch: 'feat/x' },
      { kind: 'lease_holder_is', name: 'xo-main' },
      { kind: 'dispatch_reply_exists', correlation_id: 'c1', classification: 'succeeded' },
      { kind: 'db_row_exists', table: 'runs', where: { id: 'r1' } },
    ];
    for (const spec of specs) {
      const body = renderEscalationBody({ ...base, evidence_json: JSON.stringify(spec) });
      expect(body).not.toContain('[object Object]');
      expect(body).not.toContain('undefined');
      // The kind name itself is a schema token, not a phrase; the renderer must
      // say what the proof IS, so the raw kind must not leak into the line.
      const line = body.split('\n').find(l => l.startsWith('Expected proof:')) ?? '';
      expect(line).not.toContain(spec.kind);
      expect(line.length).toBeGreaterThan('Expected proof: '.length + 5);
    }
  });

  test('an unparseable evidence spec still escalates', () => {
    // An escalation is the last line of defence; a malformed spec must not be
    // the thing that swallows it.
    const body = renderEscalationBody({ ...base, evidence_json: 'not json' });
    expect(body).toContain('unparseable evidence spec');
    expect(body).toContain('EXHAUSTED');
  });
});
