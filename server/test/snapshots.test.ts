import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { createAccount, getAccount, updateAccount } from '../src/services/accounts';
import { createTxn, deleteTxn, getTxn, listTxns, updateTxn } from '../src/services/ledger';
import { createSnapshot, deleteSnapshot, listSnapshots, updateSnapshot } from '../src/services/snapshots';
import { buildApp } from '../src/app';
import { acct, accountInput, cat, categoryId, categoryTotal, testDb, unbalancedTxnIds } from './helpers';

let db: DB;
let me: number;
let checking: number, k401: number;

beforeEach(() => {
  ({ db, me } = testDb());
  checking = createAccount(db, accountInput(me, { name: 'Checking', openingBalanceCents: 1_000_000 })).id;
  k401 = createAccount(
    db,
    accountInput(me, { name: 'Roth 401(k)', type: 'retirement', subtype: 'roth_401k', openingBalanceCents: 4_000_000 }),
  ).id;
});

const contribute = (cents: number, date: string) =>
  createTxn(db, { date, payee: 'Contribution', postings: [acct(checking, -cents), acct(k401, cents)], createdByPersonId: me });
const snap = (date: string, balanceCents: number) =>
  createSnapshot(db, k401, { date, balanceCents, createdByPersonId: me });
const balanceOn = (date: string) => getAccount(db, k401, date).balanceCents;
const valuationTxns = () => listTxns(db, { accountId: k401 }).txns.filter((t) => t.kind === 'valuation');

describe('AT-6: valuation is separate from contributions', () => {
  it('a snapshot books only the unexplained difference as Valuation Change', () => {
    contribute(50_000, '2026-01-15');
    const s = snap('2026-01-31', 4_123_456); // ledger says 4,050,000
    expect(s.valuationCents).toBe(73_456);
    expect(balanceOn('2026-01-31')).toBe(4_123_456);
    expect(categoryTotal(db, 'Valuation Change')).toBe(-73_456);
    const [v] = valuationTxns();
    expect(v).toMatchObject({ date: '2026-01-31', kind: 'valuation' });
    // The contribution itself is still a plain transfer, untouched.
    expect(listTxns(db, { accountId: k401 }).txns.filter((t) => t.isTransfer)).toHaveLength(1);
    expect(unbalancedTxnIds(db)).toEqual([]);
  });

  it('a backdated contribution recomputes the valuation; the snapshot still holds', () => {
    snap('2026-01-31', 4_100_000); // +100,000 growth
    contribute(30_000, '2026-01-20'); // entered later, dated before the snapshot
    expect(listSnapshots(db, k401)[0].valuationCents).toBe(70_000);
    expect(balanceOn('2026-01-31')).toBe(4_100_000);
    expect(valuationTxns()).toHaveLength(1);
    // A contribution after the snapshot doesn't change it.
    contribute(10_000, '2026-02-05');
    expect(listSnapshots(db, k401)[0].valuationCents).toBe(70_000);
  });

  it('editing or deleting a contribution recomputes too', () => {
    const c = contribute(30_000, '2026-01-20');
    snap('2026-01-31', 4_100_000);
    expect(listSnapshots(db, k401)[0].valuationCents).toBe(70_000);
    const t = getTxn(db, c.id);
    updateTxn(db, c.id, {
      date: t.date,
      postings: [acct(checking, -40_000), acct(k401, 40_000)],
      createdByPersonId: me,
    });
    expect(listSnapshots(db, k401)[0].valuationCents).toBe(60_000);
    deleteTxn(db, c.id);
    expect(listSnapshots(db, k401)[0].valuationCents).toBe(100_000);
    expect(balanceOn('2026-01-31')).toBe(4_100_000);
  });

  it('several snapshots chain: each books only its own period', () => {
    snap('2026-01-31', 4_100_000); // +100,000
    contribute(20_000, '2026-02-15');
    snap('2026-02-28', 4_090_000); // ledger 4,120,000 → −30,000
    const [feb, jan] = listSnapshots(db, k401);
    expect([jan.valuationCents, feb.valuationCents]).toEqual([100_000, -30_000]);
    // Fixing January's value shifts February's valuation to keep Feb right.
    updateSnapshot(db, jan.id, { balanceCents: 4_110_000 });
    expect(listSnapshots(db, k401).map((s) => s.valuationCents)).toEqual([-40_000, 110_000]);
    expect(balanceOn('2026-02-28')).toBe(4_090_000);
    deleteSnapshot(db, jan.id);
    expect(listSnapshots(db, k401).map((s) => s.valuationCents)).toEqual([70_000]);
    expect(valuationTxns()).toHaveLength(1);
  });

  it('a snapshot equal to the ledger books nothing; the snapshot is end-of-day', () => {
    contribute(10_000, '2026-01-31');
    const s = snap('2026-01-31', 4_010_000); // includes same-day contribution
    expect(s.valuationCents).toBe(0);
    expect(valuationTxns()).toHaveLength(0);
  });

  it('changing the opening balance recomputes valuations', () => {
    snap('2026-01-31', 4_100_000);
    updateAccount(db, k401, { openingBalanceCents: 4_050_000, createdByPersonId: me });
    expect(listSnapshots(db, k401)[0].valuationCents).toBe(50_000);
    expect(balanceOn('2026-01-31')).toBe(4_100_000);
  });

  it('valuation is not income: no income/expense category moves', () => {
    snap('2026-01-31', 4_200_000);
    expect(categoryTotal(db, 'Salary')).toBe(0);
    const v = valuationTxns()[0];
    const kinds = v.postings
      .filter((p) => p.categoryId !== null)
      .map((p) => (db.prepare('SELECT kind FROM category WHERE id = ?').get(p.categoryId) as { kind: string }).kind);
    expect(kinds).toEqual(['valuation']);
  });
});

describe('snapshot validation', () => {
  it('rejects non-investment accounts, bad dates, duplicates, negatives and archived accounts', () => {
    expect(() => createSnapshot(db, checking, { date: '2026-01-31', balanceCents: 1, createdByPersonId: me })).toThrow(
      /brokerage and retirement/,
    );
    expect(() => snap('2025-12-31', 1)).toThrow(/opened on/);
    expect(() => snap('2999-01-01', 1)).toThrow(/future/);
    expect(() => snap('2026-01-31', -1)).toThrow(/zero or more/);
    snap('2026-01-31', 1);
    expect(() => snap('2026-01-31', 2)).toThrow(/already a snapshot/);
    expect(getAccount(db, k401).lastSnapshotDate).toBe('2026-01-31');
    expect(() => updateAccount(db, k401, { openingDate: '2026-02-01' })).toThrow();
  });

  it('valuation txns are read-only through the ledger', () => {
    snap('2026-01-31', 4_100_000);
    const v = valuationTxns()[0];
    expect(() => deleteTxn(db, v.id)).toThrow(/snapshots/);
    expect(() =>
      createTxn(db, {
        date: '2026-02-01',
        postings: [acct(k401, 5), cat(categoryId(db, 'Valuation Change'), -5)],
        createdByPersonId: me,
      }),
    ).toThrow(/managed by the app/);
  });

  it('API: create, list, edit, delete', async () => {
    const app = buildApp(db);
    let res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${k401}/snapshots`,
      payload: { date: '2026-01-31', balanceCents: 4_012_345, note: 'Jan statement', createdByPersonId: me },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect(res.json()).toMatchObject({ valuationCents: 12_345, note: 'Jan statement' });
    res = await app.inject({ method: 'PATCH', url: `/api/snapshots/${id}`, payload: { balanceCents: 4_000_000 } });
    expect(res.json().valuationCents).toBe(0);
    res = await app.inject({ url: `/api/accounts/${k401}/snapshots` });
    expect(res.json()).toHaveLength(1);
    res = await app.inject({ method: 'DELETE', url: `/api/snapshots/${id}` });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ url: `/api/accounts/${checking}/snapshots` });
    expect(res.statusCode).toBe(400);
  });
});

describe('seed data', () => {
  it('AT-12 + D5 invariant: every txn balances and every snapshot equals the ledger at its date', async () => {
    const { seedDemoData } = await import('../src/db/seed');
    const fresh = testDb().db;
    seedDemoData(fresh);
    expect(unbalancedTxnIds(fresh)).toEqual([]);
    const rows = fresh.prepare('SELECT account_id, date, balance_cents FROM balance_snapshot').all() as {
      account_id: number;
      date: string;
      balance_cents: number;
    }[];
    expect(rows.length).toBe(12);
    for (const r of rows) expect(getAccount(fresh, r.account_id, r.date).balanceCents).toBe(r.balance_cents);
  });
});
