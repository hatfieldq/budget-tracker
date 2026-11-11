// Overview report shape (PLAN §3) and period presets. Every amount here is in
// natural terms: income, taxes and spending positive; savings/investment
// flows positive = money in; debts positive = owed; valuation change positive =
// growth.
import type { AccountSubtype, AccountType, Scope } from './types';

export interface ReportScope {
  type: Scope['type'];
  personId?: number;
  label: string;
  /** Person scope that includes joint accounts at full value (D8). */
  includesJointAccounts: boolean;
}

export interface CategoryAmount {
  categoryId: number;
  name: string;
  cents: number;
  /** The Uncategorized line (D6), shown with a warning. */
  uncategorized?: boolean;
}

export interface CategorySection {
  totalCents: number;
  lines: CategoryAmount[];
}

/** Where an investment balance comes from (AT-8). */
export type ValuationBasis =
  | { kind: 'snapshot'; date: string; transfersSince: boolean }
  | { kind: 'opening'; date: string };

export interface NetWorthLine {
  accountId: number;
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  isJoint: boolean;
  archived: boolean;
  /** Ledger sign (liabilities negative); this is what net worth adds up. */
  balanceCents: number;
  /** Investment accounts only. */
  valuation: ValuationBasis | null;
}

export interface OverviewReport {
  scope: ReportScope;
  period: { from: string; to: string };
  income: CategorySection;
  taxes: CategorySection;
  spending: CategorySection;
  /** Gross income − taxes − spending. */
  netCents: number;
  uncategorized: { count: number; cents: number };
  savingsCents: number;
  investmentContributionsCents: number;
  valuationChangeCents: number;
  debts: { accountId: number; name: string; type: AccountType; subtype: AccountSubtype | null; owedCents: number }[];
  netWorth: {
    /** End of the day before `from`. */
    startCents: number;
    endCents: number;
    lines: NetWorthLine[];
  };
  /** Consistency identity (PLAN §3): change = net + valuation + openings (+ outside transfers). */
  identity: {
    changeCents: number;
    openingCents: number;
    /** Person scope only: money moved between this scope's accounts and others'. */
    outsideTransfersCents: number | null;
    balanced: boolean;
  };
}

export type PeriodPreset = 'this-month' | 'last-month' | 'ytd' | 'last-year';

export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'ytd', label: 'Year to date' },
  { id: 'last-year', label: 'Last year' },
];

/** Inclusive date range for a preset, relative to `today` (YYYY-MM-DD). */
export function presetRange(preset: PeriodPreset, today: string): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const lastDay = (yy: number, mm: number) =>
    `${yy}-${String(mm).padStart(2, '0')}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')}`;
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  switch (preset) {
    case 'this-month':
      return { from: first(y, m), to: lastDay(y, m) };
    case 'last-month': {
      const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return { from: first(py, pm), to: lastDay(py, pm) };
    }
    case 'ytd':
      return { from: `${y}-01-01`, to: today };
    case 'last-year':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  }
}

/** The day before a YYYY-MM-DD date. */
export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
