import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account } from '@ledger/shared';
import { BalanceUpdatePanel } from './BalanceUpdatePanel';
import { api } from '../api';

vi.mock('../api', () => ({ api: { categories: vi.fn(), account: vi.fn(), createTxn: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const savings: Account = {
  id: 3, name: 'Emergency Fund', type: 'savings', subtype: null, ownerIds: [1], isJoint: false,
  openingDate: '2026-01-01', openingBalanceCents: 0, balanceCents: 1_200_000, archivedAt: null,
  lastSnapshotDate: null, lastReconciledDate: null,
};

function setup(ledgerCents: number) {
  vi.mocked(api.categories).mockResolvedValue([
    { id: 1, name: 'Salary', kind: 'income', isSystem: false, archivedAt: null },
    { id: 2, name: 'Interest Income', kind: 'income', isSystem: false, archivedAt: null },
  ]);
  vi.mocked(api.account).mockResolvedValue({ ...savings, balanceCents: ledgerCents });
  vi.mocked(api.createTxn).mockResolvedValue({} as never);
  const onChanged = vi.fn();
  render(<BalanceUpdatePanel account={savings} actingPersonId={1} onChanged={onChanged} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Statement date'), { target: { value: '2026-03-31' } });
  return onChanged;
}

describe('BalanceUpdatePanel', () => {
  it('AT-21: proposes exactly the difference as interest, defaulting to Interest Income', async () => {
    const onChanged = setup(1_200_000);
    fireEvent.change(screen.getByLabelText('Balance the bank shows'), { target: { value: '12,038.12' } });
    fireEvent.click(screen.getByText('Compare'));
    fireEvent.click(await screen.findByText('Book $38.12 interest'));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.account).toHaveBeenCalledWith(3, '2026-03-31');
    expect(api.createTxn).toHaveBeenCalledWith({
      date: '2026-03-31',
      payee: 'Interest',
      postings: [
        { accountId: 3, categoryId: null, amountCents: 3_812, status: 'cleared' },
        { accountId: null, categoryId: 2, amountCents: -3_812 },
      ],
      createdByPersonId: 1,
    });
  });

  it('a lower bank balance only warns', async () => {
    setup(1_200_000);
    fireEvent.change(screen.getByLabelText('Balance the bank shows'), { target: { value: '11900' } });
    fireEvent.click(screen.getByText('Compare'));
    expect(await screen.findByText(/shows \$100\.00 less/)).toBeTruthy();
    expect(screen.queryByText(/Book/)).toBeNull();
  });
});
