export const COST_THRESHOLDS = {
  warn: 2,
  error: 5,
} as const;

/**
 * Formats a USD cost value into a compact human-readable string.
 * Sub-cent amounts show 4 decimal places; others show 2.
 */
export function formatCostUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Returns a Tailwind text color class based on cost thresholds.
 * green (<$2), yellow ($2-$5), red (>$5).
 */
export function costColorClass(usd: number): string {
  if (usd >= COST_THRESHOLDS.error) return 'text-error';
  if (usd >= COST_THRESHOLDS.warn) return 'text-warning';
  return 'text-success';
}
