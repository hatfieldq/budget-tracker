import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { Account, ReconcileSummary } from '@ledger/shared';
import { ReconcileBar, type StatementFields } from './ReconcileBar';
import { api } from '../api';

vi.mock('../api', () => ({
  api: { reconcileSummary: vi.fn(), reconcile: vi.fn(), undoReconcile: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const card: Account = {
  id: 5, name: 'Travel Card', type: 'credit_card', subtype: null, ownerIds: [1], isJoint: false,
  openingDate: '2026-01-01', openingBalanceCents: 0, balanceCents: -4_500, archivedAt: null,
  lastSnapshotDate: null, lastReconciledDate: null,
};
const summary: ReconcileSummary = {
  accountId: 5, statementDate: '2026-02-28', reconciledCents: -1_000, clearedCents: -3_500,
  clearedCount: 2, clearedAfterCount: 0, last: null,
};

function Harness({ onFinished = vi.fn() }: { onFinished?: (d: string) => void }) {
  const [s, setS] = useState<StatementFields>({ date: '2026-02-28', balance: '' });
  return (
    <ReconcileBar account={card} statement={s} onStatementChange={setS} version={0} actingPersonId={1}
      onFinished={onFinished} onUndone={() => {}} onExit={() => {}} />
  );
}

describe('ReconcileBar', () => {
  it('a card statement is typed as amount owed; Finish enables only at zero difference', async () => {
    vi.mocked(api.reconcileSummary).mockResolvedValue(summary);
    vi.mocked(api.reconcile).mockResolvedValue({} as never);
    const onFinished = vi.fn();
    render(<Harness onFinished={onFinished} />);
    await screen.findByText('$45.00'); // cleared balance, natural (owed)
    const finish = screen.getByText('Finish') as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('Statement balance owed'), { target: { value: '44.99' } });
    expect(screen.getByText('$0.01')).toBeTruthy();
    expect(finish.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Statement balance owed'), { target: { value: '45' } });
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledWith('2026-02-28'));
    expect(api.reconcile).toHaveBeenCalledWith(5, { statementDate: '2026-02-28', statementBalanceCents: -4_500, personId: 1 });
  });

  it('offers undo of the last reconciliation with a confirm step', async () => {
    vi.mocked(api.reconcileSummary).mockResolvedValue({
      ...summary,
      last: { id: 1, accountId: 5, statementDate: '2026-01-31', statementBalanceCents: -1_000, completedByPersonId: 1, completedAt: '', postingCount: 3 },
    });
    vi.mocked(api.undoReconcile).mockResolvedValue(undefined);
    render(<Harness />);
    fireEvent.click(await screen.findByText('Undo'));
    expect(api.undoReconcile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Yes'));
    await vi.waitFor(() => expect(api.undoReconcile).toHaveBeenCalledWith(5));
  });
});
