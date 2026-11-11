import { describe, expect, it } from 'vitest';
import { compareStatement, interestPostings } from './balanceUpdate';

describe('compareStatement (AT-21 helper)', () => {
  it('proposes only the difference as interest', () => {
    expect(compareStatement(1_203_812, 1_204_950)).toEqual({ kind: 'interest', cents: 1_138 });
  });
  it('reports a match', () => {
    expect(compareStatement(500, 500)).toEqual({ kind: 'match' });
  });
  it('reports a shortfall instead of proposing anything', () => {
    expect(compareStatement(10_000, 9_250)).toEqual({ kind: 'shortfall', cents: 750 });
  });
  it('interest postings balance and credit the income category', () => {
    const p = interestPostings(3, 9, 1_138);
    expect(p.reduce((s, x) => s + x.amountCents, 0)).toBe(0);
    expect(p[1]).toEqual({ accountId: null, categoryId: 9, amountCents: -1_138 });
  });
});
