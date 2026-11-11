import { beforeEach, describe, expect, it } from 'vitest';
import { compareStatement, interestPostings, type TxnInput } from '@ledger/shared';
import { buildApp } from '../src/app';
import type { DB } from '../src/db/connection';
import { createAccount, getAccount } from '../src/services/accounts';
import { createTxn, deleteTxn, getTxn, listTxns, updateTxn } from '../src/services/ledger';
import {
  completeReconciliation,
  reconcileSummary,
  setTxnStatus,
  undoLastReconciliation,
} from '../src/services/reconcile';
import { acct, accountInput, balance, cat, categoryId, testDb, unbalancedTxnIds } from './helpers';

let db: DB;
let me: number;
let checking: number, card: number, brokerage: number;

beforeEach(() => {
  ({ db, me } = testDb());
  const mk = (o: Parameters<typeof accountInput>[1]) => createAccount(db, accountInput(me, o)).id;
  checking = mk({ name: 'Checking', openingBalanceCents: 100_000 });
  card = mk({ name: 'Card', type: 'credit_card' });
  brokerage = mk({ name: 'Brokerage', type: 'brokerage' });
});

const spend = (accountId: number, cents: number, date: string) =>
  createTxn(db, {
    date,
    payee: 'Shop',
    postings: [acct(accountId, -cents), cat(categoryId(db, 'Groceries'), cents)],
    createdByPersonId: me,
  } satisfies TxnInput);

const status = (txnId: number, accountId: number) =>
  getTxn(db, txnId).postings.find((p) => p.accountId === accountId)!.status;

describe('cleared toggle', () => {
  it('clears and un-clears one account line of a transfer', () => {
    const t = createTxn(db, {
      date: '2026-02-01',
      postings: [acct(checking, -5_000), acct(card, 5_000)],
      createdByPersonId: me,
    });
    setTxnStatus(db, t.id, { status: 'cleared', accountId: card });
    expect(status(t.id, card)).toBe('cleared');
    expect(status(t.id, checking)).toBe('uncleared');
    setTxnStatus(db, t.id, { status: 'cleared' }); // no accountId: every line
    expect(status(t.id, checking)).toBe('cleared');
    setTxnStatus(db, t.id, { status: 'uncleared', accountId: card });
    expect(status(t.id, card)).toBe('uncleared');
  });

  it('refuses system entries and unknown statuses', () => {
    const opening = listTxns(db, { accountId: checking }).txns[0];
    expect(() => setTxnStatus(db, opening.id, { status: 'cleared' })).toThrow(/System/);
    const t = spend(checking, 100, '2026-02-01');
    expect(() => setTxnStatus(db, t.id, { status: 'reconciled' as never })).toThrow(/status/);
    expect(() => setTxnStatus(db, t.id, { status: 'cleared', accountId: card })).toThrow(/not part/);
  });
});

describe('AT-14: reconciliation completion rules', () => {
  // Card statement 2026-02-28: two purchases, 45.00 owed (ledger −4500).
  let a: number, b: number, later: number, uncleared: number;
  beforeEach(() => {
    a = spend(card, 2_000, '2026-02-03').id;
    b = spend(card, 2_500, '2026-02-20').id;
    uncleared = spend(card, 999, '2026-02-25').id; // not on the statement yet
    later = spend(card, 700, '2026-03-02').id; // after the statement date
    for (const id of [a, b, later]) setTxnStatus(db, id, { status: 'cleared' });
  });

  it('summary counts reconciled + cleared through the statement date only', () => {
    const s = reconcileSummary(db, card, '2026-02-28');
    expect(s).toMatchObject({ reconciledCents: 0, clearedCents: -4_500, clearedCount: 2, clearedAfterCount: 1, last: null });
  });

  it('refuses to finish unless the difference is exactly zero; nothing changes', () => {
    expect(() =>
      completeReconciliation(db, card, { statementDate: '2026-02-28', statementBalanceCents: -4_501, personId: me }),
    ).toThrow(/off by 0\.01/);
    expect(status(a, card)).toBe('cleared');
    expect(db.prepare('SELECT COUNT(*) AS n FROM reconciliation').get()).toEqual({ n: 0 });
  });

  it('finishing reconciles only cleared lines through the statement date', () => {
    const r = completeReconciliation(db, card, { statementDate: '2026-02-28', statementBalanceCents: -4_500, personId: me });
    expect(r).toMatchObject({ statementDate: '2026-02-28', postingCount: 2, completedByPersonId: me });
    expect([status(a, card), status(b, card)]).toEqual(['reconciled', 'reconciled']);
    expect(status(later, card)).toBe('cleared');
    expect(status(uncleared, card)).toBe('uncleared');
    expect(getAccount(db, card).lastReconciledDate).toBe('2026-02-28');
    // The next statement starts from the reconciled balance.
    expect(reconcileSummary(db, card, '2026-03-31')).toMatchObject({ reconciledCents: -4_500, clearedCents: -700 });
  });

  it('includes the opening balance, and rejects bad statement dates', () => {
    expect(reconcileSummary(db, checking, '2026-01-31').reconciledCents).toBe(100_000);
    const at = (statementDate: string) => () =>
      completeReconciliation(db, checking, { statementDate, statementBalanceCents: 100_000, personId: me });
    expect(at('2025-12-31')).toThrow(/opened on/);
    expect(at('2999-01-01')).toThrow(/future/);
    at('2026-01-31')(); // an empty statement that matches is fine
    expect(at('2026-01-15')).toThrow(/Already reconciled through 2026-01-31/);
  });

  it('investment accounts are not reconciled', () => {
    expect(() => reconcileSummary(db, brokerage, '2026-02-28')).toThrow(/snapshots/);
  });

  it('AT-13: reconciled lines are locked until the reconciliation is undone', () => {
    completeReconciliation(db, card, { statementDate: '2026-02-28', statementBalanceCents: -4_500, personId: me });
    const t = getTxn(db, a);
    const input: TxnInput = {
      date: t.date,
      payee: 'Changed payee',
      postings: t.postings.map((p) => ({ accountId: p.accountId, categoryId: p.categoryId, amountCents: p.amountCents })),
      createdByPersonId: me,
    };
    // Payee/category can change; amount, date and deletion can't.
    expect(updateTxn(db, a, input).payee).toBe('Changed payee');
    expect(status(a, card)).toBe('reconciled');
    expect(() => updateTxn(db, a, { ...input, date: '2026-02-04' })).toThrow(/date is locked/);
    expect(() =>
      updateTxn(db, a, { ...input, postings: [acct(card, -2_001), cat(categoryId(db, 'Groceries'), 2_001)] }),
    ).toThrow(/locked/);
    expect(() => deleteTxn(db, a)).toThrow(/reconciled/);
    expect(() => setTxnStatus(db, a, { status: 'uncleared' })).toThrow(/locked/);

    undoLastReconciliation(db, card);
    expect(status(a, card)).toBe('cleared');
    expect(getAccount(db, card).lastReconciledDate).toBeNull();
    deleteTxn(db, a);
    expect(unbalancedTxnIds(db)).toEqual([]);
  });

  it('only the latest reconciliation is undone', () => {
    completeReconciliation(db, card, { statementDate: '2026-02-28', statementBalanceCents: -4_500, personId: me });
    completeReconciliation(db, card, { statementDate: '2026-03-31', statementBalanceCents: -5_200, personId: me });
    undoLastReconciliation(db, card);
    expect(status(later, card)).toBe('cleared');
    expect(status(a, card)).toBe('reconciled');
    expect(getAccount(db, card).lastReconciledDate).toBe('2026-02-28');
  });
});

describe('AT-21 (ledger part): cash balance update books only the difference as interest', () => {
  it('statement balance above the ledger becomes an Interest Income txn; balances then match', () => {
    const savings = createAccount(db, accountInput(me, { name: 'Savings', type: 'savings', openingBalanceCents: 1_200_000 })).id;
    spend(savings, 10_000, '2026-03-10');
    const ledger = getAccount(db, savings, '2026-03-31').balanceCents; // 1,190,000
    const check = compareStatement(ledger, 1_193_812);
    expect(check).toEqual({ kind: 'interest', cents: 3_812 });
    if (check.kind !== 'interest') return;
    const interest = categoryId(db, 'Interest Income');
    createTxn(db, {
      date: '2026-03-31',
      payee: 'Interest',
      postings: interestPostings(savings, interest, check.cents),
      createdByPersonId: me,
    });
    expect(getAccount(db, savings, '2026-03-31').balanceCents).toBe(1_193_812);
    expect(balance(db, savings)).toBe(1_193_812);
    expect(compareStatement(getAccount(db, savings, '2026-03-31').balanceCents, 1_193_812)).toEqual({ kind: 'match' });
    // It's ordinary income (standard txn), not a system valuation.
    const t = listTxns(db, { accountId: savings, q: 'Interest' }).txns[0];
    expect(t.kind).toBe('standard');
    expect(t.postings.find((p) => p.categoryId === interest)!.amountCents).toBe(-3_812);
  });
});

describe('API', () => {
  it('status toggle, summary, finish, undo, and the unreconciled filter', async () => {
    const app = buildApp(db);
    const t = spend(card, 1_234, '2026-02-03');
    let res = await app.inject({ method: 'POST', url: `/api/txns/${t.id}/status`, payload: { status: 'cleared', accountId: card } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ url: `/api/accounts/${card}/reconcile?statementDate=2026-02-28` });
    expect(res.json()).toMatchObject({ clearedCents: -1_234, clearedCount: 1 });
    res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${card}/reconciliations`,
      payload: { statementDate: '2026-02-28', statementBalanceCents: -1_000, personId: me },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/off by 2\.34/);
    res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${card}/reconciliations`,
      payload: { statementDate: '2026-02-28', statementBalanceCents: -1_234, personId: me },
    });
    expect(res.statusCode).toBe(201);
    res = await app.inject({ url: `/api/txns?accountId=${card}&unreconciled=1` });
    expect(res.json().total).toBe(0);
    res = await app.inject({ method: 'DELETE', url: `/api/accounts/${card}/reconciliations/latest` });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ url: `/api/txns?accountId=${card}&unreconciled=1` });
    expect(res.json().total).toBe(1);
    res = await app.inject({ url: `/api/accounts/${checking}?asOf=2025-12-31` });
    expect(res.json().balanceCents).toBe(0);
    res = await app.inject({ url: `/api/accounts/${checking}?asOf=bad` });
    expect(res.statusCode).toBe(400);
  });
});
