import type { MechanismProbeResult } from './types';

export function evaluateMechanismResult(result: MechanismProbeResult): MechanismProbeResult {
  if (result.verdict === 'passed' && result.evidenceRefs.length === 0) {
    return { verdict: 'failed', reasonCodes: ['mechanism_silent'], evidenceRefs: [] };
  }
  return result;
}

export function unreachable(
  reasonCode: string,
  evidence = 'signal=unreachable'
): MechanismProbeResult {
  return { verdict: 'failed', reasonCodes: [reasonCode], evidenceRefs: [evidence] };
}
