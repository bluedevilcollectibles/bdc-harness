/**
 * CycleBanner — top-left overlay on WorkflowDagViewer that surfaces the
 * self-repair loop's aggregate state (WO-MC-SELF-REPAIR-LOOP-VIZ-01, Gap B).
 *
 * Renders ONLY when the lane has actually looped at least once
 * (cycleState.hasLoopActivity) OR is currently paused awaiting a human.
 * A clean linear run (no loop traversals) shows NOTHING — no false
 * positives, no phantom banner.
 *
 * Mirror of the existing top-right `currentlyExecuting` badge in
 * WorkflowDagViewer; reuses the same surface treatment for visual parity.
 */
import { Pause, RefreshCw, CheckCircle2 } from 'lucide-react';
import type { CycleState } from '@/lib/dag-self-repair-loop';

interface CycleBannerProps {
  cycleState: CycleState;
}

export function CycleBanner({ cycleState }: CycleBannerProps): React.ReactElement | null {
  // Visibility guard (Section 11 Test 3 / Stop Point "No-loop run renders clean"):
  // only render when the lane has actually looped or is paused.
  if (!cycleState.hasLoopActivity && !cycleState.paused) return null;

  const { currentCycle, currentRung, paused, resolved } = cycleState;

  let icon: React.ReactElement;
  let label: string;
  let tone: 'paused' | 'running' | 'resolved' = 'running';

  if (paused) {
    icon = <Pause className="h-3.5 w-3.5 text-warning" />;
    label = `cycle ${String(currentCycle)} — PAUSED — awaiting human`;
    tone = 'paused';
  } else if (resolved) {
    icon = <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
    label = `self-repair: ${String(currentCycle)} cycle${currentCycle === 1 ? '' : 's'}, resolved`;
    tone = 'resolved';
  } else {
    icon = <RefreshCw className="h-3.5 w-3.5 text-accent-bright animate-spin" />;
    const rungLabel = currentRung ?? 'in-flight';
    label = `self-repair cycle ${String(currentCycle)} — current rung: ${rungLabel}`;
    tone = 'running';
  }

  const toneClass =
    tone === 'paused'
      ? 'border-warning/40 bg-warning/10'
      : tone === 'resolved'
        ? 'border-success/40 bg-success/10'
        : 'border-accent/40 bg-accent/5';

  return (
    <div
      role="status"
      aria-label={label}
      data-testid="cycle-banner"
      className={`absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md backdrop-blur-sm border px-3 py-1.5 text-xs shadow-sm ${toneClass}`}
    >
      {icon}
      <span className="font-medium text-text-primary">{label}</span>
    </div>
  );
}
