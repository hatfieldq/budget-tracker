// Cleared status and statement reconciliation (D12, AT-14).
//
// Posting status: uncleared (entered) -> cleared (seen on the bank's site) ->
// reconciled (matched to a finished statement; locked). Work in progress is
// just the cleared flags, so a reconcile can be stopped and resumed.
//
// Finishing a statement requires:
//   Σ reconciled postings + Σ cleared postings dated ≤ statement date = statement balance
// exactly. Those cleared postings then become reconciled and point at the new
// reconciliation row. Only the latest reconciliation per account can be undone.
import {
  RECONCILABLE_TYPES,
  type AccountType,
  type ReconcileInput,
  type ReconcileSummary,
  type Reconciliation,
  type StatusInput,
  type Txn,
} from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId } from '../db/bootstrap';
import { isValidDate, localToday } from '../dates';
import { NotFoundError, ValidationError } from '../errors';
import { getTxn } from './ledger';
import { assertActivePeople } from './people';

// ---------- cleared toggle ----------

/**
 * Set uncleared/cleared on a txn's account lines (only `accountId`'s, if given).
 * Reconciled lines are never changed; if every matching line is reconciled the
 * request fails rather than silently doing nothing.
 */
export function setTxnStatus(db: DB, txnId: number, input: StatusInput): Txn {
  const txn = getTxn(db, txnId);
  if (input?.status !== 'uncleared' && input?.status !== 'cleared') {
    throw new ValidationError('status must be uncleared or cleared');
  }
  if (txn.kind !== 'standard') throw new ValidationError('System entries have no cleared status to change');
  const lines = txn.postings.filter(
    (p) => p.accountId !== null && (input.accountId === undefined || p.accountId === input.accountId),
  );
  if (lines.length === 0) throw new ValidationError('That account is not part of this transaction');
  const open = lines.filter((p) => p.status !== 'reconciled');
  if (open.length === 0) throw new ValidationError('Reconciled lines are locked; undo the reconciliation first');

  const update = db.prepare('UPDATE posting SET status = ? WHERE id = ?');
  db.transaction(() => {
    for (const p of open) update.run(input.status, p.id);
  })();
  return getTxn(db, txnId);
}

// ---------- reconciliation ----------

interface AccountInfo {
  id: number;
  name: string;
  type: AccountType;
  opening_date: string;
}

function reconcilableAccount(db: DB, accountId: number): AccountInfo {
  const a = db
    .prepare('SELECT id, name, type, opening_date FROM account WHERE id = ? AND household_id = ?')
    .get(accountId, householdId(db)) as AccountInfo | undefined;
  if (!a) throw new NotFoundError('Account');
  if (!RECONCILABLE_TYPES.includes(a.type)) {
    throw new ValidationError('Investment accounts are updated with balance snapshots, not reconciled');
  }
  return a;
}

interface ReconciliationRow {
  id: number;
  account_id: number;
  statement_date: string;
  statement_balance_cents: number;
  completed_by_person_id: number | null;
  completed_at: string;
  posting_count: number;
}

const SELECT_RECONCILIATIONS = `
  SELECT r.*, (SELECT COUNT(*) FROM posting p WHERE p.reconciliation_id = r.id) AS posting_count
  FROM reconciliation r`;

const toReconciliation = (r: ReconciliationRow): Reconciliation => ({
  id: r.id,
  accountId: r.account_id,
  statementDate: r.statement_date,
  statementBalanceCents: r.statement_balance_cents,
  completedByPersonId: r.completed_by_person_id,
  completedAt: r.completed_at,
  postingCount: r.posting_count,
});

export function lastReconciliation(db: DB, accountId: number): Reconciliation | null {
  const row = db
    .prepare(`${SELECT_RECONCILIATIONS} WHERE r.account_id = ? ORDER BY r.statement_date DESC, r.id DESC LIMIT 1`)
    .get(accountId) as ReconciliationRow | undefined;
  return row ? toReconciliation(row) : null;
}

export function reconcileSummary(db: DB, accountId: number, statementDate: string): ReconcileSummary {
  reconcilableAccount(db, accountId);
  if (!isValidDate(statementDate)) throw new ValidationError('Statement date must be YYYY-MM-DD');
  const sums = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN p.status = 'reconciled' THEN p.amount_cents END), 0) AS reconciled,
         COALESCE(SUM(CASE WHEN p.status = 'cleared' AND t.date <= :d THEN p.amount_cents END), 0) AS cleared,
         COUNT(CASE WHEN p.status = 'cleared' AND t.date <= :d THEN 1 END) AS cleared_n,
         COUNT(CASE WHEN p.status = 'cleared' AND t.date > :d THEN 1 END) AS after_n
       FROM posting p JOIN txn t ON t.id = p.txn_id
       WHERE p.account_id = :a`,
    )
    .get({ a: accountId, d: statementDate }) as {
    reconciled: number;
    cleared: number;
    cleared_n: number;
    after_n: number;
  };
  return {
    accountId,
    statementDate,
    reconciledCents: sums.reconciled,
    clearedCents: sums.cleared,
    clearedCount: sums.cleared_n,
    clearedAfterCount: sums.after_n,
    last: lastReconciliation(db, accountId),
  };
}

export function completeReconciliation(db: DB, accountId: number, input: ReconcileInput): Reconciliation {
  const a = reconcilableAccount(db, accountId);
  if (!input || typeof input !== 'object') throw new ValidationError('Missing statement details');
  const { statementDate, statementBalanceCents, personId } = input;
  if (!isValidDate(statementDate)) throw new ValidationError('Statement date must be YYYY-MM-DD');
  if (!Number.isSafeInteger(statementBalanceCents)) {
    throw new ValidationError('Statement balance must be a whole number of cents');
  }
  if (statementDate < a.opening_date) {
    throw new ValidationError(`${a.name} opened on ${a.opening_date}; the statement can't be earlier`);
  }
  if (statementDate > localToday()) throw new ValidationError("A statement can't be dated in the future");
  assertActivePeople(db, [personId], 'Reconciled by');
  const last = lastReconciliation(db, accountId);
  if (last && statementDate < last.statementDate) {
    throw new ValidationError(`Already reconciled through ${last.statementDate}; use a later statement date`);
  }

  const summary = reconcileSummary(db, accountId, statementDate);
  const diff = statementBalanceCents - (summary.reconciledCents + summary.clearedCents);
  if (diff !== 0) {
    throw new ValidationError(
      `Cleared items don't match the statement yet: off by ${(Math.abs(diff) / 100).toFixed(2)}`,
    );
  }

  const id = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO reconciliation (account_id, statement_date, statement_balance_cents, completed_by_person_id, completed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(accountId, statementDate, statementBalanceCents, personId, new Date().toISOString());
    const recId = Number(lastInsertRowid);
    db.prepare(
      `UPDATE posting SET status = 'reconciled', reconciliation_id = ?
       WHERE account_id = ? AND status = 'cleared'
         AND txn_id IN (SELECT id FROM txn WHERE date <= ?)`,
    ).run(recId, accountId, statementDate);
    return recId;
  })();
  return reconciliationById(db, id);
}

function reconciliationById(db: DB, id: number): Reconciliation {
  return toReconciliation(db.prepare(`${SELECT_RECONCILIATIONS} WHERE r.id = ?`).get(id) as ReconciliationRow);
}

/** Undo the account's most recent reconciliation: its postings go back to cleared. */
export function undoLastReconciliation(db: DB, accountId: number): void {
  reconcilableAccount(db, accountId);
  const last = lastReconciliation(db, accountId);
  if (!last) throw new ValidationError('This account has no reconciliations to undo');
  db.transaction(() => {
    db.prepare("UPDATE posting SET status = 'cleared', reconciliation_id = NULL WHERE reconciliation_id = ?").run(
      last.id,
    );
    db.prepare('DELETE FROM reconciliation WHERE id = ?').run(last.id);
  })();
}
