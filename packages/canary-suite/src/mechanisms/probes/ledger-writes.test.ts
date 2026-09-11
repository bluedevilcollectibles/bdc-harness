import { expect, test } from 'bun:test';
import { probeLedgerWrites } from './ledger-writes';
test('ON CONFLICT write that throws silently fails', async () => {
  const result = await probeLedgerWrites(
    {
      write: async () => {
        throw new Error('ON CONFLICT (provider)');
      },
      read: async () => null,
    },
    'fixed'
  );
  expect(result.verdict).toBe('failed');
  expect(result.evidenceRefs[0]).toContain('ON CONFLICT');
});
