import { describe, expect, it } from 'vitest';
import { formatCents, ledgerToNatural, naturalToLedger, parseMoney } from './money';

// AT-15: display sign and integer-cent parsing.
describe('parseMoney', () => {
  it('parses dollars and cents without float drift', () => {
    expect(parseMoney('12.34')).toBe(1234);
    expect(parseMoney('0.1')).toBe(10);
    expect(parseMoney('0.29')).toBe(29); // 0.29 * 100 = 28.999... as a float
    expect(parseMoney('$1,234.5')).toBe(123450);
    expect(parseMoney('-3')).toBe(-300);
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('7.')).toBe(700);
  });

  it('rejects invalid input', () => {
    for (const bad of ['', 'abc', '1.234', '1.2.3', '-', '.', '--1', '1e5']) {
      expect(parseMoney(bad), bad).toBeNull();
    }
  });
});

describe('formatCents', () => {
  it('formats with separators and sign', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(-5)).toBe('-$0.05');
    expect(formatCents(0)).toBe('$0.00');
  });
});

describe('natural vs ledger sign', () => {
  it('shows liabilities as positive amounts owed', () => {
    expect(ledgerToNatural('credit_card', -90000)).toBe(90000);
    expect(ledgerToNatural('loan', -1500000)).toBe(1500000);
    expect(ledgerToNatural('checking', 50000)).toBe(50000);
    expect(ledgerToNatural('brokerage', 50000)).toBe(50000);
  });

  it('round-trips', () => {
    expect(naturalToLedger('credit_card', 90000)).toBe(-90000);
    expect(naturalToLedger('savings', 90000)).toBe(90000);
    expect(Object.is(naturalToLedger('loan', 0), 0)).toBe(true);
  });
});
