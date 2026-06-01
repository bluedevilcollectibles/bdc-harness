/**
 * Self-repair loop visualization helpers (WO-MC-SELF-REPAIR-LOOP-VIZ-01).
 *
 * Pure read-render: composes the existing workflow_events stream + the YAML
 * topology into three derived artifacts that the run-detail graph uses:
 *
 *   1. LoopArc[] — back-edges that the YAML's `depends_on` chain does not
 *      express (review->repair revisit, gate->resume, internal `loop:`
 *      iterations). Rendered as dashed overlay edges by WorkflowDagViewer;
 *      dagre is NOT re-run on these so it cannot crash on a cycle.
 *   2. CycleState — the small aggregate the CycleBanner needs: which
 *      ladder rung is active, how many cycles deep the lane has gone,
 *      whether it is paused waiting for a human, whether it resolved.
 *   3. Approval-context recovery — pulls the latest unresolved
 *      approval_requested event's data so the REST hydrate (which does
 *      not see SSE) can still surface the gate message and node id to
 *      the inline Approve/Reject affordance.
 *
 * No new instrumentation, no schema change, no backend mutation — every
 * input here is read-only data already in remote_agent_workflow_events
 * or the workflow YAML.
 */

import type { DagNode, WorkflowEventResponse } from '@/lib/api';

export type LoopArcType = 'self-loop' | 'review-repair' | 'gate-resume';

export interface LoopArc {
  /** Stable id so React Flow can dedupe across re-renders. */
  id: string;
  source: string;
  target: string;
  type: LoopArcType;
  /** Number of times this loop arc has been traversed in the run. */
  count: number;
}

export interface CycleState {
  /** 1-based cycle counter: how many times the self-repair lane went around. */
  currentCycle: number;
  /** Node id of the currently-active ladder rung (running or paused), or null. */
  currentRung: string | null;
  /** True when the run is paused on an approval gate with no later approval_received. */
  paused: boolean;
  /** Node id of the paused approval gate, or null. */
  pausedNodeId: string | null;
  /** True when the run terminated successfully. */
  resolved: boolean;
  /** Message recovered from the unresolved approval_requested event's data, if any. */
  approvalMessage?: string;
  /** True if any review->repair or gate->resume traversal has occurred. */
  hasLoopActivity: boolean;
}

export interface ApprovalContext {
  nodeId: string;
  message: string;
}

/**
 * Heuristic node-class detectors. Identifiers come from the YAML (e.g.
 * diff-review, diff-repair, block-classify, block-reclassify, pause-gate);
 * we read the live wiring, but recognise rungs by id substring so the
 * helpers work across any future workflow that follows the same naming
 * convention (review/repair/classify/gate).
 */
function idLower(id: string | null | undefined): string {
  return (id ?? '').toLowerCase();
}

export function isReviewNodeId(id: string | null | undefined): boolean {
  return idLower(id).includes('review');
}

export function isRepairNodeId(id: string | null | undefined): boolean {
  return idLower(id).includes('repair');
}

export function isClassifyNodeId(id: string | null | undefined): boolean {
  const lc = idLower(id);
  return lc.includes('classif');
}

export function isApprovalNode(node: DagNode): boolean {
  return node.approval !== undefined && node.approval !== null;
}

/** True if a node id looks like a self-repair ladder rung. */
export function isLadderNodeId(id: string | null | undefined): boolean {
  const lc = idLower(id);
  return (
    lc.includes('review') || lc.includes('repair') || lc.includes('classif') || lc.includes('gate')
  );
}

/**
 * Count events whose event_type === `type` AND step_name === `stepName`.
 * Reused by both arc-traversal counting and cycle aggregation.
 */
function countEvents(
  events: readonly WorkflowEventResponse[],
  type: string,
  stepName: string
): number {
  let n = 0;
  for (const e of events) {
    if (e.event_type === type && e.step_name === stepName) n++;
  }
  return n;
}

/**
 * Build a reverse depends_on map: parent id -> children ids.
 * Used to walk forward from a repair node to find its eventual "revisit" review node.
 */
function buildChildMap(yamlNodes: readonly DagNode[]): Map<string, string[]> {
  const childMap = new Map<string, string[]>();
  for (const node of yamlNodes) {
    for (const dep of node.depends_on ?? []) {
      const arr = childMap.get(dep) ?? [];
      arr.push(node.id);
      childMap.set(dep, arr);
    }
  }
  return childMap;
}

/**
 * Find the nearest downstream node from `startId` whose id contains "review".
 * BFS over the child map; returns null if no such node exists.
 */
function findDownstreamReview(startId: string, childMap: Map<string, string[]>): string | null {
  const visited = new Set<string>([startId]);
  const queue: string[] = [...(childMap.get(startId) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (isReviewNodeId(cur)) return cur;
    for (const child of childMap.get(cur) ?? []) queue.push(child);
  }
  return null;
}

/**
 * Find the nearest upstream node from `startId` whose id matches `predicate`.
 * BFS over depends_on; returns null if none matches.
 */
function findUpstreamMatching(
  startId: string,
  yamlNodes: readonly DagNode[],
  predicate: (id: string) => boolean
): string | null {
  const nodeMap = new Map(yamlNodes.map(n => [n.id, n]));
  const visited = new Set<string>([startId]);
  const start = nodeMap.get(startId);
  if (!start) return null;
  const queue: string[] = [...(start.depends_on ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (predicate(cur)) return cur;
    const node = nodeMap.get(cur);
    if (node) for (const dep of node.depends_on ?? []) queue.push(dep);
  }
  return null;
}

/**
 * deriveLoopArcs — Gap A in the WO spec.
 *
 * Returns the back-edges the depends_on topology does not express. Empty
 * array for non-looped runs (no false positives). The arcs are visual
 * overlays only — they are NOT fed to dagre (see WorkflowDagViewer).
 */
export function deriveLoopArcs(
  yamlNodes: readonly DagNode[],
  events: readonly WorkflowEventResponse[]
): LoopArc[] {
  const arcs: LoopArc[] = [];

  // 1. Self-loop arcs: any node with a `loop:` block, ONCE its loop has actually
  //    iterated (loop_iteration_started seen). Count = iteration_started events.
  for (const node of yamlNodes) {
    if (!node.loop) continue;
    const count = countEvents(events, 'loop_iteration_started', node.id);
    if (count <= 0) continue;
    arcs.push({
      id: `__loop_self__:${node.id}`,
      source: node.id,
      target: node.id,
      type: 'self-loop',
      count,
    });
  }

  // 2. Review-repair revisit arcs: a repair node that has a "review" predecessor
  //    AND a "review" successor (e.g. diff-review -> diff-repair -> diff-review-final).
  //    The visual back-arc goes from the successor review back to the repair node;
  //    count = how many times either review rung emitted node_failed (the cycle signal).
  const childMap = buildChildMap(yamlNodes);
  for (const repair of yamlNodes) {
    if (!isRepairNodeId(repair.id)) continue;
    const priorReview = findUpstreamMatching(repair.id, yamlNodes, isReviewNodeId);
    if (!priorReview) continue;
    const revisit = findDownstreamReview(repair.id, childMap);
    if (!revisit) continue;
    const count =
      countEvents(events, 'node_failed', priorReview) + countEvents(events, 'node_failed', revisit);
    if (count <= 0) continue;
    arcs.push({
      id: `__loop_rr__:${revisit}->${repair.id}`,
      source: revisit,
      target: repair.id,
      type: 'review-repair',
      count,
    });
  }

  // 3. Gate-resume arcs: an approval node ("pause-gate") that resumed after the
  //    human approved. Back-arc points from the gate to the nearest upstream
  //    classify/reclassify decision node. Count = approval_received(approved) events.
  for (const node of yamlNodes) {
    if (!isApprovalNode(node)) continue;
    const decisionDep = findUpstreamMatching(node.id, yamlNodes, isClassifyNodeId);
    if (!decisionDep) continue;
    let approvedCount = 0;
    for (const e of events) {
      if (e.event_type !== 'approval_received') continue;
      if (e.step_name !== node.id) continue;
      const decision = (e.data as { decision?: string }).decision;
      if (decision === 'approved') approvedCount++;
    }
    if (approvedCount <= 0) continue;
    arcs.push({
      id: `__loop_gate__:${node.id}->${decisionDep}`,
      source: node.id,
      target: decisionDep,
      type: 'gate-resume',
      count: approvedCount,
    });
  }

  return arcs;
}

/**
 * deriveCycleState — Gap B in the WO spec.
 *
 * Aggregates the cycle banner inputs from the event stream. Pure function of
 * events + run.status + yamlNodes; safe to call on every poll tick.
 *
 * `paused` is the architect-mandated discriminator: an approval-gate pause is
 * an approval_requested event with NO later approval_received for the same
 * step, AND run.status === 'paused'. This is distinct from operator-pause
 * (run_paused / run_resumed) which does not get an inline Approve/Reject
 * affordance.
 */
export function deriveCycleState(
  yamlNodes: readonly DagNode[],
  events: readonly WorkflowEventResponse[],
  runStatus: string | undefined
): CycleState {
  // Cycle count: 1 base + one for every review failure (each failure forces
  // a repair pass that re-enters review) + one for every gate-resume (each
  // human approval restarts the lane).
  const reviewIds = new Set<string>();
  const approvalIds = new Set<string>();
  for (const n of yamlNodes) {
    if (isReviewNodeId(n.id)) reviewIds.add(n.id);
    if (isApprovalNode(n)) approvalIds.add(n.id);
  }

  let cycleCount = 1;
  let hasLoopActivity = false;
  for (const e of events) {
    const stepName = e.step_name ?? '';
    if (!stepName) continue;
    if (e.event_type === 'node_failed' && reviewIds.has(stepName)) {
      cycleCount++;
      hasLoopActivity = true;
    }
    if (e.event_type === 'approval_received' && approvalIds.has(stepName)) {
      const decision = (e.data as { decision?: string }).decision;
      if (decision === 'approved') {
        cycleCount++;
        hasLoopActivity = true;
      }
    }
    if (e.event_type === 'loop_iteration_started') {
      hasLoopActivity = true;
    }
  }

  // Approval pause discriminator. Walk events in chronological order tracking
  // active approval_requested per step_name; an approval_received clears it.
  const sortedApprovalEvents = events
    .filter(e => e.event_type === 'approval_requested' || e.event_type === 'approval_received')
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const activeApprovals = new Map<string, { message: string; requestedAt: number }>();
  for (const e of sortedApprovalEvents) {
    const nodeId = e.step_name ?? '';
    if (!nodeId) continue;
    if (e.event_type === 'approval_requested') {
      const message = (e.data as { message?: string }).message ?? '';
      activeApprovals.set(nodeId, {
        message,
        requestedAt: new Date(e.created_at).getTime(),
      });
    } else {
      // approval_received clears the active approval for that node
      activeApprovals.delete(nodeId);
    }
  }

  let pausedNodeId: string | null = null;
  let approvalMessage: string | undefined;
  // Approval-gate pause requires BOTH run.status === 'paused' AND an
  // unresolved approval_requested. The status alone is insufficient — an
  // operator-triggered run_paused also sets run.status to 'paused' but does
  // not have an approval_requested event.
  if (runStatus === 'paused' && activeApprovals.size > 0) {
    let latestAt = -1;
    for (const [nodeId, info] of activeApprovals) {
      if (info.requestedAt > latestAt) {
        latestAt = info.requestedAt;
        pausedNodeId = nodeId;
        approvalMessage = info.message || undefined;
      }
    }
  }

  // Current rung: the latest ladder node that emitted node_started AND has
  // not since emitted a terminal node event. If none is running but we are
  // paused, the paused node is the active rung.
  const startedAt = new Map<string, number>();
  const terminatedRungs = new Set<string>();
  for (const e of events) {
    const stepName = e.step_name ?? '';
    if (!stepName) continue;
    if (!isLadderNodeId(stepName) && !approvalIds.has(stepName)) continue;
    const ts = new Date(e.created_at).getTime();
    if (e.event_type === 'node_started') {
      // Keep the latest started timestamp for each rung (loops re-start)
      startedAt.set(stepName, ts);
      // A re-start clears any prior terminal status for this rung
      terminatedRungs.delete(stepName);
    } else if (
      e.event_type === 'node_completed' ||
      e.event_type === 'node_completed_with_warning' ||
      e.event_type === 'node_failed' ||
      e.event_type === 'node_skipped'
    ) {
      const startTs = startedAt.get(stepName);
      if (startTs !== undefined && ts >= startTs) {
        terminatedRungs.add(stepName);
      }
    }
  }

  let currentRung: string | null = null;
  let currentRungAt = -1;
  for (const [nodeId, ts] of startedAt) {
    if (terminatedRungs.has(nodeId)) continue;
    if (ts > currentRungAt) {
      currentRungAt = ts;
      currentRung = nodeId;
    }
  }
  if (currentRung === null && pausedNodeId !== null) {
    currentRung = pausedNodeId;
  }

  const resolved = runStatus === 'completed';

  return {
    currentCycle: cycleCount,
    currentRung,
    paused: pausedNodeId !== null,
    pausedNodeId,
    resolved,
    approvalMessage,
    hasLoopActivity,
  };
}

/**
 * Extract the unresolved approval context (node id + message) from events.
 *
 * The REST hydrate in WorkflowExecution does NOT populate
 * WorkflowState.approval — that field is set only on the SSE path
 * (workflow-store.ts:196-209). On a page refresh of a paused run the SSE
 * stream may not have replayed, so we recover the context from the events
 * table here so the inline Approve/Reject affordance still has something to
 * bind to.
 *
 * The presence of an unresolved approval_requested event is itself the
 * discriminator for an approval-gate pause vs an operator pause (operator
 * pauses never emit approval_requested) — so this helper does NOT need the
 * workflow definition.
 */
export function extractApprovalContext(
  events: readonly WorkflowEventResponse[],
  runStatus: string | undefined
): ApprovalContext | undefined {
  if (runStatus !== 'paused') return undefined;

  const sortedApprovalEvents = events
    .filter(e => e.event_type === 'approval_requested' || e.event_type === 'approval_received')
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const active = new Map<string, { message: string; requestedAt: number }>();
  for (const e of sortedApprovalEvents) {
    const nodeId = e.step_name ?? '';
    if (!nodeId) continue;
    if (e.event_type === 'approval_requested') {
      const message = (e.data as { message?: string }).message ?? '';
      active.set(nodeId, { message, requestedAt: new Date(e.created_at).getTime() });
    } else {
      active.delete(nodeId);
    }
  }

  if (active.size === 0) return undefined;
  let pickedId: string | null = null;
  let pickedMessage = '';
  let latestAt = -1;
  for (const [nodeId, info] of active) {
    if (info.requestedAt > latestAt) {
      latestAt = info.requestedAt;
      pickedId = nodeId;
      pickedMessage = info.message;
    }
  }
  if (pickedId === null) return undefined;
  return { nodeId: pickedId, message: pickedMessage };
}
