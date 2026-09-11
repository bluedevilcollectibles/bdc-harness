import { expect, test } from 'bun:test';
import { probeDeployPipeline } from './deploy-pipeline';

test('passes matching revisions and reports drift', () => {
  expect(
    probeDeployPipeline([{ surface: 'api', expectedHead: 'abc', deployedRevision: 'abc' }]).verdict
  ).toBe('passed');
  expect(
    probeDeployPipeline([{ surface: 'api', expectedHead: 'abc', deployedRevision: 'def' }])
      .reasonCodes
  ).toEqual(['deploy_revision_mismatch:api']);
});

test('fails when no deployment signal is reachable', () => {
  expect(probeDeployPipeline([]).reasonCodes).toEqual(['deploy_pipeline_no_reachable_signal']);
});
