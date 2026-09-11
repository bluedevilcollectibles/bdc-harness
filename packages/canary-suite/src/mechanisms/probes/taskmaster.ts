import { runTaskmasterCanarySuite, type TaskmasterCanaryDeps } from '../../taskmaster-canary';
import type { MechanismProbeResult } from '../types';
export async function probeTaskmaster(deps: TaskmasterCanaryDeps): Promise<MechanismProbeResult> {
  const result = await runTaskmasterCanarySuite(deps);
  return {
    verdict: result.verdict === 'passed' ? 'passed' : 'failed',
    reasonCodes: result.reasonCodes,
    evidenceRefs: result.evidenceRefs,
  };
}
