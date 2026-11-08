// Pure conversions between what the entry form shows and ledger postings.
// The form always works in positive amounts plus a direction; these functions
// apply the debit/credit signs. Kept here (not in the web app) so they're unit
// tested next to the money helpers.
import type { Posting, PostingInput, Txn } from './types';

/** Simple mode: one account, one category (null = Uncategorized). */
export interface SimpleEntry {
  mode: 'simple';
  direction: 'out' | 'in';
  accountId: number;
  categoryId: number | null;
  amountCents: number; // positive
}

/** Transfer mode: money leaves `fromAccountId` and arrives in `toAccountId`. */
export interface TransferEntry {
  mode: 'transfer';
  fromAccountId: number;
  toAccountId: number;
  amountCents: number; // positive
}

/**
 * One split line. For accounts: 'in' = Into the account, 'out' = Out of it.
 * For categories: 'out' = Spent (expense/tax), 'in' = Received (income/refund).
 */
export interface SplitLine {
  target: { kind: 'account'; id: number } | { kind: 'category'; id: number | null };
  direction: 'in' | 'out';
  amountCents: number; // positive
  memo?: string;
}

export interface SplitEntry {
  mode: 'split';
  lines: SplitLine[];
}

export type Entry = SimpleEntry | TransferEntry | SplitEntry;

/** Ledger sign of one split line. Accounts: Into = debit. Categories: Spent = debit. */
export function lineCents(line: SplitLine): number {
  const debit = line.target.kind === 'account' ? line.direction === 'in' : line.direction === 'out';
  return debit ? line.amountCents : -line.amountCents;
}

/**
 * Remaining amount to make a split balance, as a line-independent number:
 * 0 = balanced. Positive = more debits than credits so far.
 */
export function splitImbalance(lines: SplitLine[]): number {
  return lines.reduce((sum, l) => sum + lineCents(l), 0);
}

/**
 * Build postings. `uncategorizedId` is used when a category is left empty.
 * Doesn't validate balance; the server does that (and splitImbalance shows it in the form).
 */
export function entryToPostings(entry: Entry, uncategorizedId: number): PostingInput[] {
  if (entry.mode === 'simple') {
    const a = entry.direction === 'in' ? entry.amountCents : -entry.amountCents;
    return [
      { accountId: entry.accountId, categoryId: null, amountCents: a },
      { accountId: null, categoryId: entry.categoryId ?? uncategorizedId, amountCents: -a },
    ];
  }
  if (entry.mode === 'transfer') {
    return [
      { accountId: entry.fromAccountId, categoryId: null, amountCents: -entry.amountCents },
      { accountId: entry.toAccountId, categoryId: null, amountCents: entry.amountCents },
    ];
  }
  return entry.lines
    .filter((l) => l.amountCents !== 0)
    .map((l) => ({
      accountId: l.target.kind === 'account' ? l.target.id : null,
      categoryId: l.target.kind === 'category' ? (l.target.id ?? uncategorizedId) : null,
      amountCents: lineCents(l),
      memo: l.memo || null,
    }));
}

/** Inverse: pick the simplest form mode that can show an existing txn. */
export function txnToEntry(txn: Pick<Txn, 'postings'>): Entry {
  const ps = txn.postings;
  const accounts = ps.filter((p) => p.accountId !== null);
  const categories = ps.filter((p) => p.categoryId !== null);
  const noMemos = ps.every((p) => !p.memo);

  if (ps.length === 2 && accounts.length === 1 && categories.length === 1 && noMemos) {
    const a = accounts[0];
    return {
      mode: 'simple',
      direction: a.amountCents > 0 ? 'in' : 'out',
      accountId: a.accountId!,
      categoryId: categories[0].categoryId,
      amountCents: Math.abs(a.amountCents),
    };
  }
  if (ps.length === 2 && accounts.length === 2 && noMemos) {
    const from = accounts.find((p) => p.amountCents < 0)!;
    const to = accounts.find((p) => p.amountCents > 0)!;
    return {
      mode: 'transfer',
      fromAccountId: from.accountId!,
      toAccountId: to.accountId!,
      amountCents: to.amountCents,
    };
  }
  return {
    mode: 'split',
    lines: ps.map((p) => {
      const isAccount = p.accountId !== null;
      const debit = p.amountCents > 0;
      return {
        target: isAccount
          ? { kind: 'account', id: p.accountId! }
          : { kind: 'category', id: p.categoryId },
        // invert lineCents: accounts debit = in; categories debit = out
        direction: isAccount === debit ? 'in' : 'out',
        amountCents: Math.abs(p.amountCents),
        memo: p.memo ?? undefined,
      };
    }),
  };
}

/**
 * When editing, the form rebuilds postings from scratch. Copy each old account
 * line's 'cleared' status onto a new line for the same account so an edit
 * doesn't silently un-clear it. ('reconciled' lines are matched by the server.)
 */
export function carryStatuses(
  next: PostingInput[],
  old: Pick<Posting, 'accountId' | 'status'>[],
): PostingInput[] {
  const pool = old.filter((p) => p.accountId !== null && p.status === 'cleared');
  return next.map((p) => {
    if (p.accountId === null) return p;
    const i = pool.findIndex((o) => o.accountId === p.accountId);
    if (i === -1) return p;
    pool.splice(i, 1);
    return { ...p, status: 'cleared' as const };
  });
}
