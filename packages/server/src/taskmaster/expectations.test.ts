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
});

describe('expectation supervisor', () => {
  test('expectation_absent_evidence_fails_and_acts', async () => {
    const calls: string[] = [];
    const keys: string[] = [];
    await checkExpectations(new Date(), {
      listDueExpectations: async () => [base],
      checkEvidence: async () => ({ ok: false, pointer: null }),
      markFailed: async () => {
        calls.push('failed');
      },
      incrementRetry: async () => {
        calls.push('retry');
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
      incrementRetry: async () => {
        row = {
          ...row,
          retries: row.retries + 1,
          due_at: new Date(0).toISOString(),
          status: 'failed',
        };
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
    expect(sends.filter(key => key.includes(':retry:'))).toHaveLength(2);
    expect(sends.filter(key => key.endsWith(':escalate'))).toHaveLength(1);
  });
});
