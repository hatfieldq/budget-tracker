// "Update balance" for checking/savings (D17): type the statement balance for a
// date; the app compares it with its own balance on that date. If the bank
// shows more, it offers to book exactly the difference as interest (a normal,
// editable transaction). If the bank shows less, it only warns, so a missing
// transaction gets found rather than plugged.
import { useEffect, useState, type FormEvent } from 'react';
import {
  compareStatement,
  formatCents,
  interestPostings,
  parseMoney,
  type Account,
  type BalanceCheck,
  type Category,
} from '@ledger/shared';
import { api } from '../api';
import { today } from './TxnForm';

interface Props {
  account: Account;
  actingPersonId: number;
  onChanged: () => void;
  onClose: () => void;
}

const input = 'rounded border border-stone-300 bg-white px-2 py-1';

export function BalanceUpdatePanel({ account, actingPersonId, onChanged, onClose }: Props) {
  const [date, setDate] = useState(today());
  const [statement, setStatement] = useState('');
  const [result, setResult] = useState<{ ledgerCents: number; check: BalanceCheck } | null>(null);
  const [incomeCategories, setIncomeCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<number>(0);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .categories()
      .then((cs) => {
        const income = cs.filter((c) => c.kind === 'income' && !c.archivedAt);
        setIncomeCategories(income);
        setCategoryId((income.find((c) => /interest/i.test(c.name)) ?? income[0])?.id ?? 0);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  // Any edit to the inputs invalidates the last comparison.
  useEffect(() => setResult(null), [date, statement]);

  async function check(e: FormEvent) {
    e.preventDefault();
    setDone(null);
    const cents = parseMoney(statement);
    if (cents === null) return setError('Enter the statement balance like 12049.50');
    if (date < account.openingDate) return setError(`${account.name} opened on ${account.openingDate}`);
    try {
      const a = await api.account(account.id, date);
      setResult({ ledgerCents: a.balanceCents, check: compareStatement(a.balanceCents, cents) });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function bookInterest(cents: number) {
    if (!categoryId) return setError('Add an income category for interest first');
    try {
      await api.createTxn({
        date,
        payee: 'Interest',
        postings: interestPostings(account.id, categoryId, cents),
        createdByPersonId: actingPersonId,
      });
      setDone(`Booked ${formatCents(cents)} interest on ${date}.`);
      setResult(null);
      setStatement('');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-3 rounded border border-stone-300 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Update balance: {account.name}</h2>
        <button className="text-sm text-stone-500 hover:underline" onClick={onClose}>
          Close
        </button>
      </div>
      <form onSubmit={check} className="flex flex-wrap items-end gap-2 text-sm">
        <label className="block">
          Statement date
          <input type="date" className={`${input} block`} value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block">
          Balance the bank shows
          <input className={`${input} money block w-40`} inputMode="decimal" placeholder="0.00" value={statement} onChange={(e) => setStatement(e.target.value)} />
        </label>
        <button className="rounded bg-stone-900 px-3 py-1.5 text-white">Compare</button>
      </form>

      {result && (
        <div className="space-y-2 rounded bg-stone-50 p-3 text-sm" role="status">
          <p>
            App balance at end of {date}: <span className="money">{formatCents(result.ledgerCents)}</span>
          </p>
          {result.check.kind === 'match' && <p className="text-green-700">Matches the bank. Nothing to book.</p>}
          {result.check.kind === 'shortfall' && (
            <p className="text-amber-800">
              The bank shows {formatCents(result.check.cents)} less than the app. Look for a missing withdrawal or fee
              on or before {date} and enter it as a normal transaction.
            </p>
          )}
          {result.check.kind === 'interest' && (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                The bank shows <strong className="money">{formatCents(result.check.cents)}</strong> more. Book it as
              </span>
              <select aria-label="Interest category" className={input} value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}>
                {incomeCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button className="rounded bg-green-700 px-3 py-1 text-white" onClick={() => bookInterest((result.check as { cents: number }).cents)}>
                Book {formatCents(result.check.cents)} interest
              </button>
            </div>
          )}
        </div>
      )}
      {done && <p className="text-sm text-green-700">{done}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
