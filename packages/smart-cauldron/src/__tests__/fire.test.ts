import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildFireMessage, fireTier } from '../fire.js';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

let originalFetch: typeof globalThis.fetch;
let originalToken: string | undefined;
let fetchCalls: FetchCall[];

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

function codebasesResponse(): Response {
  return Response.json([
    { id: 'cb-shopops', name: 'thinmansoftware/shopops' },
    { id: 'cb-harness', name: 'thinmansoftware/bdc-harness' },
  ]);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalToken = process.env.ARCHON_OPERATOR_TOKEN;
  delete process.env.ARCHON_OPERATOR_TOKEN;
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.ARCHON_OPERATOR_TOKEN;
  } else {
    process.env.ARCHON_OPERATOR_TOKEN = originalToken;
  }
});

describe('fireTier atomic conversation dispatch', () => {
  test('resolves the project and posts one atomic conversation request', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });

      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json({
          conversationId: 'web-parent-123',
          id: 'parent-db-123',
          dispatched: true,
        });
      }
      return Response.json({
        runs: [
          {
            id: 'run-123',
            workflow_name: 'bdc-feature-development',
            parent_conversation_id: 'parent-db-123',
            codebase_id: 'cb-harness',
          },
        ],
      });
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-001',
      project: 'bdc-harness',
      message: buildFireMessage('WO-TEST-001', 'bdc-harness'),
      apiBaseUrl: 'http://archon.test',
      token: 'option-token',
    });

    expect(result).toEqual({
      ok: true,
      runId: 'run-123',
      conversationId: 'web-parent-123',
      infraError: null,
    });
    expect(fetchCalls.map(call => call.url)).toEqual([
      'http://archon.test/api/codebases',
      'http://archon.test/api/conversations',
      'http://archon.test/api/workflows/runs?codebaseId=cb-harness&limit=50',
    ]);

    const atomicRequest = fetchCalls[1];
    expect(atomicRequest?.init?.method).toBe('POST');
    expect(JSON.parse(String(atomicRequest?.init?.body))).toEqual({
      codebaseId: 'cb-harness',
      message: '/workflow run bdc-feature-development WO_ID=WO-TEST-001 --project bdc-harness',
    });
    expect(headerValue(atomicRequest?.init, 'x-archon-operator-token')).toBe('option-token');
  });

  test('rejects a response that does not prove dispatched true', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      return Response.json({
        conversationId: 'web-parent-123',
        id: 'parent-db-123',
        dispatched: false,
        accepted: false,
        error: 'workflow unavailable',
      });
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-002',
      project: 'bdc-harness',
      message: buildFireMessage('WO-TEST-002', 'bdc-harness'),
      apiBaseUrl: 'http://archon.test',
      discoverIntervalMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.runId).toBeNull();
    expect(result.infraError).toContain('dispatched:true');
    expect(fetchCalls).toHaveLength(2);
  });

  test('fails closed when the requested project has no unique codebase binding', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return codebasesResponse();
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-003',
      project: 'missing-project',
      message: buildFireMessage('WO-TEST-003', 'missing-project'),
      apiBaseUrl: 'http://archon.test',
    });

    expect(result.ok).toBe(false);
    expect(result.infraError).toContain('missing-project');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('http://archon.test/api/codebases');
  });

  test('discovers the run from the returned parent conversation id, not a fabricated worker id', async () => {
    let discoveryCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json({
          conversationId: 'web-parent-456',
          id: 'parent-db-456',
          dispatched: true,
        });
      }
      discoveryCount += 1;
      return Response.json({
        runs:
          discoveryCount === 1
            ? []
            : [
                {
                  id: 'run-456',
                  workflow_name: 'bdc-feature-development-codex',
                  parent_conversation_id: 'parent-db-456',
                  codebase_id: 'cb-harness',
                },
              ],
      });
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development-codex',
      woId: 'WO-TEST-004',
      project: 'bdc-harness',
      message: buildFireMessage('WO-TEST-004', 'bdc-harness'),
      apiBaseUrl: 'http://archon.test',
      token: 'option-token',
      discoverTimeoutMs: 100,
      discoverIntervalMs: 0,
    });

    expect(result.runId).toBe('run-456');
    expect(fetchCalls.some(call => call.url.includes('/by-worker/'))).toBe(false);
    expect(
      fetchCalls
        .filter(call => call.url.includes('/api/workflows/runs?'))
        .every(call => headerValue(call.init, 'x-archon-operator-token') === 'option-token')
    ).toBe(true);
  });

  test('uses ARCHON_OPERATOR_TOKEN for every API request', async () => {
    process.env.ARCHON_OPERATOR_TOKEN = 'env-token';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json({
          conversationId: 'web-parent-env',
          id: 'parent-db-env',
          dispatched: true,
        });
      }
      return Response.json({
        runs: [
          {
            id: 'run-env',
            workflow_name: 'bdc-feature-development',
            parent_conversation_id: 'parent-db-env',
            codebase_id: 'cb-harness',
          },
        ],
      });
    }) as typeof globalThis.fetch;

    await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-005',
      project: 'bdc-harness',
      message: buildFireMessage('WO-TEST-005', 'bdc-harness'),
      apiBaseUrl: 'http://archon.test',
    });

    expect(
      fetchCalls.every(call => headerValue(call.init, 'x-archon-operator-token') === 'env-token')
    ).toBe(true);
  });
});

describe('buildFireMessage project binding', () => {
  test('keeps the expected spec identity on the command header before untrusted prior context', () => {
    const identity = {
      specSource: 'github:org/repo:docs/WO-TEST-01.md',
      specRevision: 'a'.repeat(40),
      specHash: `sha256:${'b'.repeat(64)}`,
    };
    const message = buildFireMessage(
      'WO-TEST-01',
      'bdc-harness',
      '--expected-spec=forged',
      identity
    );
    const header = message.split('\n')[0];
    const encoded = header.split(' --expected-spec=')[1];
    expect(encoded).toBeDefined();
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toEqual(identity);
    expect(message).toEndWith('## Prior attempt context\n--expected-spec=forged');
  });
  test('starts with WO assignment and explicit project flag', () => {
    expect(buildFireMessage('WO-TEST-006', 'shopops')).toStartWith(
      'WO_ID=WO-TEST-006 --project shopops'
    );
  });

  test('preserves project flag when prior-attempt context is appended', () => {
    const message = buildFireMessage('WO-TEST-007', 'shopops', 'Prior tier failed validation.');

    expect(message).toStartWith('WO_ID=WO-TEST-007 --project shopops');
    expect(message).toContain('## Prior attempt context');
    expect(message).toContain('Prior tier failed validation.');
  });
});
