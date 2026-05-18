/**
 * WorkflowEventEmitter - typed event emitter for workflow execution observability.
 *
 * Lives in @archon/workflows so the executor can emit events.
 * The Web adapter in @archon/server subscribes to forward events to SSE streams.
 *
 * Design:
 * - Singleton pattern via getWorkflowEventEmitter()
 * - Fire-and-forget: listener errors never propagate to the executor
 * - Conversation-scoped subscriptions via registerRun() mapping
 */
import { EventEmitter } from 'events';
import type { ArtifactType } from './schemas';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.emitter');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

interface WorkflowStartedEvent {
  type: 'workflow_started';
  runId: string;
  workflowName: string;
  conversationId: string;
}

interface WorkflowCompletedEvent {
  type: 'workflow_completed';
  runId: string;
  workflowName: string;
  duration: number;
}

interface WorkflowFailedEvent {
  type: 'workflow_failed';
  runId: string;
  workflowName: string;
  error: string;
}

interface LoopIterationStartedEvent {
  type: 'loop_iteration_started';
  runId: string;
  nodeId?: string; // present when loop runs as a DAG node
  iteration: number;
  maxIterations: number;
}

interface LoopIterationCompletedEvent {
  type: 'loop_iteration_completed';
  runId: string;
  nodeId?: string; // present when loop runs as a DAG node
  iteration: number;
  duration: number;
  completionDetected: boolean;
}

interface LoopIterationFailedEvent {
  type: 'loop_iteration_failed';
  runId: string;
  nodeId?: string; // present when loop runs as a DAG node
  iteration: number;
  error: string;
}

interface WorkflowArtifactEvent {
  type: 'workflow_artifact';
  runId: string;
  artifactType: ArtifactType;
  label: string;
  url?: string;
  path?: string;
}

interface NodeStartedEvent {
  type: 'node_started';
  runId: string;
  nodeId: string;
  nodeName: string; // command name or node.id for inline prompts
}

interface NodeCompletedEvent {
  type: 'node_completed';
  runId: string;
  nodeId: string;
  nodeName: string;
  duration: number;
  costUsd?: number;
  stopReason?: string;
  numTurns?: number;
}

interface NodeFailedEvent {
  type: 'node_failed';
  runId: string;
  nodeId: string;
  nodeName: string;
  error: string;
}

/**
 * Emitted when the overseer classifies a node failure as recoverable and the executor
 * is about to re-run that node with a mutation hint applied
 * (WO-HARNESS-OVERSEER-AUTORECOVER-WORKTREE-COLLISION-01).
 *
 * Mission Control renders this between the red `node_failed` and the subsequent
 * `node_started` so operators can see the auto-recovery transition.
 */
interface NodeRetryEvent {
  type: 'node_retry';
  runId: string;
  nodeId: string;
  nodeName: string;
  /** The branch-suffix mutation the executor is applying on the retry. */
  branchSuffix: string;
}

/**
 * WO-170: node exited 0 but emitted a STATUS=*_failed string on stdout.
 * Either the node was declared `load_bearing: true` (WO-167 doctrine) and any
 * STATUS=*_failed appeared, OR stdout matched a known silent-data-loss
 * pattern (push_failed, registry_write_failed, etc.) that is always treated
 * as a warning regardless of load_bearing.
 *
 * Mission Control renders this as a yellow checkmark — a third state between
 * green `node_completed` and red `node_failed`.
 *
 * Anchor: 2026-05-16 engine sortie completed all-green while silently losing
 * 13 spec files; XO didn't notice for 25 minutes because UI showed success.
 */
interface NodeCompletedWithWarningEvent {
  type: 'node_completed_with_warning';
  runId: string;
  nodeId: string;
  nodeName: string;
  duration: number;
  /** Literal STATUS=... line(s) found in stdout (joined by \n). */
  statusLine: string;
  /** Pattern tokens that triggered the warning (e.g. ['push_failed']). */
  patterns: string[];
  /** True when triggered by `load_bearing: true`; false when matched on always-dangerous pattern. */
  loadBearing: boolean;
  costUsd?: number;
}

interface NodeSkippedEvent {
  type: 'node_skipped';
  runId: string;
  nodeId: string;
  nodeName: string;
  reason: 'when_condition' | 'when_condition_parse_error' | 'trigger_rule' | 'prior_success';
}

interface ToolStartedEvent {
  type: 'tool_started';
  runId: string;
  toolName: string;
  stepName: string;
}

interface ToolCompletedEvent {
  type: 'tool_completed';
  runId: string;
  toolName: string;
  stepName: string;
  durationMs: number;
}

interface ApprovalPendingEvent {
  type: 'approval_pending';
  runId: string;
  nodeId: string;
  message: string;
}

interface WorkflowCancelledEvent {
  type: 'workflow_cancelled';
  runId: string;
  nodeId: string;
  reason: string;
}

export type WorkflowEmitterEvent =
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | LoopIterationStartedEvent
  | LoopIterationCompletedEvent
  | LoopIterationFailedEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeCompletedWithWarningEvent
  | NodeFailedEvent
  | NodeRetryEvent
  | NodeSkippedEvent
  | WorkflowArtifactEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ApprovalPendingEvent
  | WorkflowCancelledEvent;

// ---------------------------------------------------------------------------
// Emitter class
// ---------------------------------------------------------------------------

type Listener = (event: WorkflowEmitterEvent) => void;

const WORKFLOW_EVENT = 'workflow_event';

class WorkflowEventEmitter {
  private emitter = new EventEmitter();
  private conversationMap = new Map<string, string>(); // runId -> conversationId

  constructor() {
    // Allow many subscribers (adapters, DB persistence, tests, etc.)
    this.emitter.setMaxListeners(50);
  }

  /**
   * Register a run-to-conversation mapping so subscribers can filter by conversation.
   */
  registerRun(runId: string, conversationId: string): void {
    this.conversationMap.set(runId, conversationId);
  }

  /**
   * Remove the run-to-conversation mapping (called at workflow end).
   */
  unregisterRun(runId: string): void {
    this.conversationMap.delete(runId);
  }

  /**
   * Get the conversation ID for a given run.
   */
  getConversationId(runId: string): string | undefined {
    return this.conversationMap.get(runId);
  }

  /**
   * Emit a workflow event. Fire-and-forget: listener errors are caught and logged.
   */
  emit(event: WorkflowEmitterEvent): void {
    try {
      this.emitter.emit(WORKFLOW_EVENT, event);
    } catch (error) {
      getLog().error({ err: error as Error, eventType: event.type }, 'event_emit_failed');
    }
  }

  /**
   * Subscribe to all workflow events. Returns an unsubscribe function.
   */
  subscribe(listener: Listener): () => void {
    // Wrap listener to catch errors - listener failures must not propagate
    const safeListener = (event: WorkflowEmitterEvent): void => {
      try {
        listener(event);
      } catch (error) {
        getLog().error({ err: error as Error, eventType: event.type }, 'event_listener_error');
      }
    };

    this.emitter.on(WORKFLOW_EVENT, safeListener);
    return (): void => {
      this.emitter.removeListener(WORKFLOW_EVENT, safeListener);
    };
  }

  /**
   * Subscribe to events for a specific conversation only. Returns unsubscribe function.
   */
  subscribeForConversation(conversationId: string, listener: Listener): () => void {
    return this.subscribe((event: WorkflowEmitterEvent) => {
      const eventConversationId = this.conversationMap.get(event.runId);
      if (eventConversationId === conversationId) {
        listener(event);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: WorkflowEventEmitter | null = null;

export function getWorkflowEventEmitter(): WorkflowEventEmitter {
  if (!instance) {
    instance = new WorkflowEventEmitter();
  }
  return instance;
}

/**
 * Reset singleton for testing.
 */
export function resetWorkflowEventEmitter(): void {
  instance = null;
}
