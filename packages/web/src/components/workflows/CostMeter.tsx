import { formatCostUsd } from '@/lib/format';

const COST_THRESHOLD_WARN = 2;
const COST_THRESHOLD_ERROR = 5;

interface CostMeterProps {
  totalCostUsd: number;
}

export function CostMeter({ totalCostUsd }: CostMeterProps): React.ReactElement {
  let colorClass: string;
  if (totalCostUsd === 0) {
    colorClass = 'text-text-secondary';
  } else if (totalCostUsd < COST_THRESHOLD_WARN) {
    colorClass = 'text-success';
  } else if (totalCostUsd < COST_THRESHOLD_ERROR) {
    colorClass = 'text-warning';
  } else {
    colorClass = 'text-error';
  }

  return (
    <span className={`text-xs font-mono ${colorClass}`} title="Estimated run cost">
      {formatCostUsd(totalCostUsd)}
    </span>
  );
}
