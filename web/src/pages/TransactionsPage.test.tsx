import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account, Txn } from '@ledger/shared';
import { TransactionsPage, statusTint } from './TransactionsPage';
import { api } from '../api';

vi.mock('../api', () => ({
  api: { txns: vi.fn(), accounts: vi.fn(), categories: vi.fn(), payees: vi.fn(), setTxnStatus: vi.fn() },
}));
vi.mock('../scope', () => ({
  useScope: () => ({ scope: { type: 'household' }, actingPersonId: 1, personName: () => 'Quinn', people: [] }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const checking: Account = {
  id: 1, name: 'SoFi Checking', type: 'checking', subtype: null, ownerIds: [1], isJoint: false,
  openingDate: '2026-11-01', openingBalanceCents: 100_000, balanceCents: 100_000, archivedAt: null,
  lastSnapshotDate: null, lastReconciledDate: null,
};
const txn = (id: number, payee: string, status: 'uncleared' | 'cleared' | 'reconciled', kind: Txn['kind'] = 'standard'): Txn =>
  ({
    id, date: '2026-11-05', payee, memo: null, kind, createdByPersonId: 1, isUncategorized: false,
    postings: [
      { id: id * 10, accountId: 1, categoryId: null, amountCents: -1_000, memo: null, status },
      { id: id * 10 + 1, accountId: null, categoryId: 7, amountCents: 1_000, memo: null, status: null },
    ],
  }) as unknown as Txn;

const rowOf = (payee: string) => screen.getByText(payee).closest('tr')!;

describe('register status colours', () => {
  it('pending rows are red; cleared and reconciled rows are green; system entries are neutral', async () => {
    vi.mocked(api.accounts).mockResolvedValue([checking]);
    vi.mocked(api.categories).mockResolvedValue([{ id: 7, name: 'Groceries', kind: 'expense', isSystem: false, archivedAt: null }]);
    vi.mocked(api.payees).mockResolvedValue([]);
    vi.mocked(api.txns).mockResolvedValue({
      txns: [txn(1, 'Pending Market', 'uncleared'), txn(2, 'Cleared Cafe', 'cleared'), txn(3, 'Old Rent', 'reconciled'), txn(4, 'Opening', 'reconciled', 'opening')],
      total: 4,
    });
    render(<TransactionsPage params={new URLSearchParams()} />);
    await screen.findByText('Pending Market');

    expect(rowOf('Pending Market').dataset.status).toBe('pending');
    expect(rowOf('Pending Market').className).toContain('bg-red-50');
    expect(rowOf('Cleared Cafe').dataset.status).toBe('confirmed');
    expect(rowOf('Cleared Cafe').className).toContain('bg-green-50');
    expect(rowOf('Old Rent').className).toContain('bg-green-50');
    expect(rowOf('Opening').dataset.status).toBe('system');
    expect(rowOf('Opening').className).not.toMatch(/bg-(red|green)-50/);
  });

  it('checking an item off turns its row green', async () => {
    vi.mocked(api.accounts).mockResolvedValue([checking]);
    vi.mocked(api.categories).mockResolvedValue([]);
    vi.mocked(api.payees).mockResolvedValue([]);
    let status: 'uncleared' | 'cleared' = 'uncleared'; // the "server" state
    vi.mocked(api.txns).mockImplementation(async () => ({ txns: [txn(1, 'Pending Market', status)], total: 1 }));
    vi.mocked(api.setTxnStatus).mockImplementation(async () => {
      status = 'cleared';
      return txn(1, 'Pending Market', 'cleared');
    });
    render(<TransactionsPage params={new URLSearchParams()} />);
    await screen.findByText('Pending Market');
    expect(rowOf('Pending Market').dataset.status).toBe('pending');
    fireEvent.click(screen.getByLabelText('Uncleared: click to mark cleared'));
    await vi.waitFor(() => expect(rowOf('Pending Market').dataset.status).toBe('confirmed'));
    expect(rowOf('Pending Market').className).toContain('bg-green-50');
  });

  it('statusTint', () => {
    expect(statusTint('', false)).toContain('bg-red-50');
    expect(statusTint('C', false)).toContain('bg-green-50');
    expect(statusTint('R', false)).toContain('bg-green-50');
    expect(statusTint('', true)).toBe('');
  });
});
