import { beforeEach, describe, expect, it } from 'vitest';
import type { PostingInput } from '@ledger/shared';
import { buildApp } from '../src/app';
import type { DB } from '../src/db/connection';
import { createAccount, setArchived } from '../src/services/accounts';
import { setBudget } from '../src/services/budgets';
import { createTxn } from '../src/services/ledger';
import { completeReconciliation, setTxnStatus } from '../src/services/reconcile';
import { createSnapshot } from '../src/services/snapshots';
import { listPayees, todaySummary } from '../src/services/today';
import { acct, accountInput, cat, categoryId, testDb } from './helpers';

let db: DB;
let me: number, partner: number;
const household = { type: 'household' } as const;

beforeEach(() => {
  ({ db, me, partner } = testDb());
});
const mk = (o: Parameters<typeof accountInput>[1]) => createAccount(db, accountInput(me, o)).id;
const post = (date: string, payee: string, postings: PostingInput[]) =>
  createTxn(db, { date, payee, postings, createdByPersonId: me });
const C = (name: string, cents: number) => cat(categoryId(db, name), cents);

describe('Today', () => {
  it('AT-16: an investment value is stale after more than 7 days (7 = fresh, 8 = stale)', () => {
    const brokerage = mk({ name: 'Brokerage', type: 'brokerage', openingBalanceCents: 100_000 });
    const ira = mk({ name: 'IRA', type: 'retirement', subtype: 'roth_ira', openingDate: '2026-03-01' });
    createSnapshot(db, brokerage, { date: '2026-03-03', balanceCents: 101_000, createdByPersonId: me });
    const at = (today: string) => Object.fromEntries(todaySummary(db, household, today).stale.map((s) => [s.name, s]));
    expect(at('2026-03-10').Brokerage).toMatchObject({ days: 7, stale: false, lastValueDate: '2026-03-03' });
    expect(at('2026-03-11').Brokerage).toMatchObject({ days: 8, stale: true });
    // No value update yet: measured from the opening date.
    expect(at('2026-03-08').IRA).toMatchObject({ lastValueDate: null, basisDate: '2026-03-01', days: 7, stale: false });
    expect(at('2026-03-09').IRA.stale).toBe(true);
    // Archived accounts are never flagged.
    setArchived(db, ira, true);
    expect(at('2026-04-01').IRA).toBeUndefined();
  });

  it('review status: uncleared and cleared counts and last reconciliation per account', () => {
    const card = mk({ name: 'Card', type: 'credit_card' });
    mk({ name: 'Brokerage', type: 'brokerage' }); // not reconcilable: not listed
    const a = post('2026-03-02', 'Shop', [acct(card, -1_000), C('Groceries', 1_000)]);
    const b = post('2026-03-03', 'Shop', [acct(card, -2_000), C('Groceries', 2_000)]);
    post('2026-03-04', 'Shop', [acct(card, -3_000), C('Groceries', 3_000)]);
    setTxnStatus(db, a.id, { status: 'cleared' });
    setTxnStatus(db, b.id, { status: 'cleared' });
    completeReconciliation(db, card, { statementDate: '2026-03-02', statementBalanceCents: -1_000, personId: me });
    expect(todaySummary(db, household, '2026-03-10').review).toEqual([
      { accountId: card, name: 'Card', type: 'credit_card', unclearedCount: 1, clearedCount: 1, lastReconciledDate: '2026-03-02' },
    ]);
  });

  it('uncategorized list, budget glance, and scope', () => {
    const mine = mk({ name: 'Mine', type: 'credit_card' });
    const theirs = mk({ name: 'Theirs', type: 'credit_card', ownerIds: [partner] });
    post('2026-03-05', 'Popup', [acct(mine, -2_475), C('Uncategorized', 2_475)]);
    post('2026-03-06', 'Venmo', [acct(theirs, 4_000), C('Uncategorized', -4_000)]);
    post('2026-03-07', 'Bistro', [acct(theirs, -7_000), C('Dining', 7_000)]);
    setBudget(db, '2026-03', categoryId(db, 'Dining'), 6_000);
    setBudget(db, '2026-03', categoryId(db, 'Groceries'), 30_000);

    const hh = todaySummary(db, household, '2026-03-10');
    expect(hh.uncategorized.total).toBe(2);
    expect(hh.uncategorized.txns.map((t) => t.payee)).toEqual(['Venmo', 'Popup']);
    expect(hh.budget).toEqual({
      month: '2026-03',
      hasBudget: true,
      budgetedCents: 36_000,
      spentBudgetedCents: 7_000,
      overCategories: ['Dining'],
    });
    const mineToday = todaySummary(db, { type: 'person', personId: me }, '2026-03-10');
    expect(mineToday.uncategorized.total).toBe(1);
    expect(mineToday.review.map((r) => r.name)).toEqual(['Mine']);
    expect(mineToday.budget.overCategories).toEqual([]);
  });
});

describe('payee hints', () => {
  it('one per payee (case-insensitive), newest first, with the last single category', () => {
    const card = mk({ name: 'Card', type: 'credit_card' });
    const checking = mk({ name: 'Checking', openingBalanceCents: 100_000 });
    post('2026-03-01', 'Green Basket', [acct(card, -1_000), C('Dining', 1_000)]);
    post('2026-03-08', 'green basket ', [acct(card, -1_000), C('Groceries', 1_000)]); // newer wins
    post('2026-03-05', 'Big Box', [acct(card, -3_000), C('Groceries', 2_000), C('Clothing', 1_000)]); // split: no hint
    post('2026-03-06', 'Popup', [acct(card, -500), C('Uncategorized', 500)]); // uncategorized: no hint
    post('2026-03-07', 'To savings', [acct(checking, -500), acct(card, 500)]); // transfer: no category
    post('2026-03-09', '', [acct(card, -100), C('Fees', 100)]); // no payee: skipped
    expect(listPayees(db)).toEqual([
      { payee: 'green basket', lastDate: '2026-03-08', categoryId: categoryId(db, 'Groceries') },
      { payee: 'To savings', lastDate: '2026-03-07', categoryId: null },
      { payee: 'Popup', lastDate: '2026-03-06', categoryId: null },
      { payee: 'Big Box', lastDate: '2026-03-05', categoryId: null },
    ]);
  });
});

describe('Today API', () => {
  it('GET /api/today and /api/payees', async () => {
    const app = buildApp(db);
    mk({ name: 'Checking' });
    let res = await app.inject({ url: `/api/today?scope=person:${me}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().review[0].name).toBe('Checking');
    res = await app.inject({ url: '/api/payees' });
    expect(res.json()).toEqual([]);
    res = await app.inject({ url: '/api/today?scope=nobody' });
    expect(res.statusCode).toBe(400);
  });
});
