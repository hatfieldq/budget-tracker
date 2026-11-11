import { beforeEach, describe, expect, it } from 'vitest';
import type { BudgetMonth, PostingInput } from '@ledger/shared';
import { buildApp } from '../src/app';
import type { DB } from '../src/db/connection';
import { seedDemoData } from '../src/db/seed';
import { createAccount } from '../src/services/accounts';
import { copyPreviousMonth, getBudgetMonth, setBudget } from '../src/services/budgets';
import { setCategoryArchived } from '../src/services/categories';
import { createTxn } from '../src/services/ledger';
import { createSnapshot } from '../src/services/snapshots';
import { acct, accountInput, cat, categoryId, testDb } from './helpers';

let db: DB;
let me: number, partner: number;
let mine: number, theirs: number, joint: number, savings: number, brokerage: number;
const household = { type: 'household' } as const;

beforeEach(() => {
  ({ db, me, partner } = testDb());
  const mk = (o: Parameters<typeof accountInput>[1]) => createAccount(db, accountInput(me, o)).id;
  mine = mk({ name: 'My Card', type: 'credit_card' });
  theirs = mk({ name: 'Their Card', type: 'credit_card', ownerIds: [partner] });
  joint = mk({ name: 'Joint', ownerIds: [me, partner], openingBalanceCents: 500_000 });
  savings = mk({ name: 'Savings', type: 'savings' });
  brokerage = mk({ name: 'Brokerage', type: 'brokerage' });
});

const post = (date: string, postings: PostingInput[]) =>
  createTxn(db, { date, payee: 'x', postings, createdByPersonId: me });
const spend = (accountId: number, category: string, cents: number, date = '2026-03-10') =>
  post(date, [acct(accountId, -cents), cat(categoryId(db, category), cents)]);
const line = (m: BudgetMonth, name: string) => m.lines.find((l) => l.name === name)!;

// AT-22: budget vs. actual
describe('spending for budgets (PLAN §3)', () => {
  it('counts expense postings only in the month; transfers, income, taxes, opening and valuations do not', () => {
    spend(mine, 'Groceries', 12_000);
    spend(mine, 'Groceries', 3_000, '2026-02-28'); // previous month
    spend(mine, 'Groceries', 1_000, '2026-04-01'); // next month
    post('2026-03-12', [acct(joint, -50_000), acct(savings, 50_000)]); // AT-2 transfer
    post('2026-03-13', [acct(joint, -20_000), acct(mine, 20_000)]); // AT-1 card payment
    post('2026-03-14', [acct(joint, -30_000), acct(brokerage, 30_000)]); // AT-5 contribution
    post('2026-03-15', [cat(categoryId(db, 'Salary'), -100_000), cat(categoryId(db, 'Federal Income Tax'), 20_000), acct(joint, 80_000)]);
    const loan = createAccount(db, accountInput(me, { name: 'Loan', type: 'loan', subtype: 'auto', openingBalanceCents: -900_000 })).id;
    post('2026-03-25', [acct(joint, -30_000), acct(loan, 25_000), cat(categoryId(db, 'Interest Expense'), 5_000)]); // AT-3
    createSnapshot(db, brokerage, { date: '2026-03-31', balanceCents: 31_000, createdByPersonId: me }); // valuation +1,000

    const m = getBudgetMonth(db, household, '2026-03');
    const spent = Object.fromEntries(m.lines.filter((l) => l.spentCents !== 0).map((l) => [l.name, l.spentCents]));
    expect(spent).toEqual({ Groceries: 12_000, 'Interest Expense': 5_000 });
    // Only expense categories are budget lines.
    expect(m.lines.some((l) => l.name === 'Salary' || l.name === 'Federal Income Tax')).toBe(false);
  });

  it('AT-4: refunds reduce the category, possibly below zero', () => {
    spend(mine, 'Clothing', 5_000);
    spend(mine, 'Clothing', -7_000); // bigger refund
    expect(line(getBudgetMonth(db, household, '2026-03'), 'Clothing').spentCents).toBe(-2_000);
  });

  it('Uncategorized money out is reported separately, money in is not spending (D6)', () => {
    spend(mine, 'Uncategorized', 2_475);
    spend(mine, 'Uncategorized', -4_000);
    expect(getBudgetMonth(db, household, '2026-03').uncategorized).toEqual({ cents: 2_475, count: 1 });
  });

  it('AT-7: scope picks accounts; a joint account counts once in household and fully for each person', () => {
    spend(mine, 'Dining', 1_000);
    spend(theirs, 'Dining', 2_000);
    spend(joint, 'Dining', 4_000);
    const dining = (scope: Parameters<typeof getBudgetMonth>[1]) => line(getBudgetMonth(db, scope, '2026-03'), 'Dining').spentCents;
    expect(dining(household)).toBe(7_000);
    expect(dining({ type: 'person', personId: me })).toBe(5_000);
    expect(dining({ type: 'person', personId: partner })).toBe(6_000);
    const m = getBudgetMonth(db, { type: 'person', personId: me }, '2026-03');
    expect(m).toMatchObject({ scopeLabel: 'Me', includesJointAccounts: true });
    expect(getBudgetMonth(db, household, '2026-03')).toMatchObject({ scopeLabel: 'Household', includesJointAccounts: false });
  });
});

describe('budget amounts', () => {
  it('set, change and clear one month without touching others', () => {
    const groceries = categoryId(db, 'Groceries');
    setBudget(db, '2026-03', groceries, 40_000);
    setBudget(db, '2026-03', groceries, 45_000);
    expect(line(getBudgetMonth(db, household, '2026-03'), 'Groceries').budgetCents).toBe(45_000);
    expect(line(getBudgetMonth(db, household, '2026-04'), 'Groceries').budgetCents).toBeNull(); // fresh each month
    setBudget(db, '2026-03', groceries, null);
    expect(line(getBudgetMonth(db, household, '2026-03'), 'Groceries').budgetCents).toBeNull();
    setBudget(db, '2026-03', groceries, 0); // an explicit zero budget is allowed
    expect(line(getBudgetMonth(db, household, '2026-03'), 'Groceries').budgetCents).toBe(0);
  });

  it('rejects bad months, amounts and categories', () => {
    const groceries = categoryId(db, 'Groceries');
    expect(() => setBudget(db, '2026-13', groceries, 100)).toThrow(/YYYY-MM/);
    expect(() => setBudget(db, '2026-03', groceries, -1)).toThrow(/zero or more/);
    expect(() => setBudget(db, '2026-03', groceries, 1.5)).toThrow(/whole cents/);
    expect(() => setBudget(db, '2026-03', categoryId(db, 'Salary'), 100)).toThrow(/expense/);
    expect(() => setBudget(db, '2026-03', categoryId(db, 'Uncategorized'), 100)).toThrow(/expense/);
    expect(() => setBudget(db, '2026-03', 9_999, 100)).toThrow(/not found/i);
    setCategoryArchived(db, groceries, true);
    expect(() => setBudget(db, '2026-03', groceries, 100)).toThrow(/archived/);
  });

  it('archived categories show only when the month has a budget or spending for them', () => {
    const fees = categoryId(db, 'Fees');
    setBudget(db, '2026-03', fees, 1_000);
    setCategoryArchived(db, fees, true);
    expect(line(getBudgetMonth(db, household, '2026-03'), 'Fees')).toMatchObject({ archived: true, budgetCents: 1_000 });
    expect(line(getBudgetMonth(db, household, '2026-04'), 'Fees')).toBeUndefined();
  });

  it('copy last month fills blanks only and skips archived categories', () => {
    setBudget(db, '2026-02', categoryId(db, 'Groceries'), 30_000);
    setBudget(db, '2026-02', categoryId(db, 'Dining'), 6_000);
    setBudget(db, '2026-02', categoryId(db, 'Fees'), 500);
    setCategoryArchived(db, categoryId(db, 'Fees'), true);
    setBudget(db, '2026-03', categoryId(db, 'Dining'), 8_000); // already set: kept
    expect(getBudgetMonth(db, household, '2026-03').previousMonthBudgetCount).toBe(3);
    expect(copyPreviousMonth(db, '2026-03')).toBe(1);
    const m = getBudgetMonth(db, household, '2026-03');
    expect(line(m, 'Groceries').budgetCents).toBe(30_000);
    expect(line(m, 'Dining').budgetCents).toBe(8_000);
    expect(line(m, 'Fees')).toBeUndefined();
    expect(copyPreviousMonth(db, '2026-03')).toBe(0); // idempotent
    expect(() => copyPreviousMonth(db, '2026-06')).toThrow(/2026-05 has no budget/);
  });

  it('seed: three months of budgets with over, under and exact lines', () => {
    const fresh = testDb().db;
    expect(seedDemoData(fresh)).toMatch(/24 budget amounts/);
    const m = getBudgetMonth(fresh, household, '2026-03');
    expect(line(m, 'Dining')).toMatchObject({ budgetCents: 6_000, spentCents: 6_450 }); // over
    expect(line(m, 'Housing')).toMatchObject({ budgetCents: 185_000, spentCents: 185_000 }); // exact
    expect(line(m, 'Groceries')).toMatchObject({ budgetCents: 30_000, spentCents: 28_796 }); // under
    expect(m.uncategorized).toEqual({ cents: 2_475, count: 1 });
  });
});

describe('budgets API', () => {
  it('get, put, clear, copy, and errors', async () => {
    const app = buildApp(db);
    const groceries = categoryId(db, 'Groceries');
    spend(mine, 'Groceries', 12_345);
    let res = await app.inject({ method: 'PUT', url: `/api/budgets/2026-02/${groceries}`, payload: { amountCents: 20_000 } });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ method: 'POST', url: '/api/budgets/2026-03/copy-previous' });
    expect(res.json()).toEqual({ copied: 1 });
    res = await app.inject({ url: `/api/budgets/2026-03?scope=person:${me}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines.find((l: { categoryId: number }) => l.categoryId === groceries)).toMatchObject({
      budgetCents: 20_000,
      spentCents: 12_345,
    });
    res = await app.inject({ method: 'PUT', url: `/api/budgets/2026-03/${groceries}`, payload: { amountCents: null } });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ method: 'PUT', url: `/api/budgets/2026-03/${groceries}`, payload: {} });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ url: '/api/budgets/March' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/YYYY-MM/);
  });
});
