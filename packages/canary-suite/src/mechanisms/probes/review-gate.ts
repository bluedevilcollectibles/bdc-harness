import type { MechanismProbeResult } from '../types';

export interface ReviewCoverage {
  readonly repo: string;
  readonly openPrCount: number;
  readonly recentIngestCount: number;
}
export async function probeReviewGate(
  list: () => Promise<readonly ReviewCoverage[]>
): Promise<MechanismProbeResult> {
  try {
    const rows = await list();
    const missing = rows.filter(row => row.openPrCount > 0 && row.recentIngestCount === 0);
    if (missing.length)
      return {
        verdict: 'failed',
        reasonCodes: missing.map(
          row => `review_gate_zero_ingests:${row.repo}:open_prs=${row.openPrCount}`
        ),
        evidenceRefs: rows.map(
          row => `${row.repo}:open_prs=${row.openPrCount}:recent_ingests=${row.recentIngestCount}`
        ),
      };
    return rows.length
      ? {
          verdict: 'passed',
          reasonCodes: [],
          evidenceRefs: rows.map(
            row => `${row.repo}:open_prs=${row.openPrCount}:recent_ingests=${row.recentIngestCount}`
          ),
        }
      : { verdict: 'failed', reasonCodes: ['review_gate_no_reachable_signal'], evidenceRefs: [] };
  } catch (error) {
    return {
      verdict: 'failed',
      reasonCodes: ['review_gate_unreachable'],
      evidenceRefs: [`error=${(error as Error).message}`],
    };
  }
}
