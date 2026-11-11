import { beforeEach, describe, expect, it } from 'vitest';
import type { OverviewReport, PostingInput, Scope } from '@ledger/shared';
import { buildApp } from '../src/app';
import type { DB } from '../src/db/connection';
import { seedDemoData } from '../src/db/seed';
import { createAccount, setArchived, updateAccount } from '../src/services/accounts';
import { createTxn } from '../src/services/ledger';
import { listPeople } from '../src/services/people';
import { overviewReport } from '../src/services/reports';
import { createSnapshot } from '../src/services/snapshots';
import { acct, accountInput, cat, categoryId, testDb } from './helpers';

let db: DB;
let me: number, partner: number;
const household: Scope = { type: 'household' };
const P = { from: '2026-03-01', to: '2026-03-31' };

beforeEach(() => {
  ({ db, me, partner } = testDb());
});

const mk = (o: Parameters<typeof accountInput>[1]) => createAccount(db, accountInput(me, o)).id;
const post = (date: string, postings: PostingInput[]) => createTxn(db, { date, payee: 'x', postings, createdByPersonId: me });
const C = (name: string, cents: number) => cat(categoryId(db, name), cents);
const report = (scope: Scope = household, p = P) => overviewReport(db, scope, p.from, p.to);
const line = (r: OverviewReport['spending'], name: string) => r.lines.find((l) => l.name === name)?.cents ?? 0;

describe('Overview report (PLAN §3)', () => {
  it('AT-1: a card purchase is spending; paying the card is a transfer', () => {
    const checking = mk({ name: 'Checking', openingBalanceCents: 100_000 });
    const card = mk({ name: 'Card', type: 'credit_card' });
    post('2026-03-05', [acct(card, -5_000), C('Groceries', 5_000)]);
    post('2026-03-20', [acct(checking, -5_000), acct(card, 5_000)]);
    const r = report();
    expect(r.spending.totalCents).toBe(5_000);
    expect(r.debts).toEqual([expect.objectContaining({ name: 'Card', owedCents: 0 })]);
    expect(r.identity.balanced).toBe(true);
  });

  it('AT-2 + AT-21: a savings transfer is not spending but counts as saved; interest is income and saved', () => {
    const checking = mk({ name: 'Checking', openingBalanceCents: 100_000 });
    const savings = mk({ name: 'Savings', type: 'savings' });
    post('2026-03-10', [acct(checking, -50_000), acct(savings, 50_000)]);
    post('2026-03-31', [acct(savings, 412), C('Interest Income', -412)]);
    const r = report();
    expect(r.spending.totalCents).toBe(0);
    expect(r.income.lines).toEqual([{ categoryId: categoryId(db, 'Interest Income'), name: 'Interest Income', cents: 412 }]);
    expect(r.savingsCents).toBe(50_412);
    expect(r.netCents).toBe(412);
  });

  it('AT-3: loan principal is a transfer, interest is spending', () => {
    const checking = mk({ name: 'Checking', openingBalanceCents: 100_000 });
    const loan = mk({ name: 'Car', type: 'loan', subtype: 'auto', openingBalanceCents: -900_000 });
    post('2026-03-25', [acct(checking, -30_000), acct(loan, 25_000), C('Interest Expense', 5_000)]);
    const r = report();
    expect(r.spending.totalCents).toBe(5_000);
    expect(r.debts[0]).toMatchObject({ name: 'Car', subtype: 'auto', owedCents: 875_000 });
  });

  it('AT-4: refunds reduce their category', () => {
    const card = mk({ name: 'Card', type: 'credit_card' });
    post('2026-03-02', [acct(card, -8_000), C('Clothing', 8_000)]);
    post('2026-03-09', [acct(card, 3_000), C('Clothing', -3_000)]);
    expect(line(report().spending, 'Clothing')).toBe(5_000);
  });

  it('AT-5: moving money between investment accounts nets to zero; trades have no postings', () => {
    const checking = mk({ name: 'Checking', openingBalanceCents: 100_000 });
    const brokerage = mk({ name: 'Brokerage', type: 'brokerage' });
    const ira = mk({ name: 'IRA', type: 'retirement', subtype: 'roth_ira' });
    post('2026-03-03', [acct(checking, -30_000), acct(brokerage, 30_000)]);
    post('2026-03-04', [acct(brokerage, -10_000), acct(ira, 10_000)]);
    const r = report();
    expect(r.investmentContributionsCents).toBe(30_000);
    expect(r.spending.totalCents).toBe(0);
    expect(r.income.totalCents).toBe(0);
  });

  it('AT-6/AT-8/AT-11: opening and valuation are excluded from income and spending, labelled with their dates', () => {
    const brokerage = mk({ name: 'Brokerage', type: 'brokerage', openingDate: '2026-03-01', openingBalanceCents: 1_000_000 });
    const ira = mk({ name: 'IRA', type: 'retirement', subtype: 'roth_ira', openingBalanceCents: 50_000 });
    const checking = mk({ name: 'Checking', openingBalanceCents: 100_000 });
    createSnapshot(db, brokerage, { date: '2026-03-15', balanceCents: 1_020_000, createdByPersonId: me });
    post('2026-03-20', [acct(checking, -5_000), acct(brokerage, 5_000)]);
    const r = report();
    expect(r.income.totalCents).toBe(0);
    expect(r.spending.totalCents).toBe(0);
    expect(r.valuationChangeCents).toBe(20_000);
    expect(r.identity).toMatchObject({ openingCents: 1_000_000, changeCents: 1_020_000, balanced: true });
    const nw = Object.fromEntries(r.netWorth.lines.map((l) => [l.name, l.valuation]));
    expect(nw.Brokerage).toEqual({ kind: 'snapshot', date: '2026-03-15', transfersSince: true });
    expect(nw.IRA).toEqual({ kind: 'opening', date: '2026-01-01' });
    expect(nw.Checking).toBeNull();
    // Editing the opening balance replaces it in the report (AT-11).
    updateAccount(db, brokerage, { openingBalanceCents: 900_000, createdByPersonId: me });
    expect(report().identity.openingCents).toBe(900_000);
    expect(report().valuationChangeCents).toBe(120_000);
  });

  it('AT-20: a paycheck splits into gross income, taxes and a 401(k) contribution', () => {
    const checking = mk({ name: 'Checking' });
    const k401 = mk({ name: '401k', type: 'retirement', subtype: '401k' });
    post('2026-03-15', [
      C('Salary', -500_000),
      C('Federal Income Tax', 70_000),
      C('State Income Tax', 20_000),
      C('Social Security & Medicare', 10_000),
      acct(k401, 50_000),
      acct(checking, 350_000),
    ]);
    const r = report();
    expect(r.income.totalCents).toBe(500_000);
    expect(r.taxes.totalCents).toBe(100_000);
    expect(r.taxes.lines.map((l) => l.name)).toEqual(['Federal Income Tax', 'State Income Tax', 'Social Security & Medicare']);
    expect(r.investmentContributionsCents).toBe(50_000);
    expect(r.netCents).toBe(400_000);
    expect(r.netWorth.endCents - r.netWorth.startCents).toBe(400_000); // net deposit + 401k
  });

  it('Uncategorized counts by sign and is warned about (D6)', () => {
    const card = mk({ name: 'Card', type: 'credit_card' });
    post('2026-03-29', [acct(card, -2_475), C('Uncategorized', 2_475)]);
    post('2026-03-30', [acct(card, 4_000), C('Uncategorized', -4_000)]);
    const r = report();
    expect(r.spending.lines).toEqual([expect.objectContaining({ name: 'Uncategorized (money out)', cents: 2_475, uncategorized: true })]);
    expect(r.income.lines).toEqual([expect.objectContaining({ name: 'Uncategorized (money in)', cents: 4_000, uncategorized: true })]);
    expect(r.uncategorized).toEqual({ count: 2, cents: 6_475 });
  });

  it('only the period counts; net worth starts at the end of the day before', () => {
    const checking = mk({ name: 'Checking', openingBalanceCents: 100_000 });
    const card = mk({ name: 'Card', type: 'credit_card' });
    post('2026-02-28', [acct(card, -1_000), C('Dining', 1_000)]);
    post('2026-04-01', [acct(card, -2_000), C('Dining', 2_000)]);
    post('2026-03-01', [acct(checking, -500), C('Dining', 500)]);
    const r = report();
    expect(r.spending.totalCents).toBe(500);
    expect(r.netWorth).toMatchObject({ startCents: 99_000, endCents: 98_500 });
  });

  it('archived accounts stay in net worth while nonzero; accounts opened later are left out', () => {
    const old = mk({ name: 'Old', openingBalanceCents: 1_000 });
    const empty = mk({ name: 'Empty' });
    mk({ name: 'Future', openingDate: '2026-06-01', openingBalanceCents: 5_000 });
    setArchived(db, old, true);
    setArchived(db, empty, true);
    expect(report().netWorth.lines.map((l) => [l.name, l.archived])).toEqual([['Old', true]]);
  });

  it('AT-7: joint accounts count once in household and in full for each person; outside transfers explain the rest', () => {
    const joint = mk({ name: 'Joint', ownerIds: [me, partner], openingBalanceCents: 200_000 });
    const mine = mk({ name: 'Mine', type: 'credit_card' });
    const theirs = mk({ name: 'Theirs', type: 'credit_card', ownerIds: [partner] });
    post('2026-03-05', [acct(joint, -10_000), C('Groceries', 10_000)]);
    post('2026-03-06', [acct(mine, -2_000), C('Dining', 2_000)]);
    post('2026-03-07', [acct(theirs, -3_000), C('Dining', 3_000)]);
    post('2026-03-20', [acct(joint, -3_000), acct(theirs, 3_000)]); // partner's card paid from joint

    const hh = report();
    const mineR = report({ type: 'person', personId: me });
    const theirsR = report({ type: 'person', personId: partner });
    expect(hh.spending.totalCents).toBe(15_000);
    expect(mineR.spending.totalCents).toBe(12_000);
    expect(theirsR.spending.totalCents).toBe(13_000);
    expect(hh.netWorth.lines.filter((l) => l.name === 'Joint')).toHaveLength(1);
    expect(mineR.scope).toEqual({ type: 'person', personId: me, label: 'Me', includesJointAccounts: true });
    expect(hh.scope).toEqual({ type: 'household', label: 'Household', includesJointAccounts: false });
    expect(hh.identity.outsideTransfersCents).toBeNull();
    // Me's scope paid 3,000 to an account outside it (partner's card).
    expect(mineR.identity).toMatchObject({ outsideTransfersCents: -3_000, balanced: true });
    expect(theirsR.identity.balanced).toBe(true);
  });

  it('AT-17: the household identity holds on the seed data, for every period and scope', () => {
    seedDemoData(db);
    const people = listPeople(db);
    const scopes: Scope[] = [household, ...people.map((p) => ({ type: 'person' as const, personId: p.id }))];
    const periods = [
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-02-28' },
      { from: '2026-03-01', to: '2026-03-31' },
      { from: '2026-01-01', to: '2026-12-31' },
      { from: '2025-01-01', to: '2025-12-31' },
    ];
    for (const scope of scopes) for (const p of periods) expect(report(scope, p).identity.balanced).toBe(true);

    const q1 = report(household, { from: '2026-01-01', to: '2026-03-31' });
    expect(q1.income.lines.find((l) => l.name === 'Salary')!.cents).toBe(3 * (2 * 320_000 + 410_000));
    expect(q1.netWorth.endCents - q1.netWorth.startCents).toBe(
      q1.netCents + q1.valuationChangeCents + q1.identity.openingCents,
    );
    expect(q1.uncategorized.count).toBe(2);
  });

  it('rejects bad periods', () => {
    expect(() => overviewReport(db, household, '2026-03-31', '2026-03-01')).toThrow(/starts after/);
    expect(() => overviewReport(db, household, '', '2026-03-01')).toThrow(/YYYY-MM-DD/);
  });
});

describe('reports API', () => {
  it('GET /api/reports/overview', async () => {
    const app = buildApp(db);
    mk({ name: 'Checking', openingBalanceCents: 1_000 });
    let res = await app.inject({ url: `/api/reports/overview?scope=person:${me}&from=2026-01-01&to=2026-01-31` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scope: { label: 'Me' }, period: { from: '2026-01-01', to: '2026-01-31' } });
    expect(res.json().netWorth.endCents).toBe(1_000);
    res = await app.inject({ url: '/api/reports/overview?from=2026-01-01' });
    expect(res.statusCode).toBe(400);
  });
});
