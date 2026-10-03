import type { Money, Spend, Usage } from '@kramahq/contract';

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export interface Aggregate {
  total: Spend;
  /** True when some items reported cost and others did not, so `total` undercounts. */
  partial: boolean;
}

/**
 * Sums provider-reported cost. `null` means "not reported" and is never estimated:
 * all-null aggregates to `null`, a mix sums the reported part and flags `partial`.
 */
export function aggregateSpend(items: readonly Spend[]): Aggregate {
  const reported = items.filter((i): i is Money => i !== null);
  if (reported.length === 0) return { total: null, partial: false };
  return {
    total: { amount: round(reported.reduce((a, i) => a + i.amount, 0)), currency: 'USD' },
    partial: reported.length < items.length,
  };
}

export const addSpend = (a: Spend, b: Spend): Spend => aggregateSpend([a, b]).total;

/** Sums usage per unit (units are never mixed). */
export function aggregateUsage(items: readonly (readonly Usage[])[]): Usage[] {
  const byUnit = new Map<Usage['unit'], number>();
  for (const list of items)
    for (const u of list) byUnit.set(u.unit, round((byUnit.get(u.unit) ?? 0) + u.quantity));
  return [...byUnit].map(([unit, quantity]) => ({ unit, quantity }));
}
