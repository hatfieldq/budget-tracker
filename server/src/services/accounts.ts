import {
  ACCOUNT_TYPES,
  SUBTYPES_BY_TYPE,
  type Account,
  type AccountInput,
  type AccountType,
  type AccountUpdate,
  type Scope,
} from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId, systemCategoryId } from '../db/bootstrap';
import { isValidDate, localToday } from '../dates';
import { NotFoundError, ValidationError } from '../errors';
import { assertActivePeople } from './people';
import { scopeAccountFilter } from './scope';
import { recomputeValuations } from './snapshots';

interface AccountRow {
  id: number;
  name: string;
  type: AccountType;
  subtype: string | null;
  opening_date: string;
  archived_at: string | null;
  owner_ids: string; // comma-separated, from group_concat
  opening_cents: number;
  balance_cents: number;
  last_snapshot_date: string | null;
  last_reconciled_date: string | null;
}

// Balance = sum of every posting to the account dated on or before :asOf.
// Opening amount = the account's postings in its kind='opening' txn.
const SELECT_ACCOUNTS = `
  SELECT a.id, a.name, a.type, a.subtype, a.opening_date, a.archived_at,
    (SELECT group_concat(person_id) FROM
       (SELECT person_id FROM account_owner WHERE account_id = a.id ORDER BY person_id)
    ) AS owner_ids,
    COALESCE((SELECT SUM(p.amount_cents) FROM posting p JOIN txn t ON t.id = p.txn_id
              WHERE p.account_id = a.id AND t.kind = 'opening'), 0) AS opening_cents,
    COALESCE((SELECT SUM(p.amount_cents) FROM posting p JOIN txn t ON t.id = p.txn_id
              WHERE p.account_id = a.id AND t.date <= :asOf), 0) AS balance_cents,
    (SELECT MAX(date) FROM balance_snapshot WHERE account_id = a.id) AS last_snapshot_date,
    (SELECT MAX(statement_date) FROM reconciliation WHERE account_id = a.id) AS last_reconciled_date
  FROM account a`;

function toAccount(r: AccountRow): Account {
  const ownerIds = r.owner_ids ? r.owner_ids.split(',').map(Number) : [];
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    subtype: r.subtype as Account['subtype'],
    ownerIds,
    isJoint: ownerIds.length > 1,
    openingDate: r.opening_date,
    openingBalanceCents: r.opening_cents,
    balanceCents: r.balance_cents,
    archivedAt: r.archived_at,
    lastSnapshotDate: r.last_snapshot_date,
    lastReconciledDate: r.last_reconciled_date,
  };
}

export function listAccounts(
  db: DB,
  opts: { scope?: Scope; includeArchived?: boolean; asOf?: string } = {},
): Account[] {
  const scope = opts.scope ?? { type: 'household' };
  const filter = scopeAccountFilter(db, scope);
  const archived = opts.includeArchived ? '' : 'AND a.archived_at IS NULL';
  const rows = db
    .prepare(
      `${SELECT_ACCOUNTS}
       WHERE a.id IN (${filter.sql}) ${archived}
       ORDER BY a.archived_at IS NOT NULL, a.type, a.name COLLATE NOCASE`,
    )
    .all(...filter.params, { asOf: opts.asOf ?? localToday() }) as AccountRow[];
  return rows.map(toAccount);
}

export function getAccount(db: DB, id: number, asOf: string = localToday()): Account {
  const row = db
    .prepare(`${SELECT_ACCOUNTS} WHERE a.id = :id AND a.household_id = :household`)
    .get({ id, household: householdId(db), asOf }) as AccountRow | undefined;
  if (!row) throw new NotFoundError('Account');
  return toAccount(row);
}

// ---------- validation ----------

function cleanName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new ValidationError('Account name is required');
  if (n.length > 60) throw new ValidationError('Account name must be 60 characters or fewer');
  return n;
}

function checkSubtype(type: AccountType, subtype: unknown): string | null {
  const allowed = SUBTYPES_BY_TYPE[type];
  if (!allowed) {
    if (subtype != null) throw new ValidationError(`${type} accounts have no subtype`);
    return null;
  }
  if (typeof subtype !== 'string' || !allowed.includes(subtype)) {
    throw new ValidationError(`${type} accounts need a subtype: ${allowed.join(', ')}`);
  }
  return subtype;
}

function checkOwners(db: DB, ownerIds: unknown): number[] {
  if (!Array.isArray(ownerIds) || ownerIds.length === 0) {
    throw new ValidationError('An account needs at least one owner');
  }
  const unique = [...new Set(ownerIds as number[])];
  assertActivePeople(db, unique, 'Owner');
  return unique;
}

function checkCents(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError('Opening balance must be a whole number of cents');
  }
  return value as number;
}

function checkDate(value: unknown): string {
  if (!isValidDate(value)) throw new ValidationError('Opening date must be YYYY-MM-DD');
  return value;
}

// ---------- writes ----------

/** Create an account, its owners and (if nonzero) its opening-balance txn, atomically. */
export function createAccount(db: DB, input: AccountInput): Account {
  if (!ACCOUNT_TYPES.includes(input.type)) throw new ValidationError('Unknown account type');
  const name = cleanName(input.name);
  const subtype = checkSubtype(input.type, input.subtype);
  const ownerIds = checkOwners(db, input.ownerIds);
  const openingDate = checkDate(input.openingDate);
  const openingCents = checkCents(input.openingBalanceCents);
  assertActivePeople(db, [input.createdByPersonId], 'Created by');

  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO account (household_id, name, type, subtype, opening_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(householdId(db), name, input.type, subtype, openingDate, now, now);
    const accountId = Number(lastInsertRowid);
    setOwners(db, accountId, ownerIds);
    writeOpeningTxn(db, accountId, openingDate, openingCents, input.createdByPersonId);
    return accountId;
  })();
  return getAccount(db, id);
}

/** Update name, subtype, owners, opening date/balance. Type is fixed after creation. */
export function updateAccount(db: DB, id: number, patch: AccountUpdate): Account {
  const current = getAccount(db, id);
  const name = patch.name !== undefined ? cleanName(patch.name) : current.name;
  const subtype =
    patch.subtype !== undefined ? checkSubtype(current.type, patch.subtype) : current.subtype;
  const ownerIds = patch.ownerIds !== undefined ? checkOwners(db, patch.ownerIds) : null;
  const openingDate =
    patch.openingDate !== undefined ? checkDate(patch.openingDate) : current.openingDate;
  const openingCents =
    patch.openingBalanceCents !== undefined
      ? checkCents(patch.openingBalanceCents)
      : current.openingBalanceCents;
  const openingChanged =
    openingDate !== current.openingDate || openingCents !== current.openingBalanceCents;
  if (openingChanged) {
    if (patch.createdByPersonId === undefined) {
      throw new ValidationError('createdByPersonId is required when changing the opening balance');
    }
    assertActivePeople(db, [patch.createdByPersonId], 'Created by');
  }

  if (openingDate > current.openingDate) {
    const earlier = db
      .prepare(
        `SELECT COUNT(*) AS n FROM posting p JOIN txn t ON t.id = p.txn_id
         WHERE p.account_id = ? AND t.kind <> 'opening' AND t.date < ?`,
      )
      .get(id, openingDate) as { n: number };
    if (earlier.n > 0) {
      throw new ValidationError(
        `Opening date can't be after existing transactions (${earlier.n} dated before ${openingDate})`,
      );
    }
    const snaps = db
      .prepare('SELECT COUNT(*) AS n FROM balance_snapshot WHERE account_id = ? AND date < ?')
      .get(id, openingDate) as { n: number };
    if (snaps.n > 0) {
      throw new ValidationError(`Opening date can't be after existing balance snapshots`);
    }
  }

  db.transaction(() => {
    db.prepare(
      'UPDATE account SET name = ?, subtype = ?, opening_date = ?, updated_at = ? WHERE id = ?',
    ).run(name, subtype, openingDate, new Date().toISOString(), id);
    if (ownerIds) setOwners(db, id, ownerIds);
    if (openingChanged) {
      writeOpeningTxn(db, id, openingDate, openingCents, patch.createdByPersonId!);
      recomputeValuations(db, [id]);
    }
  })();
  return getAccount(db, id);
}

/**
 * Archived accounts are hidden from pickers and can't receive new postings
 * (enforced in the ledger service, Session 2), but stay in historical reports.
 */
export function setArchived(db: DB, id: number, archived: boolean): Account {
  getAccount(db, id); // 404 if missing
  db.prepare('UPDATE account SET archived_at = ?, updated_at = ? WHERE id = ?').run(
    archived ? new Date().toISOString() : null,
    new Date().toISOString(),
    id,
  );
  return getAccount(db, id);
}

function setOwners(db: DB, accountId: number, ownerIds: number[]): void {
  db.prepare('DELETE FROM account_owner WHERE account_id = ?').run(accountId);
  const insert = db.prepare('INSERT INTO account_owner (account_id, person_id) VALUES (?, ?)');
  for (const personId of ownerIds) insert.run(accountId, personId);
}

/**
 * Replace the account's opening txn: account posting +cents, Opening Balance
 * category -cents (they sum to zero). A zero opening balance has no txn,
 * because postings can't be zero. Must be called inside a DB transaction.
 */
function writeOpeningTxn(
  db: DB,
  accountId: number,
  date: string,
  cents: number,
  personId: number,
): void {
  db.prepare(
    `DELETE FROM txn WHERE kind = 'opening' AND id IN
       (SELECT txn_id FROM posting WHERE account_id = ?)`,
  ).run(accountId);
  if (cents === 0) return;

  const now = new Date().toISOString();
  const { lastInsertRowid: txnId } = db
    .prepare(
      `INSERT INTO txn (household_id, date, payee, kind, created_by_person_id, created_at, updated_at)
       VALUES (?, ?, 'Opening balance', 'opening', ?, ?, ?)`,
    )
    .run(householdId(db), date, personId, now, now);
  const post = db.prepare(
    `INSERT INTO posting (txn_id, account_id, category_id, amount_cents, status)
     VALUES (?, ?, ?, ?, ?)`,
  );
  post.run(txnId, accountId, null, cents, 'reconciled');
  post.run(txnId, null, systemCategoryId(db, 'opening_equity'), -cents, null);
}
