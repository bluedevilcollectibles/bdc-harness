/**
 * Overseer bridge for dag-executor node-failure handlers.
 *
 * Wires the @archon/overseer decision layer into the executor without growing
 * dag-executor.ts further. Each of the executor's node-failure sites calls
 * `handleNodeFailure` instead of inlining the log + persist + emit + return pattern.
 *
 * v1 scope (WO-HARNESS-OVERSEER-WIRE-V1-01 / bdc-xo#151):
 *   - AI-node failure sites only (4 sites in dag-executor.ts: command-load,
 *     cancelled-during-streaming, credit-exhaustion, empty-output)
 *   - Bash-node failures are out of scope; sibling WO to follow
 *   - All 4 v1 sites currently classify as `unknown` → `escalate` → returns
 *     `{ state: 'failed' }`. Net behavioral change at these 4 sites is zero;
 *     the v1 win is the structured `overseer.decision` log line and the wired
 *     decision path for future extension.
 *
 * v2 deferred (per @archon/overseer README):
 *   - createWorkflowEvent persistence for Mission Control "Workflow Decisions" tab
 *   - Per-WO-class override rules
 *   - LLM provider failover
 */

import type { Logger } from '@archon/paths';
import { classifyError, decide, type Decision } from '@archon/overseer';
import type { WorkflowRun, NodeOutput } from './schemas/workflow-run.ts';
import type { DagNode } from './schemas/dag-node.ts';
import type { WorkflowEmitterEvent } from './event-emitter.ts';
import type { IWorkflowStore } from './store.ts';

export interface HandleNodeFailureDeps {
  store: IWorkflowStore;
  emitter: { emit: (event: WorkflowEmitterEvent) => void };
  log: Logger;
  logNodeError: (
    logDir: string,
    workflowRunId: string,
    nodeId: string,
    errorMsg: string
  ) => Promise<void>;
}

export interface HandleNodeFailureContext {
  /** Error message text — used for classification + persisted in node_failed event */
  errorMsg: string;
  /** Standard log dir for logNodeError */
  logDir: string;
  /** Node-level retry counter (1-based). Defaults to 1 if caller doesn't track. */
  attempt?: number;
  /** Has the node produced any output so far? Used by sentinel_mismatch heuristic. */
  hasOutput?: boolean;
  /** Node output captured before failure (returned in NodeOutput.output) */
  outputSoFar?: string;
  /** Node type string for classify disambiguation. AI-node sites can omit (only `loop` matters for v1). */
  nodeType?: string;
  /** Optional bash exit code (not present at AI-node sites; reserved for future bash-site wiring) */
  exitCode?: number;
  /** Optional HTTP status code (not present at AI-node sites; reserved) */
  statusCode?: number;
  /** Optional extra data fields to attach to the persisted node_failed event */
  extraEventData?: Record<string, unknown>;
}

export interface HandleNodeFailureResult {
  output: NodeOutput;
  decision: Decision;
  errorClass: string;
}

/**
 * Shared node-failure handler. Replaces the 5-step log + logNodeError + createWorkflowEvent +
 * emitter.emit + return-failed pattern at each AI-node failure site in dag-executor.ts.
 *
 * Returns a NodeOutput the caller returns directly. The caller remains responsible for
 * site-specific housekeeping (throttle-map cleanup, etc).
 */
export async function handleNodeFailure(
  deps: HandleNodeFailureDeps,
  workflowRun: WorkflowRun,
  node: DagNode,
  ctx: HandleNodeFailureContext
): Promise<HandleNodeFailureResult> {
  const attempt = ctx.attempt ?? 1;
  const hasOutput = ctx.hasOutput ?? false;

  const errorClass = classifyError({
    message: ctx.errorMsg,
    nodeId: node.id,
    nodeType: ctx.nodeType,
    exitCode: ctx.exitCode,
    statusCode: ctx.statusCode,
  });

  const result = decide({
    errorClass,
    attempt,
    hasOutput,
    nodeId: node.id,
  });

  // Observability — Mission Control "Workflow Decisions" tab will consume this when
  // persistence lands in v2. For v1 we only emit a structured log line.
  deps.log.info(
    {
      module: 'overseer',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeType: ctx.nodeType,
      errorClass,
      decision: result.decision,
      reason: result.reason,
      attempt,
      hasOutput,
    },
    'overseer.decision'
  );

  // Preserve the existing 4 housekeeping calls.
  await deps.logNodeError(ctx.logDir, workflowRun.id, node.id, ctx.errorMsg);

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_failed',
      step_name: node.id,
      data: {
        error: ctx.errorMsg,
        overseer_class: errorClass,
        overseer_decision: result.decision,
        ...(ctx.extraEventData ?? {}),
      },
    })
    .catch((err: Error) => {
      deps.log.error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
        'workflow_event_persist_failed'
      );
    });

  deps.emitter.emit({
    type: 'node_failed',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.command ?? node.id,
    error: ctx.errorMsg,
  });

  // Translate decision to NodeOutput state.
  // Exhaustiveness: if Decision ever gains a value we don't handle, the `never` assignment
  // becomes a compile error.
  const output = translateDecision(result.decision, ctx.errorMsg, ctx.outputSoFar ?? '');

  return { output, decision: result.decision, errorClass };
}

function translateDecision(decision: Decision, errorMsg: string, outputSoFar: string): NodeOutput {
  switch (decision) {
    case 'escalate':
      return { state: 'failed', output: outputSoFar, error: errorMsg };

    case 'skip':
      // Use existing NodeState.skipped — graceful skip propagates correctly through
      // checkTriggerRule's `all_success` default (downstream nodes also skip).
      return { state: 'skipped', output: outputSoFar };

    case 'retry':
      // v1: retry at AI-node sites requires SDK-level restart that doesn't exist yet.
      // A naive sleep+recursion inside the streaming path would deadlock. Log a warn
      // and fall through to escalate behavior. Bash-node sites (sibling WO) will be
      // the first to honor `retry` for real.
      return { state: 'failed', output: outputSoFar, error: errorMsg };

    case 'commit_and_push_anyway':
      // Only emitted by sentinel_mismatch+hasOutput, which requires nodeType==='loop'
      // and the SDK 'returned success' message. None of the 4 v1 AI-node sites can
      // produce this combination. Reserved for bash/loop-node integration in sibling WO.
      // For v1: treat as escalate (no PR-with-note path wired at AI-node sites).
      return { state: 'failed', output: outputSoFar, error: errorMsg };

    default: {
      // Compile-time exhaustiveness guard. If Decision gains a 5th variant this fails to build.
      decision satisfies never;
      return { state: 'failed', output: outputSoFar, error: errorMsg };
    }
  }
}
