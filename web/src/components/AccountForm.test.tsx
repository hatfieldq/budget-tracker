import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account } from '@ledger/shared';
import { AccountForm } from './AccountForm';

const people = [
  { id: 1, displayName: 'Me', archivedAt: null },
  { id: 2, displayName: 'Partner', archivedAt: null },
];

afterEach(cleanup);

// AT-15 at the UI boundary: what the user types (natural terms) is sent in ledger sign.
describe('AccountForm', () => {
  it('sends a credit card "amount owed" as a negative ledger balance', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AccountForm people={people} actingPersonId={1} onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Travel Card' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'credit_card' } });
    fireEvent.change(screen.getByLabelText('Opening amount owed'), { target: { value: '843.17' } });
    fireEvent.click(screen.getByLabelText('Partner')); // make it joint
    fireEvent.click(screen.getByText('Create account'));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Travel Card',
      type: 'credit_card',
      subtype: null,
      ownerIds: [1, 2],
      openingBalanceCents: -84317,
      createdByPersonId: 1,
    });
  });

  it('picks a default subtype for loans and shows the loan category picker', () => {
    const onSubmit = vi.fn();
    render(<AccountForm people={people} actingPersonId={1} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'loan' } });
    expect((screen.getByLabelText('Loan category') as HTMLSelectElement).value).toBe('auto');
  });

  it('pre-fills an existing liability in natural terms and locks the type', () => {
    const account: Account = {
      id: 9, name: 'Hatchback Loan', type: 'loan', subtype: 'auto', ownerIds: [1], isJoint: false,
      openingDate: '2026-01-01', openingBalanceCents: -1450000, balanceCents: -1450000, archivedAt: null,
      lastSnapshotDate: null, lastReconciledDate: null,
    };
    render(
      <AccountForm people={people} actingPersonId={1} account={account} onSubmit={vi.fn()} onCancel={() => {}} />,
    );
    expect((screen.getByLabelText('Opening amount owed') as HTMLInputElement).value).toBe('14500.00');
    expect((screen.getByLabelText('Type') as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows a message instead of submitting an invalid amount', async () => {
    const onSubmit = vi.fn();
    render(<AccountForm people={people} actingPersonId={1} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Opening balance'), { target: { value: '12.345' } });
    fireEvent.click(screen.getByText('Create account'));
    expect(await screen.findByText(/must be an amount/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
