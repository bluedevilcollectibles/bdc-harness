import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { join } from 'path';
import {
  appendDeliveryReceipt,
  appendOperatorCard,
  claimDueDeliveryJob,
  closeDatabase,
  completeDeliveryJob,
  getOperatorCard,
  listMessages,
  resetDatabase,
} from '@archon/core/db';
import {
  buildOperatorCard,
  canonicalizeActionableEvent,
  deriveOperatorCardId,
  type ActionableEventIdentity,
} from '../operator-card';
import {
  createDefaultOperatorCardChannels,
  runDueOperatorCardDeliveries,
  type OperatorCardChannel,
} from '../escalation-delivery';
import { lookupNotionPageId, runEscalation } from '../escalate';

const identity: ActionableEventIdentity = {
  identity_version: 'overseer-actionable-event-v1',
  source_event_id: 'event-123',
  run_id: 'run-123',
  wo_id: 'WO-TEST-123',
  event_type: 'node_failed',
  step_name: 'verify',
  event_created_at: '2026-07-16T08:00:00.000Z',
  error_class: 'validator_rejected',
};

describe('operator card identity', () => {
  test('canonicalizes the exact frozen identity key order and derives lowercase sha256', () => {
    const canonical = canonicalizeActionableEvent(identity);

    expect(canonical).toBe(
      '{"identity_version":"overseer-actionable-event-v1","source_event_id":"event-123","run_id":"run-123","wo_id":"WO-TEST-123","event_type":"node_failed","step_name":"verify","event_created_at":"2026-07-16T08:00:00.000Z","error_class":"validator_rejected"}'
    );
    expect(deriveOperatorCardId(identity)).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex')
    );
  });

  test('rejects a missing stable source event id', () => {
    expect(() =>
      deriveOperatorCardId({
        ...identity,
        source_event_id: '',
      })
    ).toThrow('operator_card_identity_invalid:source_event_id');
  });

  test('builds a deterministic full payload digest independent of nested object key order', () => {
    const first = buildOperatorCard(identity, {
      repository: 'thinmansoftware/bdc-harness',
      branch: 'feat/example',
      pr_url: null,
      pr_number: null,
      head_sha: null,
      base_branch: 'dev',
      base_sha: 'a'.repeat(40),
      checks: { failed: 1, total: 2 },
      mergeability: 'unknown',
      blocker: 'validator rejected',
      mechanical_evidence: { z: 2, a: 1 },
      recovery_attempted: { attempted: false },
      proposed_remediation: { steps: ['review validator output'] },
      next_permitted_action: 'await operator ruling',
      responsible_actor: 'acting-xo',
      actionable_event_at: identity.event_created_at,
      required_ruling: 'approve repair',
      evidence_links: { run: '/runs/run-123' },
      lifecycle_classification: 'recovery',
      governance_classification: 'non-production',
    });
    const second = buildOperatorCard(identity, {
      ...first.payload,
      checks: { total: 2, failed: 1 },
      mechanical_evidence: { a: 1, z: 2 },
    });

    expect(first.card_id).toMatch(/^[0-9a-f]{64}$/);
    expect(first.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.card_id).toBe(first.card_id);
    expect(second.payload_digest).toBe(first.payload_digest);
    expect(second.payload).toEqual(first.payload);
  });
});

describe('durable operator-card delivery', () => {
  let home = '';
  const oldHome = process.env.ARCHON_HOME;
  const oldUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(
      import.meta.dir,
      `.test-escalation-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (oldHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldHome;
    if (oldUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldUrl;
    removeTempDirWithRetry(home);
  });

  async function persistCard(): Promise<string> {
    const built = buildOperatorCard(identity, {
      repository: 'thinmansoftware/bdc-harness',
      branch: 'feat/example',
      pr_url: null,
      pr_number: null,
      head_sha: null,
      base_branch: 'dev',
      base_sha: 'a'.repeat(40),
      checks: { failed: 1, total: 1 },
      mergeability: 'unknown',
      blocker: 'validator rejected',
      mechanical_evidence: { source: 'deterministic-test' },
      recovery_attempted: { attempted: false },
      proposed_remediation: { steps: ['review'] },
      next_permitted_action: 'await operator ruling',
      responsible_actor: 'acting-xo',
      actionable_event_at: identity.event_created_at,
      required_ruling: 'approve repair',
      evidence_links: { run: '/runs/run-123' },
      lifecycle_classification: 'recovery',
      governance_classification: 'non-production',
    });
    await appendOperatorCard({
      ...built,
      ...built.payload,
      run_id: identity.run_id,
      wo_id: identity.wo_id,
      created_at: identity.event_created_at,
    });
    return built.card_id;
  }

  test('survives restart and succeeds only on the fixed third attempt', async () => {
    const cardId = await persistCard();
    const calls: string[] = [];
    const channels: OperatorCardChannel[] = ['builder_monitor', 'dispatch', 'notion'].map(
      channel => ({
        channel: channel as OperatorCardChannel['channel'],
        deliver: async (_card, key) => {
          calls.push(`${channel}:${key}`);
          if (
            channel === 'dispatch' &&
            calls.filter(value => value.startsWith('dispatch:')).length < 3
          ) {
            return { outcome: 'transient_failure' as const, sanitized_status: 'retryable' };
          }
          return { outcome: 'succeeded' as const, sanitized_status: 'delivered' };
        },
        reconcile: async () => ({ outcome: 'indeterminate', sanitized_status: 'unknown' }),
      })
    );

    await runDueOperatorCardDeliveries({
      channels,
      owner: 'runner-1',
      now: '2026-07-16T08:00:00.000Z',
    });
    await closeDatabase();
    resetDatabase();
    await runDueOperatorCardDeliveries({
      channels,
      owner: 'runner-2',
      now: '2026-07-16T08:00:30.000Z',
    });
    await runDueOperatorCardDeliveries({
      channels,
      owner: 'runner-2',
      now: '2026-07-16T08:02:00.000Z',
    });
    await runDueOperatorCardDeliveries({
      channels,
      owner: 'runner-2',
      now: '2026-07-16T09:00:00.000Z',
    });

    const view = await getOperatorCard(cardId);
    expect(calls.filter(value => value.startsWith('dispatch:'))).toHaveLength(3);
    expect(view?.delivery_summary.dispatch.state).toBe('succeeded');
    expect(view?.receipts.filter(receipt => receipt.channel === 'dispatch')).toHaveLength(6);
    expect(
      view?.receipts.map(receipt => receipt.phase).filter(phase => phase === 'started')
    ).toHaveLength(5);
  });

  test('reconciles an expired STARTED attempt to indeterminate without blind delivery', async () => {
    const cardId = await persistCard();
    const job = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'crashed-runner',
      now: '2026-07-16T08:00:00.000Z',
      lease_duration_ms: 1_000,
    });
    expect(job).not.toBeNull();
    await appendDeliveryReceipt({
      card_id: cardId,
      channel: 'dispatch',
      attempt_number: 1,
      phase: 'started',
      started_at: '2026-07-16T08:00:00.000Z',
      fencing_token: job!.fencing_token,
      lease_owner: 'crashed-runner',
    });
    let deliverCalls = 0;
    let reconcileCalls = 0;
    const channel: OperatorCardChannel = {
      channel: 'dispatch',
      deliver: async () => {
        deliverCalls += 1;
        return { outcome: 'succeeded', sanitized_status: 'unexpected' };
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return { outcome: 'indeterminate', sanitized_status: 'provider_state_unknown' };
      },
    };

    const store = {
      claimDueDeliveryJob: input => claimDueDeliveryJob({ ...input, channel: 'dispatch' }),
      getOperatorCard,
      appendDeliveryReceipt,
      completeDeliveryJob,
    };
    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'recovery-runner',
      now: '2026-07-16T08:00:02.000Z',
      store,
    });
    const view = await getOperatorCard(cardId);
    expect(deliverCalls).toBe(0);
    expect(reconcileCalls).toBe(1);
    expect(view?.delivery_summary.dispatch.state).toBe('indeterminate');
    expect(view?.receipts.at(-1)?.outcome).toBe('indeterminate');
  });

  test('reclaims an expired third attempt and reconciles without a fourth provider call', async () => {
    const cardId = await persistCard();
    let deliverCalls = 0;
    let reconcileCalls = 0;
    const channel: OperatorCardChannel = {
      channel: 'dispatch',
      deliver: async () => {
        deliverCalls += 1;
        return { outcome: 'transient_failure', sanitized_status: 'retry_safe' };
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return { outcome: 'indeterminate', sanitized_status: 'provider_state_unknown' };
      },
    };
    const claimDispatch = (input: Parameters<typeof claimDueDeliveryJob>[0]) =>
      claimDueDeliveryJob({ ...input, channel: 'dispatch' });
    const store = {
      claimDueDeliveryJob: claimDispatch,
      getOperatorCard,
      appendDeliveryReceipt,
      completeDeliveryJob,
    };

    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'runner-1',
      now: '2026-07-16T08:00:00.000Z',
      store,
    });
    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'runner-2',
      now: '2026-07-16T08:00:30.000Z',
      store,
    });
    const crashed = await claimDispatch({
      owner: 'runner-3-crashed',
      now: '2026-07-16T08:02:00.000Z',
      lease_duration_ms: 1_000,
    });
    expect(crashed?.attempts_started).toBe(3);
    await appendDeliveryReceipt({
      card_id: cardId,
      channel: 'dispatch',
      attempt_number: 3,
      phase: 'started',
      started_at: '2026-07-16T08:02:00.000Z',
      fencing_token: crashed!.fencing_token,
      lease_owner: 'runner-3-crashed',
    });

    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'recovery-runner',
      now: '2026-07-16T08:02:02.000Z',
      store,
    });

    const view = await getOperatorCard(cardId);
    expect(deliverCalls).toBe(2);
    expect(reconcileCalls).toBe(1);
    expect(view?.delivery_summary.dispatch.state).toBe('indeterminate');
    expect(view?.delivery_summary.dispatch.attempts_started).toBe(3);
    expect(view?.receipts.filter(receipt => receipt.phase === 'started')).toHaveLength(3);
  });

  test('finishes an expired lease from its existing TERMINAL receipt without redelivery', async () => {
    const cardId = await persistCard();
    let deliveries = 0;
    let reconciliations = 0;
    const channel: OperatorCardChannel = {
      channel: 'dispatch',
      deliver: async () => {
        deliveries += 1;
        return { outcome: 'succeeded', sanitized_status: 'queued' };
      },
      reconcile: async () => {
        reconciliations += 1;
        return { outcome: 'indeterminate', sanitized_status: 'unexpected' };
      },
    };
    const claimDispatch = (input: Parameters<typeof claimDueDeliveryJob>[0]) =>
      claimDueDeliveryJob({ ...input, channel: 'dispatch' });
    const crashAfterTerminal = {
      claimDueDeliveryJob: claimDispatch,
      getOperatorCard,
      appendDeliveryReceipt,
      completeDeliveryJob: async () => {
        throw new Error('simulated_crash_after_terminal_receipt');
      },
    };
    await expect(
      runDueOperatorCardDeliveries({
        channels: [channel],
        owner: 'runner-before-crash',
        now: '2026-07-16T08:00:00.000Z',
        store: crashAfterTerminal,
      })
    ).rejects.toThrow('simulated_crash_after_terminal_receipt');

    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'runner-after-restart',
      now: '2026-07-16T08:01:01.000Z',
      store: {
        claimDueDeliveryJob: claimDispatch,
        getOperatorCard,
        appendDeliveryReceipt,
        completeDeliveryJob,
      },
    });
    const view = await getOperatorCard(cardId);
    expect(deliveries).toBe(1);
    expect(reconciliations).toBe(0);
    expect(view?.delivery_summary.dispatch.state).toBe('succeeded');
    expect(view?.receipts.filter(receipt => receipt.channel === 'dispatch')).toHaveLength(2);
  });

  test('treats a thrown response-loss transport as indeterminate and never retries', async () => {
    const cardId = await persistCard();
    let calls = 0;
    const channel: OperatorCardChannel = {
      channel: 'dispatch',
      deliver: async () => {
        calls += 1;
        throw new Error('response_lost_after_post');
      },
      reconcile: async () => ({
        outcome: 'indeterminate',
        sanitized_status: 'provider_state_unknown',
      }),
    };
    const claimDispatch = (input: Parameters<typeof claimDueDeliveryJob>[0]) =>
      claimDueDeliveryJob({ ...input, channel: 'dispatch' });
    const store = {
      claimDueDeliveryJob: claimDispatch,
      getOperatorCard,
      appendDeliveryReceipt,
      completeDeliveryJob,
    };

    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'response-loss-runner',
      now: '2026-07-16T08:00:00.000Z',
      store,
    });
    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'response-loss-runner',
      now: '2026-07-16T09:00:00.000Z',
      store,
    });
    const view = await getOperatorCard(cardId);
    expect(calls).toBe(1);
    expect(view?.delivery_summary.dispatch.state).toBe('indeterminate');
    expect(view?.delivery_summary.dispatch.attempts_started).toBe(1);
    expect(view?.receipts.at(-1)?.outcome).toBe('indeterminate');
    expect(view?.receipts.at(-1)?.next_attempt_at).toBeNull();
  });

  test('uses card persistence time as retry epoch for an hours-old source event', async () => {
    const sourceTime = '2026-07-15T00:00:00.000Z';
    const card = await runEscalation(
      'run-old-event',
      { decision: 'escalate', reason: 'old actionable event' },
      {
        errorClass: 'validator_rejected',
        woId: 'WO-OLD-EVENT-01',
        repository: 'thinmansoftware/bdc-harness',
      },
      {
        sourceEventId: 'event-old-1',
        eventType: 'node_failed',
        stepName: 'verify',
        eventCreatedAt: sourceTime,
      }
    );
    const view = await getOperatorCard(card.card_id);
    expect(card.actionable_event_at).toBe(sourceTime);
    expect(card.created_at).not.toBe(sourceTime);
    expect(view?.jobs.every(job => job.next_attempt_at === card.created_at)).toBe(true);
    expect(
      await claimDueDeliveryJob({
        channel: 'dispatch',
        owner: 'too-early-runner',
        now: '2026-07-15T01:00:00.000Z',
      })
    ).toBeNull();
    const attempt1 = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'epoch-runner',
      now: card.created_at,
    });
    expect(attempt1?.attempts_started).toBe(1);
    if (!attempt1) throw new Error('attempt_1_not_claimed');
    await completeDeliveryJob({
      card_id: card.card_id,
      channel: 'dispatch',
      owner: 'epoch-runner',
      fencing_token: attempt1.fencing_token,
      outcome: 'transient_failure',
      now: card.created_at,
    });
    const plus = (milliseconds: number) =>
      new Date(new Date(card.created_at).getTime() + milliseconds).toISOString();
    expect(
      await claimDueDeliveryJob({
        channel: 'dispatch',
        owner: 'epoch-runner',
        now: plus(29_999),
      })
    ).toBeNull();
    const attempt2 = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'epoch-runner',
      now: plus(30_000),
    });
    expect(attempt2?.attempts_started).toBe(2);
    if (!attempt2) throw new Error('attempt_2_not_claimed');
    await completeDeliveryJob({
      card_id: card.card_id,
      channel: 'dispatch',
      owner: 'epoch-runner',
      fencing_token: attempt2.fencing_token,
      outcome: 'transient_failure',
      now: plus(30_000),
    });
    expect(
      await claimDueDeliveryJob({
        channel: 'dispatch',
        owner: 'epoch-runner',
        now: plus(119_999),
      })
    ).toBeNull();
    const attempt3 = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'epoch-runner',
      now: plus(120_000),
    });
    expect(attempt3?.attempts_started).toBe(3);
  });
});

describe('Notion WO lookup', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('queries separate candidates in frozen order and returns first success', async () => {
    const queried: string[] = [];
    globalThis.fetch = mock(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { filter: { property: string } };
      queried.push(body.filter.property);
      if (body.filter.property === 'Name') {
        return Response.json({ results: [{ id: 'page-1' }] });
      }
      return new Response('unknown property', { status: 400 });
    }) as typeof fetch;

    expect(await lookupNotionPageId('test-key', 'db-1', 'WO-1')).toBe('page-1');
    expect(queried).toEqual(['Task', 'WO ID', 'Name']);
  });

  test('resolves on the "Task" title property as the first candidate', async () => {
    const queried: string[] = [];
    globalThis.fetch = mock(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { filter: { property: string } };
      queried.push(body.filter.property);
      if (body.filter.property === 'Task') {
        return Response.json({ results: [{ id: 'task-page' }] });
      }
      return new Response('unknown property', { status: 400 });
    }) as typeof fetch;

    expect(await lookupNotionPageId('test-key', 'db-1', 'WO-1')).toBe('task-page');
    expect(queried).toEqual(['Task']);
  });

  test('fails soft after all candidate queries fail', async () => {
    const queried: string[] = [];
    globalThis.fetch = mock(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { filter: { property: string } };
      queried.push(body.filter.property);
      return new Response('unknown property', { status: 400 });
    }) as typeof fetch;

    expect(await lookupNotionPageId('test-key', 'db-1', 'WO-1')).toBeNull();
    expect(queried).toEqual(['Task', 'WO ID', 'Name', 'Title', 'WO_ID']);
  });
});

describe('default informational channel adapters', () => {
  let home = '';
  const oldHome = process.env.ARCHON_HOME;
  const oldUrl = process.env.DATABASE_URL;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.test-default-channels-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
    globalThis.fetch = mock(async () => {
      throw new Error('poison_global_network');
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await closeDatabase();
    resetDatabase();
    if (oldHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldHome;
    if (oldUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldUrl;
    removeTempDirWithRetry(home);
  });

  async function defaultCardView() {
    const built = buildOperatorCard(identity, {
      repository: 'thinmansoftware/bdc-harness',
      branch: 'feat/example',
      pr_url: null,
      pr_number: null,
      head_sha: null,
      base_branch: 'dev',
      base_sha: null,
      checks: {},
      mergeability: 'unknown',
      blocker: 'validator rejected',
      mechanical_evidence: {},
      recovery_attempted: {},
      proposed_remediation: {},
      next_permitted_action: 'await operator ruling',
      responsible_actor: 'acting-xo',
      actionable_event_at: identity.event_created_at,
      required_ruling: null,
      evidence_links: {},
      lifecycle_classification: 'recovery',
      governance_classification: 'information-only',
    });
    await appendOperatorCard({
      ...built,
      canonical_event_identity: { ...built.canonical_event_identity },
      payload: { ...built.payload },
      ...built.payload,
      run_id: identity.run_id,
      wo_id: identity.wo_id,
    });
    const view = await getOperatorCard(built.card_id);
    if (!view) throw new Error('default_channel_card_missing');
    return view;
  }

  test('default Dispatch adapter routes a guarded run report to the resolved owner', async () => {
    const view = await defaultCardView();
    const dispatch = createDefaultOperatorCardChannels({
      fetch: globalThis.fetch,
      resolve_owner: mock(async () => 'Grok'),
    }).find(channel => channel.channel === 'dispatch');
    if (!dispatch) throw new Error('dispatch_channel_missing');
    const result = await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
    const messages = await listMessages({ recipient: 'Grok' });
    expect(result.outcome).toBe('succeeded');
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]?.body ?? '{}')).toMatchObject({
      card_id: view.card.card_id,
      payload_digest: view.card.payload_digest,
    });
  });

  test('default Dispatch adapter falls back to operator when owner resolution returns null', async () => {
    const view = await defaultCardView();
    const dispatch = createDefaultOperatorCardChannels({
      fetch: globalThis.fetch,
      resolve_owner: mock(async () => null),
    }).find(channel => channel.channel === 'dispatch');
    if (!dispatch) throw new Error('dispatch_channel_missing');
    await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
    expect(await listMessages({ recipient: 'operator' })).toHaveLength(1);
  });

  test('default builder-monitor adapter uses injected fetch and frozen payload', async () => {
    const view = await defaultCardView();
    const calls: Array<{ url: string; body: unknown }> = [];
    const injected = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const builder = createDefaultOperatorCardChannels({
      fetch: injected,
      builder_monitor_url: 'https://monitor.test/status',
    }).find(channel => channel.channel === 'builder_monitor');
    if (!builder) throw new Error('builder_channel_missing');
    const result = await builder.deliver(view, 'unused');
    expect(result.outcome).toBe('succeeded');
    expect(calls).toEqual([
      {
        url: 'https://monitor.test/status',
        body: {
          builder: 'Cauldron',
          wo_id: view.card.wo_id,
          action: 'needs_human',
          detail: view.card.blocker,
          card_id: view.card.card_id,
        },
      },
    ]);
  });

  test('default builder-monitor adapter retries only 429 and treats 5xx as indeterminate', async () => {
    const view = await defaultCardView();
    for (const [status, outcome] of [
      [401, 'permanent_failure'],
      [422, 'permanent_failure'],
      [429, 'transient_failure'],
      [500, 'indeterminate'],
      [503, 'indeterminate'],
    ] as const) {
      const builder = createDefaultOperatorCardChannels({
        fetch: mock(async () => new Response('failure', { status })) as typeof fetch,
      }).find(channel => channel.channel === 'builder_monitor');
      if (!builder) throw new Error('builder_channel_missing');
      expect((await builder.deliver(view, 'unused')).outcome).toBe(outcome);
    }
  });

  test('default Notion adapter uses injected fetch for lookup and comment', async () => {
    const view = await defaultCardView();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const injected = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      return String(input).includes('/query')
        ? Response.json({ results: [{ id: 'notion-page-1' }] })
        : new Response('ok', { status: 200 });
    }) as typeof fetch;
    const notion = createDefaultOperatorCardChannels({
      fetch: injected,
      notion_api_key: 'test-notion-key',
      notion_database_id: 'notion-db-1',
    }).find(channel => channel.channel === 'notion');
    if (!notion) throw new Error('notion_channel_missing');
    const result = await notion.deliver(view, 'unused');
    expect(result.outcome).toBe('succeeded');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toMatchObject({ filter: { property: 'Task' } });
    expect(calls[1]?.body).toMatchObject({ parent: { page_id: 'notion-page-1' } });
  });

  test('default Notion adapter retries only 429 and treats comment 5xx as indeterminate', async () => {
    const view = await defaultCardView();
    for (const [status, outcome] of [
      [401, 'permanent_failure'],
      [422, 'permanent_failure'],
      [429, 'transient_failure'],
      [500, 'indeterminate'],
      [503, 'indeterminate'],
    ] as const) {
      const injected = mock(async (input: string | URL | Request) =>
        String(input).includes('/query')
          ? Response.json({ results: [{ id: 'notion-page-1' }] })
          : new Response('failure', { status })
      ) as typeof fetch;
      const notion = createDefaultOperatorCardChannels({
        fetch: injected,
        notion_api_key: 'test-notion-key',
      }).find(channel => channel.channel === 'notion');
      if (!notion) throw new Error('notion_channel_missing');
      expect((await notion.deliver(view, 'unused')).outcome).toBe(outcome);
    }
  });

  test('default Notion adapter treats exhausted 4xx lookup responses as permanent', async () => {
    const view = await defaultCardView();
    const notion = createDefaultOperatorCardChannels({
      fetch: mock(async () => new Response('unauthorized', { status: 401 })) as typeof fetch,
      notion_api_key: 'test-notion-key',
    }).find(channel => channel.channel === 'notion');
    if (!notion) throw new Error('notion_channel_missing');
    expect((await notion.deliver(view, 'unused')).outcome).toBe('permanent_failure');
  });
});
