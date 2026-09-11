import type { MechanismProbeResult } from '../types';
export interface DeploySignal {
  readonly surface: string;
  readonly expectedHead: string;
  readonly deployedRevision: string | null;
}
export function probeDeployPipeline(signals: readonly DeploySignal[]): MechanismProbeResult {
  if (!signals.length)
    return {
      verdict: 'failed',
      reasonCodes: ['deploy_pipeline_no_reachable_signal'],
      evidenceRefs: [],
    };
  const drift = signals.filter(
    signal => !signal.deployedRevision || signal.deployedRevision !== signal.expectedHead
  );
  return drift.length
    ? {
        verdict: 'failed',
        reasonCodes: drift.map(signal => `deploy_revision_mismatch:${signal.surface}`),
        evidenceRefs: signals.map(
          signal =>
            `${signal.surface}:expected=${signal.expectedHead}:deployed=${signal.deployedRevision ?? ''}`
        ),
      }
    : {
        verdict: 'passed',
        reasonCodes: [],
        evidenceRefs: signals.map(
          signal => `${signal.surface}:revision=${signal.deployedRevision}`
        ),
      };
}
