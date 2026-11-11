import { beforeEach, describe, expect, it } from 'vitest';
import type { BudgetMonth, PostingInput } from '@ledger/shared';
import { buildApp } from '../src/app';
import type { DB } from '../src/db/connection';
import { seedDemoData } from '../src/db/seed';
import { createAccount, setArchived } from '../src/services/accounts';
import { copyPreviousMonth, getBudgetMonth, setAccountBudget, setBudget, setGroupBudget } from '../src/services/budgets';
import { overviewReport } from '../src/services/reports';
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
    const spent = Object.fromEntries(m.lines.filter((l) => l.spentCents !== 0).map((l) => [`${l.kind}:${l.name}`, l.spentCents]));
    // The loan payment counts in full on the loan's line (D36); the savings move on the savings line.
    expect(spent).toEqual({ 'category:Groceries': 12_000, 'loan:Loan': 30_000, 'savings:Savings': 50_000, 'investing:All investing': 30_000 });
    expect(line(m, 'Interest Expense')).toMatchObject({ spentCents: 0, inLoanPaymentsCents: 5_000 });
    // Only expense categories, loans and savings accounts are budget lines.
    expect(m.lines.some((l) => ['Salary', 'Federal Income Tax', 'My Card', 'Joint', 'Brokerage'].includes(l.name))).toBe(false);
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
    expect(seedDemoData(fresh)).toMatch(/33 budget amounts/);
    const m = getBudgetMonth(fresh, household, '2026-03');
    expect(line(m, 'Dining')).toMatchObject({ budgetCents: 6_000, spentCents: 6_450 }); // over
    expect(line(m, 'Housing')).toMatchObject({ budgetCents: 185_000, spentCents: 185_000 }); // exact
    expect(line(m, 'Groceries')).toMatchObject({ budgetCents: 30_000, spentCents: 28_796 }); // under
    expect(m.uncategorized).toEqual({ cents: 2_475, count: 1 });
    expect(line(m, 'Hatchback Loan')).toMatchObject({ kind: 'loan', budgetCents: 38_500, spentCents: 38_500 });
    expect(line(m, 'Grad School Loan')).toMatchObject({ kind: 'loan', budgetCents: 29_000, spentCents: 29_000 });
    expect(line(m, 'Car Fund')).toMatchObject({ kind: 'savings', budgetCents: 20_000, spentCents: 20_000 });
    expect(line(m, 'Interest Expense')).toMatchObject({ spentCents: 0, inLoanPaymentsCents: 16_471 });
    expect(line(m, 'All investing')).toMatchObject({ kind: 'investing', group: 'investing', budgetCents: 90_000, spentCents: 83_400 });
  });
});

// D36: loans as whole-payment lines, savings as goals.
describe('loan and savings budget lines', () => {
  let loan: number;
  beforeEach(() => {
    loan = createAccount(db, accountInput(me, { name: 'Car Loan', type: 'loan', subtype: 'auto', openingBalanceCents: -1_450_000 })).id;
  });
  const pay = (date: string, principal: number, interest: number) =>
    post(date, [acct(joint, -(principal + interest)), acct(loan, principal), cat(categoryId(db, 'Interest Expense'), interest)]);

  it('a loan line is the whole payment; its interest leaves the Interest Expense line; nothing double counts', () => {
    pay('2026-03-25', 32_458, 6_042);
    spend(mine, 'Interest Expense', 1_200); // card interest stays on the category line
    setAccountBudget(db, '2026-03', loan, 38_500);
    setBudget(db, '2026-03', categoryId(db, 'Interest Expense'), 2_000);
    const m = getBudgetMonth(db, household, '2026-03');
    expect(line(m, 'Car Loan')).toMatchObject({ kind: 'loan', accountId: loan, categoryId: null, budgetCents: 38_500, spentCents: 38_500 });
    expect(line(m, 'Interest Expense')).toMatchObject({ spentCents: 1_200, inLoanPaymentsCents: 6_042 });
    // Every dollar of spending + payments is counted exactly once.
    const total = m.lines.filter((l) => l.kind !== 'savings').reduce((s, l) => s + l.spentCents, 0);
    expect(total).toBe(38_500 + 1_200);
  });

  it('extra principal or two payments push the loan over; borrowing more does not count', () => {
    pay('2026-03-05', 32_458, 6_042);
    post('2026-03-20', [acct(joint, -10_000), acct(loan, 10_000)]); // extra principal, as a plain transfer
    post('2026-03-28', [acct(loan, -50_000), acct(joint, 50_000)]); // drew more on the loan
    setAccountBudget(db, '2026-03', loan, 38_500);
    expect(line(getBudgetMonth(db, household, '2026-03'), 'Car Loan').spentCents).toBe(48_500);
  });

  it('savings line = net moved in this month, including interest and withdrawals', () => {
    post('2026-03-01', [acct(joint, -20_000), acct(savings, 20_000)]);
    post('2026-03-31', [acct(savings, 51), cat(categoryId(db, 'Interest Income'), -51)]);
    post('2026-03-15', [acct(savings, -5_000), acct(joint, 5_000)]); // took some back out
    setAccountBudget(db, '2026-03', savings, 20_000);
    expect(line(getBudgetMonth(db, household, '2026-03'), 'Savings')).toMatchObject({ kind: 'savings', spentCents: 15_051 });
  });

  it('Overview is unchanged: principal is never spending', () => {
    pay('2026-03-25', 32_458, 6_042);
    setAccountBudget(db, '2026-03', loan, 38_500);
    const r = overviewReport(db, household, '2026-03-01', '2026-03-31');
    expect(r.spending.totalCents).toBe(6_042);
    expect(r.identity.balanced).toBe(true);
  });

  it('scope: only in-scope loans/savings are lines; out-of-scope loan interest stays on its category', () => {
    const theirLoan = createAccount(db, accountInput(me, { name: 'Their Loan', type: 'loan', subtype: 'student', ownerIds: [partner], openingBalanceCents: -100_000 })).id;
    // Paid from the joint account (in both scopes).
    post('2026-03-25', [acct(joint, -12_000), acct(theirLoan, 10_000), cat(categoryId(db, 'Interest Expense'), 2_000)]);
    const mineM = getBudgetMonth(db, { type: 'person', personId: me }, '2026-03');
    expect(line(mineM, 'Their Loan')).toBeUndefined();
    expect(line(mineM, 'Interest Expense').spentCents).toBe(2_000);
    const theirsM = getBudgetMonth(db, { type: 'person', personId: partner }, '2026-03');
    expect(line(theirsM, 'Their Loan').spentCents).toBe(12_000);
    expect(line(theirsM, 'Interest Expense').spentCents).toBe(0);
  });

  it('validation, clearing, archived accounts, and copy last month', () => {
    expect(() => setAccountBudget(db, '2026-03', mine, 100)).toThrow(/loan and savings/);
    expect(() => setAccountBudget(db, '2026-03', brokerage, 100)).toThrow(/loan and savings/);
    expect(() => setAccountBudget(db, '2026-03', 9_999, 100)).toThrow(/not found/i);
    expect(() => setAccountBudget(db, '2026-03', loan, -1)).toThrow(/zero or more/);
    setAccountBudget(db, '2026-02', loan, 38_500);
    setAccountBudget(db, '2026-02', savings, 20_000);
    setBudget(db, '2026-02', categoryId(db, 'Groceries'), 30_000);
    setAccountBudget(db, '2026-03', savings, 25_000); // already set: kept
    expect(copyPreviousMonth(db, '2026-03')).toBe(2);
    const m = getBudgetMonth(db, household, '2026-03');
    expect([line(m, 'Car Loan').budgetCents, line(m, 'Savings').budgetCents, line(m, 'Groceries').budgetCents]).toEqual([38_500, 25_000, 30_000]);
    setAccountBudget(db, '2026-03', loan, null);
    expect(line(getBudgetMonth(db, household, '2026-03'), 'Car Loan').budgetCents).toBeNull();
    // Archived: hidden unless the month has a budget or activity; can't get a new amount.
    setArchived(db, savings, true);
    expect(() => setAccountBudget(db, '2026-04', savings, 100)).toThrow(/archived/);
    expect(line(getBudgetMonth(db, household, '2026-03'), 'Savings')).toMatchObject({ archived: true });
    expect(line(getBudgetMonth(db, household, '2026-05'), 'Savings')).toBeUndefined();
  });

  it('API: PUT /api/budgets/:month/accounts/:id', async () => {
    const app = buildApp(db);
    let res = await app.inject({ method: 'PUT', url: `/api/budgets/2026-03/accounts/${loan}`, payload: { amountCents: 38_500 } });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ url: '/api/budgets/2026-03' });
    expect(res.json().lines.find((l: { accountId: number | null }) => l.accountId === loan).budgetCents).toBe(38_500);
    res = await app.inject({ method: 'PUT', url: `/api/budgets/2026-03/accounts/${mine}`, payload: { amountCents: 1 } });
    expect(res.statusCode).toBe(400);
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

// D37: one goal for all investing.
describe('All investing line', () => {
  let ira: number, k401: number;
  beforeEach(() => {
    ira = createAccount(db, accountInput(me, { name: 'Roth IRA', type: 'retirement', subtype: 'roth_ira' })).id;
    k401 = createAccount(db, accountInput(me, { name: 'Roth 401k', type: 'retirement', subtype: 'roth_401k', ownerIds: [partner] })).id;
  });

  it('totals every investment account, however the money got there; valuations never count; matches Overview', () => {
    // Paycheck split straight into the 401(k), a transfer to the IRA, one to the brokerage.
    post('2026-03-15', [cat(categoryId(db, 'Salary'), -300_000), acct(k401, 19_200), acct(joint, 280_800)]);
    post('2026-03-16', [acct(joint, -30_000), acct(ira, 30_000)]);
    post('2026-03-17', [acct(joint, -10_000), acct(brokerage, 10_000)]);
    post('2026-03-18', [acct(brokerage, -5_000), acct(ira, 5_000)]); // moving between investments nets to zero
    createSnapshot(db, ira, { date: '2026-03-31', balanceCents: 40_000, createdByPersonId: me }); // +5,000 growth: not counted
    setGroupBudget(db, '2026-03', 'investing', 60_000);

    const m = getBudgetMonth(db, household, '2026-03');
    expect(line(m, 'All investing')).toMatchObject({ kind: 'investing', budgetCents: 60_000, spentCents: 59_200 });
    // Individual investment accounts are not separate lines.
    expect(m.lines.some((l) => ['Roth IRA', 'Roth 401k', 'Brokerage'].includes(l.name))).toBe(false);
    expect(overviewReport(db, household, '2026-03-01', '2026-03-31').investmentContributionsCents).toBe(59_200);
  });

  it('withdrawals reduce it; scope picks the accounts', () => {
    post('2026-03-01', [acct(joint, -30_000), acct(ira, 30_000)]); // me
    post('2026-03-02', [acct(joint, -20_000), acct(k401, 20_000)]); // partner
    post('2026-03-20', [acct(ira, -4_000), acct(joint, 4_000)]); // took some out
    expect(line(getBudgetMonth(db, household, '2026-03'), 'All investing').spentCents).toBe(46_000);
    expect(line(getBudgetMonth(db, { type: 'person', personId: me }, '2026-03'), 'All investing').spentCents).toBe(26_000);
    expect(line(getBudgetMonth(db, { type: 'person', personId: partner }, '2026-03'), 'All investing').spentCents).toBe(20_000);
  });

  it('set, clear, copy, validation; hidden when there are no investment accounts', () => {
    setGroupBudget(db, '2026-02', 'investing', 50_000);
    expect(copyPreviousMonth(db, '2026-03')).toBe(1);
    expect(line(getBudgetMonth(db, household, '2026-03'), 'All investing').budgetCents).toBe(50_000);
    setGroupBudget(db, '2026-03', 'investing', null);
    expect(line(getBudgetMonth(db, household, '2026-03'), 'All investing').budgetCents).toBeNull();
    expect(() => setGroupBudget(db, '2026-03', 'travel', 1)).toThrow(/not found/i);
    expect(() => setGroupBudget(db, '2026-03', 'investing', -1)).toThrow(/zero or more/);

    const empty = testDb().db;
    expect(getBudgetMonth(empty, household, '2026-03').lines.some((l) => l.kind === 'investing')).toBe(false);
  });

  it('API: PUT /api/budgets/:month/groups/investing', async () => {
    const app = buildApp(db);
    let res = await app.inject({ method: 'PUT', url: '/api/budgets/2026-03/groups/investing', payload: { amountCents: 50_000 } });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ url: '/api/budgets/2026-03' });
    expect(res.json().lines.find((l: { kind: string }) => l.kind === 'investing').budgetCents).toBe(50_000);
    res = await app.inject({ method: 'PUT', url: '/api/budgets/2026-03/groups/nope', payload: { amountCents: 1 } });
    expect(res.statusCode).toBe(404);
  });
});
