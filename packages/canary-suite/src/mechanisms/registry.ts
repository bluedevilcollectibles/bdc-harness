import { probeCauldronLanes } from './probes/cauldron-lanes';
import { probeDeployPipeline } from './probes/deploy-pipeline';
import { probeDispatchTransport } from './probes/dispatch-transport';
import { probeKnowledgeLayer } from './probes/knowledge-layer';
import { probeLedgerWrites } from './probes/ledger-writes';
import { probeOperatorInbox } from './probes/operator-inbox';
import { probeReviewGate } from './probes/review-gate';
import { probeTaskmaster } from './probes/taskmaster';
import { probeXoLease } from './probes/xo-lease';
import type { MechanismDefinition, MechanismProbeResult } from './types';
import {
  deploySignals,
  dispatchTransports,
  knowledgeSignals,
  ledgerAdapter,
  operatorInboxAdapter,
  reviewCoverageAdapter,
  xoLeaseSignal,
} from './live-adapters';

const unavailable = (reason: string): Promise<MechanismProbeResult> =>
  Promise.resolve({ verdict: 'failed', reasonCodes: [reason], evidenceRefs: [] });

export const mechanismRegistry: readonly MechanismDefinition[] = [
  {
    id: 'cauldron-lanes',
    description: 'Nine Cauldron lanes resolve and route',
    level: 0,
    probe: ({ env, outputRoot }) =>
      env.CANARY_MANIFEST &&
      env.ARCHON_API_BASE &&
      env.ARCHON_CODEBASE_ID &&
      env.ARCHON_OPERATOR_TOKEN
        ? probeCauldronLanes({
            manifestPath: env.CANARY_MANIFEST,
            apiBase: env.ARCHON_API_BASE,
            codebaseId: env.ARCHON_CODEBASE_ID,
            token: env.ARCHON_OPERATOR_TOKEN,
            outputRoot,
          })
        : unavailable('cauldron_lanes_no_reachable_signal'),
  },
  {
    id: 'review-gate',
    description: 'Open PR repositories have recent review ingests',
    level: 0,
    probe: ({ env }) => probeReviewGate(reviewCoverageAdapter(env)),
  },
  {
    id: 'dispatch-transport',
    description: 'Providers return readable round-trip replies',
    level: 1,
    probe: ({ env }) => probeDispatchTransport(dispatchTransports(env)),
  },
  {
    id: 'xo-lease',
    description: 'XO lease heartbeat is fresh and scheduled',
    level: 0,
    probe: async ({ env }) => probeXoLease(await xoLeaseSignal(env)),
  },
  {
    id: 'taskmaster',
    description: 'Taskmaster ticked and evaluated candidates',
    level: 0,
    probe: ({ env }) =>
      env.ARCHON_DB_PATH
        ? probeTaskmaster({
            dbPath: env.ARCHON_DB_PATH,
            statusUrl: env.TASKMASTER_STATUS_URL,
            operatorToken: env.ARCHON_OPERATOR_TOKEN,
            githubRepo: env.TASKMASTER_CANARY_REPO,
            githubIssue: Number(env.TASKMASTER_CANARY_ISSUE) || undefined,
          })
        : unavailable('taskmaster_no_reachable_signal'),
  },
  {
    id: 'ledger-writes',
    description: 'tm_health write is readable',
    level: 1,
    probe: () => probeLedgerWrites(ledgerAdapter()),
  },
  {
    id: 'operator-inbox',
    description: 'Message can be posted, retrieved, and acknowledged',
    level: 1,
    probe: () => probeOperatorInbox(operatorInboxAdapter()),
  },
  {
    id: 'knowledge-layer',
    description: 'Wiki index and Oracle seeded document resolve',
    level: 0,
    probe: ({ env }) => probeKnowledgeLayer(knowledgeSignals(env)),
  },
  {
    id: 'deploy-pipeline',
    description: 'Deployed revision matches expected branch HEAD',
    level: 0,
    probe: async ({ env }) => probeDeployPipeline(await deploySignals(env)),
  },
];
