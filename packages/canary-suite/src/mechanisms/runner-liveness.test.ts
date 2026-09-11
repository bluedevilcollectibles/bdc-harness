import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkRunnerLiveness, writeRunnerHeartbeat } from './runner-liveness';
test('stopped runner is externally detectable without logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'heartbeat-'));
  const path = await writeRunnerHeartbeat(directory, {
    observedAt: '2026-01-01T00:00:00.000Z',
    suiteRunId: 'run',
  });
  expect(await checkRunnerLiveness(path, 1000, Date.parse('2026-01-01T00:00:02.000Z'))).toEqual({
    healthy: false,
    reasonCode: 'mechanism_runner_heartbeat_stale',
  });
  await rm(directory, { recursive: true });
});
