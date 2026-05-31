import { useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
} from '@xyflow/react';
import type { Edge, NodeTypes } from '@xyflow/react';
import type { DagNodeState, WorkflowRunStatus, WorkflowStepStatus } from '@/lib/types';
import type { DagNode } from '@/lib/api';
import { dagNodesToReactFlow, mergeLoopArcsIntoEdges, resolveNodeDisplay } from '@/lib/dag-layout';
import type { CycleState, LoopArc } from '@/lib/dag-self-repair-loop';
import { formatDurationMs } from '@/lib/format';
import {
  executionDagNode,
  type ExecutionFlowNode,
  type ExecutionNodeData,
} from './ExecutionDagNode';
import { CycleBanner } from './CycleBanner';

import '@xyflow/react/dist/style.css';

// Defined at module scope — prevents ReactFlow from remounting nodes on every render
const nodeTypes: NodeTypes = { executionNode: executionDagNode };

const STATUS_MINIMAP_COLORS: Partial<Record<WorkflowStepStatus, string>> = {
  completed: 'var(--success)',
  running: 'var(--accent-bright)',
  failed: 'var(--error)',
  skipped: 'var(--text-tertiary)',
  // WO-MC-SELF-REPAIR-LOOP-VIZ-01: awaiting_approval renders amber in minimap.
  awaiting_approval: 'var(--warning)',
};
const DEFAULT_MINIMAP_COLOR = 'var(--surface-elevated)';

const EDGE_STROKE_BY_STATUS: Partial<Record<WorkflowStepStatus, string>> = {
  completed: 'var(--success)',
  running: 'var(--accent-bright)',
  failed: 'var(--error)',
  awaiting_approval: 'var(--warning)',
};
const DEFAULT_EDGE_STROKE = 'var(--border)';

interface WorkflowDagViewerProps {
  dagNodes: readonly DagNode[];
  liveStatus: readonly DagNodeState[];
  isRunning: boolean;
  currentlyExecuting?: { nodeName: string; startedAt: number };
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  /** WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap A): dashed back-edges for the
   *  review-repair / gate-resume / internal `loop:` arcs. Defaults to [],
   *  in which case the viewer renders exactly as before. */
  loopArcs?: readonly LoopArc[];
  /** WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap B): aggregate cycle state for the
   *  CycleBanner overlay. Null/undefined => no banner (clean linear render). */
  cycleState?: CycleState | null;
  /** Run-level status; used by the banner to choose tone (paused vs running
   *  vs resolved). */
  runStatus?: WorkflowRunStatus;
}

export function WorkflowDagViewer({
  dagNodes,
  liveStatus,
  isRunning,
  currentlyExecuting,
  selectedNodeId,
  onNodeClick,
  loopArcs,
  cycleState,
}: WorkflowDagViewerProps): React.ReactElement {
  // Compute topology layout ONCE from the workflow definition.
  // Only re-layout when the definition changes (node/edge count), not on status updates.
  const { baseNodes, edges: layoutedEdges } = useMemo(() => {
    const { nodes, edges } = dagNodesToReactFlow(dagNodes);
    return { baseNodes: nodes, edges };
  }, [dagNodes]);

  // WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap A): merge dashed loop-back arcs into
  // the depends_on edge set. Dagre is NOT re-run on the merged set — back
  // edges would either crash or move nodes. Arcs are visual overlays only.
  const edgesWithLoopArcs = useMemo(
    () => mergeLoopArcsIntoEdges(baseNodes, layoutedEdges, loopArcs ?? []),
    [baseNodes, layoutedEdges, loopArcs]
  );

  // Build a status lookup map from live SSE/REST data
  const statusMap = useMemo(() => {
    const map = new Map<string, DagNodeState>();
    for (const node of liveStatus) {
      map.set(node.nodeId, node);
    }
    return map;
  }, [liveStatus]);

  // Overlay live status onto the topology nodes.
  // Creates new node objects only for nodes whose status changed (React.memo handles the rest).
  const nodes: ExecutionFlowNode[] = useMemo(() => {
    return baseNodes.map(node => {
      const live = statusMap.get(node.id);
      // baseNodes is derived from dagNodes, so this find should always succeed
      const dagNode = dagNodes.find(dn => dn.id === node.id);
      const display = dagNode ? resolveNodeDisplay(dagNode) : node.data;
      return {
        ...node,
        type: 'executionNode',
        data: {
          ...node.data,
          ...display,
          status: live?.status,
          duration: live?.duration,
          error: live?.error,
          selected: node.id === selectedNodeId,
          currentIteration: live?.currentIteration,
          maxIterations: live?.maxIterations,
          costUsd: live?.costUsd,
          // WO-170: pass warning fields through to ExecutionDagNode so the
          // node renders yellow + shows the STATUS=*_failed tooltip.
          warningStatusLine: live?.warningStatusLine,
          warningPatterns: live?.warningPatterns,
          warningLoadBearing: live?.warningLoadBearing,
        },
      } as ExecutionFlowNode;
    });
  }, [baseNodes, statusMap, dagNodes, selectedNodeId]);

  // Color edges based on target node status.
  // Loop-arc overlays carry their own dashed style + warning color; do not
  // recolor them by target status (a paused gate would otherwise repaint the
  // self-loop arc in amber twice). Detect via the synthetic id prefix the
  // merge helper uses.
  const edges: Edge[] = useMemo(() => {
    return edgesWithLoopArcs.map(edge => {
      if (edge.id.startsWith('__loop_')) return edge;
      const targetStatus = statusMap.get(edge.target)?.status;
      const stroke = (targetStatus && EDGE_STROKE_BY_STATUS[targetStatus]) ?? DEFAULT_EDGE_STROKE;
      return {
        ...edge,
        animated: targetStatus === 'running',
        // ReactFlow SVG edges require inline style for stroke — className cannot target SVG stroke.
        style: { stroke, strokeWidth: 1.5 },
      };
    });
  }, [edgesWithLoopArcs, statusMap]);

  return (
    <div className="h-full w-full relative">
      {cycleState && <CycleBanner cycleState={cycleState} />}
      {isRunning && currentlyExecuting && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-md bg-surface/90 backdrop-blur-sm border border-border px-3 py-1.5 text-xs">
          <span className="inline-block w-2 h-2 rounded-full bg-accent-bright animate-pulse" />
          <span className="text-text-secondary">Executing:</span>
          <span className="font-medium text-text-primary">{currentlyExecuting.nodeName}</span>
          <span className="text-text-tertiary">
            {formatDurationMs(Date.now() - currentlyExecuting.startedAt)}
          </span>
        </div>
      )}
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
          onNodeClick={
            onNodeClick
              ? (_event, node): void => {
                  onNodeClick(node.id);
                }
              : undefined
          }
          fitView
          fitViewOptions={{ padding: 0.15 }}
          panOnDrag
          zoomOnScroll
          className="bg-background"
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border)" />
          <Controls showInteractive={false} className="!bg-surface !border-border" />
          <MiniMap
            nodeColor={(node): string => {
              const data = node.data as ExecutionNodeData;
              return (data.status && STATUS_MINIMAP_COLORS[data.status]) ?? DEFAULT_MINIMAP_COLOR;
            }}
            className="!bg-surface !border-border"
            maskColor="rgba(0, 0, 0, 0.6)"
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
