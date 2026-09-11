import { runCanary, type RunCanaryOptions } from '../../runner';
import type { MechanismProbeResult } from '../types';
export async function probeCauldronLanes(
  options: Omit<RunCanaryOptions, 'level'>
): Promise<MechanismProbeResult> {
  const result = await runCanary({ ...options, level: 0 });
  return {
    verdict: result.report.verdict === 'passed' ? 'passed' : 'failed',
    reasonCodes: result.report.reasonCodes,
    evidenceRefs: result.report.evidenceRefs.length
      ? result.report.evidenceRefs
      : [`suite_run=${result.report.suiteRunId}`],
  };
}
