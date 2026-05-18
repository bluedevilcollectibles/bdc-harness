/**
 * NodePeekPanel — WO-MC-NODE-PEEK-01
 *
 * Right-side detail panel for a single DAG node in the workflow execution view.
 * Renders the latest stored output (node_completed.data.node_output), the last
 * error (if any), and the last 5 DB events for the node with humanised labels.
 *
 * V1 note: prompt text is NOT persisted in remote_agent_workflow_events. The
 * spec's "latest prompt" requirement is satisfied by labelling the node by its
 * inline prompt (when available on the workflow definition) or by the command
 * name. Streaming partial responses are also not available in V1 — a follow-up
 * WO is required to extend dag-executor.ts to persist prompt text and stream
 * partials before that data can be surfaced here.
 *
 * Live updates: this component is purely presentational. The parent's React
 * Query 3 s poll on `getWorkflowRun` re-renders this panel with fresh events.
 * No internal timer or setInterval lives here.
 */

import { useState } from 'react';
import { X } from 'lucide-react';

import { StatusIcon } from './StatusIcon';
import { ScrollArea } from '@/components/ui/scroll-area';
import { resolveNodeDisplay } from '@/lib/dag-layout';
import { getNodeEvents } from '@/lib/workflow-utils';
import { ensureUtc, formatDurationMs } from '@/lib/format';

import type { DagNode, WorkflowEventResponse } from '@/lib/api';
import type { DagNodeState } from '@/lib/types';

const OUTPUT_TRUNCATE_CHARS = 2000;
const ACTIVITY_EVENT_LIMIT = 5;

interface NodePeekPanelProps {
  nodeId: string;
  /** Resolved workflow definition node — null when the run predates the current YAML. */
  dagNode: DagNode | null;
  /** All events for the workflow run; the panel filters internally to nodeId. */
  events: WorkflowEventResponse[];
  /** Live runtime state for the node (status, duration, error, cost). */
  dagNodeState: DagNodeState | undefined;
  /** True when the parent workflow run is still running/pending. */
  isRunning: boolean;
  onClose: () => void;
}

function typeBadgeLabel(nodeType: 'command' | 'prompt' | 'bash'): string {
  switch (nodeType) {
    case 'command':
      return 'CMD';
    case 'bash':
      return 'BASH';
    case 'prompt':
      return 'PROMPT';
  }
}

function outputLabel(nodeType: 'command' | 'prompt' | 'bash'): string {
  return nodeType === 'bash' ? 'stdout' : 'Response';
}

/**
 * Humanise an event row for the activity stream. Keeps each line short so
 * the panel works at 20% width.
 */
function formatEventLabel(event: WorkflowEventResponse): string {
  const data = event.data;
  switch (event.event_type) {
    case 'node_started':
      return 'started';
    case 'node_completed':
      return 'completed';
    case 'node_completed_with_warning': {
      const sl = data.statusLine as string | undefined;
      return sl ? `completed (warning: ${sl.split('\n')[0]})` : 'completed (warning)';
    }
    case 'node_failed': {
      const err = data.error as string | undefined;
      return err ? `failed: ${err.slice(0, 80)}` : 'failed';
    }
    case 'node_skipped': {
      const reason = data.reason as string | undefined;
      return reason ? `skipped (${reason})` : 'skipped';
    }
    case 'tool_called': {
      const name = data.tool_name as string | undefined;
      return name ? `tool: ${name}` : 'tool called';
    }
    case 'tool_completed': {
      const name = data.tool_name as string | undefined;
      const dur = data.duration_ms as number | undefined;
      const durStr = dur !== undefined ? ` (${formatDurationMs(dur)})` : '';
      return name ? `tool done: ${name}${durStr}` : `tool done${durStr}`;
    }
    case 'loop_iteration_started': {
      const iter = data.iteration as number | undefined;
      const max = data.maxIterations as number | undefined;
      return `iter ${String(iter ?? '?')}${max !== undefined ? `/${String(max)}` : ''} started`;
    }
    case 'loop_iteration_completed': {
      const iter = data.iteration as number | undefined;
      const dur = data.duration_ms as number | undefined;
      const durStr = dur !== undefined ? ` (${formatDurationMs(dur)})` : '';
      return `iter ${String(iter ?? '?')} done${durStr}`;
    }
    case 'loop_iteration_failed': {
      const iter = data.iteration as number | undefined;
      return `iter ${String(iter ?? '?')} failed`;
    }
    default:
      return event.event_type;
  }
}

export function NodePeekPanel({
  nodeId,
  dagNode,
  events,
  dagNodeState,
  isRunning,
  onClose,
}: NodePeekPanelProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  const display = dagNode ? resolveNodeDisplay(dagNode) : null;
  const nodeType = display?.nodeType ?? 'prompt';
  const label = display?.label ?? nodeId;
  const promptText = display?.promptText;

  const nodeEvents = getNodeEvents(events, nodeId);
  const lastEvents = nodeEvents.slice(-ACTIVITY_EVENT_LIMIT).reverse();

  // Latest stored output: node_completed wins, then node_completed_with_warning.
  const completedEvent = [...nodeEvents]
    .reverse()
    .find(e => e.event_type === 'node_completed' || e.event_type === 'node_completed_with_warning');
  const rawOutput = completedEvent?.data.node_output as string | undefined;

  const errorEvent = [...nodeEvents].reverse().find(e => e.event_type === 'node_failed');
  const errorText =
    (errorEvent?.data.error as string | undefined) ?? dagNodeState?.error ?? undefined;

  const status = dagNodeState?.status ?? (nodeEvents.length > 0 ? 'running' : 'pending');
  const duration = dagNodeState?.duration;

  const truncated =
    rawOutput !== undefined && rawOutput.length > OUTPUT_TRUNCATE_CHARS && !expanded;
  const displayedOutput = truncated ? rawOutput.slice(0, OUTPUT_TRUNCATE_CHARS) : rawOutput;

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-inset border-l border-border">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <StatusIcon status={status} />
        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface text-text-secondary uppercase tracking-wide">
          {typeBadgeLabel(nodeType)}
        </span>
        <span className="text-sm text-text-primary font-medium truncate flex-1" title={label}>
          {label}
        </span>
        {duration !== undefined && (
          <span className="text-xs text-text-secondary tabular-nums shrink-0">
            {formatDurationMs(duration)}
          </span>
        )}
        <button
          onClick={onClose}
          className="text-text-secondary hover:text-text-primary transition-colors shrink-0"
          title="Close panel"
          aria-label="Close node detail panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 py-3 space-y-4">
          {/* Prompt / Command preview */}
          {nodeType === 'prompt' && promptText && (
            <section>
              <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">Prompt</div>
              <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap break-all bg-surface rounded p-2 max-h-40 overflow-auto">
                {promptText.length > OUTPUT_TRUNCATE_CHARS
                  ? promptText.slice(0, OUTPUT_TRUNCATE_CHARS) + '\n...'
                  : promptText}
              </pre>
              <div className="text-[10px] text-text-secondary mt-1 italic">
                Static prompt from workflow YAML. Per-iteration prompt text is not persisted.
              </div>
            </section>
          )}
          {nodeType === 'command' && (
            <section>
              <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">
                Command
              </div>
              <pre className="text-xs font-mono text-text-primary bg-surface rounded p-2">
                {dagNode?.command ?? '(unknown)'}
              </pre>
            </section>
          )}
          {nodeType === 'bash' && display?.bashScript && (
            <section>
              <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">Script</div>
              <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap break-all bg-surface rounded p-2 max-h-40 overflow-auto">
                {display.bashScript.length > OUTPUT_TRUNCATE_CHARS
                  ? display.bashScript.slice(0, OUTPUT_TRUNCATE_CHARS) + '\n...'
                  : display.bashScript}
              </pre>
            </section>
          )}

          {/* Output / Response */}
          <section>
            <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">
              {outputLabel(nodeType)}
            </div>
            {displayedOutput !== undefined ? (
              <>
                <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap break-all bg-surface rounded p-2 max-h-96 overflow-auto">
                  {displayedOutput}
                  {truncated && '\n...'}
                </pre>
                {rawOutput !== undefined && rawOutput.length > OUTPUT_TRUNCATE_CHARS && (
                  <button
                    onClick={(): void => {
                      setExpanded(prev => !prev);
                    }}
                    className="mt-1 text-xs text-primary hover:text-accent-bright transition-colors"
                  >
                    {expanded
                      ? 'Collapse'
                      : `Expand (${String(rawOutput.length - OUTPUT_TRUNCATE_CHARS)} more chars)`}
                  </button>
                )}
              </>
            ) : (
              <div className="text-xs text-text-secondary italic">
                {isRunning && status === 'running'
                  ? 'No output yet — node is still running.'
                  : 'No output available.'}
              </div>
            )}
          </section>

          {/* Error */}
          {errorText && (
            <section>
              <div className="text-xs text-error uppercase tracking-wide mb-1">Error</div>
              <pre className="text-xs font-mono text-error whitespace-pre-wrap break-all bg-surface rounded p-2 max-h-40 overflow-auto">
                {errorText}
              </pre>
            </section>
          )}

          {/* Activity stream */}
          <section>
            <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">
              Activity (last {String(ACTIVITY_EVENT_LIMIT)})
            </div>
            {lastEvents.length === 0 ? (
              <div className="text-xs text-text-secondary italic">No events recorded yet.</div>
            ) : (
              <ul className="space-y-1">
                {lastEvents.map(event => {
                  const ts = new Date(ensureUtc(event.created_at)).toLocaleTimeString();
                  return (
                    <li key={event.id} className="text-xs font-mono text-text-primary flex gap-2">
                      <span className="text-text-secondary tabular-nums shrink-0">{ts}</span>
                      <span className="break-all">{formatEventLabel(event)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
