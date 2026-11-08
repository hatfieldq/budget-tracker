import { describe, expect, it } from 'vitest';
import { carryStatuses, entryToPostings, lineCents, splitImbalance, txnToEntry, type SplitLine } from './entry';
import type { Posting } from './types';

const UNCAT = 99;
const sum = (ps: { amountCents: number }[]) => ps.reduce((s, p) => s + p.amountCents, 0);
const asPostings = (ps: ReturnType<typeof entryToPostings>): Posting[] =>
  ps.map((p, i) => ({ id: i, reconciliationId: null, status: null, memo: p.memo ?? null, ...p }));

describe('entryToPostings', () => {
  it('money out on a card = card credit, category debit (an expense)', () => {
    const ps = entryToPostings(
      { mode: 'simple', direction: 'out', accountId: 1, categoryId: 5, amountCents: 5000 },
      UNCAT,
    );
    expect(ps).toEqual([
      { accountId: 1, categoryId: null, amountCents: -5000 },
      { accountId: null, categoryId: 5, amountCents: 5000 },
    ]);
  });

  it('money in with no category goes to Uncategorized', () => {
    const ps = entryToPostings(
      { mode: 'simple', direction: 'in', accountId: 1, categoryId: null, amountCents: 700 },
      UNCAT,
    );
    expect(ps[1]).toEqual({ accountId: null, categoryId: UNCAT, amountCents: -700 });
  });

  it('transfer: from is credited, to is debited', () => {
    const ps = entryToPostings({ mode: 'transfer', fromAccountId: 1, toAccountId: 2, amountCents: 50000 }, UNCAT);
    expect(ps.map((p) => [p.accountId, p.amountCents])).toEqual([[1, -50000], [2, 50000]]);
  });

  it('paycheck split balances with Received / Spent / Into labels', () => {
    const lines: SplitLine[] = [
      { target: { kind: 'category', id: 10 }, direction: 'in', amountCents: 500000 }, // Salary received
      { target: { kind: 'category', id: 11 }, direction: 'out', amountCents: 80000 }, // Fed tax
      { target: { kind: 'account', id: 3 }, direction: 'in', amountCents: 50000 }, // into Roth 401k
      { target: { kind: 'account', id: 1 }, direction: 'in', amountCents: 370000 }, // into checking
    ];
    expect(splitImbalance(lines)).toBe(0);
    const ps = entryToPostings({ mode: 'split', lines }, UNCAT);
    expect(ps.map((p) => p.amountCents)).toEqual([-500000, 80000, 50000, 370000]);
    expect(sum(ps)).toBe(0);
  });

  it('loan payment split: out of checking, into loan, interest spent', () => {
    const lines: SplitLine[] = [
      { target: { kind: 'account', id: 1 }, direction: 'out', amountCents: 30000 },
      { target: { kind: 'account', id: 7 }, direction: 'in', amountCents: 25000 },
      { target: { kind: 'category', id: 12 }, direction: 'out', amountCents: 5000 },
    ];
    expect(lines.map(lineCents)).toEqual([-30000, 25000, 5000]);
  });

  it('drops zero lines', () => {
    const ps = entryToPostings(
      {
        mode: 'split',
        lines: [
          { target: { kind: 'account', id: 1 }, direction: 'out', amountCents: 100 },
          { target: { kind: 'category', id: 5 }, direction: 'out', amountCents: 100 },
          { target: { kind: 'category', id: 6 }, direction: 'out', amountCents: 0 },
        ],
      },
      UNCAT,
    );
    expect(ps).toHaveLength(2);
  });
});

describe('txnToEntry round-trips', () => {
  const cases = [
    { mode: 'simple', direction: 'out', accountId: 1, categoryId: 5, amountCents: 5000 },
    { mode: 'simple', direction: 'in', accountId: 1, categoryId: 5, amountCents: 2000 },
    { mode: 'transfer', fromAccountId: 1, toAccountId: 2, amountCents: 9000 },
    {
      mode: 'split',
      lines: [
        { target: { kind: 'account', id: 1 }, direction: 'out', amountCents: 30000, memo: undefined },
        { target: { kind: 'account', id: 7 }, direction: 'in', amountCents: 25000, memo: undefined },
        { target: { kind: 'category', id: 12 }, direction: 'out', amountCents: 5000, memo: undefined },
      ],
    },
  ] as const;
  for (const entry of cases) {
    it(entry.mode, () => {
      const postings = asPostings(entryToPostings(entry as any, UNCAT));
      expect(txnToEntry({ postings })).toEqual(entry);
    });
  }
});

describe('carryStatuses', () => {
  it('keeps cleared on the same account, once per old line', () => {
    const next = [
      { accountId: 1, categoryId: null, amountCents: -900 },
      { accountId: null, categoryId: 5, amountCents: 900 },
    ];
    const out = carryStatuses(next, [
      { accountId: 1, status: 'cleared' },
      { accountId: null, status: null },
    ]);
    expect(out[0].status).toBe('cleared');
    expect(out[1].status).toBeUndefined();
    expect(carryStatuses(next, [{ accountId: 2, status: 'cleared' }])[0].status).toBeUndefined();
  });
});
