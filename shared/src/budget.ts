// Monthly budget helpers shared by server and web (D31–D33).
// A month is 'YYYY-MM'. Budget amounts and spending are natural terms:
// positive = money spent (expense categories are debits, so ledger sign already
// matches). Refunds can make spending negative.

export type BudgetStatus = 'none' | 'under' | 'over';

export interface BudgetLine {
  categoryId: number;
  name: string;
  archived: boolean;
  /** null = no budget set for this category this month. */
  budgetCents: number | null;
  spentCents: number;
}

export interface BudgetMonth {
  month: string;
  scopeLabel: string;
  /** Person scope that includes joint accounts (counted at full value, D8). */
  includesJointAccounts: boolean;
  lines: BudgetLine[];
  /** Money-out postings to Uncategorized this month (D6): not budgetable. */
  uncategorized: { cents: number; count: number };
  /** How many categories have a budget in the previous month (for "Copy last month"). */
  previousMonthBudgetCount: number;
}

/** Body for PUT /api/budgets/:month/:categoryId. null clears the budget. */
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

/** Totals across lines. Spending in categories without a budget is kept separate. */
export function budgetTotals(lines: BudgetLine[]) {
  let budgetedCents = 0;
  let spentBudgetedCents = 0;
  let unbudgetedSpentCents = 0;
  for (const l of lines) {
    if (l.budgetCents === null) unbudgetedSpentCents += l.spentCents;
    else {
      budgetedCents += l.budgetCents;
      spentBudgetedCents += l.spentCents;
    }
  }
  return { budgetedCents, spentBudgetedCents, unbudgetedSpentCents, leftCents: budgetedCents - spentBudgetedCents };
}
