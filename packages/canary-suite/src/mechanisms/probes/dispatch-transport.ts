import type { MechanismProbeResult } from '../types';
export interface DispatchRoundTrip {
  readonly provider: string;
  roundTrip(): Promise<string | null>;
}
export async function probeDispatchTransport(
  transports: readonly DispatchRoundTrip[]
): Promise<MechanismProbeResult> {
  if (!transports.length)
    return {
      verdict: 'blocked',
      reasonCodes: ['dispatch_transport_no_reachable_provider'],
      evidenceRefs: [],
    };
  const evidence: string[] = [];
  for (const transport of transports) {
    try {
      const reply = await transport.roundTrip();
      if (!reply?.trim())
        return {
          verdict: 'blocked',
          reasonCodes: [`dispatch_reply_unreadable:${transport.provider}`],
          evidenceRefs: evidence,
        };
      evidence.push(`${transport.provider}:reply_bytes=${new TextEncoder().encode(reply).length}`);
    } catch (error) {
      return {
        verdict: 'failed',
        reasonCodes: [`dispatch_round_trip_failed:${transport.provider}`],
        evidenceRefs: [`error=${(error as Error).message}`],
      };
    }
  }
  return { verdict: 'passed', reasonCodes: [], evidenceRefs: evidence };
}
