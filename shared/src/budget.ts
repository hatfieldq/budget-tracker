// Monthly budget helpers shared by server and web (D31–D33, D36).
// A month is 'YYYY-MM'. Budget amounts and spending are natural terms:
// positive = money spent (expense categories are debits, so ledger sign already
// matches). Refunds can make spending negative.
//
// Three kinds of line:
//   category - expense category spending (minus anything inside loan payments)
//   loan     - the whole of each payment to the loan: principal + expense lines in it (interest)
//   savings  - net money moved into a savings account (transfers + interest); a goal to reach
//   investing - the "All investing" group: net money into every brokerage and
//              retirement account (= Overview's net contributions; valuations never count); a goal

export type BudgetStatus = 'none' | 'under' | 'over';
export type SavingsStatus = 'none' | 'met' | 'short';
export type BudgetLineKind = 'category' | 'loan' | 'savings' | 'investing';

/** Budget groups (lines covering several accounts). */
export const BUDGET_GROUPS = ['investing'] as const;
export type BudgetGroup = (typeof BUDGET_GROUPS)[number];

/** Goal lines: reaching the amount is good. The rest are limits. */
export const isGoalLine = (l: Pick<BudgetLine, 'kind'>) => l.kind === 'savings' || l.kind === 'investing';

export interface BudgetLine {
  kind: BudgetLineKind;
  /** Set for category lines. */
  categoryId: number | null;
  /** Set for loan and savings lines. */
  accountId: number | null;
  /** Set for group lines ('investing'). */
  group?: BudgetGroup;
  name: string;
  archived: boolean;
  /** null = no budget set for this line this month. */
  budgetCents: number | null;
  spentCents: number;
  /** Category lines: spending inside loan payments, counted on the loan's line instead. */
  inLoanPaymentsCents?: number;
}

/** Stable key for a line (React keys, lookups). */
export const lineKey = (l: Pick<BudgetLine, 'kind' | 'categoryId' | 'accountId' | 'group'>) =>
  l.kind === 'category' ? `c${l.categoryId}` : l.group ? `g${l.group}` : `a${l.accountId}`;

export interface BudgetMonth {
  month: string;
  scopeLabel: string;
  /** Person scope that includes joint accounts (counted at full value, D8). */
  includesJointAccounts: boolean;
  lines: BudgetLine[];
  /** Money-out postings to Uncategorized this month (D6): not budgetable. */
  uncategorized: { cents: number; count: number };
  /** How many lines have a budget in the previous month (for "Copy last month"). */
  previousMonthBudgetCount: number;
}

/** Body for PUT /api/budgets/:month/:categoryId, /accounts/:accountId and /groups/:group. null clears. */
export interface BudgetSetInput {
  amountCents: number | null;
}

export const isValidMonth = (m: unknown): m is string =>
  typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

/** Shift a 'YYYY-MM' month by n months (negative = earlier). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** First and last day of a month, as inclusive 'YYYY-MM-DD' bounds. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** Spending exactly at the budget counts as on target (green), not over. */
export function budgetStatus(budgetCents: number | null, spentCents: number): BudgetStatus {
  if (budgetCents === null) return 'none';
  return spentCents > budgetCents ? 'over' : 'under';
}

/** Savings is a goal: reaching it (or more) is good; below it is still to go. */
export function savingsStatus(goalCents: number | null, savedCents: number): SavingsStatus {
  if (goalCents === null) return 'none';
  return savedCents >= goalCents ? 'met' : 'short';
}

export const lineStatus = (l: BudgetLine): BudgetStatus | SavingsStatus =>
  isGoalLine(l) ? savingsStatus(l.budgetCents, l.spentCents) : budgetStatus(l.budgetCents, l.spentCents);

/**
 * Totals. Spending (categories + loan payments), savings and investing are
 * kept apart, since spending is a limit and the others are goals. Category spending without a
 * budget is reported separately.
 */
export function budgetTotals(lines: BudgetLine[]) {
  let budgetedCents = 0;
  let spentBudgetedCents = 0;
  let unbudgetedSpentCents = 0;
  let savingsGoalCents = 0;
  let savedCents = 0;
  let investingGoalCents = 0;
  let investedCents = 0;
  for (const l of lines) {
    if (l.kind === 'savings') {
      if (l.budgetCents !== null) {
        savingsGoalCents += l.budgetCents;
        savedCents += l.spentCents;
      }
    } else if (l.kind === 'investing') {
      if (l.budgetCents !== null) {
        investingGoalCents += l.budgetCents;
        investedCents += l.spentCents;
      }
    } else if (l.budgetCents === null) {
      if (l.kind === 'category') unbudgetedSpentCents += l.spentCents;
    } else {
      budgetedCents += l.budgetCents;
      spentBudgetedCents += l.spentCents;
    }
  }
  return {
    budgetedCents,
    spentBudgetedCents,
    unbudgetedSpentCents,
    leftCents: budgetedCents - spentBudgetedCents,
    savingsGoalCents,
    savedCents,
    investingGoalCents,
    investedCents,
  };
}
