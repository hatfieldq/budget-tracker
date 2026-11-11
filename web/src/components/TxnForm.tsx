// Create / edit / duplicate a transaction. Three modes:
//   Spend/Receive - one account + one category (empty category = Uncategorized)
//   Transfer      - from one account to another
//   Split         - any number of lines (paychecks, loan payments, mixed purchases)
// Amounts are always typed as positive numbers with a direction; the pure
// helpers in @ledger/shared/entry.ts turn that into signed ledger postings.
// For new entries the form stays open after saving: it clears payee, memo,
// amounts and category but keeps the date, mode and accounts for the next one.
import { useId, useRef, useState, type FormEvent } from 'react';
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  carryStatuses,
  entryToPostings,
  formatCents,
  lineCents,
  parseMoney,
  txnToEntry,
  type Entry,
  type PayeeHint,
  type SplitLine,
  type Txn,
  type TxnInput,
} from '@ledger/shared';
import type { Lookups } from '../lookups';

type Mode = Entry['mode'];

interface LineState {
  target: string; // "a:3" account, "c:5" category, "c:" Uncategorized
  direction: 'in' | 'out';
  amount: string;
  memo: string;
}

interface Props {
  lookups: Lookups;
  actingPersonId: number;
  /** Edit this txn (PUT). */
  editing?: Txn;
  /** Prefill from this txn but create a new one (Duplicate). */
  template?: Txn;
  defaultAccountId?: number;
  /** Date for new entries (sticky across entries); reported back via onDateChange. */
  entryDate?: string;
  onDateChange?: (date: string) => void;
  onSubmit: (input: TxnInput, id?: number) => Promise<void>;
  /** Omitted for the always-open entry form, which shows "Clear" instead. */
  onCancel?: () => void;
  /** Payees used before: suggested while typing; a match fills in its last category. */
  payees?: PayeeHint[];
}

export const today = () => new Date().toLocaleDateString('en-CA');
const toAmount = (cents: number) => (cents / 100).toFixed(2);
const blankLine = (): LineState => ({ target: '', direction: 'out', amount: '', memo: '' });

function targetKey(t: SplitLine['target']): string {
  return t.kind === 'account' ? `a:${t.id}` : `c:${t.id ?? ''}`;
}

function parseTarget(key: string): SplitLine['target'] | null {
  const [kind, id] = key.split(':');
  if (kind === 'a' && id) return { kind: 'account', id: Number(id) };
  if (kind === 'c') return { kind: 'category', id: id ? Number(id) : null };
  return null;
}

export function TxnForm(props: Props) {
  const { lookups, actingPersonId, editing, template, defaultAccountId, entryDate, onDateChange, onSubmit, onCancel, payees = [] } = props;
  const payeeListId = useId();
  const source = editing ?? template;
  const initial = source ? txnToEntry(source) : null;
  const firstAccount = defaultAccountId ?? lookups.accounts.find((a) => !a.archivedAt)?.id ?? 0;

  const [mode, setMode] = useState<Mode>(initial?.mode ?? 'simple');
  const [date, setDateState] = useState(editing?.date ?? entryDate ?? today());
  const setDate = (d: string) => {
    setDateState(d);
    if (!editing && d) onDateChange?.(d);
  };
  const payeeRef = useRef<HTMLInputElement>(null);
  const [payee, setPayee] = useState(source?.payee ?? '');
  const [memo, setMemo] = useState(source?.memo ?? '');

  // simple
  const [direction, setDirection] = useState<'out' | 'in'>(initial?.mode === 'simple' ? initial.direction : 'out');
  const [accountId, setAccountId] = useState(initial?.mode === 'simple' ? initial.accountId : firstAccount);
  const [categoryId, setCategoryId] = useState<string>(
    initial?.mode === 'simple' && initial.categoryId !== lookups.uncategorizedId ? String(initial.categoryId ?? '') : '',
  );
  // transfer
  const [fromId, setFromId] = useState(initial?.mode === 'transfer' ? initial.fromAccountId : firstAccount);
  const [toId, setToId] = useState(initial?.mode === 'transfer' ? initial.toAccountId : 0);
  // simple + transfer share one amount box
  const [amount, setAmount] = useState(
    initial && initial.mode !== 'split' ? toAmount(initial.amountCents) : '',
  );
  // split
  const [lines, setLines] = useState<LineState[]>(
    initial?.mode === 'split'
      ? initial.lines.map((l) => ({
          target: l.target.kind === 'category' && l.target.id === lookups.uncategorizedId ? 'c:' : targetKey(l.target),
          direction: l.direction,
          amount: toAmount(l.amountCents),
          memo: l.memo ?? '',
        }))
      : [blankLine(), blankLine()],
  );

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  /**
   * Typing a known payee (exact, case-insensitive) in Spend/Receive with no
   * category chosen yet fills in the category used last time, and the matching
   * direction (income -> Money in, expense -> Money out). Never overrides a choice.
   */
  function changePayee(value: string) {
    setPayee(value);
    setAdded(null);
    if (mode !== 'simple' || editing || categoryId !== '') return;
    const hint = payees.find((p) => p.payee.toLowerCase() === value.trim().toLowerCase());
    const category = hint?.categoryId ? lookups.categories.find((c) => c.id === hint.categoryId) : undefined;
    if (!category || category.archivedAt || category.kind === 'uncategorized') return;
    setCategoryId(String(category.id));
    if (category.kind === 'income') setDirection('in');
    else if (category.kind === 'expense') setDirection('out');
  }

  /** Clear what changes per transaction; keep date, mode, direction and accounts. */
  function clearForNext() {
    setPayee('');
    setMemo('');
    setAmount('');
    setCategoryId('');
    setLines([blankLine(), blankLine()]);
    setError(null);
    payeeRef.current?.focus();
  }

  // ---- split helpers ----
  const parsedLines = lines.map((l) => {
    const target = parseTarget(l.target);
    const cents = l.amount.trim() === '' ? 0 : parseMoney(l.amount);
    return target && cents !== null && cents >= 0 ? { target, direction: l.direction, amountCents: cents, memo: l.memo } : null;
  });
  const imbalance = parsedLines.reduce((s, l) => s + (l ? lineCents(l) : 0), 0);

  function updateLine(i: number, patch: Partial<LineState>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  /** Set the last line's amount and direction so the split balances. */
  function balanceLastLine() {
    const last = lines.length - 1;
    const rest = parsedLines.reduce((s, l, i) => s + (i !== last && l ? lineCents(l) : 0), 0);
    const target = parseTarget(lines[last].target);
    if (!target || rest === 0) return;
    const need = -rest; // what the last line's ledger amount must be
    const debit = need > 0;
    const dir: 'in' | 'out' = target.kind === 'account' ? (debit ? 'in' : 'out') : debit ? 'out' : 'in';
    updateLine(last, { direction: dir, amount: toAmount(Math.abs(need)) });
  }

  /** Switching to Split carries the current simple/transfer values over as lines. */
  function changeMode(next: Mode) {
    const cents = parseMoney(amount);
    if (next === 'split' && mode !== 'split' && cents && cents > 0) {
      if (mode === 'simple') {
        setLines([
          { target: `a:${accountId}`, direction: direction === 'out' ? 'out' : 'in', amount, memo: '' },
          { target: `c:${categoryId}`, direction: direction === 'out' ? 'out' : 'in', amount, memo: '' },
        ]);
      } else {
        setLines([
          { target: `a:${fromId}`, direction: 'out', amount, memo: '' },
          { target: `a:${toId}`, direction: 'in', amount, memo: '' },
        ]);
      }
    }
    setMode(next);
  }

  function buildEntry(): Entry | string {
    if (mode === 'split') {
      if (parsedLines.some((l, i) => !l && (lines[i].amount.trim() || lines[i].target))) {
        return 'Each split line needs an account or category and a valid amount';
      }
      const valid = parsedLines.filter((l): l is NonNullable<typeof l> => !!l && l.amountCents > 0);
      if (valid.length < 2) return 'A split needs at least two lines with amounts';
      if (imbalance !== 0) return `Split doesn't balance: ${formatCents(Math.abs(imbalance))} left over`;
      return { mode: 'split', lines: valid };
    }
    const cents = parseMoney(amount);
    if (cents === null || cents <= 0) return 'Enter a positive amount like 12.34';
    if (mode === 'simple') {
      if (!accountId) return 'Choose an account';
      return { mode, direction, accountId, categoryId: categoryId ? Number(categoryId) : null, amountCents: cents };
    }
    if (!fromId || !toId) return 'Choose both accounts';
    if (fromId === toId) return 'From and To must be different accounts';
    return { mode, fromAccountId: fromId, toAccountId: toId, amountCents: cents };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const entry = buildEntry();
    if (typeof entry === 'string') return setError(entry);
    if (lookups.uncategorizedId === null) return setError('Categories not loaded yet');
    let postings = entryToPostings(entry, lookups.uncategorizedId);
    if (editing) postings = carryStatuses(postings, editing.postings);
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ date, payee: payee || null, memo: memo || null, postings, createdByPersonId: actingPersonId }, editing?.id);
      if (!editing) {
        setAdded(`Added ${payee || 'transaction'} on ${date}`);
        clearForNext();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // ---- pickers ----
  const selectedAccountIds = new Set(source?.postings.map((p) => p.accountId) ?? []);
  const pickableAccounts = lookups.accounts.filter((a) => !a.archivedAt || selectedAccountIds.has(a.id));
  const selectedCategoryIds = new Set(source?.postings.map((p) => p.categoryId) ?? []);
  const pickableCategories = lookups.categories.filter(
    (c) => !c.isSystem && (!c.archivedAt || selectedCategoryIds.has(c.id)),
  );

  const accountOptions = ACCOUNT_TYPES.map((type) => {
    const group = pickableAccounts.filter((a) => a.type === type);
    return group.length === 0 ? null : (
      <optgroup key={type} label={ACCOUNT_TYPE_LABELS[type]}>
        {group.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </optgroup>
    );
  });

  const categoryGroups = (['expense', 'income', 'tax'] as const).map((kind) => ({
    kind,
    label: { expense: 'Expenses', income: 'Income', tax: 'Taxes' }[kind],
    items: pickableCategories.filter((c) => c.kind === kind),
  }));

  const input = 'rounded border border-stone-300 bg-white px-2 py-1';
  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => changeMode(m)}
      className={`rounded px-3 py-1 text-sm ${mode === m ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-700'}`}
    >
      {label}
    </button>
  );

  return (
    <form onSubmit={submit} className="space-y-3 rounded border border-stone-300 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{editing ? 'Edit transaction' : template ? 'Duplicate transaction' : 'New transaction'}</h2>
        <div className="flex gap-1">
          {tab('simple', 'Spend / Receive')}
          {tab('transfer', 'Transfer')}
          {tab('split', 'Split')}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_1fr]">
        <div className="text-sm">
          <div className="flex justify-between">
            <label htmlFor="txn-date">Date</label>
            {date !== today() && (
              <button type="button" className="text-xs text-stone-500 hover:underline" onClick={() => setDate(today())}>
                Today
              </button>
            )}
          </div>
          <input id="txn-date" type="date" className={`${input} w-full`} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <label className="block text-sm">
          Payee
          <input ref={payeeRef} className={`${input} w-full`} list={payeeListId} autoComplete="off" value={payee} onChange={(e) => changePayee(e.target.value)} />
          <datalist id={payeeListId}>
            {payees.map((p) => (
              <option key={p.payee} value={p.payee} />
            ))}
          </datalist>
        </label>
        <label className="block text-sm">
          Memo
          <input className={`${input} w-full`} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
      </div>

      {mode === 'simple' && (
        <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_9rem] sm:items-end">
          <div className="flex overflow-hidden rounded border border-stone-300 text-sm" role="group" aria-label="Direction">
            {(['out', 'in'] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={direction === d}
                onClick={() => setDirection(d)}
                className={`px-3 py-1 ${direction === d ? (d === 'out' ? 'bg-red-600 text-white' : 'bg-green-700 text-white') : 'bg-white'}`}
              >
                {d === 'out' ? 'Money out' : 'Money in'}
              </button>
            ))}
          </div>
          <label className="block text-sm">
            Account
            <select className={`${input} w-full`} value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
              <option value={0} disabled>
                Choose…
              </option>
              {accountOptions}
            </select>
          </label>
          <label className="block text-sm">
            Category
            <select className={`${input} w-full`} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Uncategorized</option>
              {categoryGroups.map((g) =>
                g.items.length ? (
                  <optgroup key={g.kind} label={g.label}>
                    {g.items.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null,
              )}
            </select>
          </label>
          <label className="block text-sm">
            Amount
            <input className={`${input} money w-full`} inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
        </div>
      )}

      {mode === 'transfer' && (
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem]">
          <label className="block text-sm">
            From
            <select className={`${input} w-full`} value={fromId} onChange={(e) => setFromId(Number(e.target.value))}>
              <option value={0} disabled>
                Choose…
              </option>
              {accountOptions}
            </select>
          </label>
          <label className="block text-sm">
            To
            <select className={`${input} w-full`} value={toId} onChange={(e) => setToId(Number(e.target.value))}>
              <option value={0} disabled>
                Choose…
              </option>
              {accountOptions}
            </select>
          </label>
          <label className="block text-sm">
            Amount
            <input className={`${input} money w-full`} inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <p className="text-xs text-stone-500 sm:col-span-3">
            Card or loan payment from checking: From = checking, To = the card/loan. Loan payment with interest? Use Split.
          </p>
        </div>
      )}

      {mode === 'split' && (
        <div className="space-y-2">
          {lines.map((l, i) => {
            const target = parseTarget(l.target);
            const isAccount = target?.kind === 'account';
            const labels = isAccount ? { in: 'Into', out: 'Out of' } : { in: 'Received', out: 'Spent' };
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_auto_8rem_1fr_auto] sm:items-center">
                <select aria-label={`Line ${i + 1} target`} className={input} value={l.target} onChange={(e) => updateLine(i, { target: e.target.value })}>
                  <option value="" disabled>
                    Account or category…
                  </option>
                  {ACCOUNT_TYPES.map((type) => {
                    const group = pickableAccounts.filter((a) => a.type === type);
                    return group.length ? (
                      <optgroup key={type} label={`Account: ${ACCOUNT_TYPE_LABELS[type]}`}>
                        {group.map((a) => (
                          <option key={a.id} value={`a:${a.id}`}>
                            {a.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null;
                  })}
                  {categoryGroups.map((g) =>
                    g.items.length ? (
                      <optgroup key={g.kind} label={`Category: ${g.label}`}>
                        {g.items.map((c) => (
                          <option key={c.id} value={`c:${c.id}`}>
                            {c.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null,
                  )}
                  <option value="c:">Uncategorized</option>
                </select>
                <div className="flex overflow-hidden rounded border border-stone-300 text-xs" role="group" aria-label={`Line ${i + 1} direction`}>
                  {(['out', 'in'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={l.direction === d}
                      onClick={() => updateLine(i, { direction: d })}
                      className={`w-16 px-2 py-1 ${l.direction === d ? 'bg-stone-800 text-white' : 'bg-white'}`}
                    >
                      {labels[d]}
                    </button>
                  ))}
                </div>
                <input
                  aria-label={`Line ${i + 1} amount`}
                  className={`${input} money`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={l.amount}
                  onChange={(e) => updateLine(i, { amount: e.target.value })}
                />
                <input
                  aria-label={`Line ${i + 1} memo`}
                  className={input}
                  placeholder="Line memo"
                  value={l.memo}
                  onChange={(e) => updateLine(i, { memo: e.target.value })}
                />
                <button
                  type="button"
                  className="text-sm text-stone-500 hover:text-red-600 disabled:opacity-30"
                  disabled={lines.length <= 2}
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  aria-label={`Remove line ${i + 1}`}
                >
                  ✕
                </button>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button type="button" className="rounded bg-stone-100 px-2 py-1" onClick={() => setLines((ls) => [...ls, blankLine()])}>
              + Line
            </button>
            <button type="button" className="rounded bg-stone-100 px-2 py-1" onClick={balanceLastLine}>
              Balance last line
            </button>
            <span className={imbalance === 0 ? 'text-green-700' : 'text-amber-700'}>
              {imbalance === 0 ? 'Balanced' : `Off by ${formatCents(Math.abs(imbalance))}`}
            </span>
          </div>
          <p className="text-xs text-stone-500">
            Paycheck: Salary <em>Received</em> (gross), each tax <em>Spent</em>, 401(k) <em>Into</em>, checking <em>Into</em> (net).
            Loan payment: checking <em>Out of</em>, loan <em>Into</em> (principal), Interest Expense <em>Spent</em>.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={saving} className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {editing ? 'Save' : 'Add transaction'}
        </button>
        <button type="button" onClick={onCancel ?? clearForNext} className="rounded px-3 py-1.5 text-sm">
          {onCancel ? 'Cancel' : 'Clear'}
        </button>
        {added && <span className="text-sm text-green-700" role="status">{added}</span>}
      </div>
    </form>
  );
}
