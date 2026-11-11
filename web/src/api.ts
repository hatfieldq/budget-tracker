// Thin wrapper around fetch for the local API. Every call goes to /api on the
// same origin; in dev, Vite proxies that to the server on 127.0.0.1:4317.
import type {
  Account,
  AccountInput,
  AccountUpdate,
  BudgetMonth,
  Category,
  CategoryInput,
  OverviewReport,
  PayeeHint,
  Person,
  ReconcileInput,
  ReconcileSummary,
  Reconciliation,
  Scope,
  Snapshot,
  SnapshotInput,
  StatusInput,
  Txn,
  TxnFilters,
  TxnInput,
  TxnPage,
  TodaySummary,
} from '@ledger/shared';
import { scopeToParam } from '@ledger/shared';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${method} ${url} failed (${res.status})`);
  return data as T;
}

export const api = {
  people: () => request<Person[]>('GET', '/api/people'),
  renamePerson: (id: number, displayName: string) =>
    request<Person>('PATCH', `/api/people/${id}`, { displayName }),

  categories: () => request<Category[]>('GET', '/api/categories'),
  createCategory: (input: CategoryInput) => request<Category>('POST', '/api/categories', input),
  updateCategory: (id: number, patch: Partial<CategoryInput>) =>
    request<Category>('PATCH', `/api/categories/${id}`, patch),
  archiveCategory: (id: number, archived: boolean) =>
    request<Category>('POST', `/api/categories/${id}/${archived ? 'archive' : 'unarchive'}`),

  accounts: (scope: Scope, includeArchived = false) =>
    request<Account[]>(
      'GET',
      `/api/accounts?scope=${scopeToParam(scope)}${includeArchived ? '&includeArchived=1' : ''}`,
    ),
  createAccount: (input: AccountInput) => request<Account>('POST', '/api/accounts', input),
  updateAccount: (id: number, patch: AccountUpdate) =>
    request<Account>('PATCH', `/api/accounts/${id}`, patch),
  /** One account, balance as of the end of `asOf` (default today). */
  account: (id: number, asOf?: string) =>
    request<Account>('GET', `/api/accounts/${id}${asOf ? `?asOf=${asOf}` : ''}`),
  archiveAccount: (id: number, archived: boolean) =>
    request<Account>('POST', `/api/accounts/${id}/${archived ? 'archive' : 'unarchive'}`),

  txns: (filters: TxnFilters) => request<TxnPage>('GET', `/api/txns?${txnQuery(filters)}`),
  createTxn: (input: TxnInput) => request<Txn>('POST', '/api/txns', input),
  updateTxn: (id: number, input: TxnInput) => request<Txn>('PUT', `/api/txns/${id}`, input),
  deleteTxn: (id: number) => request<void>('DELETE', `/api/txns/${id}`),
  setTxnStatus: (id: number, input: StatusInput) => request<Txn>('POST', `/api/txns/${id}/status`, input),

  reconcileSummary: (accountId: number, statementDate: string) =>
    request<ReconcileSummary>('GET', `/api/accounts/${accountId}/reconcile?statementDate=${statementDate}`),
  reconcile: (accountId: number, input: ReconcileInput) =>
    request<Reconciliation>('POST', `/api/accounts/${accountId}/reconciliations`, input),
  undoReconcile: (accountId: number) =>
    request<void>('DELETE', `/api/accounts/${accountId}/reconciliations/latest`),

  snapshots: (accountId: number) => request<Snapshot[]>('GET', `/api/accounts/${accountId}/snapshots`),
  createSnapshot: (accountId: number, input: SnapshotInput) =>
    request<Snapshot>('POST', `/api/accounts/${accountId}/snapshots`, input),
  updateSnapshot: (id: number, patch: Partial<SnapshotInput>) =>
    request<Snapshot>('PATCH', `/api/snapshots/${id}`, patch),
  deleteSnapshot: (id: number) => request<void>('DELETE', `/api/snapshots/${id}`),

  budgetMonth: (month: string, scope: Scope) =>
    request<BudgetMonth>('GET', `/api/budgets/${month}?scope=${scopeToParam(scope)}`),
  /** amountCents null clears the category's budget for that month. */
  setBudget: (month: string, categoryId: number, amountCents: number | null) =>
    request<void>('PUT', `/api/budgets/${month}/${categoryId}`, { amountCents }),
  copyBudget: (month: string) => request<{ copied: number }>('POST', `/api/budgets/${month}/copy-previous`),

  today: (scope: Scope) => request<TodaySummary>('GET', `/api/today?scope=${scopeToParam(scope)}`),
  payees: () => request<PayeeHint[]>('GET', '/api/payees'),

  overview: (scope: Scope, from: string, to: string) =>
    request<OverviewReport>('GET', `/api/reports/overview?scope=${scopeToParam(scope)}&from=${from}&to=${to}`),
};

/** TxnFilters -> query string, skipping empty values. */
export function txnQuery(f: TxnFilters): string {
  const params = new URLSearchParams();
  if (f.scope) params.set('scope', scopeToParam(f.scope));
  for (const key of ['accountId', 'categoryId', 'from', 'to', 'q', 'status', 'createdBy', 'limit', 'offset'] as const) {
    const v = f[key];
    if (v !== undefined && v !== '') params.set(key, String(v));
  }
  if (f.uncategorized) params.set('uncategorized', '1');
  if (f.unreconciled) params.set('unreconciled', '1');
  return params.toString();
}
