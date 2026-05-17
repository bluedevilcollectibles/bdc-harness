import { describe, test, expect, mock } from 'bun:test';
import { OracleError } from '../src/oracle-client';

describe('queryOracle', () => {
  test('returns answer and citations on 200', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ answer: 'Test answer', citations: ['doc1.md'] }), {
          status: 200,
        })
      )
    );
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const { queryOracle } = await import('../src/oracle-client');
      const result = await queryOracle('test query', 'test-key');
      expect(result.answer).toBe('Test answer');
      expect(result.citations).toEqual(['doc1.md']);
      expect(result.query).toBe('test query');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('throws OracleError with code auth on 401', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response('', { status: 401 })));
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const { queryOracle } = await import('../src/oracle-client');
      let err: OracleError | null = null;
      try {
        await queryOracle('test', 'bad-key');
      } catch (e) {
        err = e as OracleError;
      }
      expect(err?.code).toBe('auth');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('throws OracleError with code rate_limit on 429', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response('', { status: 429 })));
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const { queryOracle } = await import('../src/oracle-client');
      let err: OracleError | null = null;
      try {
        await queryOracle('test', 'key');
      } catch (e) {
        err = e as OracleError;
      }
      expect(err?.code).toBe('rate_limit');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('throws OracleError with code server on 500', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response('Internal error', { status: 500 })));
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const { queryOracle } = await import('../src/oracle-client');
      let err: OracleError | null = null;
      try {
        await queryOracle('test', 'key');
      } catch (e) {
        err = e as OracleError;
      }
      expect(err?.code).toBe('server');
    } finally {
      globalThis.fetch = original;
    }
  });
});
