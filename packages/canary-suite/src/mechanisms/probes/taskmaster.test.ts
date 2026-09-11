import { expect, mock, test } from 'bun:test';

mock.module('../../taskmaster-canary', () => ({
  runTaskmasterCanarySuite: async () => ({
    verdict: 'failed',
    reasonCodes: ['tick_missing'],
    evidenceRefs: ['db'],
  }),
}));
const { probeTaskmaster } = await import('./taskmaster');

test('preserves taskmaster failure evidence', async () => {
  const result = await probeTaskmaster({ dbPath: 'db' });
  expect(result).toEqual({
    verdict: 'failed',
    reasonCodes: ['tick_missing'],
    evidenceRefs: ['db'],
  });
});
