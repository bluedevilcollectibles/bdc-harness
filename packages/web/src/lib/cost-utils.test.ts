import { describe, expect, it } from 'bun:test';
import { formatCostUsd, costColorClass, COST_THRESHOLDS } from './cost-utils';

describe('formatCostUsd', () => {
  it('formats zero as $0.00', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
  });

  it('formats sub-cent amounts with 4 decimal places', () => {
    expect(formatCostUsd(0.0042)).toBe('$0.0042');
    expect(formatCostUsd(0.001)).toBe('$0.0010');
    expect(formatCostUsd(0.009)).toBe('$0.0090');
  });

  it('formats cent-level amounts with 2 decimal places', () => {
    expect(formatCostUsd(0.01)).toBe('$0.01');
    expect(formatCostUsd(0.99)).toBe('$0.99');
  });

  it('formats dollar amounts with 2 decimal places', () => {
    expect(formatCostUsd(1.23)).toBe('$1.23');
    expect(formatCostUsd(10.5)).toBe('$10.50');
  });

  it('formats multi-dollar amounts', () => {
    expect(formatCostUsd(100)).toBe('$100.00');
    expect(formatCostUsd(1234.56)).toBe('$1234.56');
  });
});

describe('costColorClass', () => {
  it('returns success class for zero', () => {
    expect(costColorClass(0)).toBe('text-success');
  });

  it('returns success class below $2 threshold', () => {
    expect(costColorClass(1.99)).toBe('text-success');
  });

  it('returns warning class at $2 boundary', () => {
    expect(costColorClass(COST_THRESHOLDS.warn)).toBe('text-warning');
  });

  it('returns warning class between $2 and $5', () => {
    expect(costColorClass(3.5)).toBe('text-warning');
  });

  it('returns warning class just below $5', () => {
    expect(costColorClass(4.99)).toBe('text-warning');
  });

  it('returns error class at $5 boundary', () => {
    expect(costColorClass(COST_THRESHOLDS.error)).toBe('text-error');
  });

  it('returns error class above $5', () => {
    expect(costColorClass(7.5)).toBe('text-error');
  });
});
