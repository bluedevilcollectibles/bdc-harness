import type { WorkflowEventResponse } from '@/lib/api';

/**
 * Check if a workflow status represents a terminal (finished) state.
 */
export function isTerminalStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Filter workflow events for a specific DAG node by step_name match.
 * Returns events in the original chronological order from the database.
 *
 * Used by NodePeekPanel (WO-MC-NODE-PEEK-01) to render the activity stream
 * and the latest stored output for a single node.
 */
export function getNodeEvents(
  events: WorkflowEventResponse[],
  nodeId: string
): WorkflowEventResponse[] {
  return events.filter(e => e.step_name === nodeId);
}
