import { beforeEach, describe, expect, it } from 'vitest';
import type { TxnInput } from '@ledger/shared';
import type { DB } from '../src/db/connection';
import { createAccount, setArchived, updateAccount } from '../src/services/accounts';
import { setCategoryArchived } from '../src/services/categories';
import { createTxn, deleteTxn, getTxn, listTxns, updateTxn } from '../src/services/ledger';
import {
  acct,
  accountInput,
  balance,
  cat,
  categoryId,
  categoryTotal,
  testDb,
  unbalancedTxnIds,
} from './helpers';

let db: DB;
let me: number;
let partner: number;
let checking: number, savings: number, card: number, loan: number, roth401k: number, partnerChecking: number;

beforeEach(() => {
  ({ db, me, partner } = testDb());
  const mk = (overrides: Parameters<typeof accountInput>[1]) => createAccount(db, accountInput(me, overrides)).id;
  checking = mk({ name: 'Checking', openingBalanceCents: 1_000_000 });
  savings = mk({ name: 'Emergency Fund', type: 'savings' });
  card = mk({ name: 'Card', type: 'credit_card' });
  loan = mk({ name: 'Car Loan', type: 'loan', subtype: 'auto', openingBalanceCents: -1_000_000 });
  roth401k = mk({ name: 'Roth 401(k)', type: 'retirement', subtype: 'roth_401k' });
  partnerChecking = createAccount(db, accountInput(partner, { name: 'Partner Checking', ownerIds: [partner] })).id;
});

const txn = (postings: TxnInput['postings'], extra: Partial<TxnInput> = {}): TxnInput => ({
  date: '2026-03-01',
  payee: 'Test',
  postings,
  createdByPersonId: me,
  ...extra,
});

// Ledger-level halves of the correctness rules; Session 4 adds the report-level halves.
describe('correctness rules (ledger level)', () => {
  it('AT-1: card purchase hits an expense; card payment is a transfer', () => {
    const groceries = categoryId(db, 'Groceries');
    const purchase = createTxn(db, txn([acct(card, -5000), cat(groceries, 5000)]));
    expect(purchase.isTransfer).toBe(false);
    expect(balance(db, card)).toBe(-5000); // owes $50

    const payment = createTxn(db, txn([acct(checking, -5000), acct(card, 5000)]));
    expect(payment.isTransfer).toBe(true);
    expect(balance(db, card)).toBe(0);
    expect(categoryTotal(db, 'Groceries')).toBe(5000); // payment added no expense
  });

  it('AT-2: savings transfer touches no category', () => {
    const t = createTxn(db, txn([acct(checking, -20000), acct(savings, 20000)]));
    expect(t.isTransfer).toBe(true);
    expect(t.postings.every((p) => p.categoryId === null)).toBe(true);
    expect(balance(db, savings)).toBe(20000);
  });

  it('AT-3: loan payment splits principal (loan) from interest (expense)', () => {
    createTxn(db, txn([acct(checking, -30000), acct(loan, 25000), cat(categoryId(db, 'Interest Expense'), 5000)]));
    expect(balance(db, loan)).toBe(-1_000_000 + 25000);
    expect(categoryTotal(db, 'Interest Expense')).toBe(5000);
  });

  it('AT-4: a refund reduces its expense category', () => {
    const clothing = categoryId(db, 'Clothing');
    createTxn(db, txn([acct(card, -12000), cat(clothing, 12000)]));
    createTxn(db, txn([acct(card, 2000), cat(clothing, -2000)]));
    expect(categoryTotal(db, 'Clothing')).toBe(10000);
  });

  it('AT-20: paycheck split puts gross, taxes and Roth 401(k) on separate lines', () => {
    const t = createTxn(
      db,
      txn([
        cat(categoryId(db, 'Salary'), -500000),
        cat(categoryId(db, 'Federal Income Tax'), 80000),
        cat(categoryId(db, 'Social Security & Medicare'), 38250),
        acct(roth401k, 50000),
        acct(checking, 331750),
      ]),
    );
    expect(t.postings).toHaveLength(5);
    expect(categoryTotal(db, 'Salary')).toBe(-500000);
    expect(categoryTotal(db, 'Federal Income Tax')).toBe(80000);
    expect(balance(db, roth401k)).toBe(50000);
    expect(balance(db, checking)).toBe(1_000_000 + 331750); // net = gross − taxes − 401k
  });
});

describe('AT-9: invalid transactions are rejected and nothing is written', () => {
  const g = () => categoryId(db, 'Groceries');
  const cases: [string, () => TxnInput['postings'], RegExp][] = [
    ['unbalanced', () => [acct(checking, -100), cat(g(), 99)], /off by 0.01/],
    ['single line', () => [acct(checking, -100)], /at least two/],
    ['zero amount', () => [acct(checking, 0), cat(g(), 0)], /nonzero/],
    ['fractional cents', () => [acct(checking, -10.5), cat(g(), 10.5)], /whole number/],
    ['both targets', () => [{ accountId: checking, categoryId: g(), amountCents: -1 }, cat(g(), 1)], /exactly one/],
    ['no target', () => [{ accountId: null, categoryId: null, amountCents: -1 }, cat(g(), 1)], /exactly one/],
    ['categories only', () => [cat(g(), -100), cat(categoryId(db, 'Dining'), 100)], /at least one account/],
    ['system category', () => [acct(checking, -100), cat(categoryId(db, 'Opening Balance'), 100)], /managed by the app/],
    ['unknown account', () => [acct(9999, -100), cat(g(), 100)], /unknown account/],
    ['status on a category', () => [acct(checking, -100), { ...cat(g(), 100), status: 'cleared' as const }], /only account lines/],
  ];
  for (const [name, postings, message] of cases) {
    it(name, () => {
      const before = db.prepare('SELECT COUNT(*) AS n FROM posting').get();
      expect(() => createTxn(db, txn(postings()))).toThrow(message);
      expect(db.prepare('SELECT COUNT(*) AS n FROM posting').get()).toEqual(before);
    });
  }

  it('rejects a bad date and an unknown person', () => {
    const p = [acct(checking, -100), cat(g(), 100)];
    expect(() => createTxn(db, txn(p, { date: '2026-13-01' }))).toThrow(/YYYY-MM-DD/);
    expect(() => createTxn(db, txn(p, { createdByPersonId: 999 }))).toThrow(/unknown person/);
  });

  it('allows Uncategorized', () => {
    const t = createTxn(db, txn([acct(checking, -100), cat(categoryId(db, 'Uncategorized'), 100)]));
    expect(t.isUncategorized).toBe(true);
  });
});

describe('AT-10: transfers are created, updated and deleted atomically', () => {
  it('update replaces both sides; delete removes both', () => {
    const t = createTxn(db, txn([acct(checking, -20000), acct(savings, 20000)]));
    updateTxn(db, t.id, txn([acct(checking, -35000), acct(savings, 35000)]));
    expect(balance(db, savings)).toBe(35000);
    expect(getTxn(db, t.id).postings).toHaveLength(2);
    deleteTxn(db, t.id);
    expect(balance(db, savings)).toBe(0);
    expect(balance(db, checking)).toBe(1_000_000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM posting WHERE txn_id = ?').get(t.id)).toEqual({ n: 0 });
  });

  it('a failure halfway through an update leaves the original intact', () => {
    const t = createTxn(db, txn([acct(checking, -20000), acct(savings, 20000)]));
    // Simulate a crash after the old postings are deleted and the first new one is inserted.
    db.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON posting WHEN NEW.memo = 'boom'
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    expect(() =>
      updateTxn(db, t.id, txn([acct(checking, -50000), { ...acct(savings, 50000), memo: 'boom' }])),
    ).toThrow(/simulated failure/);
    const after = getTxn(db, t.id);
    expect(after.postings.map((p) => p.amountCents)).toEqual([-20000, 20000]);
    expect(balance(db, savings)).toBe(20000);
  });
});

describe('AT-13 / AT-18: dates, archives and locks', () => {
  it('rejects postings before an account opened', () => {
    const late = createAccount(db, accountInput(me, { name: 'New', openingDate: '2026-06-01' })).id;
    expect(() => createTxn(db, txn([acct(late, -100), cat(categoryId(db, 'Dining'), 100)]))).toThrow(
      /opened on 2026-06-01/,
    );
  });

  it('opening date cannot move past existing transactions', () => {
    createTxn(db, txn([acct(checking, -100), cat(categoryId(db, 'Dining'), 100)], { date: '2026-03-01' }));
    expect(() =>
      updateAccount(db, checking, { openingDate: '2026-04-01', createdByPersonId: me }),
    ).toThrow(/after existing transactions/);
  });

  it('archived accounts and categories take no new postings but existing txns stay editable', () => {
    const dining = categoryId(db, 'Dining');
    const t = createTxn(db, txn([acct(card, -100), cat(dining, 100)]));
    setArchived(db, card, true);
    setCategoryArchived(db, dining, true);
    expect(() => createTxn(db, txn([acct(card, -100), cat(categoryId(db, 'Groceries'), 100)]))).toThrow(/archived/);
    expect(() => createTxn(db, txn([acct(checking, -100), cat(dining, 100)]))).toThrow(/archived/);
    // editing the old txn (same archived targets) is fine
    expect(updateTxn(db, t.id, txn([acct(card, -150), cat(dining, 150)])).postings[0].amountCents).toBe(-150);
    expect(listTxns(db, { accountId: card }).total).toBe(1); // history kept
  });

  it('reconciled lines are locked; other lines can change; delete is blocked', () => {
    const t = createTxn(db, txn([acct(card, -5000), cat(categoryId(db, 'Groceries'), 5000)]));
    db.prepare("UPDATE posting SET status = 'reconciled' WHERE txn_id = ? AND account_id = ?").run(t.id, card);

    // recategorizing keeps the reconciled line
    const recat = updateTxn(db, t.id, txn([acct(card, -5000), cat(categoryId(db, 'Dining'), 5000)]));
    expect(recat.postings.find((p) => p.accountId === card)?.status).toBe('reconciled');

    expect(() => updateTxn(db, t.id, txn([acct(card, -6000), cat(categoryId(db, 'Dining'), 6000)]))).toThrow(/locked/);
    expect(() =>
      updateTxn(db, t.id, txn([acct(card, -5000), cat(categoryId(db, 'Dining'), 5000)], { date: '2026-03-02' })),
    ).toThrow(/date is locked/);
    expect(() => deleteTxn(db, t.id)).toThrow(/reconciled/);
  });

  it('opening-balance txns cannot be edited or deleted here', () => {
    const opening = listTxns(db, { accountId: checking }).txns.find((t) => t.kind === 'opening')!;
    expect(() => deleteTxn(db, opening.id)).toThrow(/edited from the account/);
    expect(() => updateTxn(db, opening.id, txn([acct(checking, -1), cat(categoryId(db, 'Dining'), 1)]))).toThrow(
      /edited from the account/,
    );
  });
});

describe('register (listTxns)', () => {
  beforeEach(() => {
    const groceries = categoryId(db, 'Groceries');
    createTxn(db, txn([acct(checking, -1000), cat(groceries, 1000)], { date: '2026-02-01', payee: 'Corner Market' }));
    createTxn(db, txn([acct(checking, -2500), cat(groceries, 2500)], { date: '2026-02-03', payee: 'Big Grocer', memo: 'weekly 50% off' }));
    createTxn(db, txn([acct(checking, -10000), acct(savings, 10000)], { date: '2026-02-02', payee: 'To savings' }));
    createTxn(db, txn([acct(partnerChecking, -700), cat(categoryId(db, 'Uncategorized'), 700)], { date: '2026-02-04', createdByPersonId: partner }));
  });

  it('newest first, with search, date range and category filters', () => {
    expect(listTxns(db).txns.map((t) => t.date).slice(0, 4)).toEqual(['2026-02-04', '2026-02-03', '2026-02-02', '2026-02-01']);
    expect(listTxns(db, { q: 'grocer' }).txns.map((t) => t.payee)).toEqual(['Big Grocer']);
    expect(listTxns(db, { q: '50%' }).total).toBe(1); // % is literal, not a wildcard
    expect(listTxns(db, { from: '2026-02-02', to: '2026-02-03' }).total).toBe(2);
    expect(listTxns(db, { categoryId: categoryId(db, 'Groceries') }).total).toBe(2);
    expect(listTxns(db, { uncategorized: true }).total).toBe(1);
    expect(listTxns(db, { createdBy: partner }).total).toBe(1);
  });

  it('scope: a person sees only txns on their accounts', () => {
    const mine = listTxns(db, { scope: { type: 'person', personId: me } });
    expect(mine.txns.some((t) => t.payee === 'Test' && t.createdByPersonId === partner)).toBe(false);
    expect(listTxns(db, { scope: { type: 'person', personId: partner } }).total).toBe(1);
  });

  it('running balance per account, including the opening balance', () => {
    const { txns } = listTxns(db, { accountId: checking });
    expect(txns.map((t) => [t.date, t.runningBalanceCents])).toEqual([
      ['2026-02-03', 1_000_000 - 1000 - 10000 - 2500],
      ['2026-02-02', 1_000_000 - 1000 - 10000],
      ['2026-02-01', 1_000_000 - 1000],
      ['2026-01-01', 1_000_000],
    ]);
  });

  it('status filter and paging', () => {
    expect(listTxns(db, { status: 'cleared' }).total).toBe(0);
    const page = listTxns(db, { limit: 2, offset: 0 });
    expect(page.txns).toHaveLength(2);
    expect(page.total).toBeGreaterThan(2);
  });
});

it('AT-12: every transaction balances after all of the above', () => {
  createTxn(db, txn([acct(checking, -100), acct(savings, 60), cat(categoryId(db, 'Fees'), 40)]));
  expect(unbalancedTxnIds(db)).toEqual([]);
});
