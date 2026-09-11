import type { MechanismProbeResult } from '../types';
export interface LedgerRoundTrip {
  write(id: string): Promise<void>;
  read(id: string): Promise<unknown | null>;
}
export async function probeLedgerWrites(
  ledger: LedgerRoundTrip,
  id = `canary-${crypto.randomUUID()}`
): Promise<MechanismProbeResult> {
  try {
    await ledger.write(id);
    const row = await ledger.read(id);
    return row
      ? { verdict: 'passed', reasonCodes: [], evidenceRefs: [`tm_health.id=${id}`] }
      : {
          verdict: 'failed',
          reasonCodes: ['tm_health_write_not_readable'],
          evidenceRefs: [`tm_health.id=${id}`],
        };
  } catch (error) {
    return {
      verdict: 'failed',
      reasonCodes: ['tm_health_write_failed'],
      evidenceRefs: [`error=${(error as Error).message}`],
    };
  }
}
