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
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import type { DagNode, WorkflowEventResponse } from '@/lib/api';
import { getNodeEvents } from '@/lib/api';
import { resolveNodeDisplay } from '@/lib/dag-layout';
import { ensureUtc } from '@/lib/format';
import type { WorkflowStepStatus } from '@/lib/types';
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
}: NodePeekPanelProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  useClickOutside(panelRef, onClose);

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
