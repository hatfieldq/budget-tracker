// Statement-balance helper for checking/savings (D17): compare what the bank
// says with the app's balance on the same date. Only a surplus is proposed as
// interest; a shortfall is reported so the user finds the missing transaction
// instead of plugging it.
import type { PostingInput } from './types';

export type BalanceCheck =
  | { kind: 'match' }
  | { kind: 'interest'; cents: number }
  | { kind: 'shortfall'; cents: number };

/** Both amounts in ledger sign for an asset account (checking/savings). */
export function compareStatement(ledgerCents: number, statementCents: number): BalanceCheck {
  const diff = statementCents - ledgerCents;
  if (diff === 0) return { kind: 'match' };
  return diff > 0 ? { kind: 'interest', cents: diff } : { kind: 'shortfall', cents: -diff };
}

/** Postings for an interest txn: account +cents (cleared: it's on the statement), income −cents. */
export function interestPostings(accountId: number, categoryId: number, cents: number): PostingInput[] {
  return [
    { accountId, categoryId: null, amountCents: cents, status: 'cleared' },
    { accountId: null, categoryId, amountCents: -cents },
  ];
}
