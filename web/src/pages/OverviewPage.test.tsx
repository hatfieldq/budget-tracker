import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OverviewReport } from '@ledger/shared';
import { OverviewPage } from './OverviewPage';
import { api } from '../api';

vi.mock('../api', () => ({ api: { overview: vi.fn() } }));
vi.mock('../scope', () => ({ useScope: () => ({ scope: { type: 'person', personId: 1 } }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = '';
});

const report: OverviewReport = {
  scope: { type: 'person', personId: 1, label: 'Me', includesJointAccounts: true },
  period: { from: '2026-03-01', to: '2026-03-31' },
  income: { totalCents: 640_000, lines: [{ categoryId: 1, name: 'Salary', cents: 640_000 }] },
  taxes: { totalCents: 100_000, lines: [{ categoryId: 2, name: 'Federal Income Tax', cents: 100_000 }] },
  spending: {
    totalCents: 52_475,
    lines: [
      { categoryId: 3, name: 'Groceries', cents: 50_000 },
      { categoryId: 9, name: 'Uncategorized (money out)', cents: 2_475, uncategorized: true },
    ],
  },
  netCents: 487_525,
  uncategorized: { count: 1, cents: 2_475 },
  savingsCents: 50_000,
  investmentContributionsCents: 38_400,
  valuationChangeCents: -12_000,
  debts: [{ accountId: 5, name: 'Travel Card', type: 'credit_card', subtype: null, owedCents: 84_317 }],
  netWorth: {
    startCents: 1_000_000,
    endCents: 1_475_525,
    lines: [
      { accountId: 1, name: 'Joint Checking', type: 'checking', subtype: null, isJoint: true, archived: false, balanceCents: 500_000, valuation: null },
      { accountId: 4, name: 'Work Roth 401(k)', type: 'retirement', subtype: 'roth_401k', isJoint: false, archived: false, balanceCents: 1_059_842, valuation: { kind: 'snapshot', date: '2026-03-31', transfersSince: false } },
      { accountId: 5, name: 'Travel Card', type: 'credit_card', subtype: null, isJoint: false, archived: false, balanceCents: -84_317, valuation: null },
    ],
  },
  identity: { changeCents: 475_525, openingCents: 0, outsideTransfersCents: 0, balanced: true },
};

describe('OverviewPage', () => {
  it('labels scope and period, shows totals, breakdown links, net worth basis and the identity check', async () => {
    vi.mocked(api.overview).mockResolvedValue(report);
    render(<OverviewPage params={new URLSearchParams('from=2026-03-01&to=2026-03-31')} />);
    await screen.findByText('Salary');
    expect(api.overview).toHaveBeenCalledWith({ type: 'person', personId: 1 }, '2026-03-01', '2026-03-31');
    screen.getByText(/Me \(includes joint accounts at full value\) · 2026-03-01 to 2026-03-31/);
    expect(screen.getByText('Income − taxes − spending', { selector: 'div' }).nextSibling!.textContent).toBe('$4,875.25');
    expect(screen.getByText('Market change', { selector: 'div' }).nextSibling!.textContent).toBe('-$120.00');
    expect(screen.getByText('Groceries').getAttribute('href')).toBe('#/transactions?categoryId=3&from=2026-03-01&to=2026-03-31');
    expect(screen.getByText('Uncategorized (money out)').getAttribute('href')).toBe('#/transactions?uncategorized=1&from=2026-03-01&to=2026-03-31');
    screen.getByText(/1 uncategorized item/);
    screen.getByText('value as of 2026-03-31');
    screen.getByText(/· joint/);
    screen.getByText('$843.17 owed');
    screen.getByText('✓ Everything adds up.');
  });

  it('preset buttons change the period in the URL', async () => {
    vi.mocked(api.overview).mockResolvedValue(report);
    render(<OverviewPage params={new URLSearchParams('from=2026-03-01&to=2026-03-31')} />);
    await screen.findByText('Salary');
    fireEvent.click(screen.getByText('Last year'));
    const year = Number(new Date().toLocaleDateString('en-CA').slice(0, 4)) - 1;
    expect(window.location.hash).toBe(`#/overview?from=${year}-01-01&to=${year}-12-31`);
  });
});
