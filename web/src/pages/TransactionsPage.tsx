// Transactions register: an always-open entry form at the top, then search +
// filters, newest first, with edit, duplicate and delete. The entry date is
// sticky (kept in sessionStorage) so a batch of back-dated entries keeps it.
// Filtering to one account shows that account's amounts and its running
// balance (in natural terms: cards/loans show amount owed). The status column
// toggles cleared. With ?reconcile=1 the register switches to reconcile mode:
// only unreconciled items through the statement date, with a tick column.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RECONCILABLE_TYPES,
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
import { ReconcileBar, type StatementFields } from '../components/ReconcileBar';
import { href } from '../router';

const PAGE_SIZE = 100;
const DATE_KEY = 'ledger.entryDate';
const statementKey = (accountId: number) => `ledger.reconcile.${accountId}`;

function loadStatement(accountId: number | undefined): StatementFields {
  try {
    const raw = accountId === undefined ? null : localStorage.getItem(statementKey(accountId));
    if (raw) return JSON.parse(raw) as StatementFields;
  } catch {
    /* ignore */
  }
  return { date: today(), balance: '' };
}

function saveStatement(accountId: number, s: StatementFields | null) {
  try {
    if (s) localStorage.setItem(statementKey(accountId), JSON.stringify(s));
    else localStorage.removeItem(statementKey(accountId));
  } catch {
    /* storage unavailable: keep it in memory only */
  }
}

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
    categoryId: params.get('categoryId') ? Number(params.get('categoryId')) : undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
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

  // Reconcile mode (needs the account to be loaded and reconcilable).
  const filteredAccount = lookups.accounts.find((a) => a.id === filters.accountId);
  const reconciling =
    params.get('reconcile') === '1' && !!filteredAccount && RECONCILABLE_TYPES.includes(filteredAccount.type);
  const [statement, setStatementState] = useState(() => loadStatement(filters.accountId));
  const [summaryVersion, setSummaryVersion] = useState(0);
  const justReconciled = params.get('reconciled');
  const setStatement = (s: StatementFields) => {
    setStatementState(s);
    if (filters.accountId !== undefined) saveStatement(filters.accountId, s);
  };

  // Debounce the search box so we don't query on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: search || undefined })), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Only the latest request may update the list (filters can change mid-flight).
  const requestSeq = useRef(0);
  const load = useCallback(
    async (offset = 0) => {
      const seq = ++requestSeq.current;
      try {
        const page = await api.txns(
          reconciling
            ? { accountId: filters.accountId, unreconciled: true, to: statement.date || undefined, limit: 1000 }
            : { ...filters, scope, limit: PAGE_SIZE, offset },
        );
        if (seq !== requestSeq.current) return;
        setTxns((prev) => (offset === 0 ? page.txns : [...prev, ...page.txns]));
        setTotal(page.total);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [filters, scope, reconciling, statement.date],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  async function save(input: TxnInput, id?: number) {
    if (id) await api.updateTxn(id, input);
    else await api.createTxn(input);
    if (id || form) setForm(null);
    await load(0);
    setSummaryVersion((v) => v + 1);
  }

  /** Toggle cleared on this txn's lines (only the filtered account's, when filtered). */
  async function toggleCleared(t: Txn, cleared: boolean) {
    try {
      const updated = await api.setTxnStatus(t.id, {
        status: cleared ? 'cleared' : 'uncleared',
        accountId: filters.accountId,
      });
      setTxns((ts) => ts.map((x) => (x.id === t.id ? { ...updated, runningBalanceCents: x.runningBalanceCents } : x)));
      setSummaryVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
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

      {justReconciled && !reconciling && (
        <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800" role="status">
          Reconciled through {justReconciled}. Those items are now locked (R).
        </p>
      )}

      {reconciling && filteredAccount && (
        <ReconcileBar
          account={filteredAccount}
          statement={statement}
          onStatementChange={setStatement}
          version={summaryVersion}
          actingPersonId={actingPersonId}
          onFinished={(date) => {
            saveStatement(filteredAccount.id, null);
            window.location.hash = href('transactions', { accountId: filteredAccount.id, reconciled: date });
          }}
          onUndone={() => {
            load(0);
            setSummaryVersion((v) => v + 1);
          }}
          onExit={() => {
            window.location.hash = href('transactions', { accountId: filteredAccount.id });
          }}
        />
      )}

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

      {!reconciling && (
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
      )}

      <div className="overflow-x-auto rounded border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-left text-stone-600">
            <tr>
              {reconciling && <th className="px-3 py-2" title="On the statement">✓</th>}
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
                reconciling={reconciling}
                onToggleCleared={(cleared) => toggleCleared(t, cleared)}
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
                <td colSpan={9} className="px-3 py-6 text-center text-stone-500">
                  {reconciling ? `Nothing left to reconcile through ${statement.date}.` : 'No transactions match.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!reconciling && txns.length < total && (
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
  reconciling: boolean;
  onToggleCleared: (cleared: boolean) => void;
  confirming: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}

function TxnRow(props: RowProps) {
  const { txn, lookups, accountId, reconciling, onToggleCleared, confirming } = props;
  const { onEdit, onDuplicate, onAskDelete, onCancelDelete, onDelete } = props;
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
  // Cleared can be toggled on standard txns until every relevant line is reconciled.
  const toggleable = !isSystem && status !== 'R';
  const cleared = status !== '';
  const statusTitle = status === 'R' ? 'Reconciled (locked)' : cleared ? 'Cleared: click to un-clear' : 'Uncleared: click to mark cleared';

  return (
    <tr className={`border-t border-stone-100 align-top ${isSystem ? 'text-stone-500' : ''} ${reconciling && cleared ? 'bg-green-50' : ''}`}>
      {reconciling && (
        <td className="px-3 py-2">
          <input
            type="checkbox"
            aria-label={`On statement: ${txn.payee ?? txn.date}`}
            checked={cleared}
            disabled={!toggleable}
            onChange={(e) => onToggleCleared(e.target.checked)}
          />
        </td>
      )}
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
      <td className="px-3 py-2 text-center text-xs font-semibold text-stone-500">
        {toggleable ? (
          <button
            className={`h-6 w-6 rounded border ${cleared ? 'border-green-600 bg-green-50 text-green-700' : 'border-stone-300 text-stone-300 hover:border-stone-500'}`}
            title={statusTitle}
            aria-label={statusTitle}
            onClick={() => onToggleCleared(!cleared)}
          >
            C
          </button>
        ) : (
          <span title={isSystem ? 'System entry' : statusTitle}>{status}</span>
        )}
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
