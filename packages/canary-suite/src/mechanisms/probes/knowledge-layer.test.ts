import { expect, test } from 'bun:test';
import { probeKnowledgeLayer } from './knowledge-layer';

test('passes only when Oracle and wiki both resolve the seed', async () => {
  const passed = await probeKnowledgeLayer({
    oracle: async () => ({ answer: 'found' }),
    wikiIndex: async () => true,
  });
  expect(passed.verdict).toBe('passed');
  const failed = await probeKnowledgeLayer({
    oracle: async () => null,
    wikiIndex: async () => true,
  });
  expect(failed.reasonCodes).toEqual(['oracle_seed_doc_not_found']);
});

test('converts adapter exceptions to a reachable-signal failure', async () => {
  const result = await probeKnowledgeLayer({
    oracle: async () => {
      throw new Error('offline');
    },
    wikiIndex: async () => true,
  });
  expect(result.reasonCodes).toEqual(['knowledge_layer_no_reachable_signal']);
});
