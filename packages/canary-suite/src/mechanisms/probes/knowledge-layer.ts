import type { MechanismProbeResult } from '../types';
export interface KnowledgeSignals {
  oracle(query: string): Promise<{ answer: string } | null>;
  wikiIndex(): Promise<boolean>;
}
export async function probeKnowledgeLayer(
  signals: KnowledgeSignals,
  seed = 'Cauldron Canary Suite'
): Promise<MechanismProbeResult> {
  try {
    const [oracle, wiki] = await Promise.all([signals.oracle(seed), signals.wikiIndex()]);
    const evidence = [`oracle_hit=${Boolean(oracle?.answer.trim())}`, `wiki_index=${wiki}`];
    if (!oracle?.answer.trim() || !wiki)
      return {
        verdict: 'failed',
        reasonCodes: [
          !oracle?.answer.trim() ? 'oracle_seed_doc_not_found' : 'wiki_index_unreachable',
        ],
        evidenceRefs: evidence,
      };
    return { verdict: 'passed', reasonCodes: [], evidenceRefs: evidence };
  } catch (error) {
    return {
      verdict: 'failed',
      reasonCodes: ['knowledge_layer_no_reachable_signal'],
      evidenceRefs: [`error=${(error as Error).message}`],
    };
  }
}
