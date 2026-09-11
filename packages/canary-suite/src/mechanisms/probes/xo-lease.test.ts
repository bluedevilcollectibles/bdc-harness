import { expect, test } from 'bun:test';
import { probeXoLease } from './xo-lease';
test('Ready lease with empty NextRunTime fails', () => {
  expect(
    probeXoLease({
      state: 'Ready',
      nextRunTime: '',
      lastHeartbeatAt: new Date().toISOString(),
      windowMs: 60_000,
    }).reasonCodes
  ).toContain('xo_lease_next_run_time_empty');
});
