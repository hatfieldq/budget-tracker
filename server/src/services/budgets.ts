// Monthly budgets (D31–D33, D36). Amounts are household-wide, one per line per
// month; each month starts blank and can be filled from the previous month.
// Lines:
//   category - expense category spending (PLAN §3), minus expense lines that sit
//              inside a loan payment (those count on the loan's line instead)
//   loan     - each payment to the loan in full: principal (money into the loan
//              account) + the expense lines in the same txn (interest, escrow)
//   savings  - net money moved into the savings account (transfers + interest)
//   investing - "All investing": net money into every in-scope brokerage and
//              retirement account (D37; = Overview's net contributions)
// Actuals follow the "Viewing as" scope. Overview is unaffected: principal is
// still a transfer there, never spending.
import {
  BUDGET_GROUPS,
  addMonths,
  isInvestment,
  isValidMonth,
  monthBounds,
  type BudgetLine,
  type BudgetMonth,
  type Scope,
} from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId } from '../db/bootstrap';
import { NotFoundError, ValidationError } from '../errors';
import { listAccounts } from './accounts';
import { scopeInfo, spendingByCategory } from './reports';
import { scopeAccountFilter } from './scope';

const BUDGET_ACCOUNT_TYPES = ['loan', 'savings'] as const;

function assertMonth(month: unknown): asserts month is string {
  if (!isValidMonth(month)) throw new ValidationError('Month must be YYYY-MM');
}

interface BudgetRow {
  category_id: number | null;
  account_id: number | null;
  group_key: string | null;
  amount_cents: number;
}

function budgetsFor(db: DB, month: string) {
  const rows = db
    .prepare('SELECT category_id, account_id, group_key, amount_cents FROM budget WHERE household_id = ? AND month = ?')
    .all(householdId(db), month) as BudgetRow[];
  const byCategory = new Map<number, number>();
  const byAccount = new Map<number, number>();
  const byGroup = new Map<string, number>();
  for (const r of rows) {
    if (r.category_id !== null) byCategory.set(r.category_id, r.amount_cents);
    else if (r.account_id !== null) byAccount.set(r.account_id, r.amount_cents);
    else if (r.group_key !== null) byGroup.set(r.group_key, r.amount_cents);
  }
  return { byCategory, byAccount, byGroup, count: rows.length };
}

/**
 * Loan payments in [from, to] for in-scope loans: per loan, principal plus the
 * expense lines in the same txns; and per category, how much of its spending
 * those payments took over. A txn paying two loans gives its expense lines to
 * the lower account id (rare; keeps the totals exact).
 */
function loanPayments(db: DB, scope: Scope, from: string, to: string) {
  const s = scopeAccountFilter(db, scope);
  const principal = db
    .prepare(
      `SELECT p.txn_id, p.account_id, SUM(p.amount_cents) AS cents
       FROM posting p JOIN txn t ON t.id = p.txn_id JOIN account a ON a.id = p.account_id
       WHERE t.household_id = ? AND t.kind = 'standard' AND t.date BETWEEN ? AND ?
         AND a.type = 'loan' AND p.amount_cents > 0 AND p.account_id IN (${s.sql})
       GROUP BY p.txn_id, p.account_id
       ORDER BY p.txn_id, p.account_id`,
    )
    .all(householdId(db), from, to, ...s.params) as { txn_id: number; account_id: number; cents: number }[];

  const byLoan = new Map<number, number>();
  const takenFromCategory = new Map<number, number>();
  const loanOfTxn = new Map<number, number>();
  for (const r of principal) {
    byLoan.set(r.account_id, (byLoan.get(r.account_id) ?? 0) + r.cents);
    if (!loanOfTxn.has(r.txn_id)) loanOfTxn.set(r.txn_id, r.account_id); // lowest id first (ORDER BY)
  }
  if (loanOfTxn.size > 0) {
    const ids = [...loanOfTxn.keys()];
    const expense = db
      .prepare(
        `SELECT p.txn_id, p.category_id, SUM(p.amount_cents) AS cents
         FROM posting p JOIN category c ON c.id = p.category_id
         WHERE c.kind = 'expense' AND p.txn_id IN (${ids.map(() => '?').join(',')})
         GROUP BY p.txn_id, p.category_id`,
      )
      .all(...ids) as { txn_id: number; category_id: number; cents: number }[];
    for (const e of expense) {
      const loan = loanOfTxn.get(e.txn_id)!;
      byLoan.set(loan, (byLoan.get(loan) ?? 0) + e.cents);
      takenFromCategory.set(e.category_id, (takenFromCategory.get(e.category_id) ?? 0) + e.cents);
    }
  }
  return { byLoan, takenFromCategory };
}

/** Net standard postings into each in-scope savings account in [from, to]. */
function savingsMoved(db: DB, scope: Scope, from: string, to: string): Map<number, number> {
  const s = scopeAccountFilter(db, scope);
  const rows = db
    .prepare(
      `SELECT p.account_id, SUM(p.amount_cents) AS cents
       FROM posting p JOIN txn t ON t.id = p.txn_id JOIN account a ON a.id = p.account_id
       WHERE t.household_id = ? AND t.kind = 'standard' AND t.date BETWEEN ? AND ?
         AND a.type = 'savings' AND p.account_id IN (${s.sql})
       GROUP BY p.account_id`,
    )
    .all(householdId(db), from, to, ...s.params) as { account_id: number; cents: number }[];
  return new Map(rows.map((r) => [r.account_id, r.cents]));
}

/** Net standard postings into in-scope brokerage + retirement accounts in [from, to]. */
function investedTotal(db: DB, scope: Scope, from: string, to: string): number {
  const s = scopeAccountFilter(db, scope);
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(p.amount_cents), 0) AS cents
         FROM posting p JOIN txn t ON t.id = p.txn_id JOIN account a ON a.id = p.account_id
         WHERE t.household_id = ? AND t.kind = 'standard' AND t.date BETWEEN ? AND ?
           AND a.type IN ('brokerage', 'retirement') AND p.account_id IN (${s.sql})`,
      )
      .get(householdId(db), from, to, ...s.params) as { cents: number }
  ).cents;
}

export function getBudgetMonth(db: DB, scope: Scope, month: string): BudgetMonth {
  assertMonth(month);
  const { from, to } = monthBounds(month);
  const spending = spendingByCategory(db, scope, from, to);
  const loans = loanPayments(db, scope, from, to);
  const saved = savingsMoved(db, scope, from, to);
  const budgets = budgetsFor(db, month);

  const categories = db
    .prepare(
      `SELECT id, name, archived_at FROM category
       WHERE household_id = ? AND kind = 'expense' ORDER BY name COLLATE NOCASE`,
    )
    .all(householdId(db)) as { id: number; name: string; archived_at: string | null }[];

  const categoryLines: BudgetLine[] = categories
    // Archived categories only show up when this month has something for them.
    .filter((c) => !c.archived_at || budgets.byCategory.has(c.id) || spending.byCategory.has(c.id))
    .map((c) => {
      const taken = loans.takenFromCategory.get(c.id) ?? 0;
      return {
        kind: 'category' as const,
        categoryId: c.id,
        accountId: null,
        name: c.name,
        archived: !!c.archived_at,
        budgetCents: budgets.byCategory.get(c.id) ?? null,
        spentCents: (spending.byCategory.get(c.id) ?? 0) - taken,
        ...(taken !== 0 ? { inLoanPaymentsCents: taken } : {}),
      };
    });

  const scopeAccounts = listAccounts(db, { scope, includeArchived: true });
  const accountLines: BudgetLine[] = scopeAccounts
    .filter((a) => (BUDGET_ACCOUNT_TYPES as readonly string[]).includes(a.type))
    .map((a) => ({
      kind: a.type === 'loan' ? ('loan' as const) : ('savings' as const),
      categoryId: null,
      accountId: a.id,
      name: a.name,
      archived: !!a.archivedAt,
      budgetCents: budgets.byAccount.get(a.id) ?? null,
      spentCents: (a.type === 'loan' ? loans.byLoan.get(a.id) : saved.get(a.id)) ?? 0,
    }))
    .filter((l) => !l.archived || l.budgetCents !== null || l.spentCents !== 0)
    .sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === 'loan' ? -1 : 1));

  // "All investing": shown while any investment account is open in scope, or the month has a goal/activity.
  const investedCents = investedTotal(db, scope, from, to);
  const investingBudget = budgets.byGroup.get('investing') ?? null;
  const groupLines: BudgetLine[] =
    scopeAccounts.some((a) => isInvestment(a.type) && !a.archivedAt) || investingBudget !== null || investedCents !== 0
      ? [
          {
            kind: 'investing',
            categoryId: null,
            accountId: null,
            group: 'investing',
            name: 'All investing',
            archived: false,
            budgetCents: investingBudget,
            spentCents: investedCents,
          },
        ]
      : [];

  const info = scopeInfo(db, scope);
  return {
    month,
    scopeLabel: info.label,
    includesJointAccounts: info.includesJointAccounts,
    lines: [...categoryLines, ...accountLines, ...groupLines],
    uncategorized: spending.uncategorized,
    previousMonthBudgetCount: budgetsFor(db, addMonths(month, -1)).count,
  };
}

const UPSERT = (target: 'category_id' | 'account_id' | 'group_key') =>
  `INSERT INTO budget (household_id, month, ${target}, amount_cents) VALUES (?, ?, ?, ?)
   ON CONFLICT (household_id, month, ${target}) DO UPDATE SET amount_cents = excluded.amount_cents`;

function checkAmount(amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new ValidationError('Budget must be zero or more, in whole cents');
  }
}

/** Set (or clear, with null) one category's budget for a month. */
export function setBudget(db: DB, month: string, categoryId: number, amountCents: number | null): void {
  assertMonth(month);
  const c = db
    .prepare('SELECT name, kind, archived_at FROM category WHERE id = ? AND household_id = ?')
    .get(categoryId, householdId(db)) as { name: string; kind: string; archived_at: string | null } | undefined;
  if (!c) throw new NotFoundError('Category');
  if (amountCents === null) {
    db.prepare('DELETE FROM budget WHERE household_id = ? AND month = ? AND category_id = ?').run(
      householdId(db),
      month,
      categoryId,
    );
    return;
  }
  if (c.kind !== 'expense') throw new ValidationError(`Only expense categories can have a budget (${c.name} isn't one)`);
  if (c.archived_at) throw new ValidationError(`${c.name} is archived`);
  checkAmount(amountCents);
  db.prepare(UPSERT('category_id')).run(householdId(db), month, categoryId, amountCents);
}

/** Set (or clear, with null) a loan payment or savings goal for a month. */
export function setAccountBudget(db: DB, month: string, accountId: number, amountCents: number | null): void {
  assertMonth(month);
  const a = db
    .prepare('SELECT name, type, archived_at FROM account WHERE id = ? AND household_id = ?')
    .get(accountId, householdId(db)) as { name: string; type: string; archived_at: string | null } | undefined;
  if (!a) throw new NotFoundError('Account');
  if (amountCents === null) {
    db.prepare('DELETE FROM budget WHERE household_id = ? AND month = ? AND account_id = ?').run(
      householdId(db),
      month,
      accountId,
    );
    return;
  }
  if (!(BUDGET_ACCOUNT_TYPES as readonly string[]).includes(a.type)) {
    throw new ValidationError(`Only loan and savings accounts can have a budget (${a.name} isn't one)`);
  }
  if (a.archived_at) throw new ValidationError(`${a.name} is archived`);
  checkAmount(amountCents);
  db.prepare(UPSERT('account_id')).run(householdId(db), month, accountId, amountCents);
}

/** Set (or clear, with null) a group goal ('investing') for a month. */
export function setGroupBudget(db: DB, month: string, group: string, amountCents: number | null): void {
  assertMonth(month);
  if (!(BUDGET_GROUPS as readonly string[]).includes(group)) throw new NotFoundError('Budget group');
  if (amountCents === null) {
    db.prepare('DELETE FROM budget WHERE household_id = ? AND month = ? AND group_key = ?').run(householdId(db), month, group);
    return;
  }
  checkAmount(amountCents);
  db.prepare(UPSERT('group_key')).run(householdId(db), month, group, amountCents);
}

/**
 * Fill this month's blank lines with last month's amounts. Lines that already
 * have a budget this month are left alone; archived (or no longer eligible)
 * categories and accounts are skipped. Returns how many were copied.
 */
export function copyPreviousMonth(db: DB, month: string): number {
  assertMonth(month);
  const previous = addMonths(month, -1);
  const hh = householdId(db);
  if (budgetsFor(db, previous).count === 0) {
    throw new ValidationError(`${previous} has no budget to copy`);
  }
  return db.transaction(() => {
    const categories = db
      .prepare(
        `INSERT INTO budget (household_id, month, category_id, amount_cents)
         SELECT b.household_id, ?, b.category_id, b.amount_cents
         FROM budget b JOIN category c ON c.id = b.category_id
         WHERE b.household_id = ? AND b.month = ? AND c.kind = 'expense' AND c.archived_at IS NULL
         ON CONFLICT DO NOTHING`,
      )
      .run(month, hh, previous).changes;
    const accounts = db
      .prepare(
        `INSERT INTO budget (household_id, month, account_id, amount_cents)
         SELECT b.household_id, ?, b.account_id, b.amount_cents
         FROM budget b JOIN account a ON a.id = b.account_id
         WHERE b.household_id = ? AND b.month = ? AND a.type IN ('loan', 'savings') AND a.archived_at IS NULL
         ON CONFLICT DO NOTHING`,
      )
      .run(month, hh, previous).changes;
    const groups = db
      .prepare(
        `INSERT INTO budget (household_id, month, group_key, amount_cents)
         SELECT household_id, ?, group_key, amount_cents FROM budget
         WHERE household_id = ? AND month = ? AND group_key IS NOT NULL
         ON CONFLICT DO NOTHING`,
      )
      .run(month, hh, previous).changes;
    return categories + accounts + groups;
  })();
}
