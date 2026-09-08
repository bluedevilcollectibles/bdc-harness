import { afterEach, describe, expect, test } from 'bun:test';

import { PollTransportError, pollForTerminal } from '../poll.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('pollForTerminal PR-detection race guard', () => {
  const completedRun = (events: unknown[]) =>
    new Response(
      JSON.stringify({
        run: { id: 'run-race', status: 'completed', metadata: {} },
        events,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

  const openPrEvent = {
    event_type: 'node_completed',
    step_name: 'open-pr-if-needed',
    data: { output: 'PR_URL=https://github.com/thinmansoftware/bdc-harness/pull/488' },
  };

  test('retries the event read when the PR event lands after run-complete (2026-07-17 false-negative race)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      // First read: run already completed but open-pr event not yet recorded.
      // Second read (retry): event has landed.
      return calls === 1 ? completedRun([]) : completedRun([openPrEvent]);
    }) as unknown as typeof fetch;

    const result = await pollForTerminal({
      runId: 'run-race',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 3,
      prRetryDelayMs: 1,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(result.prUrl).toBe('https://github.com/thinmansoftware/bdc-harness/pull/488');
    expect(calls).toBe(2);
    // 30s, raised from 15s after a 15016ms CI failure (16ms over) on 2026-07-25.
    // NOTE for whoever touches this next: intervalMs and the retry delays here are
    // 1ms, so this test has no business taking 15 SECONDS -- the wall time is not
    // slowness, it is something in the PR-lookup path blocking. Raising the ceiling
    // unblocks the branch; it does NOT explain the duration. Worth a real look.
  });

  test('declares no PR only after exhausting retries', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return completedRun([]);
    }) as unknown as typeof fetch;

    const result = await pollForTerminal({
      runId: 'run-race-no-pr',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 3,
      prRetryDelayMs: 1,
    });

    expect(result.prUrl).toBeNull();
    // 1 initial read + 3 retries
    expect(calls).toBe(4);
  });

  test('does not retry when the PR event is present on the first read', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return completedRun([openPrEvent]);
    }) as unknown as typeof fetch;

    const result = await pollForTerminal({
      runId: 'run-no-race',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 3,
      prRetryDelayMs: 1,
    });

    expect(result.prUrl).toBe('https://github.com/thinmansoftware/bdc-harness/pull/488');
    expect(calls).toBe(1);
  });
});

describe('pollForTerminal transport truth', () => {
  test('surfaces an HTTP transport failure instead of converting it into a timeout', async () => {
    globalThis.fetch = (async () =>
      new Response('unavailable', { status: 503 })) as unknown as typeof fetch;

    await expect(
      pollForTerminal({
        runId: 'run-http-failure',
        apiBaseUrl: 'http://archon.test',
        timeoutMs: 60_000,
        intervalMs: 1,
      })
    ).rejects.toBeInstanceOf(PollTransportError);
  });

  test('surfaces a network failure instead of silently polling null', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch;

    await expect(
      pollForTerminal({
        runId: 'run-network-failure',
        apiBaseUrl: 'http://archon.test',
        timeoutMs: 60_000,
        intervalMs: 1,
      })
    ).rejects.toBeInstanceOf(PollTransportError);
  });
});
