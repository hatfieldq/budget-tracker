// Transactions register: an always-open entry form at the top, then search +
// filters, newest first, with edit, duplicate and delete. The entry date is
// sticky (kept in sessionStorage) so a batch of back-dated entries keeps it. Filtering to one account shows that account's amounts and its
// running balance (in natural terms: cards/loans show amount owed).
import { useCallback, useEffect, useState } from 'react';
import {
  formatCents,
  ledgerToNatural,
  type PostingStatus,
  type Txn,
  type TxnFilters,
  type TxnInput,
} from '@ledger/shared';
import { api } from '../api';
import { useLookups, type Lookups } from '../lookups';
import { useScope } from '../scope';
import { TxnForm, today } from '../components/TxnForm';

const PAGE_SIZE = 100;
const DATE_KEY = 'ledger.entryDate';

/** Edit or Duplicate temporarily replaces the entry form; null = entry form. */
type FormState = { kind: 'edit'; txn: Txn } | { kind: 'duplicate'; txn: Txn } | null;

function loadEntryDate(): string {
  try {
    return sessionStorage.getItem(DATE_KEY) ?? today();
  } catch {
    return today();
  }
}

export function TransactionsPage({ params }: { params: URLSearchParams }) {
  const { scope, actingPersonId, personName, people } = useScope();
  const lookups = useLookups();

  const [filters, setFilters] = useState<TxnFilters>(() => ({
    accountId: params.get('accountId') ? Number(params.get('accountId')) : undefined,
    uncategorized: params.get('uncategorized') === '1',
  }));
  const [search, setSearch] = useState('');
  const [txns, setTxns] = useState<Txn[]>([]);
  const [total, setTotal] = useState(0);
  const [form, setForm] = useState<FormState>(null);
  const [entryDate, setEntryDate] = useState(loadEntryDate);
  const rememberDate = (d: string) => {
    setEntryDate(d);
    try {
      sessionStorage.setItem(DATE_KEY, d);
    } catch {
      /* storage unavailable: keep it in memory only */
    }
  };
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Debounce the search box so we don't query on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: search || undefined })), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (offset = 0) => {
      try {
        const page = await api.txns({ ...filters, scope, limit: PAGE_SIZE, offset });
        setTxns((prev) => (offset === 0 ? page.txns : [...prev, ...page.txns]));
        setTotal(page.total);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [filters, scope],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  async function save(input: TxnInput, id?: number) {
    if (id) await api.updateTxn(id, input);
    else await api.createTxn(input);
    if (id || form) setForm(null);
    await load(0);
  }

  async function remove(id: number) {
    try {
      await api.deleteTxn(id);
      setConfirmDelete(null);
      await load(0);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const setFilter = (patch: Partial<TxnFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const filteredAccount = lookups.accounts.find((a) => a.id === filters.accountId);
  const input = 'rounded border border-stone-300 bg-white px-2 py-1 text-sm';

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Transactions</h1>
          <p className="text-sm text-stone-500">
            {scope.type === 'household' ? 'Household' : `${personName(scope.personId)} (own and joint accounts)`} · {total} found
          </p>
        </div>
      </div>

      {(error || lookups.error) && <p className="text-sm text-red-600">{error ?? lookups.error}</p>}

      {actingPersonId !== null && lookups.accounts.length > 0 && (
        <TxnForm
          key={form ? `${form.kind}-${form.txn.id}` : 'entry'}
          lookups={lookups}
          actingPersonId={actingPersonId}
          editing={form?.kind === 'edit' ? form.txn : undefined}
          template={form?.kind === 'duplicate' ? form.txn : undefined}
          defaultAccountId={filters.accountId}
          entryDate={entryDate}
          onDateChange={rememberDate}
          onSubmit={save}
          onCancel={form ? () => setForm(null) : undefined}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 rounded border border-stone-200 bg-white p-2">
        <input className={`${input} w-48`} placeholder="Search payee or memo" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select
          aria-label="Account filter"
          className={input}
          value={filters.accountId ?? ''}
          onChange={(e) => setFilter({ accountId: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">All accounts</option>
          {lookups.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.archivedAt ? ' (archived)' : ''}
            </option>
          ))}
        </select>
        <select
          aria-label="Category filter"
          className={input}
          value={filters.categoryId ?? ''}
          onChange={(e) => setFilter({ categoryId: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">All categories</option>
          {lookups.categories
            .filter((c) => c.kind !== 'opening_equity' && c.kind !== 'valuation')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <input type="date" aria-label="From date" className={input} value={filters.from ?? ''} onChange={(e) => setFilter({ from: e.target.value || undefined })} />
        <span className="text-sm text-stone-400">to</span>
        <input type="date" aria-label="To date" className={input} value={filters.to ?? ''} onChange={(e) => setFilter({ to: e.target.value || undefined })} />
        <select
          aria-label="Status filter"
          className={input}
          value={filters.status ?? ''}
          onChange={(e) => setFilter({ status: (e.target.value || undefined) as PostingStatus | undefined })}
        >
          <option value="">Any status</option>
          <option value="uncleared">Uncleared</option>
          <option value="cleared">Cleared</option>
          <option value="reconciled">Reconciled</option>
        </select>
        <select
          aria-label="Entered by filter"
          className={input}
          value={filters.createdBy ?? ''}
          onChange={(e) => setFilter({ createdBy: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">Entered by anyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={!!filters.uncategorized} onChange={(e) => setFilter({ uncategorized: e.target.checked })} />
          Uncategorized only
        </label>
        <button
          className="ml-auto text-sm text-stone-500 hover:underline"
          onClick={() => {
            setSearch('');
            setFilters({});
          }}
        >
          Clear filters
        </button>
      </div>

      <div className="overflow-x-auto rounded border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-left text-stone-600">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Payee</th>
              <th className="px-3 py-2">Account</th>
              <th className="px-3 py-2">Category</th>
              <th className="money px-3 py-2">Amount</th>
              {filteredAccount && <th className="money px-3 py-2">{filteredAccount.type === 'credit_card' || filteredAccount.type === 'loan' ? 'Owed' : 'Balance'}</th>}
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <TxnRow
                key={t.id}
                txn={t}
                lookups={lookups}
                accountId={filters.accountId}
                confirming={confirmDelete === t.id}
                onEdit={() => {
                  setForm({ kind: 'edit', txn: t });
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                onDuplicate={() => {
                  setForm({ kind: 'duplicate', txn: t });
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                onAskDelete={() => setConfirmDelete(t.id)}
                onCancelDelete={() => setConfirmDelete(null)}
                onDelete={() => remove(t.id)}
              />
            ))}
            {txns.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-stone-500">
                  No transactions match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {txns.length < total && (
        <button className="rounded bg-stone-100 px-3 py-1.5 text-sm" onClick={() => load(txns.length)}>
          Load more ({total - txns.length} remaining)
        </button>
      )}
    </section>
  );
}

interface RowProps {
  txn: Txn;
  lookups: Lookups;
  accountId?: number;
  confirming: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}

function TxnRow({ txn, lookups, accountId, confirming, onEdit, onDuplicate, onAskDelete, onCancelDelete, onDelete }: RowProps) {
  const accountPostings = txn.postings.filter((p) => p.accountId !== null);
  const categoryPostings = txn.postings.filter((p) => p.categoryId !== null);
  const isSystem = txn.kind !== 'standard';

  // Account column: transfers read "From → To"; otherwise list the accounts.
  const accounts = txn.isTransfer
    ? [...accountPostings].sort((a, b) => a.amountCents - b.amountCents).map((p) => lookups.accountName(p.accountId)).join(' → ')
    : accountPostings.map((p) => lookups.accountName(p.accountId)).join(', ');

  const categories = txn.isTransfer
    ? 'Transfer'
    : txn.kind === 'opening'
      ? 'Opening balance'
      : (categoryPostings.length > 1 ? 'Split: ' : '') + categoryPostings.map((p) => lookups.categoryName(p.categoryId)).join(', ');

  // Amount: with an account filter, that account's in/out; otherwise net
  // movement across the txn's accounts (a transfer shows the amount moved).
  let amount: string;
  if (accountId !== undefined) {
    amount = formatCents(accountPostings.filter((p) => p.accountId === accountId).reduce((s, p) => s + p.amountCents, 0));
  } else if (txn.isTransfer) {
    amount = '↔ ' + formatCents(accountPostings.filter((p) => p.amountCents > 0).reduce((s, p) => s + p.amountCents, 0));
  } else {
    amount = formatCents(accountPostings.reduce((s, p) => s + p.amountCents, 0));
  }

  const filtered = lookups.accounts.find((a) => a.id === accountId);
  const statuses = accountPostings
    .filter((p) => accountId === undefined || p.accountId === accountId)
    .map((p) => p.status);
  const status = statuses.every((s) => s === 'reconciled') ? 'R' : statuses.every((s) => s !== 'uncleared') ? 'C' : '';

  return (
    <tr className={`border-t border-stone-100 align-top ${isSystem ? 'text-stone-500' : ''}`}>
      <td className="px-3 py-2 whitespace-nowrap">{txn.date}</td>
      <td className="px-3 py-2">
        {txn.payee}
        {txn.memo && <div className="text-xs text-stone-500">{txn.memo}</div>}
      </td>
      <td className="px-3 py-2">{accounts}</td>
      <td className="px-3 py-2">
        {txn.isUncategorized ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">{categories}</span> : categories}
      </td>
      <td className="money px-3 py-2">{amount}</td>
      {filtered && (
        <td className="money px-3 py-2">
          {txn.runningBalanceCents !== undefined ? formatCents(ledgerToNatural(filtered.type, txn.runningBalanceCents)) : ''}
        </td>
      )}
      <td className="px-3 py-2 text-center text-xs font-semibold text-stone-500" title={statuses.join(', ')}>
        {status}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {isSystem ? (
          <span className="text-xs">{txn.kind === 'opening' ? 'Edit in Accounts' : 'System'}</span>
        ) : confirming ? (
          <>
            <span className="mr-2 text-red-700">Delete?</span>
            <button className="text-red-700 hover:underline" onClick={onDelete}>
              Yes
            </button>
            <button className="ml-2 hover:underline" onClick={onCancelDelete}>
              No
            </button>
          </>
        ) : (
          <>
            <button className="text-stone-600 hover:underline" onClick={onEdit}>
              Edit
            </button>
            <button className="ml-3 text-stone-600 hover:underline" onClick={onDuplicate}>
              Duplicate
            </button>
            <button className="ml-3 text-stone-600 hover:text-red-700 hover:underline" onClick={onAskDelete}>
              Delete
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
