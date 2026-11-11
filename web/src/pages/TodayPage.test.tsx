import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account, TodaySummary } from '@ledger/shared';
import { TodayPage } from './TodayPage';
import { api } from '../api';

vi.mock('../api', () => ({
  api: { today: vi.fn(), payees: vi.fn(), accounts: vi.fn(), categories: vi.fn(), createTxn: vi.fn() },
}));
vi.mock('../scope', () => ({ useScope: () => ({ scope: { type: 'household' }, actingPersonId: 1 }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const card: Account = {
  id: 5, name: 'Travel Card', type: 'credit_card', subtype: null, ownerIds: [1], isJoint: false,
  openingDate: '2026-01-01', openingBalanceCents: 0, balanceCents: 0, archivedAt: null,
  lastSnapshotDate: null, lastReconciledDate: '2026-01-31',
};

const summary: TodaySummary = {
  today: '2026-03-10',
  review: [{ accountId: 5, name: 'Travel Card', type: 'credit_card', unclearedCount: 3, clearedCount: 2, lastReconciledDate: '2026-01-31' }],
  stale: [
    { accountId: 7, name: 'Work Roth 401(k)', lastValueDate: '2026-02-28', basisDate: '2026-02-28', days: 10, stale: true },
    { accountId: 8, name: 'Roth IRA', lastValueDate: '2026-03-08', basisDate: '2026-03-08', days: 2, stale: false },
  ],
  uncategorized: {
    total: 1,
    txns: [{
      id: 40, date: '2026-03-09', payee: 'SQ *POPUP MKT', memo: null, kind: 'standard', createdByPersonId: 1,
      postings: [
        { id: 1, accountId: 5, categoryId: null, amountCents: -2_475, memo: null, status: 'uncleared' },
        { id: 2, accountId: null, categoryId: 99, amountCents: 2_475, memo: null, status: null },
      ],
    } as never],
  },
  budget: { month: '2026-03', hasBudget: true, budgetedCents: 36_000, spentBudgetedCents: 37_000, overCategories: ['Dining'] },
};

async function show(s: TodaySummary = summary) {
  vi.mocked(api.today).mockResolvedValue(s);
  vi.mocked(api.payees).mockResolvedValue([]);
  vi.mocked(api.accounts).mockResolvedValue([card]);
  vi.mocked(api.categories).mockResolvedValue([{ id: 99, name: 'Uncategorized', kind: 'uncategorized', isSystem: true, archivedAt: null }]);
  render(<TodayPage />);
  await screen.findByText('Over in Dining');
}

describe('TodayPage', () => {
  it('shows budget, review status, stale values only, and uncategorized items with links', async () => {
    await show();
    expect(screen.getByText('$10.00 over').className).toContain('text-red-700');
    expect(screen.getByText(/3 to check off · 2 cleared, not reconciled · reconciled through 2026-01-31/)).toBeTruthy();
    expect(screen.getByText('Reconcile').getAttribute('href')).toBe('#/transactions?accountId=5&reconcile=1');
    expect(screen.getByText('Work Roth 401(k)')).toBeTruthy();
    expect(screen.queryByText('Roth IRA')).toBeNull(); // updated 2 days ago: not stale
    expect(screen.getByText('Update value').getAttribute('href')).toBe('#/accounts?update=7');
    expect(screen.getByText('SQ *POPUP MKT')).toBeTruthy();
    expect(screen.getByText('$24.75')).toBeTruthy();
  });

  it('adding a transaction from the quick entry refreshes the summary', async () => {
    vi.mocked(api.createTxn).mockResolvedValue({} as never);
    await show();
    await screen.findByLabelText('Amount');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12' } });
    fireEvent.click(screen.getByText('Add transaction'));
    await vi.waitFor(() => expect(api.createTxn).toHaveBeenCalled());
    await vi.waitFor(() => expect(vi.mocked(api.today).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(vi.mocked(api.payees).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('with no accounts yet, points to Accounts instead of the entry form', async () => {
    vi.mocked(api.today).mockResolvedValue({ ...summary, review: [], stale: [], uncategorized: { total: 0, txns: [] }, budget: { ...summary.budget, hasBudget: false, overCategories: [] } });
    vi.mocked(api.payees).mockResolvedValue([]);
    vi.mocked(api.accounts).mockResolvedValue([]);
    vi.mocked(api.categories).mockResolvedValue([]);
    render(<TodayPage />);
    await screen.findByText(/No budget set for March/);
    expect(screen.getByText('Add your first account').getAttribute('href')).toBe('#/accounts');
    expect(screen.queryByText('Add transaction')).toBeNull();
    expect(screen.getByText('Everything has a category.')).toBeTruthy();
  });
});
