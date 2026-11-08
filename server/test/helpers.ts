import type { AccountInput } from '@ledger/shared';
import { openDb, type DB } from '../src/db/connection';
import { listPeople } from '../src/services/people';

/** Fresh in-memory DB with the household, Me + Partner and default categories. */
export function testDb(): { db: DB; me: number; partner: number } {
  const db = openDb(':memory:');
  const [me, partner] = listPeople(db);
  return { db, me: me.id, partner: partner.id };
}

/** Account input with sensible defaults; override only what the test cares about. */
export function accountInput(personId: number, overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    name: 'Test Checking',
    type: 'checking',
    subtype: null,
    ownerIds: [personId],
    openingDate: '2026-01-01',
    openingBalanceCents: 0,
    createdByPersonId: personId,
    ...overrides,
  };
}

/** Every txn's postings must sum to zero (AT-12). Returns the ids of any that don't. */
export function unbalancedTxnIds(db: DB): number[] {
  return (
    db
      .prepare('SELECT txn_id FROM posting GROUP BY txn_id HAVING SUM(amount_cents) <> 0')
      .all() as { txn_id: number }[]
  ).map((r) => r.txn_id);
}

/** Category id by name (seeded defaults or system categories). */
export function categoryId(db: DB, name: string): number {
  const row = db.prepare('SELECT id FROM category WHERE name = ?').get(name) as { id: number } | undefined;
  if (!row) throw new Error(`No category ${name}`);
  return row.id;
}

/** Balance of one account (ledger sign), all dates. */
export function balance(db: DB, accountId: number): number {
  return (
    db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS b FROM posting WHERE account_id = ?').get(accountId) as {
      b: number;
    }
  ).b;
}

/** Net postings to one category (ledger sign: expenses +, income −). */
export function categoryTotal(db: DB, name: string): number {
  return (
    db
      .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM posting WHERE category_id = ?')
      .get(categoryId(db, name)) as { t: number }
  ).t;
}

/** Shorthand posting builders for tests. */
export const acct = (accountId: number, amountCents: number) => ({ accountId, categoryId: null, amountCents });
export const cat = (categoryId: number, amountCents: number) => ({ accountId: null, categoryId, amountCents });
