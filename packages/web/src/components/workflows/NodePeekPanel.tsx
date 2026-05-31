/**
 * NodePeekPanel — side-panel drawer that surfaces per-node activity for a
 * workflow run. Eliminates the need to SSH and tail the JSONL log to know
 * whether a node is making progress or stuck.
 *
 * Sources of data:
 *  - Prompt / command / shell script come from the workflow definition
 *    (workflowDef.workflow.nodes) — the events table does not persist prompts.
 *  - Output comes from the most recent node_completed event in the events list
 *    — partial / streaming output is SSE-only and never persisted.
 *  - Event list comes from GET /api/workflows/runs/:runId/nodes/:nodeId/events
 *    (last 5 events, newest first). Re-fetches every 5s while the run is live.
 */
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, CheckCircle, XCircle, Pause } from 'lucide-react';

import type { DagNode, WorkflowEventResponse } from '@/lib/api';
import { approveWorkflowRun, getNodeEvents, rejectWorkflowRun } from '@/lib/api';
import { resolveNodeDisplay } from '@/lib/dag-layout';
import { ensureUtc } from '@/lib/format';
import type { WorkflowRunStatus, WorkflowStepStatus } from '@/lib/types';
import { useClickOutside } from '@/hooks/useClickOutside';

const MAX_BODY_CHARS = 2000;
const EVENT_POLL_MS = 5000;

interface NodePeekPanelProps {
  runId: string;
  nodeId: string;
  nodeDef: DagNode | null;
  nodeStatus: WorkflowStepStatus | undefined;
  isRunning: boolean;
  onClose: () => void;
  /** WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap C): run-level status. Used together
   *  with `approval` to decide whether to render the inline Approve/Reject
   *  affordance — ONLY when run is paused on the selected approval gate. */
  runStatus?: WorkflowRunStatus;
  /** Unresolved approval context (node id + message) recovered from events
   *  by extractApprovalContext, or set by SSE. The buttons render only when
   *  approval.nodeId === this panel's nodeId AND runStatus === 'paused'. */
  approval?: { nodeId: string; message: string };
}

/** Truncate a string to MAX_BODY_CHARS with a "show more" affordance. */
function ExpandableBlock({ text }: { text: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const tooLong = text.length > MAX_BODY_CHARS;
  const display = expanded || !tooLong ? text : text.slice(0, MAX_BODY_CHARS);
  return (
    <div className="text-xs font-mono text-text-primary whitespace-pre-wrap break-words">
      {display}
      {tooLong && (
        <button
          type="button"
          onClick={(): void => {
            setExpanded(prev => !prev);
          }}
          className="block mt-1 text-[10px] uppercase tracking-wide text-accent hover:text-accent-bright"
        >
          {expanded ? 'Show less' : `Show more (${String(text.length - MAX_BODY_CHARS)} chars)`}
        </button>
      )}
    </div>
  );
}

/** Pick the most recent node_completed event from a newest-first event list. */
function extractLatestOutput(events: WorkflowEventResponse[]): string | null {
  for (const ev of events) {
    if (ev.event_type === 'node_completed' || ev.event_type === 'node_completed_with_warning') {
      const out = ev.data.node_output;
      if (typeof out === 'string') return out;
    }
  }
  return null;
}

export function NodePeekPanel({
  runId,
  nodeId,
  nodeDef,
  nodeStatus,
  isRunning,
  onClose,
  runStatus,
  approval,
}: NodePeekPanelProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  useClickOutside(panelRef, onClose);
  const queryClient = useQueryClient();
  const [gateBusy, setGateBusy] = useState<null | 'approving' | 'rejecting'>(null);
  const [gateError, setGateError] = useState<string | null>(null);

  // WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap C): inline gate affordance is shown
  // ONLY when this panel's node IS the unresolved approval-gate node on a
  // paused run. The discriminator (approval object present + nodeId match +
  // run.status === 'paused' + this node has approval defined in the YAML)
  // distinguishes approval-gate pauses from operator-triggered run_paused,
  // which never emits approval_requested and so never populates `approval`.
  const showInlineGate =
    runStatus === 'paused' && approval?.nodeId === nodeId && nodeDef?.approval != null;

  const onApprove = async (): Promise<void> => {
    if (gateBusy !== null) return;
    setGateBusy('approving');
    setGateError(null);
    try {
      await approveWorkflowRun(runId);
      // Trigger a re-fetch so the run status + events refresh promptly.
      // A transient run.status === 'failed' is expected during auto-resume
      // (api.ts:2672) and must NOT be treated as an error here.
      await queryClient.invalidateQueries({ queryKey: ['workflowRun', runId] });
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setGateBusy(null);
    }
  };

  const onReject = async (): Promise<void> => {
    if (gateBusy !== null) return;
    setGateBusy('rejecting');
    setGateError(null);
    try {
      await rejectWorkflowRun(runId);
      await queryClient.invalidateQueries({ queryKey: ['workflowRun', runId] });
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setGateBusy(null);
    }
  };

  // Live poll while the workflow run as a whole is still running.
  // Stops polling for terminal runs — react-query refetches still happen on focus.
  const { data: events, isLoading } = useQuery({
    queryKey: ['nodeEvents', runId, nodeId],
    queryFn: () => getNodeEvents(runId, nodeId, 5),
    refetchInterval: isRunning ? EVENT_POLL_MS : false,
    staleTime: 0,
  });

  const display = useMemo(() => (nodeDef ? resolveNodeDisplay(nodeDef) : null), [nodeDef]);
  const promptText = display?.promptText ?? null;
  const bashScript = display?.bashScript ?? null;
  const nodeType = display?.nodeType ?? null;

  const eventList = events ?? [];
  const latestOutput = extractLatestOutput(eventList);
  const hasNotStarted = nodeStatus === undefined || nodeStatus === 'pending';

  // Section ordering (top to bottom): header, prompt/command, output/response, events list.
  return (
    <div
      ref={panelRef}
      role="complementary"
      aria-label={`Node peek for ${nodeId}`}
      className="absolute right-0 top-0 h-full w-80 z-10 bg-surface border-l border-border flex flex-col shadow-lg"
      data-testid="node-detail"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-[10px] uppercase tracking-wide text-text-tertiary">
          {nodeType ?? 'node'}
        </span>
        <span className="flex-1 truncate text-xs font-mono font-semibold text-text-primary">
          {nodeId}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-text-tertiary hover:text-text-primary hover:bg-surface-elevated"
          aria-label="Close node peek"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        {/* WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap C): inline Approve / Reject for
            an approval-gate pause. Render BEFORE prompt so it is unmissable. */}
        {showInlineGate && (
          <section
            className="px-3 py-2 border-b border-border bg-warning/5"
            data-testid="inline-approve-gate"
          >
            <div className="flex items-center gap-2 mb-2">
              <Pause className="h-3.5 w-3.5 text-warning shrink-0" />
              <span className="text-[10px] uppercase tracking-wide text-warning font-semibold">
                Awaiting approval
              </span>
            </div>
            {approval?.message && (
              <p className="text-xs text-text-secondary mb-2 whitespace-pre-wrap break-words">
                {approval.message}
              </p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(): void => {
                  void onApprove();
                }}
                disabled={gateBusy !== null}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-success/90 border border-success/30 hover:bg-success/10 hover:text-success disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                data-testid="inline-approve-button"
              >
                <CheckCircle className="h-3.5 w-3.5" />
                {gateBusy === 'approving' ? 'Approving...' : 'Approve'}
              </button>
              <button
                type="button"
                onClick={(): void => {
                  void onReject();
                }}
                disabled={gateBusy !== null}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-error/90 border border-error/30 hover:bg-error/10 hover:text-error disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                data-testid="inline-reject-button"
              >
                <XCircle className="h-3.5 w-3.5" />
                {gateBusy === 'rejecting' ? 'Rejecting...' : 'Reject'}
              </button>
            </div>
            {gateError !== null && <p className="mt-1 text-[10px] text-error">{gateError}</p>}
          </section>
        )}
        {/* Prompt / Command / Shell */}
        <section className="px-3 py-2 border-b border-border">
          <h3 className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">
            {nodeType === 'bash' ? 'Shell script' : nodeType === 'command' ? 'Command' : 'Prompt'}
          </h3>
          {nodeType === 'command' ? (
            <div className="text-xs font-mono text-text-primary break-words">
              {display?.label ?? nodeId}
            </div>
          ) : nodeType === 'bash' && bashScript ? (
            <ExpandableBlock text={bashScript} />
          ) : promptText ? (
            <ExpandableBlock text={promptText} />
          ) : (
            <p className="text-xs text-text-tertiary italic">No prompt available.</p>
          )}
        </section>

        {/* Output / Response */}
        <section className="px-3 py-2 border-b border-border">
          <h3 className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">
            {nodeType === 'bash' ? 'Output' : 'Response'}
          </h3>
          {hasNotStarted ? (
            <p className="text-xs text-text-tertiary italic">Node has not started.</p>
          ) : latestOutput !== null ? (
            <ExpandableBlock text={latestOutput} />
          ) : nodeStatus === 'running' ? (
            <p className="text-xs text-text-tertiary italic">
              Running... output will appear when the node completes.
            </p>
          ) : nodeStatus === 'failed' ? (
            <p className="text-xs text-error italic">Node failed without producing output.</p>
          ) : (
            <p className="text-xs text-text-tertiary italic">No output recorded.</p>
          )}
        </section>

        {/* Last events */}
        <section className="px-3 py-2">
          <h3 className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">
            Last events
          </h3>
          {isLoading && eventList.length === 0 ? (
            <p className="text-xs text-text-tertiary italic">Loading events...</p>
          ) : eventList.length === 0 ? (
            <p className="text-xs text-text-tertiary italic">
              {hasNotStarted ? 'Node has not started.' : 'No events recorded.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {eventList.map(ev => {
                const ts = new Date(ensureUtc(ev.created_at)).toLocaleTimeString();
                return (
                  <li
                    key={ev.id}
                    className="flex items-center gap-2 text-[11px] font-mono text-text-secondary"
                  >
                    <span className="text-text-tertiary tabular-nums shrink-0">{ts}</span>
                    <span className="truncate">{ev.event_type}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
