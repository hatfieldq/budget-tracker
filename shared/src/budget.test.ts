import { describe, expect, it } from 'vitest';
import { addMonths, budgetStatus, budgetTotals, isValidMonth, monthBounds } from './budget';

describe('budget helpers', () => {
  it('validates and shifts months across year ends', () => {
    expect(isValidMonth('2026-11')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-1')).toBe(false);
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(addMonths('2026-11', 14)).toBe('2028-01');
  });

  it('month bounds handle month lengths and leap years', () => {
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthBounds('2028-02').to).toBe('2028-02-29');
    expect(monthBounds('2026-12').to).toBe('2026-12-31');
  });

  it('over only when spending exceeds the budget; exactly on budget is green', () => {
    expect(budgetStatus(null, 500)).toBe('none');
    expect(budgetStatus(10_000, 9_999)).toBe('under');
    expect(budgetStatus(10_000, 10_000)).toBe('under');
    expect(budgetStatus(10_000, 10_001)).toBe('over');
    expect(budgetStatus(0, 1)).toBe('over');
    expect(budgetStatus(5_000, -3_600)).toBe('under'); // net refund
  });

  it('totals keep unbudgeted spending separate', () => {
    const line = (budgetCents: number | null, spentCents: number) => ({
      categoryId: 1, name: 'x', archived: false, budgetCents, spentCents,
    });
    expect(budgetTotals([line(50_000, 42_000), line(10_000, 12_500), line(null, 3_000)])).toEqual({
      budgetedCents: 60_000,
      spentBudgetedCents: 54_500,
      unbudgetedSpentCents: 3_000,
      leftCents: 5_500,
    });
  });
});
