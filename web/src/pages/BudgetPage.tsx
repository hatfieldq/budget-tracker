// Monthly budget (D31–D33): type a budget next to any expense category; each
// row shows what's been spent this month against it, green while at or under,
// red once over. Each month starts blank; "Copy last month" fills the blanks.
// Spending follows the "Viewing as" scope and refreshes whenever this tab
// regains focus, so entries made on Transactions show up straight away.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addMonths,
  budgetStatus,
  budgetTotals,
  formatCents,
  isValidMonth,
  monthBounds,
  parseMoney,
  type BudgetLine,
  type BudgetMonth,
} from '@ledger/shared';
import { api } from '../api';
import { href } from '../router';
import { useScope } from '../scope';
import { today } from '../components/TxnForm';

const thisMonth = () => today().slice(0, 7);
const toAmount = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));
const monthName = (m: string) =>
  new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

const STATUS_TEXT = { over: 'text-red-700', under: 'text-green-700', none: 'text-stone-500' } as const;
const STATUS_BAR = { over: 'bg-red-600', under: 'bg-green-600', none: 'bg-stone-300' } as const;

export function BudgetPage({ params }: { params: URLSearchParams }) {
  const { scope } = useScope();
  const requested = params.get('month');
  const month = isValidMonth(requested) ? requested : thisMonth();
  const [data, setData] = useState<BudgetMonth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await api.budgetMonth(month, scope);
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    }
  }, [month, scope]);

  useEffect(() => {
    reload();
    const onFocus = () => document.visibilityState === 'visible' && reload();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [reload]);

  const go = (m: string) => {
    window.location.hash = href('budget', { month: m });
  };

  async function save(categoryId: number, cents: number | null) {
    try {
      await api.setBudget(month, categoryId, cents);
      await reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function copyLastMonth() {
    try {
      await api.copyBudget(month);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const lines = data?.lines ?? [];
  const totals = budgetTotals(lines);
  const overall = budgetStatus(totals.budgetedCents, totals.spentBudgetedCents);
  const hasBudgets = lines.some((l) => l.budgetCents !== null);
  const blanks = lines.filter((l) => l.budgetCents === null && !l.archived).length;
  const { from, to } = monthBounds(month);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Budget: {monthName(month)}</h1>
        <div className="flex items-center gap-1 text-sm">
          <button className="rounded px-2 py-1 hover:bg-stone-200" aria-label="Previous month" onClick={() => go(addMonths(month, -1))}>
            ‹
          </button>
          <input
            type="month"
            aria-label="Month"
            className="rounded border border-stone-300 bg-white px-2 py-1"
            value={month}
            onChange={(e) => isValidMonth(e.target.value) && go(e.target.value)}
          />
          <button className="rounded px-2 py-1 hover:bg-stone-200" aria-label="Next month" onClick={() => go(addMonths(month, 1))}>
            ›
          </button>
          {month !== thisMonth() && (
            <button className="ml-1 text-stone-600 hover:underline" onClick={() => go(thisMonth())}>
              This month
            </button>
          )}
        </div>
      </div>

      {data && (
        <p className="text-xs text-stone-500">
          {scope.type === 'household'
            ? 'Spending from every household account.'
            : `Spending from ${data.scopeLabel}'s accounts${data.includesJointAccounts ? ', including joint accounts at full value' : ''}. Budget amounts are shared by the household.`}
        </p>
      )}

      {hasBudgets && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Budgeted" value={formatCents(totals.budgetedCents)} />
          <Stat label="Spent" value={formatCents(totals.spentBudgetedCents)} />
          <Stat
            label={overall === 'over' ? 'Over budget' : 'Left to spend'}
            value={formatCents(Math.abs(totals.leftCents))}
            className={STATUS_TEXT[overall]}
          />
        </div>
      )}

      {data && blanks > 0 && data.previousMonthBudgetCount > 0 && (
        <button className="rounded border border-stone-300 bg-white px-3 py-1.5 text-sm hover:bg-stone-50" onClick={copyLastMonth}>
          Copy last month's budget{hasBudgets ? ' into the blank categories' : ''}
        </button>
      )}
      {data && !hasBudgets && data.previousMonthBudgetCount === 0 && (
        <p className="text-sm text-stone-600">Type an amount next to a category to start this month's budget.</p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto rounded border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-left text-stone-600">
            <tr>
              <th className="px-3 py-2">Category</th>
              <th className="money px-3 py-2">Budget</th>
              <th className="money px-3 py-2">Spent</th>
              <th className="money px-3 py-2">Left</th>
              <th className="w-1/4 px-3 py-2">
                <span className="sr-only">Progress</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <Row key={`${month}-${l.categoryId}`} line={l} txnsHref={href('transactions', { categoryId: l.categoryId, from, to })} onSave={(c) => save(l.categoryId, c)} />
            ))}
          </tbody>
        </table>
      </div>

      {data && (totals.unbudgetedSpentCents !== 0 || data.uncategorized.count > 0) && (
        <div className="space-y-1 text-sm text-stone-600">
          {totals.unbudgetedSpentCents !== 0 && hasBudgets && (
            <p>
              <span className="money">{formatCents(totals.unbudgetedSpentCents)}</span> spent in categories without a budget.
            </p>
          )}
          {data.uncategorized.count > 0 && (
            <p className="text-amber-800">
              <span className="money">{formatCents(data.uncategorized.cents)}</span> spent in {data.uncategorized.count} uncategorized
              transaction{data.uncategorized.count === 1 ? '' : 's'} isn't counted against any budget.{' '}
              <a className="underline" href={href('transactions', { uncategorized: 1, from, to })}>
                Categorize
              </a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded border border-stone-200 bg-white px-4 py-3">
      <div className="text-xs text-stone-500">{label}</div>
      <div className={`money text-left text-lg font-semibold ${className}`}>{value}</div>
    </div>
  );
}

function Row({ line, txnsHref, onSave }: { line: BudgetLine; txnsHref: string; onSave: (cents: number | null) => Promise<boolean> }) {
  const status = budgetStatus(line.budgetCents, line.spentCents);
  const left = line.budgetCents === null ? null : line.budgetCents - line.spentCents;
  const pct =
    line.budgetCents === null || line.spentCents <= 0
      ? 0
      : line.budgetCents === 0
        ? 100
        : Math.min(100, (line.spentCents / line.budgetCents) * 100);

  return (
    <tr className="border-t border-stone-100" data-status={status}>
      <td className="px-3 py-1.5">
        {line.name}
        {line.archived && <span className="ml-1 text-xs text-stone-400">(archived)</span>}
      </td>
      <td className="px-3 py-1.5 text-right">
        <BudgetInput name={line.name} cents={line.budgetCents} disabled={line.archived} onSave={onSave} />
      </td>
      <td className="money px-3 py-1.5">
        <a href={txnsHref} className="hover:underline">
          {formatCents(line.spentCents)}
        </a>
      </td>
      <td className={`money px-3 py-1.5 font-medium ${STATUS_TEXT[status]}`}>
        {left === null ? '—' : status === 'over' ? `${formatCents(-left)} over` : `${formatCents(left)} left`}
      </td>
      <td className="px-3 py-1.5">
        {line.budgetCents !== null && (
          <div className="h-2 w-full overflow-hidden rounded bg-stone-100" role="presentation">
            <div className={`h-full ${STATUS_BAR[status]}`} style={{ width: `${pct}%` }} />
          </div>
        )}
      </td>
    </tr>
  );
}

/** Saves on Enter or when leaving the field; Escape reverts; empty clears the budget. */
function BudgetInput({
  name,
  cents,
  disabled,
  onSave,
}: {
  name: string;
  cents: number | null;
  disabled: boolean;
  onSave: (cents: number | null) => Promise<boolean>;
}) {
  const [text, setText] = useState(toAmount(cents));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(toAmount(cents)), [cents]);

  async function commit() {
    const trimmed = text.trim();
    const next = trimmed === '' ? null : parseMoney(trimmed);
    if (trimmed !== '' && (next === null || next < 0)) return setInvalid(true);
    setInvalid(false);
    if (next === cents) return setText(toAmount(cents));
    if (!(await onSave(next))) setText(toAmount(cents));
  }

  return (
    <input
      aria-label={`Budget for ${name}`}
      className={`money w-28 rounded border bg-white px-2 py-0.5 disabled:bg-stone-50 ${invalid ? 'border-red-500' : 'border-stone-300'}`}
      inputMode="decimal"
      placeholder="—"
      disabled={disabled}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setInvalid(false);
          setText(toAmount(cents));
        }
      }}
    />
  );
}
