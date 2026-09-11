import type { MechanismProbeResult } from '../types';
export interface XoLeaseSignal {
  readonly state: string;
  readonly nextRunTime: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly windowMs: number;
}
export function probeXoLease(signal: XoLeaseSignal | null, now = Date.now()): MechanismProbeResult {
  if (!signal)
    return { verdict: 'failed', reasonCodes: ['xo_lease_no_reachable_signal'], evidenceRefs: [] };
  const heartbeat = signal.lastHeartbeatAt ? Date.parse(signal.lastHeartbeatAt) : NaN;
  const evidenceRefs = [
    `state=${signal.state}`,
    `next_run_time=${signal.nextRunTime ?? ''}`,
    `last_heartbeat_at=${signal.lastHeartbeatAt ?? ''}`,
  ];
  if (!signal.nextRunTime?.trim())
    return { verdict: 'failed', reasonCodes: ['xo_lease_next_run_time_empty'], evidenceRefs };
  if (!Number.isFinite(heartbeat) || now - heartbeat > signal.windowMs)
    return { verdict: 'failed', reasonCodes: ['xo_lease_heartbeat_stale'], evidenceRefs };
  return { verdict: 'passed', reasonCodes: [], evidenceRefs };
}
