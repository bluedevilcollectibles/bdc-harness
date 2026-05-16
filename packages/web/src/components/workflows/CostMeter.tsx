import { formatCostUsd } from '@/lib/format';

const COST_WARN_USD = 2;
const COST_DANGER_USD = 5;

interface CostMeterProps {
  totalUsd: number;
  isRunning: boolean;
}

export function CostMeter({ totalUsd, isRunning }: CostMeterProps): React.ReactElement {
  const costUsd = totalUsd;
  let colorClass = 'text-text-tertiary';
  if (costUsd > 0 && costUsd < COST_WARN_USD) {
    colorClass = 'text-success';
  } else if (costUsd >= COST_WARN_USD && costUsd <= COST_DANGER_USD) {
    colorClass = 'text-amber-400';
  } else if (costUsd > COST_DANGER_USD) {
    colorClass = 'text-error font-bold';
  }

  return (
    <span className="flex items-center gap-1 text-xs shrink-0" aria-label="run cost usd">
      <span className="text-text-tertiary">cost:</span>
      <span className={colorClass}>{formatCostUsd(costUsd)}</span>
      {isRunning && costUsd > 0 && (
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
      )}
    </span>
  );
}
