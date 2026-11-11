// Today screen data (PLAN §3 "Today") and payee hints for quick entry.
//   review   - per reconcilable account: items still uncleared / cleared, last reconciliation
//   stale    - investment accounts whose latest value (or opening date) is more than 7 days old (AT-16)
//   uncategorized - newest txns with an Uncategorized line
//   budget   - this month's budget at a glance
import {
  INVESTMENT_TYPES_FOR_TODAY,
  RECONCILABLE_TYPES,
  budgetTotals,
  lineStatus,
  type PayeeHint,
  type Scope,
  type TodaySummary,
} from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId } from '../db/bootstrap';
import { localToday } from '../dates';
import { listAccounts } from './accounts';
import { getBudgetMonth } from './budgets';
import { listTxns } from './ledger';

export const STALE_AFTER_DAYS = 7;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function todaySummary(db: DB, scope: Scope, today: string = localToday()): TodaySummary {
  const accounts = listAccounts(db, { scope, asOf: today });
  const counts = db.prepare(
    `SELECT
       COUNT(CASE WHEN p.status = 'uncleared' THEN 1 END) AS uncleared,
       COUNT(CASE WHEN p.status = 'cleared' THEN 1 END) AS cleared
     FROM posting p JOIN txn t ON t.id = p.txn_id
     WHERE p.account_id = ? AND t.kind = 'standard'`,
  );
  const review = accounts
    .filter((a) => RECONCILABLE_TYPES.includes(a.type))
    .map((a) => {
      const c = counts.get(a.id) as { uncleared: number; cleared: number };
      return {
        accountId: a.id,
        name: a.name,
        type: a.type,
        unclearedCount: c.uncleared,
        clearedCount: c.cleared,
        lastReconciledDate: a.lastReconciledDate,
      };
    });

  const stale = accounts
    .filter((a) => INVESTMENT_TYPES_FOR_TODAY.includes(a.type))
    .map((a) => {
      const basisDate = a.lastSnapshotDate ?? a.openingDate;
      const days = daysBetween(basisDate, today);
      return {
        accountId: a.id,
        name: a.name,
        lastValueDate: a.lastSnapshotDate,
        basisDate,
        days,
        stale: days > STALE_AFTER_DAYS,
      };
    })
    .sort((x, y) => y.days - x.days);

  const uncategorized = listTxns(db, { scope, uncategorized: true, limit: 10 });

  const month = today.slice(0, 7);
  const b = getBudgetMonth(db, scope, month);
  const totals = budgetTotals(b.lines);
  const over = b.lines.filter((l) => lineStatus(l) === 'over').map((l) => l.name);

  return {
    today,
    review,
    stale,
    uncategorized: { total: uncategorized.total, txns: uncategorized.txns },
    budget: {
      month,
      hasBudget: b.lines.some((l) => l.budgetCents !== null),
      budgetedCents: totals.budgetedCents,
      spentBudgetedCents: totals.spentBudgetedCents,
      overCategories: over,
    },
  };
}

/**
 * One hint per payee (case-insensitive), from its most recent standard txn:
 * that txn's category when it had exactly one (and it wasn't Uncategorized).
 */
export function listPayees(db: DB): PayeeHint[] {
  return (
    db
      .prepare(
        `WITH latest AS (
           SELECT t.id, trim(t.payee) AS payee, t.date,
                  ROW_NUMBER() OVER (PARTITION BY lower(trim(t.payee)) ORDER BY t.date DESC, t.id DESC) AS rn
           FROM txn t
           WHERE t.household_id = ? AND t.kind = 'standard' AND t.payee IS NOT NULL AND trim(t.payee) <> ''
         )
         SELECT l.payee, l.date,
           (SELECT CASE WHEN COUNT(*) = 1 AND MAX(c.kind) <> 'uncategorized' THEN MAX(p.category_id) END
            FROM posting p JOIN category c ON c.id = p.category_id
            WHERE p.txn_id = l.id) AS category_id
         FROM latest l WHERE l.rn = 1
         ORDER BY l.date DESC, l.payee
         LIMIT 500`,
      )
      .all(householdId(db)) as { payee: string; date: string; category_id: number | null }[]
  ).map((r) => ({ payee: r.payee, lastDate: r.date, categoryId: r.category_id }));
}
