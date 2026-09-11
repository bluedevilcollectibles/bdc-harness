import { expect, mock, test } from 'bun:test';

mock.module('../../runner', () => ({
  runCanary: async () => ({
    report: { verdict: 'passed', reasonCodes: [], evidenceRefs: ['artifact'], suiteRunId: 'suite' },
  }),
}));
const { probeCauldronLanes } = await import('./cauldron-lanes');

test('maps a successful level-zero suite to mechanism evidence', async () => {
  const result = await probeCauldronLanes({
    manifestPath: 'm',
    apiBase: 'https://api',
    codebaseId: 'c',
    token: 't',
    outputRoot: 'o',
  });
  expect(result).toEqual({ verdict: 'passed', reasonCodes: [], evidenceRefs: ['artifact'] });
});
