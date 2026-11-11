import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BudgetMonth } from '@ledger/shared';
import { BudgetPage } from './BudgetPage';
import { api } from '../api';

vi.mock('../api', () => ({ api: { budgetMonth: vi.fn(), setBudget: vi.fn(), setAccountBudget: vi.fn(), setGroupBudget: vi.fn(), copyBudget: vi.fn() } }));
vi.mock('../scope', () => ({ useScope: () => ({ scope: { type: 'household' } }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const cat = (id: number, name: string, budgetCents: number | null, spentCents: number) => ({
  kind: 'category' as const, categoryId: id, accountId: null, name, archived: false, budgetCents, spentCents,
});
const acc = (kind: 'loan' | 'savings', id: number, name: string, budgetCents: number | null, spentCents: number) => ({
  kind, categoryId: null, accountId: id, name, archived: false, budgetCents, spentCents,
});

const month = (overrides: Partial<BudgetMonth> = {}): BudgetMonth => ({
  month: '2026-03',
  scopeLabel: 'Household',
  includesJointAccounts: false,
  lines: [
    cat(1, 'Dining', 6_000, 6_450),
    cat(2, 'Groceries', 30_000, 28_796),
    cat(3, 'Housing', 185_000, 185_000),
    cat(4, 'Fees', null, 1_200),
    { ...cat(5, 'Interest Expense', null, 0), inLoanPaymentsCents: 6_042 },
    acc('loan', 20, 'Hatchback Loan', 40_000, 38_500),
    acc('savings', 30, 'Car Fund', 20_000, 15_000),
    acc('savings', 31, 'Emergency Fund', 10_000, 10_051),
    { kind: 'investing' as const, categoryId: null, accountId: null, group: 'investing' as const, name: 'All investing', archived: false, budgetCents: 90_000, spentCents: 83_400 },
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
    // Totals over budgeted spending + loans: 261,000 budgeted vs 258,746 spent; savings apart.
    expect(screen.getByText('Left to spend').nextSibling!.textContent).toBe('$22.54');
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

  it('loan rows are limits (whole payment); savings rows are goals; sections are labelled', async () => {
    vi.mocked(api.setAccountBudget).mockResolvedValue(undefined);
    await show();
    screen.getByText('Loan payments');
    screen.getByText('Savings goals');
    expect(row('Hatchback Loan').dataset.status).toBe('under');
    expect(screen.getByText('$15.00 left').className).toContain('text-green-700');
    expect(row('Car Fund').dataset.status).toBe('short');
    expect(screen.getByText('$50.00 to go').className).toContain('text-amber-700');
    expect(row('Emergency Fund').dataset.status).toBe('met');
    expect(screen.getByText('Goal met').className).toContain('text-green-700');
    expect(screen.getByText('Saved of $300.00 goal').nextSibling!.textContent).toBe('$250.51');
    screen.getByText('+$60.42 counted in loan payments');
    // Paid links to the loan's register for the month.
    expect(screen.getByText('$385.00').closest('a')!.getAttribute('href')).toBe(
      '#/transactions?accountId=20&from=2026-03-01&to=2026-03-31',
    );
    const loan = screen.getByLabelText('Budget for Hatchback Loan');
    loan.focus();
    fireEvent.change(loan, { target: { value: '385' } });
    fireEvent.keyDown(loan, { key: 'Enter' });
    await vi.waitFor(() => expect(api.setAccountBudget).toHaveBeenCalledWith('2026-03', 20, 38_500));
    expect(api.setBudget).not.toHaveBeenCalled();
  });

  it('All investing is one goal row: amber while short, its own total, saves to the group', async () => {
    vi.mocked(api.setGroupBudget).mockResolvedValue(undefined);
    await show();
    screen.getByText('Investing');
    expect(row('All investing').dataset.status).toBe('short');
    expect(screen.getByText('$66.00 to go').className).toContain('text-amber-700');
    expect(screen.getByText('Invested of $900.00 goal').nextSibling!.textContent).toBe('$834.00');
    expect(screen.getByText('$834.00', { selector: 'a' }).getAttribute('href')).toBe('#/overview?from=2026-03-01&to=2026-03-31');
    const goal = screen.getByLabelText('Budget for All investing');
    goal.focus();
    fireEvent.change(goal, { target: { value: '800' } });
    fireEvent.keyDown(goal, { key: 'Enter' });
    await vi.waitFor(() => expect(api.setGroupBudget).toHaveBeenCalledWith('2026-03', 'investing', 80_000));
    expect(api.setAccountBudget).not.toHaveBeenCalled();
  });
});
