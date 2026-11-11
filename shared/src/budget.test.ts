import { describe, expect, it } from 'vitest';
import { addMonths, budgetStatus, budgetTotals, isValidMonth, lineStatus, monthBounds, savingsStatus } from './budget';

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

  it('savings is a goal: met at or above, short below', () => {
    expect(savingsStatus(null, 100)).toBe('none');
    expect(savingsStatus(20_000, 19_999)).toBe('short');
    expect(savingsStatus(20_000, 20_000)).toBe('met');
    expect(savingsStatus(20_000, 20_050)).toBe('met'); // interest on top is fine
  });

  it('totals: spending (categories + loans) and savings kept apart; unbudgeted = categories only', () => {
    const line = (kind: 'category' | 'loan' | 'savings' | 'investing', budgetCents: number | null, spentCents: number) => ({
      kind, categoryId: kind === 'category' ? 1 : null, accountId: kind === 'category' ? null : 2,
      name: 'x', archived: false, budgetCents, spentCents,
    });
    const lines = [
      line('category', 50_000, 42_000),
      line('category', 10_000, 12_500),
      line('category', null, 3_000),
      line('loan', 38_500, 38_500),
      line('loan', null, 29_000),
      line('savings', 20_000, 20_050),
      line('savings', null, 50_000),
      { ...line('investing', 50_000, 49_200), accountId: null, group: 'investing' as const },
    ];
    expect(budgetTotals(lines)).toEqual({
      budgetedCents: 98_500,
      spentBudgetedCents: 93_000,
      unbudgetedSpentCents: 3_000,
      leftCents: 5_500,
      savingsGoalCents: 20_000,
      savedCents: 20_050,
      investingGoalCents: 50_000,
      investedCents: 49_200,
    });
    expect(lineStatus(lines[7])).toBe('short');
    expect(lineStatus({ ...lines[7], spentCents: 50_000 })).toBe('met');
    expect(lineStatus(lines[1])).toBe('over');
    expect(lineStatus(lines[3])).toBe('under');
    expect(lineStatus(lines[5])).toBe('met');
  });
});
