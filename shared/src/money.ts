import { isLiability, type AccountType } from './types';

/**
 * Parse user-typed money ("12.34", "$1,234.5", "-3") into integer cents.
 * Works on the string digits, never on floats, so there is no rounding drift.
 * Returns null for anything that is not a valid amount with at most 2 decimals.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, '');
  const match = /^(-)?(\d*)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const [, minus, whole, frac = ''] = match;
  if (whole === '' && frac === '') return null;
  const cents = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return minus && cents !== 0 ? -cents : cents;
}

/** Format integer cents as "$1,234.56" (or "-$1,234.56"). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars}.${rem}`;
}

/**
 * Ledger balance -> natural display amount.
 * Assets: unchanged (positive = money you have).
 * Liabilities (credit cards, loans): negated, so a positive number = amount owed.
 */
export function ledgerToNatural(type: AccountType, ledgerCents: number): number {
  return isLiability(type) ? -ledgerCents : ledgerCents;
}

/** Inverse of ledgerToNatural: what the user typed -> ledger sign for the API. */
export function naturalToLedger(type: AccountType, naturalCents: number): number {
  // Negating zero gives -0; normalise so 0 is always stored as 0.
  return isLiability(type) ? 0 - naturalCents || 0 : naturalCents;
}
