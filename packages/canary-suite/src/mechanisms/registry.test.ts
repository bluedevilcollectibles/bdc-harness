import { expect, test } from 'bun:test';
import { mechanismRegistry } from './registry';
test('registry is data-driven', () => {
  expect(mechanismRegistry).toHaveLength(9);
  expect(new Set(mechanismRegistry.map(item => item.id)).size).toBe(9);
  expect(
    mechanismRegistry
      .filter(item => item.level === 1)
      .map(item => item.id)
      .sort()
  ).toEqual(['dispatch-transport', 'ledger-writes', 'operator-inbox']);
});
