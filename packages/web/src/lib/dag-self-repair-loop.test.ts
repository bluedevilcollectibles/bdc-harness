/**
 * WO-MC-SELF-REPAIR-LOOP-VIZ-01 — tests for self-repair loop derivation.
 *
 * Asserts real behavior (not "did not throw") against fixture events shaped
 * exactly like remote_agent_workflow_events: id, workflow_run_id,
 * event_type, step_index, step_name, data, created_at.
 *
 * Modelled on the bdc-feature-development YAML topology (real node ids):
 *   diff-review -> diff-repair (loop) -> capture-diff-final -> diff-review-final
 *     -> block-classify -> opus-repair (when BLOCKED) -> block-reclassify
 *     -> pause-gate (approval, when BLOCKED)
 */

import { describe, expect, it } from 'bun:test';
import {
  deriveLoopArcs,
  deriveCycleState,
  extractApprovalContext,
  isLadderNodeId,
  isReviewNodeId,
  isRepairNodeId,
} from './dag-self-repair-loop';
import { dagNodesToReactFlow, mergeLoopArcsIntoEdges, hasCycle } from './dag-layout';
import type { DagNode, WorkflowEventResponse } from './api';

let eventSeq = 0;
function makeEvent(
  overrides: Partial<WorkflowEventResponse> & { event_type: string; step_name?: string }
): WorkflowEventResponse {
  eventSeq++;
  return {
    id: `ev-${String(eventSeq)}`,
    workflow_run_id: 'run-test',
    event_type: overrides.event_type,
    step_index: overrides.step_index ?? null,
    step_name: overrides.step_name ?? null,
    data: overrides.data ?? {},
    // Monotonically increasing fixture timestamps so chronological sorts are stable.
    created_at: overrides.created_at ?? new Date(1_700_000_000_000 + eventSeq * 1000).toISOString(),
  };
}

/**
 * The real bdc-feature-development ladder (abridged to the rungs the
 * visualization cares about). Provider/agent fields stripped — only the
 * topology and `loop:` / `approval:` markers matter for derivation.
 */
function ladderNodes(): DagNode[] {
  return [
    { id: 'capture-diff', depends_on: [], bash: 'echo capture' },
    {
      id: 'diff-review',
      depends_on: ['capture-diff'],
      prompt: 'review the diff',
    },
    {
      id: 'diff-repair',
      depends_on: ['diff-review'],
      loop: {
        prompt: 'repair the diff',
        until: '__NEVER__',
        max_iterations: 3,
        fresh_context: true,
      },
    },
    { id: 'capture-diff-final', depends_on: ['diff-repair'], bash: 'echo capture-final' },
    {
      id: 'diff-review-final',
      depends_on: ['capture-diff-final'],
      prompt: 'final review',
    },
    { id: 'block-classify', depends_on: ['diff-review-final'], bash: 'echo classify' },
    {
      id: 'opus-repair',
      depends_on: ['block-classify'],
      when: "$block-classify.output.status == 'BLOCKED'",
      prompt: 'opus repair',
    },
    {
      id: 'block-reclassify',
      depends_on: ['block-classify', 'opus-repair'],
      bash: 'echo reclassify',
    },
    {
      id: 'pause-gate',
      depends_on: ['block-reclassify'],
      when: "$block-reclassify.output.status == 'BLOCKED'",
      approval: {
        message: 'BLOCKED — review and approve or reject',
      },
    },
  ];
}

describe('node-class detectors', () => {
  it('identifies review, repair, and ladder nodes by id', () => {
    expect(isReviewNodeId('diff-review')).toBe(true);
    expect(isReviewNodeId('diff-review-final')).toBe(true);
    expect(isReviewNodeId('capture-diff')).toBe(false);
    expect(isRepairNodeId('diff-repair')).toBe(true);
    expect(isRepairNodeId('opus-repair')).toBe(true);
    expect(isRepairNodeId('diff-review')).toBe(false);
    expect(isLadderNodeId('pause-gate')).toBe(true);
    expect(isLadderNodeId('block-classify')).toBe(true);
    expect(isLadderNodeId('capture-diff')).toBe(false);
  });
});

describe('Test 1 — looped run (success case)', () => {
  it('derives at least one back-edge with traversal count for a real cycle', () => {
    eventSeq = 0;
    const nodes = ladderNodes();
    const events: WorkflowEventResponse[] = [
      // First review pass FAILED — this is the cycle signal
      makeEvent({ event_type: 'node_started', step_name: 'diff-review' }),
      makeEvent({
        event_type: 'node_failed',
        step_name: 'diff-review',
        data: { error: 'DIFF_REVIEW=needs_revision' },
      }),
      // Repair loop iterated twice
      makeEvent({ event_type: 'node_started', step_name: 'diff-repair' }),
      makeEvent({
        event_type: 'loop_iteration_started',
        step_name: 'diff-repair',
        data: { iteration: 1, maxIterations: 3 },
      }),
      makeEvent({
        event_type: 'loop_iteration_completed',
        step_name: 'diff-repair',
        data: { iteration: 1 },
      }),
      makeEvent({
        event_type: 'loop_iteration_started',
        step_name: 'diff-repair',
        data: { iteration: 2, maxIterations: 3 },
      }),
      makeEvent({
        event_type: 'loop_iteration_completed',
        step_name: 'diff-repair',
        data: { iteration: 2 },
      }),
      makeEvent({ event_type: 'node_completed', step_name: 'diff-repair' }),
      // Final review passed — completes the cycle
      makeEvent({ event_type: 'node_started', step_name: 'diff-review-final' }),
      makeEvent({ event_type: 'node_completed', step_name: 'diff-review-final' }),
    ];

    const arcs = deriveLoopArcs(nodes, events);

    // We expect (at least) a self-loop arc on diff-repair AND a review-repair
    // back-arc from diff-review-final to diff-repair.
    const selfLoop = arcs.find(a => a.type === 'self-loop' && a.source === 'diff-repair');
    expect(selfLoop).toBeDefined();
    expect(selfLoop?.count).toBe(2); // two loop_iteration_started events

    const reviewRepairArc = arcs.find(
      a =>
        a.type === 'review-repair' && a.source === 'diff-review-final' && a.target === 'diff-repair'
    );
    expect(reviewRepairArc).toBeDefined();
    expect(reviewRepairArc?.count).toBeGreaterThanOrEqual(1);

    // Cycle banner aggregate: cycleCount > 1 means we have looped at least once.
    const state = deriveCycleState(nodes, events, 'completed');
    expect(state.hasLoopActivity).toBe(true);
    expect(state.currentCycle).toBeGreaterThanOrEqual(2); // 1 base + 1 review failure
    expect(state.resolved).toBe(true);
    expect(state.paused).toBe(false);
  });

  it('renders into ReactFlow edges as dashed back-edges with x-count labels', () => {
    eventSeq = 0;
    const nodes = ladderNodes();
    const events: WorkflowEventResponse[] = [
      makeEvent({ event_type: 'node_failed', step_name: 'diff-review' }),
      makeEvent({ event_type: 'node_failed', step_name: 'diff-review' }),
      makeEvent({
        event_type: 'loop_iteration_started',
        step_name: 'diff-repair',
        data: { iteration: 1 },
      }),
      makeEvent({
        event_type: 'loop_iteration_started',
        step_name: 'diff-repair',
        data: { iteration: 2 },
      }),
      makeEvent({ event_type: 'node_completed', step_name: 'diff-review-final' }),
    ];
    const arcs = deriveLoopArcs(nodes, events);
    const { nodes: rfNodes, edges: rfEdges } = dagNodesToReactFlow(nodes);
    const merged = mergeLoopArcsIntoEdges(rfNodes, rfEdges, arcs);

    // Loop arcs must be added — at least one with a `x<n>` label.
    const loopArcEdges = merged.filter(e => e.id.startsWith('__loop_'));
    expect(loopArcEdges.length).toBeGreaterThan(0);

    // Their style must be the warning dashed treatment so the operator can
    // distinguish them from depends_on edges.
    for (const e of loopArcEdges) {
      const style = e.style as { stroke?: string; strokeDasharray?: string } | undefined;
      expect(style?.stroke).toBe('var(--warning)');
      expect(style?.strokeDasharray).toBe('6 4');
    }

    // The label for a multi-traversal arc must be `x<count>`.
    const labelled = loopArcEdges.find(e => typeof e.label === 'string' && /^x\d+$/.test(e.label));
    expect(labelled).toBeDefined();

    // Sanity: the base depends_on edges are still present (we did not drop them).
    const dependsOnEdges = merged.filter(e => !e.id.startsWith('__loop_'));
    expect(dependsOnEdges.length).toBe(rfEdges.length);
  });
});

describe('Test 2 — paused run with approval gate', () => {
  it('flags pause-gate as paused with the recovered message + currentCycle reflects pause', () => {
    eventSeq = 0;
    const nodes = ladderNodes();
    const events: WorkflowEventResponse[] = [
      // Lane progressed through review-repair successfully, then BLOCKED.
      makeEvent({ event_type: 'node_failed', step_name: 'diff-review' }),
      makeEvent({ event_type: 'node_completed', step_name: 'diff-review-final' }),
      makeEvent({ event_type: 'node_completed', step_name: 'block-classify' }),
      makeEvent({ event_type: 'node_completed', step_name: 'opus-repair' }),
      makeEvent({ event_type: 'node_completed', step_name: 'block-reclassify' }),
      // pause-gate paused with approval_requested. NO subsequent approval_received.
      makeEvent({ event_type: 'node_started', step_name: 'pause-gate' }),
      makeEvent({
        event_type: 'approval_requested',
        step_name: 'pause-gate',
        data: {
          message: 'BLOCKED — please review and approve or reject',
          nodeId: 'pause-gate',
        },
      }),
    ];

    const state = deriveCycleState(nodes, events, 'paused');
    expect(state.paused).toBe(true);
    expect(state.pausedNodeId).toBe('pause-gate');
    expect(state.approvalMessage).toBe('BLOCKED — please review and approve or reject');
    expect(state.currentRung).toBe('pause-gate');

    // extractApprovalContext should agree (it must be standalone, not need yamlNodes).
    const ctx = extractApprovalContext(events, 'paused');
    expect(ctx).toBeDefined();
    expect(ctx?.nodeId).toBe('pause-gate');
    expect(ctx?.message).toBe('BLOCKED — please review and approve or reject');

    // run.status !== 'paused' must NOT yield an approval context (so the
    // inline gate does not render after auto-resume).
    expect(extractApprovalContext(events, 'running')).toBeUndefined();
    expect(extractApprovalContext(events, 'completed')).toBeUndefined();
  });

  it('does NOT mark pause-gate as paused if approval_received cleared it', () => {
    eventSeq = 0;
    const events: WorkflowEventResponse[] = [
      makeEvent({
        event_type: 'approval_requested',
        step_name: 'pause-gate',
        data: { message: 'gate' },
      }),
      makeEvent({
        event_type: 'approval_received',
        step_name: 'pause-gate',
        data: { decision: 'approved' },
      }),
    ];
    expect(extractApprovalContext(events, 'paused')).toBeUndefined();
    const state = deriveCycleState(ladderNodes(), events, 'paused');
    expect(state.paused).toBe(false);
    expect(state.pausedNodeId).toBeNull();
  });

  it('extractApprovalContext only fires when runStatus === paused', () => {
    eventSeq = 0;
    const events: WorkflowEventResponse[] = [
      makeEvent({
        event_type: 'approval_requested',
        step_name: 'pause-gate',
        data: { message: 'gate' },
      }),
    ];
    // operator-pause (run_paused) with no approval_requested -> no inline gate
    expect(extractApprovalContext([], 'paused')).toBeUndefined();
    // run is running -> never an inline gate
    expect(extractApprovalContext(events, 'running')).toBeUndefined();
  });
});

describe('Test 3 — no-loop run renders clean (no false positives)', () => {
  it('returns empty arcs + null banner state when zero loop traversals occurred', () => {
    eventSeq = 0;
    const nodes = ladderNodes();
    const events: WorkflowEventResponse[] = [
      makeEvent({ event_type: 'node_started', step_name: 'diff-review' }),
      makeEvent({ event_type: 'node_completed', step_name: 'diff-review' }),
      makeEvent({ event_type: 'node_completed', step_name: 'diff-repair' }),
      makeEvent({ event_type: 'node_completed', step_name: 'diff-review-final' }),
      makeEvent({ event_type: 'node_completed', step_name: 'block-classify' }),
      makeEvent({ event_type: 'node_completed', step_name: 'block-reclassify' }),
    ];

    const arcs = deriveLoopArcs(nodes, events);
    expect(arcs).toEqual([]);

    const state = deriveCycleState(nodes, events, 'completed');
    expect(state.hasLoopActivity).toBe(false);
    expect(state.paused).toBe(false);
    expect(state.currentCycle).toBe(1);

    // mergeLoopArcsIntoEdges with no arcs must return the depends_on edges unchanged.
    const { nodes: rfNodes, edges: rfEdges } = dagNodesToReactFlow(nodes);
    const merged = mergeLoopArcsIntoEdges(rfNodes, rfEdges, []);
    expect(merged.length).toBe(rfEdges.length);
    for (const e of merged) {
      expect(e.id.startsWith('__loop_')).toBe(false);
    }
  });
});

describe('Test 4 — failed-rung inline error', () => {
  it('preserves the node_failed data.error so ExecutionDagNode can render it inline', () => {
    eventSeq = 0;
    const nodes = ladderNodes();
    const errorMessage = 'codex 400: unsupported model "gpt-5.3-codex" - check provider auth';
    const events: WorkflowEventResponse[] = [
      makeEvent({ event_type: 'node_started', step_name: 'diff-review' }),
      makeEvent({
        event_type: 'node_failed',
        step_name: 'diff-review',
        data: { error: errorMessage },
      }),
    ];

    // The derivation does not throw away the error — it is available on the
    // events stream for the existing per-node REST hydrate to surface.
    const failed = events.find(e => e.event_type === 'node_failed');
    expect(failed).toBeDefined();
    expect((failed?.data as { error?: string }).error).toBe(errorMessage);

    // Single failure is still a cycle signal — but only if a downstream
    // revisit review node exists in the YAML, which it does (diff-review-final).
    const arcs = deriveLoopArcs(nodes, events);
    const reviewRepairArc = arcs.find(a => a.type === 'review-repair');
    expect(reviewRepairArc).toBeDefined();
    expect(reviewRepairArc?.count).toBe(1);
  });
});

describe('Test 5 — post-approval gate-resume arc', () => {
  it('approval_received(approved) emits a gate-resume back-arc to the prior classify node', () => {
    eventSeq = 0;
    const nodes = ladderNodes();
    const events: WorkflowEventResponse[] = [
      makeEvent({ event_type: 'node_completed', step_name: 'block-reclassify' }),
      makeEvent({ event_type: 'node_started', step_name: 'pause-gate' }),
      makeEvent({
        event_type: 'approval_requested',
        step_name: 'pause-gate',
        data: { message: 'BLOCKED' },
      }),
      // Human approved
      makeEvent({
        event_type: 'approval_received',
        step_name: 'pause-gate',
        data: { decision: 'approved' },
      }),
    ];

    const arcs = deriveLoopArcs(nodes, events);
    const gateArc = arcs.find(a => a.type === 'gate-resume');
    expect(gateArc).toBeDefined();
    expect(gateArc?.source).toBe('pause-gate');
    // Should point back to the nearest upstream classify-class node — block-reclassify.
    expect(gateArc?.target).toBe('block-reclassify');
    expect(gateArc?.count).toBe(1);

    // After approval, deriveCycleState should NOT report `paused` even if
    // run.status is transiently 'failed' during auto-resume (a runtime quirk
    // — invariant 6e: this must not render as an error/terminal state).
    const transientFailed = deriveCycleState(nodes, events, 'failed');
    expect(transientFailed.paused).toBe(false);
    // The cycle counter increments for the approve traversal.
    expect(transientFailed.currentCycle).toBeGreaterThanOrEqual(2);
    expect(transientFailed.hasLoopActivity).toBe(true);

    // A rejected approval must NOT emit a gate-resume arc (no traversal).
    eventSeq = 0;
    const rejectedEvents: WorkflowEventResponse[] = [
      makeEvent({
        event_type: 'approval_requested',
        step_name: 'pause-gate',
        data: { message: 'BLOCKED' },
      }),
      makeEvent({
        event_type: 'approval_received',
        step_name: 'pause-gate',
        data: { decision: 'rejected' },
      }),
    ];
    const rejectedArcs = deriveLoopArcs(nodes, rejectedEvents);
    expect(rejectedArcs.find(a => a.type === 'gate-resume')).toBeUndefined();
  });
});

describe('mergeLoopArcsIntoEdges resilience', () => {
  it('drops arcs whose source or target is missing from the node set', () => {
    const nodes = ladderNodes();
    const { nodes: rfNodes, edges: rfEdges } = dagNodesToReactFlow(nodes);
    const merged = mergeLoopArcsIntoEdges(rfNodes, rfEdges, [
      {
        id: '__loop_bad__:ghost->void',
        source: 'ghost',
        target: 'void',
        type: 'review-repair',
        count: 9,
      },
    ]);
    expect(merged.find(e => e.id === '__loop_bad__:ghost->void')).toBeUndefined();
    expect(merged.length).toBe(rfEdges.length);
  });

  it('the depends_on subgraph (without loop arcs) remains acyclic', () => {
    const nodes = ladderNodes();
    const { nodes: rfNodes, edges: rfEdges } = dagNodesToReactFlow(nodes);
    const nodeIds = new Set(rfNodes.map(n => n.id));
    // hasCycle accepts edges with source/target as strings; ReactFlow Edge is compatible.
    const cycle = hasCycle(
      nodeIds,
      rfEdges.map(e => ({ source: e.source, target: e.target }))
    );
    expect(cycle).toBe(false);
  });
});
