// Monthly budgets (D31–D33). Amounts are household-wide, one per expense
// category per month; each month starts blank and can be filled from the
// previous month. Actual spending comes from the report engine and follows the
// "Viewing as" scope.
import { addMonths, isValidMonth, monthBounds, type BudgetLine, type BudgetMonth, type Scope } from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId } from '../db/bootstrap';
import { NotFoundError, ValidationError } from '../errors';
import { scopeInfo, spendingByCategory } from './reports';

function assertMonth(month: unknown): asserts month is string {
  if (!isValidMonth(month)) throw new ValidationError('Month must be YYYY-MM');
}

const budgetsFor = (db: DB, month: string) =>
  new Map(
    (
      db
        .prepare('SELECT category_id, amount_cents FROM budget WHERE household_id = ? AND month = ?')
        .all(householdId(db), month) as { category_id: number; amount_cents: number }[]
    ).map((r) => [r.category_id, r.amount_cents]),
  );

export function getBudgetMonth(db: DB, scope: Scope, month: string): BudgetMonth {
  assertMonth(month);
  const { from, to } = monthBounds(month);
  const spending = spendingByCategory(db, scope, from, to);
  const budgets = budgetsFor(db, month);
  const categories = db
    .prepare(
      `SELECT id, name, archived_at FROM category
       WHERE household_id = ? AND kind = 'expense' ORDER BY name COLLATE NOCASE`,
    )
    .all(householdId(db)) as { id: number; name: string; archived_at: string | null }[];

  const lines: BudgetLine[] = categories
    // Archived categories only show up when this month has something for them.
    .filter((c) => !c.archived_at || budgets.has(c.id) || spending.byCategory.has(c.id))
    .map((c) => ({
      categoryId: c.id,
      name: c.name,
      archived: !!c.archived_at,
      budgetCents: budgets.get(c.id) ?? null,
      spentCents: spending.byCategory.get(c.id) ?? 0,
    }));

  const info = scopeInfo(db, scope);
  return {
    month,
    scopeLabel: info.label,
    includesJointAccounts: info.includesJointAccounts,
    lines,
    uncategorized: spending.uncategorized,
    previousMonthBudgetCount: budgetsFor(db, addMonths(month, -1)).size,
  };
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
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new ValidationError('Budget must be zero or more, in whole cents');
  }
  db.prepare(
    `INSERT INTO budget (household_id, month, category_id, amount_cents) VALUES (?, ?, ?, ?)
     ON CONFLICT (household_id, month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents`,
  ).run(householdId(db), month, categoryId, amountCents);
}

/**
 * Fill this month's blank categories with last month's amounts. Categories that
 * already have a budget this month are left alone; archived or no-longer-expense
 * categories are skipped. Returns how many were copied.
 */
export function copyPreviousMonth(db: DB, month: string): number {
  assertMonth(month);
  const previous = addMonths(month, -1);
  const hh = householdId(db);
  if (budgetsFor(db, previous).size === 0) {
    throw new ValidationError(`${previous} has no budget to copy`);
  }
  return db.transaction(() => {
    const { changes } = db
      .prepare(
        `INSERT INTO budget (household_id, month, category_id, amount_cents)
         SELECT b.household_id, ?, b.category_id, b.amount_cents
         FROM budget b JOIN category c ON c.id = b.category_id
         WHERE b.household_id = ? AND b.month = ? AND c.kind = 'expense' AND c.archived_at IS NULL
         ON CONFLICT (household_id, month, category_id) DO NOTHING`,
      )
      .run(month, hh, previous);
    return changes;
  })();
}
