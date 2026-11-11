// The ledger write path: create / update / delete user transactions, plus the
// register query. Every rule that keeps the books consistent lives here:
//   - 2+ postings, each targeting an account XOR a category, nonzero integer cents
//   - postings sum to zero; at least one account posting
//   - no postings to archived accounts/categories, or before an account's opening date
//   - system txns (opening, valuation) and system categories are off-limits
//   - reconciled postings are locked (date, account, amount) and block deletion
// All writes run inside one DB transaction, so a txn changes completely or not at all.
// Writes touching an investment account also rebuild its valuation txns (D5).

import type {
  Posting,
  PostingStatus,
  Txn,
  TxnFilters,
  TxnInput,
  TxnKind,
} from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId, systemCategoryId } from '../db/bootstrap';
import { isValidDate } from '../dates';
import { NotFoundError, ValidationError } from '../errors';
import { assertActivePeople } from './people';
import { scopeAccountFilter } from './scope';
import { recomputeValuations } from './snapshots';

interface TxnRow {
  id: number;
  date: string;
  payee: string | null;
  memo: string | null;
  kind: TxnKind;
  created_by_person_id: number;
  created_at: string;
  updated_at: string;
}

interface PostingRow {
  id: number;
  txn_id: number;
  account_id: number | null;
  category_id: number | null;
  amount_cents: number;
  memo: string | null;
  status: PostingStatus | null;
  reconciliation_id: number | null;
}

const toPosting = (r: PostingRow): Posting => ({
  id: r.id,
  accountId: r.account_id,
  categoryId: r.category_id,
  amountCents: r.amount_cents,
  memo: r.memo,
  status: r.status,
  reconciliationId: r.reconciliation_id,
});

/** Load postings for many txns in one query and assemble Txn objects. */
function hydrate(db: DB, rows: TxnRow[]): Txn[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const postingRows = db
    .prepare(
      `SELECT * FROM posting WHERE txn_id IN (${ids.map(() => '?').join(',')})
       ORDER BY txn_id, id`,
    )
    .all(...ids) as PostingRow[];
  const byTxn = new Map<number, Posting[]>();
  for (const p of postingRows) {
    if (!byTxn.has(p.txn_id)) byTxn.set(p.txn_id, []);
    byTxn.get(p.txn_id)!.push(toPosting(p));
  }
  const uncategorizedId = systemCategoryId(db, 'uncategorized');
  return rows.map((r) => {
    const postings = byTxn.get(r.id) ?? [];
    return {
      id: r.id,
      date: r.date,
      payee: r.payee,
      memo: r.memo,
      kind: r.kind,
      createdByPersonId: r.created_by_person_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      postings,
      isTransfer: postings.every((p) => p.accountId !== null),
      isUncategorized: postings.some((p) => p.categoryId === uncategorizedId),
    };
  });
}

export function getTxn(db: DB, id: number): Txn {
  const row = db
    .prepare('SELECT * FROM txn WHERE id = ? AND household_id = ?')
    .get(id, householdId(db)) as TxnRow | undefined;
  if (!row) throw new NotFoundError('Transaction');
  return hydrate(db, [row])[0];
}

// ---------- validation ----------

function cleanText(value: unknown, label: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text`);
  const t = value.trim();
  if (t.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer`);
  return t || null;
}

interface CleanPosting {
  accountId: number | null;
  categoryId: number | null;
  amountCents: number;
  memo: string | null;
  status: 'uncleared' | 'cleared' | null;
}

interface AccountInfo {
  name: string;
  opening_date: string;
  archived_at: string | null;
}
interface CategoryInfo {
  name: string;
  kind: string;
  is_system: number;
  archived_at: string | null;
}

/**
 * Validate a TxnInput. `existing` is the txn being replaced (on update): its
 * archived accounts/categories may stay, and its reconciled postings must be kept.
 */
function validate(db: DB, input: TxnInput, existing?: Txn) {
  if (!input || typeof input !== 'object') throw new ValidationError('Missing transaction');
  if (!isValidDate(input.date)) throw new ValidationError('Date must be YYYY-MM-DD');
  const payee = cleanText(input.payee, 'Payee', 100);
  const memo = cleanText(input.memo, 'Memo', 500);
  assertActivePeople(db, [input.createdByPersonId], 'Entered by');

  const postings = input.postings;
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new ValidationError('A transaction needs at least two lines');
  }

  const household = householdId(db);
  const getAccount = db.prepare(
    'SELECT name, opening_date, archived_at FROM account WHERE id = ? AND household_id = ?',
  );
  const getCategory = db.prepare(
    'SELECT name, kind, is_system, archived_at FROM category WHERE id = ? AND household_id = ?',
  );
  const keptAccounts = new Set(existing?.postings.map((p) => p.accountId) ?? []);
  const keptCategories = new Set(existing?.postings.map((p) => p.categoryId) ?? []);

  let total = 0;
  let accountLines = 0;
  const out: CleanPosting[] = [];

  postings.forEach((p, i) => {
    const line = `Line ${i + 1}`;
    const hasAccount = p.accountId != null;
    const hasCategory = p.categoryId != null;
    if (hasAccount === hasCategory) {
      throw new ValidationError(`${line}: choose an account or a category (exactly one)`);
    }
    if (!Number.isSafeInteger(p.amountCents) || p.amountCents === 0) {
      throw new ValidationError(`${line}: amount must be a nonzero whole number of cents`);
    }
    total += p.amountCents;

    if (hasAccount) {
      accountLines++;
      const a = getAccount.get(p.accountId, household) as AccountInfo | undefined;
      if (!a) throw new ValidationError(`${line}: unknown account`);
      if (a.archived_at && !keptAccounts.has(p.accountId!)) {
        throw new ValidationError(`${line}: ${a.name} is archived`);
      }
      if (input.date < a.opening_date) {
        throw new ValidationError(`${a.name} opened on ${a.opening_date}; date can't be earlier`);
      }
      if (p.status !== undefined && p.status !== 'uncleared' && p.status !== 'cleared') {
        throw new ValidationError(`${line}: status must be uncleared or cleared`);
      }
    } else {
      const c = getCategory.get(p.categoryId, household) as CategoryInfo | undefined;
      if (!c) throw new ValidationError(`${line}: unknown category`);
      if (c.is_system && c.kind !== 'uncategorized') {
        throw new ValidationError(`${line}: ${c.name} is managed by the app`);
      }
      if (c.archived_at && !keptCategories.has(p.categoryId!)) {
        throw new ValidationError(`${line}: ${c.name} is archived`);
      }
      if (p.status !== undefined) {
        throw new ValidationError(`${line}: only account lines have a cleared status`);
      }
    }

    out.push({
      accountId: hasAccount ? p.accountId : null,
      categoryId: hasCategory ? p.categoryId : null,
      amountCents: p.amountCents,
      memo: cleanText(p.memo, `${line} memo`, 200),
      status: hasAccount ? (p.status ?? 'uncleared') : null,
    });
  });

  if (accountLines === 0) throw new ValidationError('A transaction must involve at least one account');
  if (total !== 0) {
    throw new ValidationError(`Lines don't balance: off by ${(Math.abs(total) / 100).toFixed(2)}`);
  }

  return { date: input.date, payee, memo, postings: out };
}

/**
 * Reconciled postings (D12) must survive an update unchanged: same account,
 * same amount, same date. Returns them matched to their replacement lines.
 */
function matchReconciled(
  existing: Txn,
  next: ReturnType<typeof validate>,
): Map<number, Posting> {
  const reconciled = existing.postings.filter((p) => p.status === 'reconciled');
  const matched = new Map<number, Posting>(); // index in next.postings -> old posting
  if (reconciled.length === 0) return matched;
  if (next.date !== existing.date) {
    throw new ValidationError('This transaction has reconciled lines; its date is locked');
  }
  for (const old of reconciled) {
    const idx = next.postings.findIndex(
      (p, i) => !matched.has(i) && p.accountId === old.accountId && p.amountCents === old.amountCents,
    );
    if (idx === -1) {
      throw new ValidationError(
        'This transaction has reconciled lines; their account and amount are locked',
      );
    }
    matched.set(idx, old);
  }
  return matched;
}

function assertEditable(txn: Txn) {
  if (txn.kind !== 'standard') {
    throw new ValidationError(
      txn.kind === 'opening'
        ? 'Opening balances are edited from the account'
        : 'Valuation entries are managed from balance snapshots',
    );
  }
}

// ---------- writes ----------

function insertPostings(
  db: DB,
  txnId: number,
  postings: CleanPosting[],
  reconciled: Map<number, Posting> = new Map(),
) {
  const insert = db.prepare(
    `INSERT INTO posting (txn_id, account_id, category_id, amount_cents, memo, status, reconciliation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  postings.forEach((p, i) => {
    const old = reconciled.get(i);
    insert.run(
      txnId,
      p.accountId,
      p.categoryId,
      p.amountCents,
      p.memo,
      old ? 'reconciled' : p.status,
      old ? old.reconciliationId : null,
    );
  });
}

export function createTxn(db: DB, input: TxnInput): Txn {
  const v = validate(db, input);
  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO txn (household_id, date, payee, memo, kind, created_by_person_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'standard', ?, ?, ?)`,
      )
      .run(householdId(db), v.date, v.payee, v.memo, input.createdByPersonId, now, now);
    insertPostings(db, Number(lastInsertRowid), v.postings);
    recomputeValuations(db, v.postings.map((p) => p.accountId));
    return Number(lastInsertRowid);
  })();
  return getTxn(db, id);
}

/**
 * Replace a txn's date/payee/memo and all of its postings. The original
 * creator is kept; createdByPersonId in the input is only checked as valid.
 */
export function updateTxn(db: DB, id: number, input: TxnInput): Txn {
  const existing = getTxn(db, id);
  assertEditable(existing);
  const v = validate(db, input, existing);
  const reconciled = matchReconciled(existing, v);
  db.transaction(() => {
    db.prepare('UPDATE txn SET date = ?, payee = ?, memo = ?, updated_at = ? WHERE id = ?').run(
      v.date,
      v.payee,
      v.memo,
      new Date().toISOString(),
      id,
    );
    db.prepare('DELETE FROM posting WHERE txn_id = ?').run(id);
    insertPostings(db, id, v.postings, reconciled);
    recomputeValuations(db, [...existing.postings, ...v.postings].map((p) => p.accountId));
  })();
  return getTxn(db, id);
}

export function deleteTxn(db: DB, id: number): void {
  const existing = getTxn(db, id);
  assertEditable(existing);
  if (existing.postings.some((p) => p.status === 'reconciled')) {
    throw new ValidationError('This transaction has reconciled lines and can’t be deleted');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM posting WHERE txn_id = ?').run(id); // explicit; cascade would too
    db.prepare('DELETE FROM txn WHERE id = ?').run(id);
    recomputeValuations(db, existing.postings.map((p) => p.accountId));
  })();
}

// ---------- register query ----------

/**
 * Transactions matching the filters, newest first. Scope: txns touching at
 * least one in-scope account. With accountId, each txn also carries that
 * account's running balance after it (computed over all its postings, not just
 * the filtered page).
 */
export function listTxns(db: DB, f: TxnFilters = {}): { txns: Txn[]; total: number } {
  const where: string[] = ['t.household_id = ?'];
  const params: unknown[] = [householdId(db)];

  const scope = scopeAccountFilter(db, f.scope ?? { type: 'household' });
  where.push(
    `EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.id AND p.account_id IN (${scope.sql}))`,
  );
  params.push(...scope.params);

  if (f.accountId !== undefined) {
    where.push('EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.id AND p.account_id = ?)');
    params.push(f.accountId);
  }
  if (f.categoryId !== undefined) {
    where.push('EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.id AND p.category_id = ?)');
    params.push(f.categoryId);
  }
  if (f.uncategorized) {
    where.push('EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.id AND p.category_id = ?)');
    params.push(systemCategoryId(db, 'uncategorized'));
  }
  if (f.status) {
    const accountClause = f.accountId !== undefined ? 'AND p.account_id = ?' : '';
    where.push(
      `EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.id AND p.status = ? ${accountClause})`,
    );
    params.push(f.status, ...(f.accountId !== undefined ? [f.accountId] : []));
  }
  if (f.unreconciled) {
    const accountClause = f.accountId !== undefined ? 'AND p.account_id = ?' : '';
    where.push(
      `EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.id AND p.status IN ('uncleared', 'cleared') ${accountClause})`,
    );
    if (f.accountId !== undefined) params.push(f.accountId);
  }
  if (f.from) {
    where.push('t.date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('t.date <= ?');
    params.push(f.to);
  }
  if (f.createdBy !== undefined) {
    where.push('t.created_by_person_id = ?');
    params.push(f.createdBy);
  }
  if (f.q && f.q.trim()) {
    const like = `%${f.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push(
      `(t.payee LIKE ? ESCAPE '\\' OR t.memo LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.id AND p.memo LIKE ? ESCAPE '\\'))`,
    );
    params.push(like, like, like);
  }

  const whereSql = where.join(' AND ');
  const { n: total } = db
    .prepare(`SELECT COUNT(*) AS n FROM txn t WHERE ${whereSql}`)
    .get(...params) as { n: number };

  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  const offset = Math.max(f.offset ?? 0, 0);
  const rows = db
    .prepare(
      `SELECT t.* FROM txn t WHERE ${whereSql} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as TxnRow[];
  const txns = hydrate(db, rows);

  if (f.accountId !== undefined) {
    // Same order as the register (date, then id), oldest first, cumulative.
    const running = db
      .prepare(
        `SELECT t.id AS txn_id,
           SUM(SUM(p.amount_cents)) OVER (ORDER BY t.date, t.id) AS balance
         FROM posting p JOIN txn t ON t.id = p.txn_id
         WHERE p.account_id = ?
         GROUP BY t.id`,
      )
      .all(f.accountId) as { txn_id: number; balance: number }[];
    const byId = new Map(running.map((r) => [r.txn_id, r.balance]));
    for (const t of txns) t.runningBalanceCents = byId.get(t.id);
  }

  return { txns, total };
}
