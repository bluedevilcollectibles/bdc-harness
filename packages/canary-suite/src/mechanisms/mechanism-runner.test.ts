import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runMechanisms } from './mechanism-runner';
import type { MechanismDefinition } from './types';
let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
test('working mechanism passes with evidence', async () => {
  directory = await mkdtemp(join(tmpdir(), 'mechanisms-'));
  const registry: MechanismDefinition[] = [
    {
      id: 'review-gate',
      level: 0,
      description: '',
      probe: async () => ({ verdict: 'passed', reasonCodes: [], evidenceRefs: ['path=exercised'] }),
    },
  ];
  const result = await runMechanisms({ outputRoot: directory, registry });
  expect(result.report.verdict).toBe('passed');
  expect(result.report.evidenceRefs).toEqual(['path=exercised']);
});
test('no writes and level 1 excluded by default', async () => {
  directory = await mkdtemp(join(tmpdir(), 'mechanisms-'));
  let writes = 0;
  const registry: MechanismDefinition[] = [
    {
      id: 'review-gate',
      level: 0,
      description: '',
      probe: async () => ({ verdict: 'passed', reasonCodes: [], evidenceRefs: ['read'] }),
    },
    {
      id: 'ledger-writes',
      level: 1,
      description: '',
      probe: async () => {
        writes++;
        return { verdict: 'passed', reasonCodes: [], evidenceRefs: ['write'] };
      },
    },
  ];
  const result = await runMechanisms({ outputRoot: directory, registry });
  expect(writes).toBe(0);
  expect(result.report.mechanisms.map(item => item.id)).toEqual(['review-gate']);
});

test('a throwing live adapter is recorded and artifacts are still written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mechanism-canary-'));
  const result = await runMechanisms({
    outputRoot: root,
    registry: [
      {
        id: 'knowledge-layer',
        description: 'throws',
        level: 0,
        probe: async () => {
          throw new Error('network down');
        },
      },
    ],
  });
  expect(result.report.verdict).toBe('failed');
  expect(result.report.reasonCodes).toEqual(['mechanism_probe_threw:knowledge-layer']);
  expect(result.artifactPaths.length).toBeGreaterThan(0);
});
