import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BudgetMonth } from '@ledger/shared';
import { BudgetPage } from './BudgetPage';
import { api } from '../api';

vi.mock('../api', () => ({ api: { budgetMonth: vi.fn(), setBudget: vi.fn(), copyBudget: vi.fn() } }));
vi.mock('../scope', () => ({ useScope: () => ({ scope: { type: 'household' } }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const month = (overrides: Partial<BudgetMonth> = {}): BudgetMonth => ({
  month: '2026-03',
  scopeLabel: 'Household',
  includesJointAccounts: false,
  lines: [
    { categoryId: 1, name: 'Dining', archived: false, budgetCents: 6_000, spentCents: 6_450 },
    { categoryId: 2, name: 'Groceries', archived: false, budgetCents: 30_000, spentCents: 28_796 },
    { categoryId: 3, name: 'Housing', archived: false, budgetCents: 185_000, spentCents: 185_000 },
    { categoryId: 4, name: 'Fees', archived: false, budgetCents: null, spentCents: 1_200 },
  ],
  uncategorized: { cents: 2_475, count: 1 },
  previousMonthBudgetCount: 3,
  ...overrides,
});

const show = async (data = month()) => {
  vi.mocked(api.budgetMonth).mockResolvedValue(data);
  render(<BudgetPage params={new URLSearchParams('month=2026-03')} />);
  await screen.findByText('Dining');
};
const row = (name: string) => screen.getByText(name).closest('tr')!;

describe('BudgetPage', () => {
  it('over is red, under and exactly on budget are green, no budget is neutral', async () => {
    await show();
    expect(api.budgetMonth).toHaveBeenCalledWith('2026-03', { type: 'household' });
    expect(row('Dining').dataset.status).toBe('over');
    expect(screen.getByText('$4.50 over').className).toContain('text-red-700');
    expect(screen.getByText('$12.04 left').className).toContain('text-green-700');
    expect(row('Housing').dataset.status).toBe('under');
    expect(screen.getByText('$0.00 left').className).toContain('text-green-700');
    expect(row('Fees').dataset.status).toBe('none');
    // Totals over budgeted categories only: 221,000 budgeted vs 220,246 spent.
    expect(screen.getByText('Left to spend').nextSibling!.textContent).toBe('$7.54');
    expect(screen.getByText(/spent in categories without a budget/).textContent).toContain('$12.00');
    expect(screen.getByText(/uncategorized/).textContent).toContain('$24.75');
    // Spent links to that category's transactions for the month.
    expect(screen.getByText('$64.50').closest('a')!.getAttribute('href')).toBe(
      '#/transactions?categoryId=1&from=2026-03-01&to=2026-03-31',
    );
  });

  it('saves a typed budget on Enter/blur, clears on empty, refetches', async () => {
    vi.mocked(api.setBudget).mockResolvedValue(undefined);
    await show();
    const fees = screen.getByLabelText('Budget for Fees');
    fees.focus();
    fireEvent.change(fees, { target: { value: '25' } });
    fireEvent.keyDown(fees, { key: 'Enter' }); // Enter leaves the field, which saves
    await vi.waitFor(() => expect(api.setBudget).toHaveBeenCalledWith('2026-03', 4, 2_500));
    await vi.waitFor(() => expect(vi.mocked(api.budgetMonth).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(api.setBudget).toHaveBeenCalledTimes(1);

    const dining = screen.getByLabelText('Budget for Dining');
    fireEvent.change(dining, { target: { value: '' } });
    fireEvent.blur(dining);
    await vi.waitFor(() => expect(api.setBudget).toHaveBeenCalledWith('2026-03', 1, null));
  });

  it('rejects an invalid amount without saving; unchanged values are not re-saved', async () => {
    await show();
    const groceries = screen.getByLabelText('Budget for Groceries');
    fireEvent.change(groceries, { target: { value: 'abc' } });
    fireEvent.blur(groceries);
    expect(groceries.className).toContain('border-red-500');
    fireEvent.change(groceries, { target: { value: '300.00' } });
    fireEvent.blur(groceries);
    expect(api.setBudget).not.toHaveBeenCalled();
  });

  it('offers to copy last month when there are blanks', async () => {
    vi.mocked(api.copyBudget).mockResolvedValue({ copied: 1 });
    await show();
    fireEvent.click(screen.getByText(/Copy last month's budget/));
    await vi.waitFor(() => expect(api.copyBudget).toHaveBeenCalledWith('2026-03'));
  });

  it('a blank month with nothing to copy explains how to start', async () => {
    const blank = month({
      lines: month().lines.map((l) => ({ ...l, budgetCents: null })),
      previousMonthBudgetCount: 0,
    });
    await show(blank);
    screen.getByText(/Type an amount next to a category/);
    expect(screen.queryByText(/Copy last month/)).toBeNull();
    expect(screen.queryByText('Left to spend')).toBeNull();
  });
});
