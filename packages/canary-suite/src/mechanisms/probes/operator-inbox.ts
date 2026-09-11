import type { MechanismProbeResult } from '../types';
export interface InboxRoundTrip {
  post(id: string): Promise<void>;
  retrieve(id: string): Promise<boolean>;
  acknowledge(id: string): Promise<boolean>;
}
export async function probeOperatorInbox(
  inbox: InboxRoundTrip,
  id = `canary-${crypto.randomUUID()}`
): Promise<MechanismProbeResult> {
  try {
    await inbox.post(id);
    if (!(await inbox.retrieve(id)))
      return {
        verdict: 'failed',
        reasonCodes: ['operator_inbox_message_not_retrievable'],
        evidenceRefs: [`message=${id}`],
      };
    if (!(await inbox.acknowledge(id)))
      return {
        verdict: 'failed',
        reasonCodes: ['operator_inbox_message_not_acknowledgeable'],
        evidenceRefs: [`message=${id}`],
      };
    return {
      verdict: 'passed',
      reasonCodes: [],
      evidenceRefs: [`message=${id}:round_trip=complete`],
    };
  } catch (error) {
    return {
      verdict: 'failed',
      reasonCodes: ['operator_inbox_round_trip_failed'],
      evidenceRefs: [`error=${(error as Error).message}`],
    };
  }
}
