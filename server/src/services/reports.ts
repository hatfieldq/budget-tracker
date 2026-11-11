// Report engine (PLAN §3).
//
// Eligible txn = kind 'standard', date in the period, and at least one account
// posting in the scope's accounts (D8). Opening and valuation txns are never
// eligible (AT-11). Classification is by posting target (D1): category kind for
// income/taxes/spending, account type for savings/investment flows.
import {
  dayBefore,
  isInvestment,
  type CategoryAmount,
  type NetWorthLine,
  type OverviewReport,
  type Scope,
} from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId } from '../db/bootstrap';
import { isValidDate } from '../dates';
import { ValidationError } from '../errors';
import { listAccounts } from './accounts';
import { scopeAccountFilter } from './scope';

export interface ScopeInfo {
  label: string;
  includesJointAccounts: boolean;
}

export function scopeInfo(db: DB, scope: Scope): ScopeInfo {
  if (scope.type === 'household') return { label: 'Household', includesJointAccounts: false };
  const person = db.prepare('SELECT display_name FROM person WHERE id = ?').get(scope.personId) as
    | { display_name: string }
    | undefined;
  const joint = db
    .prepare(
      `SELECT 1 FROM account_owner o
       WHERE o.person_id = ? AND (SELECT COUNT(*) FROM account_owner x WHERE x.account_id = o.account_id) > 1
       LIMIT 1`,
    )
    .get(scope.personId);
  return { label: person?.display_name ?? `Person ${scope.personId}`, includesJointAccounts: !!joint };
}

interface CategoryRow {
  id: number;
  name: string;
  kind: string;
  /** Sum of debit (positive) and credit (negative) postings, kept apart for Uncategorized (D6). */
  debit: number;
  credit: number;
  debit_n: number;
  credit_n: number;
}

/** SQL selecting eligible txn ids; params: household, from, to, ...scope params. */
const eligibleSql = (scopeSql: string) => `
  SELECT DISTINCT t.id FROM txn t JOIN posting p ON p.txn_id = t.id
  WHERE t.household_id = ? AND t.kind = 'standard' AND t.date BETWEEN ? AND ?
    AND p.account_id IN (${scopeSql})`;

/** Category postings in eligible txns, per category. */
function categoryTotals(db: DB, scope: Scope, from: string, to: string): CategoryRow[] {
  const s = scopeAccountFilter(db, scope);
  return db
    .prepare(
      `SELECT c.id, c.name, c.kind,
         COALESCE(SUM(CASE WHEN p.amount_cents > 0 THEN p.amount_cents END), 0) AS debit,
         COALESCE(SUM(CASE WHEN p.amount_cents < 0 THEN p.amount_cents END), 0) AS credit,
         COUNT(CASE WHEN p.amount_cents > 0 THEN 1 END) AS debit_n,
         COUNT(CASE WHEN p.amount_cents < 0 THEN 1 END) AS credit_n
       FROM posting p JOIN category c ON c.id = p.category_id
       WHERE p.txn_id IN (${eligibleSql(s.sql)})
       GROUP BY c.id`,
    )
    .all(householdId(db), from, to, ...s.params) as CategoryRow[];
}

export interface Spending {
  /** Net spending per expense category id (natural: + spent, − refunded). */
  byCategory: Map<number, number>;
  /** Money-out postings to Uncategorized (D6). */
  uncategorized: { cents: number; count: number };
}

/** Spending (PLAN §3) in [from, to] for a scope. Used by budgets. */
export function spendingByCategory(db: DB, scope: Scope, from: string, to: string): Spending {
  const byCategory = new Map<number, number>();
  const uncategorized = { cents: 0, count: 0 };
  for (const r of categoryTotals(db, scope, from, to)) {
    if (r.kind === 'expense') byCategory.set(r.id, r.debit + r.credit);
    else if (r.kind === 'uncategorized') {
      uncategorized.cents += r.debit;
      uncategorized.count += r.debit_n;
    }
  }
  return { byCategory, uncategorized };
}

const section = (lines: CategoryAmount[]) => ({
  totalCents: lines.reduce((sum, l) => sum + l.cents, 0),
  lines: lines.filter((l) => l.cents !== 0).sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name)),
});

export function overviewReport(db: DB, scope: Scope, from: string, to: string): OverviewReport {
  if (!isValidDate(from) || !isValidDate(to)) throw new ValidationError('Period dates must be YYYY-MM-DD');
  if (from > to) throw new ValidationError('The period starts after it ends');
  const s = scopeAccountFilter(db, scope);
  const hh = householdId(db);

  // ---- income / taxes / spending (eligible txns) ----
  const income: CategoryAmount[] = [];
  const taxes: CategoryAmount[] = [];
  const spending: CategoryAmount[] = [];
  const uncategorized = { count: 0, cents: 0 };
  for (const r of categoryTotals(db, scope, from, to)) {
    const net = r.debit + r.credit;
    if (r.kind === 'income') income.push({ categoryId: r.id, name: r.name, cents: -net });
    else if (r.kind === 'tax') taxes.push({ categoryId: r.id, name: r.name, cents: net });
    else if (r.kind === 'expense') spending.push({ categoryId: r.id, name: r.name, cents: net });
    else if (r.kind === 'uncategorized') {
      // D6: counted by sign, labelled, and warned about.
      if (r.credit) income.push({ categoryId: r.id, name: 'Uncategorized (money in)', cents: -r.credit, uncategorized: true });
      if (r.debit) spending.push({ categoryId: r.id, name: 'Uncategorized (money out)', cents: r.debit, uncategorized: true });
      uncategorized.count += r.debit_n + r.credit_n;
      uncategorized.cents += r.debit - r.credit;
    }
  }
  const inc = section(income);
  const tax = section(taxes);
  const spend = section(spending);
  const netCents = inc.totalCents - tax.totalCents - spend.totalCents;

  // ---- account flows in the period, by account type and txn kind ----
  const flows = db
    .prepare(
      `SELECT a.type, t.kind, SUM(p.amount_cents) AS cents
       FROM posting p JOIN txn t ON t.id = p.txn_id JOIN account a ON a.id = p.account_id
       WHERE p.account_id IN (${s.sql}) AND t.date BETWEEN ? AND ?
       GROUP BY a.type, t.kind`,
    )
    .all(...s.params, from, to) as { type: string; kind: string; cents: number }[];
  const flow = (pred: (f: { type: string; kind: string }) => boolean) =>
    flows.filter(pred).reduce((sum, f) => sum + f.cents, 0);
  const savingsCents = flow((f) => f.type === 'savings' && f.kind === 'standard');
  const investmentContributionsCents = flow(
    (f) => (f.type === 'brokerage' || f.type === 'retirement') && f.kind === 'standard',
  );
  const valuationChangeCents = flow((f) => f.kind === 'valuation');
  const openingCents = flow((f) => f.kind === 'opening');
  const changeCents = flow(() => true);

  // Person scope: eligible txns may move money to/from accounts outside the scope.
  let outsideTransfersCents: number | null = null;
  if (scope.type === 'person') {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(p.amount_cents), 0) AS cents FROM posting p
         WHERE p.account_id IS NOT NULL AND p.account_id NOT IN (${s.sql})
           AND p.txn_id IN (${eligibleSql(s.sql)})`,
      )
      .get(...s.params, hh, from, to, ...s.params) as { cents: number };
    outsideTransfersCents = 0 - row.cents;
  }

  // ---- balances: net worth and debts at the end of the period ----
  const startCents = (
    db
      .prepare(
        `SELECT COALESCE(SUM(p.amount_cents), 0) AS cents FROM posting p JOIN txn t ON t.id = p.txn_id
         WHERE p.account_id IN (${s.sql}) AND t.date <= ?`,
      )
      .get(...s.params, dayBefore(from)) as { cents: number }
  ).cents;
  const latestSnapshot = db.prepare(
    'SELECT MAX(date) AS date FROM balance_snapshot WHERE account_id = ? AND date <= ?',
  );
  const movedSince = db.prepare(
    `SELECT 1 FROM posting p JOIN txn t ON t.id = p.txn_id
     WHERE p.account_id = ? AND t.kind = 'standard' AND t.date > ? AND t.date <= ? LIMIT 1`,
  );
  const lines: NetWorthLine[] = listAccounts(db, { scope, includeArchived: true, asOf: to })
    .filter((a) => a.openingDate <= to && (!a.archivedAt || a.balanceCents !== 0))
    .map((a) => {
      let valuation: NetWorthLine['valuation'] = null;
      if (isInvestment(a.type)) {
        const snap = (latestSnapshot.get(a.id, to) as { date: string | null }).date;
        valuation = snap
          ? { kind: 'snapshot', date: snap, transfersSince: !!movedSince.get(a.id, snap, to) }
          : { kind: 'opening', date: a.openingDate };
      }
      return {
        accountId: a.id,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        isJoint: a.isJoint,
        archived: !!a.archivedAt,
        balanceCents: a.balanceCents,
        valuation,
      };
    });
  const endCents = lines.reduce((sum, l) => sum + l.balanceCents, 0);
  const debts = lines
    .filter((l) => l.type === 'credit_card' || l.type === 'loan')
    .map((l) => ({ accountId: l.accountId, name: l.name, type: l.type, subtype: l.subtype, owedCents: 0 - l.balanceCents }));

  const explained = netCents + valuationChangeCents + openingCents + (outsideTransfersCents ?? 0);
  const info = scopeInfo(db, scope);
  return {
    scope: {
      type: scope.type,
      ...(scope.type === 'person' ? { personId: scope.personId } : {}),
      label: info.label,
      includesJointAccounts: info.includesJointAccounts,
    },
    period: { from, to },
    income: inc,
    taxes: tax,
    spending: spend,
    netCents,
    uncategorized,
    savingsCents,
    investmentContributionsCents,
    valuationChangeCents,
    debts,
    netWorth: { startCents, endCents, lines },
    identity: {
      changeCents,
      openingCents,
      outsideTransfersCents,
      balanced: explained === changeCents && endCents - startCents === changeCents,
    },
  };
}
