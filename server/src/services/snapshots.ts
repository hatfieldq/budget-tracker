// Investment balance snapshots (D5). A snapshot says "this account was worth X
// at the end of this date". The app books the part the ledger can't explain
// (market growth/loss) as a system txn kind='valuation' against the Valuation
// Change category, so contributions and growth stay separate.
//
// Valuation txns are derived, never edited: recomputeValuations() throws them
// all away and rebuilds them, oldest snapshot first. It runs inside the same DB
// transaction as anything that changes an investment account's postings or
// snapshots (snapshot writes here; txn writes in ledger.ts; opening balance in
// accounts.ts). Invariant: ledger balance at end of each snapshot date = snapshot.
import { isInvestment, type AccountType, type Snapshot, type SnapshotInput } from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId, systemCategoryId } from '../db/bootstrap';
import { isValidDate, localToday } from '../dates';
import { NotFoundError, ValidationError } from '../errors';
import { assertActivePeople } from './people';

interface SnapshotRow {
  id: number;
  account_id: number;
  date: string;
  balance_cents: number;
  note: string | null;
  created_by_person_id: number;
  valuation_cents: number;
}

const SELECT_SNAPSHOTS = `
  SELECT s.id, s.account_id, s.date, s.balance_cents, s.note, s.created_by_person_id,
    COALESCE((SELECT SUM(p.amount_cents) FROM posting p
              WHERE p.txn_id = s.valuation_txn_id AND p.account_id = s.account_id), 0) AS valuation_cents
  FROM balance_snapshot s`;

const toSnapshot = (r: SnapshotRow): Snapshot => ({
  id: r.id,
  accountId: r.account_id,
  date: r.date,
  balanceCents: r.balance_cents,
  note: r.note,
  valuationCents: r.valuation_cents,
  createdByPersonId: r.created_by_person_id,
});

interface AccountInfo {
  id: number;
  name: string;
  type: AccountType;
  opening_date: string;
  archived_at: string | null;
}

function investmentAccount(db: DB, accountId: number): AccountInfo {
  const a = db
    .prepare('SELECT id, name, type, opening_date, archived_at FROM account WHERE id = ? AND household_id = ?')
    .get(accountId, householdId(db)) as AccountInfo | undefined;
  if (!a) throw new NotFoundError('Account');
  if (!isInvestment(a.type)) {
    throw new ValidationError('Balance snapshots are for brokerage and retirement accounts');
  }
  return a;
}

/** Newest first, each with the valuation change it booked. */
export function listSnapshots(db: DB, accountId: number): Snapshot[] {
  investmentAccount(db, accountId);
  return (
    db.prepare(`${SELECT_SNAPSHOTS} WHERE s.account_id = ? ORDER BY s.date DESC`).all(accountId) as SnapshotRow[]
  ).map(toSnapshot);
}

export function getSnapshot(db: DB, id: number): Snapshot {
  const row = db.prepare(`${SELECT_SNAPSHOTS} WHERE s.id = ?`).get(id) as SnapshotRow | undefined;
  if (!row) throw new NotFoundError('Snapshot');
  investmentAccount(db, row.account_id); // household check
  return toSnapshot(row);
}

function checkFields(a: AccountInfo, date: unknown, cents: unknown, note: unknown) {
  if (!isValidDate(date)) throw new ValidationError('Date must be YYYY-MM-DD');
  if (date < a.opening_date) {
    throw new ValidationError(`${a.name} opened on ${a.opening_date}; a snapshot can't be earlier`);
  }
  if (date > localToday()) throw new ValidationError("A snapshot can't be dated in the future");
  if (!Number.isSafeInteger(cents) || (cents as number) < 0) {
    throw new ValidationError('Value must be zero or more, in whole cents');
  }
  if (note != null && typeof note !== 'string') throw new ValidationError('Note must be text');
  const n = typeof note === 'string' ? note.trim() : '';
  if (n.length > 200) throw new ValidationError('Note must be 200 characters or fewer');
  return { date, cents: cents as number, note: n || null };
}

function assertDateFree(db: DB, accountId: number, date: string, exceptId?: number) {
  const clash = db
    .prepare('SELECT id FROM balance_snapshot WHERE account_id = ? AND date = ? AND id IS NOT ?')
    .get(accountId, date, exceptId ?? null);
  if (clash) throw new ValidationError(`There's already a snapshot on ${date}; edit that one instead`);
}

export function createSnapshot(db: DB, accountId: number, input: SnapshotInput): Snapshot {
  const a = investmentAccount(db, accountId);
  if (a.archived_at) throw new ValidationError(`${a.name} is archived`);
  const v = checkFields(a, input?.date, input?.balanceCents, input?.note);
  assertActivePeople(db, [input.createdByPersonId], 'Entered by');
  assertDateFree(db, accountId, v.date);

  const id = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO balance_snapshot (account_id, date, balance_cents, note, created_by_person_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(accountId, v.date, v.cents, v.note, input.createdByPersonId, new Date().toISOString());
    recomputeValuations(db, [accountId]);
    return Number(lastInsertRowid);
  })();
  return getSnapshot(db, id);
}

export function updateSnapshot(db: DB, id: number, patch: Partial<SnapshotInput>): Snapshot {
  const current = getSnapshot(db, id);
  const a = investmentAccount(db, current.accountId);
  const v = checkFields(
    a,
    patch.date ?? current.date,
    patch.balanceCents ?? current.balanceCents,
    patch.note !== undefined ? patch.note : current.note,
  );
  assertDateFree(db, a.id, v.date, id);
  db.transaction(() => {
    db.prepare('UPDATE balance_snapshot SET date = ?, balance_cents = ?, note = ? WHERE id = ?').run(
      v.date,
      v.cents,
      v.note,
      id,
    );
    recomputeValuations(db, [a.id]);
  })();
  return getSnapshot(db, id);
}

export function deleteSnapshot(db: DB, id: number): void {
  const current = getSnapshot(db, id);
  db.transaction(() => {
    db.prepare('DELETE FROM balance_snapshot WHERE id = ?').run(id);
    recomputeValuations(db, [current.accountId]);
  })();
}

/**
 * Rebuild the valuation txns of the given accounts (non-investment ids are
 * ignored). Must be called inside a DB transaction.
 */
export function recomputeValuations(db: DB, accountIds: Iterable<number | null>): void {
  const ids = [...new Set([...accountIds].filter((id): id is number => id != null))];
  if (ids.length === 0) return;
  const typeOf = db.prepare('SELECT type FROM account WHERE id = ?');
  const snapshots = db.prepare(
    'SELECT id, date, balance_cents, created_by_person_id FROM balance_snapshot WHERE account_id = ? ORDER BY date',
  );
  const balanceAt = db.prepare(
    `SELECT COALESCE(SUM(p.amount_cents), 0) AS b FROM posting p JOIN txn t ON t.id = p.txn_id
     WHERE p.account_id = ? AND t.date <= ?`,
  );
  const insertTxn = db.prepare(
    `INSERT INTO txn (household_id, date, payee, kind, created_by_person_id, created_at, updated_at)
     VALUES (?, ?, 'Valuation change', 'valuation', ?, ?, ?)`,
  );
  const insertPosting = db.prepare(
    'INSERT INTO posting (txn_id, account_id, category_id, amount_cents, status) VALUES (?, ?, ?, ?, ?)',
  );
  const link = db.prepare('UPDATE balance_snapshot SET valuation_txn_id = ? WHERE id = ?');
  const valuationCategory = systemCategoryId(db, 'valuation');
  const household = householdId(db);
  const now = new Date().toISOString();

  for (const accountId of ids) {
    const row = typeOf.get(accountId) as { type: AccountType } | undefined;
    if (!row || !isInvestment(row.type)) continue;

    // Snapshot links are cleared by ON DELETE SET NULL; postings by CASCADE.
    db.prepare(
      `DELETE FROM txn WHERE kind = 'valuation' AND id IN (SELECT txn_id FROM posting WHERE account_id = ?)`,
    ).run(accountId);

    const snaps = snapshots.all(accountId) as {
      id: number;
      date: string;
      balance_cents: number;
      created_by_person_id: number;
    }[];
    for (const s of snaps) {
      // Includes earlier snapshots' valuations, which were just rebuilt.
      const { b } = balanceAt.get(accountId, s.date) as { b: number };
      const diff = s.balance_cents - b;
      if (diff === 0) continue;
      const txnId = insertTxn.run(household, s.date, s.created_by_person_id, now, now).lastInsertRowid;
      insertPosting.run(txnId, accountId, null, diff, 'reconciled');
      insertPosting.run(txnId, null, valuationCategory, -diff, null);
      link.run(txnId, s.id);
    }
  }
}
