// Types shared by the server (API responses) and the web app (API calls).
// All money is integer cents in LEDGER sign: debit = positive, credit = negative.
// Convert to "natural" display terms with the helpers in money.ts.

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'credit_card',
  'loan',
  'brokerage',
  'retirement',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const LOAN_SUBTYPES = ['auto', 'student', 'mortgage', 'personal', 'other'] as const;
export const RETIREMENT_SUBTYPES = ['401k', 'roth_401k', 'roth_ira', 'traditional_ira', 'hsa', 'other'] as const;
export type LoanSubtype = (typeof LOAN_SUBTYPES)[number];
export type RetirementSubtype = (typeof RETIREMENT_SUBTYPES)[number];
export type AccountSubtype = LoanSubtype | RetirementSubtype;

/** Valid subtypes per account type. Types not listed here must have subtype null. */
export const SUBTYPES_BY_TYPE: Partial<Record<AccountType, readonly string[]>> = {
  loan: LOAN_SUBTYPES,
  retirement: RETIREMENT_SUBTYPES,
};

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
  loan: 'Loan',
  brokerage: 'Brokerage',
  retirement: 'Retirement',
};

export const SUBTYPE_LABELS: Record<string, string> = {
  auto: 'Auto',
  student: 'Student',
  mortgage: 'Mortgage',
  personal: 'Personal',
  other: 'Other',
  '401k': '401(k)',
  roth_401k: 'Roth 401(k)',
  roth_ira: 'Roth IRA',
  traditional_ira: 'Traditional IRA',
  hsa: 'HSA',
};

export function isLiability(type: AccountType): boolean {
  return type === 'credit_card' || type === 'loan';
}

export function isInvestment(type: AccountType): boolean {
  return type === 'brokerage' || type === 'retirement';
}

export const CATEGORY_KINDS = [
  'income',
  'expense',
  'tax',
  'opening_equity',
  'valuation',
  'uncategorized',
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export interface Person {
  id: number;
  displayName: string;
  archivedAt: string | null;
}

export interface Category {
  id: number;
  name: string;
  kind: CategoryKind;
  isSystem: boolean;
  archivedAt: string | null;
}

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  ownerIds: number[];
  isJoint: boolean;
  openingDate: string; // YYYY-MM-DD
  openingBalanceCents: number; // ledger sign
  balanceCents: number; // ledger sign, as of today
  archivedAt: string | null;
  /** Latest balance snapshot date (investment accounts), or null. */
  lastSnapshotDate: string | null;
  /** Statement date of the latest completed reconciliation, or null. */
  lastReconciledDate: string | null;
}

/** Body for POST /api/accounts. Money in ledger sign. */
export interface AccountInput {
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  ownerIds: number[];
  openingDate: string;
  openingBalanceCents: number;
  createdByPersonId: number;
}

/** Body for PATCH /api/accounts/:id. Type cannot change after creation. */
export type AccountUpdate = Partial<Omit<AccountInput, 'type'>>;

/** A report or list scope: one person (their own + joint accounts) or the whole household. */
export type Scope = { type: 'household' } | { type: 'person'; personId: number };

/** Query-string form: "household" or "person:3". */
export function scopeToParam(scope: Scope): string {
  return scope.type === 'household' ? 'household' : `person:${scope.personId}`;
}

// ---------- Ledger ----------

export type PostingStatus = 'uncleared' | 'cleared' | 'reconciled';
export type TxnKind = 'standard' | 'opening' | 'valuation';

/** A posting hits exactly one target: an account OR a category. */
export interface PostingInput {
  accountId: number | null;
  categoryId: number | null;
  amountCents: number; // ledger sign, nonzero
  memo?: string | null;
  /** Account postings only. 'reconciled' is set by the reconcile flow, never here. */
  status?: 'uncleared' | 'cleared';
}

/** Body for POST /api/txns and PUT /api/txns/:id. */
export interface TxnInput {
  date: string;
  payee?: string | null;
  memo?: string | null;
  postings: PostingInput[];
  createdByPersonId: number;
}

export interface Posting {
  id: number;
  accountId: number | null;
  categoryId: number | null;
  amountCents: number;
  memo: string | null;
  status: PostingStatus | null;
  reconciliationId: number | null;
}

export interface Txn {
  id: number;
  date: string;
  payee: string | null;
  memo: string | null;
  kind: TxnKind;
  createdByPersonId: number;
  createdAt: string;
  updatedAt: string;
  postings: Posting[];
  /** Only account postings: money moving between your own accounts. */
  isTransfer: boolean;
  /** Has any Uncategorized posting. */
  isUncategorized: boolean;
  /** Present when the list was filtered to one account: its balance after this txn. */
  runningBalanceCents?: number;
}

export interface TxnFilters {
  scope?: Scope;
  accountId?: number;
  categoryId?: number;
  from?: string;
  to?: string;
  q?: string;
  status?: PostingStatus;
  /** Only txns with an uncleared or cleared line (in accountId, if given). */
  unreconciled?: boolean;
  uncategorized?: boolean;
  createdBy?: number;
  limit?: number;
  offset?: number;
}

export interface TxnPage {
  txns: Txn[];
  total: number;
}

export interface CategoryInput {
  name: string;
  kind: 'income' | 'expense' | 'tax';
}

// ---------- Reconciliation and snapshots ----------

/** Checking, savings, cards and loans are reconciled against statements. */
export const RECONCILABLE_TYPES: readonly AccountType[] = ['checking', 'savings', 'credit_card', 'loan'];
/** Checking and savings get the statement-balance → interest helper (D17). */
export const INTEREST_HELPER_TYPES: readonly AccountType[] = ['checking', 'savings'];

/** Body for POST /api/txns/:id/status. Without accountId, every unreconciled account line changes. */
export interface StatusInput {
  status: 'uncleared' | 'cleared';
  accountId?: number;
}

export interface Reconciliation {
  id: number;
  accountId: number;
  statementDate: string;
  statementBalanceCents: number; // ledger sign
  completedByPersonId: number | null;
  completedAt: string;
  postingCount: number;
}

/** GET /api/accounts/:id/reconcile?statementDate=. All ledger sign. */
export interface ReconcileSummary {
  accountId: number;
  statementDate: string;
  /** Σ reconciled postings (incl. the opening balance). */
  reconciledCents: number;
  /** Σ cleared postings dated on or before statementDate. */
  clearedCents: number;
  clearedCount: number;
  /** Cleared postings dated after statementDate (not counted). */
  clearedAfterCount: number;
  last: Reconciliation | null;
}

/** Body for POST /api/accounts/:id/reconciliations. Balance in ledger sign. */
export interface ReconcileInput {
  statementDate: string;
  statementBalanceCents: number;
  personId: number;
}

export interface Snapshot {
  id: number;
  accountId: number;
  date: string;
  balanceCents: number;
  note: string | null;
  /** The valuation change this snapshot booked (0 when the ledger already matched). */
  valuationCents: number;
  createdByPersonId: number;
}

/** Body for POST /api/accounts/:id/snapshots (PATCH /api/snapshots/:id takes a partial). */
export interface SnapshotInput {
  date: string;
  balanceCents: number;
  note?: string | null;
  createdByPersonId: number;
}

// ---------- Today (Session 6) ----------

/** Investment types checked for stale values on Today. */
export const INVESTMENT_TYPES_FOR_TODAY: readonly AccountType[] = ['brokerage', 'retirement'];

export interface TodaySummary {
  today: string;
  review: {
    accountId: number;
    name: string;
    type: AccountType;
    unclearedCount: number;
    clearedCount: number;
    lastReconciledDate: string | null;
  }[];
  /** Every active investment account, most out of date first; `stale` = more than 7 days (AT-16). */
  stale: {
    accountId: number;
    name: string;
    lastValueDate: string | null;
    /** lastValueDate, or the opening date when there's no value update yet. */
    basisDate: string;
    days: number;
    stale: boolean;
  }[];
  uncategorized: { total: number; txns: Txn[] };
  budget: {
    month: string;
    hasBudget: boolean;
    budgetedCents: number;
    spentBudgetedCents: number;
    overCategories: string[];
  };
}

/** Quick-entry hint: a payee used before and the category used last time (if a single one). */
export interface PayeeHint {
  payee: string;
  lastDate: string;
  categoryId: number | null;
}
