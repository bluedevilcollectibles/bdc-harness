import { expect, test } from 'bun:test';
import { probeDispatchTransport } from './dispatch-transport';

test('requires and exercises a readable provider round trip', async () => {
  expect((await probeDispatchTransport([])).verdict).toBe('blocked');
  const result = await probeDispatchTransport([
    { provider: 'codex', roundTrip: async () => 'CANARY_OK' },
  ]);
  expect(result.verdict).toBe('passed');
  expect(result.evidenceRefs[0]).toContain('reply_bytes=9');
});

test('reports provider failures', async () => {
  const result = await probeDispatchTransport([
    {
      provider: 'x',
      roundTrip: async () => {
        throw new Error('down');
      },
    },
  ]);
  expect(result.reasonCodes).toEqual(['dispatch_round_trip_failed:x']);
});
