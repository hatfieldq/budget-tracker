import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Account, Category, Txn } from '@ledger/shared';
import type { Lookups } from '../lookups';
import { TxnForm } from './TxnForm';

afterEach(cleanup);

const account = (id: number, name: string, type: Account['type']): Account => ({
  id, name, type, subtype: null, ownerIds: [1], isJoint: false, openingDate: '2026-01-01',
  openingBalanceCents: 0, balanceCents: 0, archivedAt: null, lastSnapshotDate: null, lastReconciledDate: null,
});
const category = (id: number, name: string, kind: Category['kind'], isSystem = false): Category => ({
  id, name, kind, isSystem, archivedAt: null,
});

const accounts = [account(1, 'Checking', 'checking'), account(2, 'Card', 'credit_card'), account(3, 'Roth 401(k)', 'retirement')];
const categories = [
  category(10, 'Salary', 'income'),
  category(11, 'Federal Income Tax', 'tax'),
  category(12, 'Groceries', 'expense'),
  category(99, 'Uncategorized', 'uncategorized', true),
];
const lookups: Lookups = {
  accounts, categories, uncategorizedId: 99, error: null, reload: async () => {},
  accountName: (id) => accounts.find((a) => a.id === id)?.name ?? '',
  categoryName: (id) => categories.find((c) => c.id === id)?.name ?? '',
};

function setup(props: Partial<Parameters<typeof TxnForm>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<TxnForm lookups={lookups} actingPersonId={1} onSubmit={onSubmit} onCancel={() => {}} {...props} />);
  return onSubmit;
}
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submitted = async (fn: ReturnType<typeof vi.fn>) => {
  await vi.waitFor(() => expect(fn).toHaveBeenCalled());
  return fn.mock.calls[0];
};

describe('TxnForm', () => {
  it('Spend on a card: money out credits the card and debits the category', async () => {
    const onSubmit = setup();
    change('Account', '2');
    change('Category', '12');
    change('Amount', '45.10');
    change('Payee', 'Market');
    fireEvent.click(screen.getByText('Add transaction'));
    const [input] = await submitted(onSubmit);
    expect(input.payee).toBe('Market');
    expect(input.postings).toEqual([
      { accountId: 2, categoryId: null, amountCents: -4510 },
      { accountId: null, categoryId: 12, amountCents: 4510 },
    ]);
  });

  it('empty category becomes Uncategorized; Money in flips the signs', async () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByText('Money in'));
    change('Amount', '5');
    fireEvent.click(screen.getByText('Add transaction'));
    const [input] = await submitted(onSubmit);
    expect(input.postings).toEqual([
      { accountId: 1, categoryId: null, amountCents: 500 },
      { accountId: null, categoryId: 99, amountCents: -500 },
    ]);
  });

  it('Transfer: card payment from checking', async () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByText('Transfer'));
    change('From', '1');
    change('To', '2');
    change('Amount', '500');
    fireEvent.click(screen.getByText('Add transaction'));
    const [input] = await submitted(onSubmit);
    expect(input.postings.map((p: any) => [p.accountId, p.amountCents])).toEqual([[1, -50000], [2, 50000]]);
  });

  it('Split paycheck: "Balance last line" fills the net deposit', async () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByText('Split'));
    fireEvent.click(screen.getByText('+ Line'));
    fireEvent.click(screen.getByText('+ Line'));

    change('Line 1 target', 'c:10');
    fireEvent.click(within(screen.getByLabelText('Line 1 direction')).getByText('Received'));
    change('Line 1 amount', '5000');
    change('Line 2 target', 'c:11');
    change('Line 2 amount', '800'); // Spent is the default
    change('Line 3 target', 'a:3');
    fireEvent.click(within(screen.getByLabelText('Line 3 direction')).getByText('Into'));
    change('Line 3 amount', '500');
    change('Line 4 target', 'a:1');
    fireEvent.click(screen.getByText('Balance last line'));
    expect((screen.getByLabelText('Line 4 amount') as HTMLInputElement).value).toBe('3700.00');
    expect(screen.getByText('Balanced')).toBeTruthy();

    fireEvent.click(screen.getByText('Add transaction'));
    const [input] = await submitted(onSubmit);
    expect(input.postings.map((p: any) => p.amountCents)).toEqual([-500000, 80000, 50000, 370000]);
  });

  it('refuses an unbalanced split', async () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByText('Split'));
    change('Line 1 target', 'a:1');
    change('Line 1 amount', '10');
    change('Line 2 target', 'c:12');
    change('Line 2 amount', '9');
    fireEvent.click(screen.getByText('Add transaction'));
    expect(await screen.findByText(/doesn't balance/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  const existing: Txn = {
    id: 7, date: '2026-02-01', payee: 'Market', memo: null, kind: 'standard', createdByPersonId: 1,
    createdAt: '', updatedAt: '', isTransfer: false, isUncategorized: false,
    postings: [
      { id: 1, accountId: 2, categoryId: null, amountCents: -4510, memo: null, status: 'cleared', reconciliationId: null },
      { id: 2, accountId: null, categoryId: 12, amountCents: 4510, memo: null, status: null, reconciliationId: null },
    ],
  };

  it('edit keeps the date and the cleared status', async () => {
    const onSubmit = setup({ editing: existing });
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('45.10');
    change('Amount', '50');
    fireEvent.click(screen.getByText('Save'));
    const [input, id] = await submitted(onSubmit);
    expect(id).toBe(7);
    expect(input.date).toBe('2026-02-01');
    expect(input.postings[0]).toEqual({ accountId: 2, categoryId: null, amountCents: -5000, status: 'cleared' });
  });

  it('duplicate copies lines but uses today and creates a new txn', async () => {
    const onSubmit = setup({ template: existing });
    fireEvent.click(screen.getByText('Add transaction'));
    const [input, id] = await submitted(onSubmit);
    expect(id).toBeUndefined();
    expect(input.date).toBe(new Date().toLocaleDateString('en-CA'));
    expect(input.postings[0].status).toBeUndefined(); // a copy starts uncleared
  });

  it('entry form stays open: keeps the chosen date and account, clears the rest', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onDateChange = vi.fn();
    render(<TxnForm lookups={lookups} actingPersonId={1} onSubmit={onSubmit} entryDate="2026-10-28" onDateChange={onDateChange} />);
    expect(screen.getByLabelText('Date')).toHaveProperty('value', '2026-10-28');
    change('Date', '2026-10-27');
    expect(onDateChange).toHaveBeenCalledWith('2026-10-27');
    change('Account', '2');
    change('Category', '12');
    change('Payee', 'Market');
    change('Amount', '12.00');
    fireEvent.click(screen.getByText('Add transaction'));
    await submitted(onSubmit);
    await screen.findByRole('status');
    expect(screen.getByLabelText('Date')).toHaveProperty('value', '2026-10-27');
    expect(screen.getByLabelText('Account')).toHaveProperty('value', '2');
    expect(screen.getByLabelText('Payee')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Amount')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Category')).toHaveProperty('value', '');
    expect(screen.getByText('Clear')).toBeTruthy();

    change('Payee', 'Bakery');
    change('Amount', '3.50');
    fireEvent.click(screen.getByText('Add transaction'));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][0].date).toBe('2026-10-27');
  });

  it('duplicate uses the sticky entry date when one is set', async () => {
    const t = { id: 5, date: '2026-01-02', payee: 'X', memo: null, kind: 'standard', createdByPersonId: 1, isTransfer: false, isUncategorized: false,
      postings: [
        { id: 1, accountId: 1, categoryId: null, amountCents: -100, memo: null, status: 'cleared' },
        { id: 2, accountId: null, categoryId: 12, amountCents: 100, memo: null, status: 'uncleared' },
      ] } as unknown as Txn;
    setup({ template: t, entryDate: '2026-10-28' });
    expect(screen.getByLabelText('Date')).toHaveProperty('value', '2026-10-28');
  });
});
