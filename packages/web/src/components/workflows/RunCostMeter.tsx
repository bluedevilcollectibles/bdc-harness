import { formatCostUsd } from '@/lib/format';

export const COST_THRESHOLD_WARN = 2;
export const COST_THRESHOLD_ERROR = 5;

interface RunCostMeterProps {
  costUsd: number;
  isRunning: boolean;
}

export function RunCostMeter({ costUsd, isRunning }: RunCostMeterProps): React.ReactElement {
  const colorClass =
    costUsd === 0
      ? 'text-text-secondary'
      : costUsd >= COST_THRESHOLD_ERROR
        ? 'text-error'
        : costUsd >= COST_THRESHOLD_WARN
          ? 'text-warning'
          : 'text-success';

  return (
    <span className={`flex items-center gap-1 text-xs font-mono ${colorClass}`}>
      {isRunning && (
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      )}
      {formatCostUsd(costUsd)}
    </span>
  );
}
