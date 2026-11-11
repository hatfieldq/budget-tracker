// Today (PLAN §3): the starting point for a weekly session.
//   Quick entry - the same always-open form as Transactions (sticky date, payee hints)
//   Budget      - this month at a glance, red if any category is over
//   To review   - per account: items to check off, cleared but not reconciled, last statement
//   Values      - investment accounts whose value is more than 7 days old (AT-16)
//   Uncategorized - newest items still needing a category
// Refreshes after each entry and whenever the tab regains focus.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatCents, type TodaySummary, type Txn, type TxnInput } from '@ledger/shared';
import { api } from '../api';
import { useEntryDate } from '../entryDate';
import { useLookups } from '../lookups';
import { usePayees } from '../payees';
import { href } from '../router';
import { useScope } from '../scope';
import { TxnForm } from '../components/TxnForm';

const longDate = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const monthName = (m: string) =>
  new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined, { month: 'long' });

export function TodayPage() {
  const { scope, actingPersonId } = useScope();
  const lookups = useLookups();
  const { payees, reload: reloadPayees } = usePayees();
  const [entryDate, setEntryDate] = useEntryDate();
  const [summary, setSummary] = useState<TodaySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const s = await api.today(scope);
      if (mine === seq.current) {
        setSummary(s);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    }
  }, [scope]);

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

  async function save(input: TxnInput) {
    await api.createTxn(input);
    reloadPayees();
    await reload();
  }

  const noAccounts = lookups.accounts.filter((a) => !a.archivedAt).length === 0;

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{summary ? longDate(summary.today) : 'Today'}</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {noAccounts ? (
        <p className="rounded border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-600">
          No accounts yet. <a className="underline" href={href('accounts')}>Add your first account</a> with its balance on
          the day you start, then come back here to enter transactions.
        </p>
      ) : (
        actingPersonId !== null && (
          <TxnForm
            key="today-entry"
            lookups={lookups}
            actingPersonId={actingPersonId}
            entryDate={entryDate}
            onDateChange={setEntryDate}
            onSubmit={save}
            payees={payees}
          />
        )
      )}

      {summary && (
        <div className="grid gap-4 md:grid-cols-2">
          <BudgetCard summary={summary} />
          <ReviewCard summary={summary} />
          <ValuesCard summary={summary} />
          <UncategorizedCard summary={summary} accountName={lookups.accountName} uncategorizedId={lookups.uncategorizedId} />
        </div>
      )}
    </section>
  );
}

function Card({ title, link, children }: { title: string; link?: { label: string; href: string }; children: ReactNode }) {
  return (
    <div className="rounded border border-stone-200 bg-white">
      <div className="flex items-center justify-between border-b border-stone-100 bg-stone-100 px-3 py-2 text-sm">
        <h2 className="font-semibold text-stone-600">{title}</h2>
        {link && (
          <a className="text-stone-600 hover:underline" href={link.href}>
            {link.label}
          </a>
        )}
      </div>
      <div className="px-3 py-2 text-sm">{children}</div>
    </div>
  );
}

function BudgetCard({ summary }: { summary: TodaySummary }) {
  const b = summary.budget;
  const link = { label: 'Budget', href: href('budget', { month: b.month }) };
  if (!b.hasBudget) {
    return (
      <Card title={`${monthName(b.month)} budget`} link={link}>
        <p className="text-stone-500">No budget set for {monthName(b.month)} yet.</p>
      </Card>
    );
  }
  const over = b.overCategories.length > 0;
  const left = b.budgetedCents - b.spentBudgetedCents;
  return (
    <Card title={`${monthName(b.month)} budget`} link={link}>
      <p>
        Spent <span className="money">{formatCents(b.spentBudgetedCents)}</span> of{' '}
        <span className="money">{formatCents(b.budgetedCents)}</span>:{' '}
        <span className={`font-semibold ${left < 0 ? 'text-red-700' : 'text-green-700'}`}>
          {left < 0 ? `${formatCents(-left)} over` : `${formatCents(left)} left`}
        </span>
      </p>
      {over ? (
        <p className="mt-1 text-red-700" data-status="over">
          Over in {b.overCategories.join(', ')}
        </p>
      ) : (
        <p className="mt-1 text-green-700" data-status="under">
          Every category is within budget.
        </p>
      )}
    </Card>
  );
}

function ReviewCard({ summary }: { summary: TodaySummary }) {
  return (
    <Card title="To review">
      {summary.review.length === 0 ? (
        <p className="text-stone-500">No bank, card or loan accounts.</p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {summary.review.map((r) => (
            <li key={r.accountId} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
              <div>
                <a className="font-medium hover:underline" href={href('transactions', { accountId: r.accountId })}>
                  {r.name}
                </a>
                <div className="text-xs text-stone-500">
                  {r.unclearedCount === 0 ? 'All checked off' : `${r.unclearedCount} to check off`}
                  {r.clearedCount > 0 && ` · ${r.clearedCount} cleared, not reconciled`} · reconciled through{' '}
                  {r.lastReconciledDate ?? 'never'}
                </div>
              </div>
              <a className="text-stone-600 hover:underline" href={href('transactions', { accountId: r.accountId, reconcile: 1 })}>
                Reconcile
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ValuesCard({ summary }: { summary: TodaySummary }) {
  const stale = summary.stale.filter((s) => s.stale);
  return (
    <Card title="Investment values">
      {summary.stale.length === 0 ? (
        <p className="text-stone-500">No investment accounts.</p>
      ) : stale.length === 0 ? (
        <p className="text-green-700">All values updated in the last 7 days.</p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {stale.map((s) => (
            <li key={s.accountId} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5" data-stale="true">
              <div>
                <span className="font-medium">{s.name}</span>
                <div className="text-xs text-amber-800">
                  {s.lastValueDate ? `Last value ${s.lastValueDate}` : `No value update since opening (${s.basisDate})`},{' '}
                  {s.days} days ago
                </div>
              </div>
              <a className="text-stone-600 hover:underline" href={href('accounts', { update: s.accountId })}>
                Update value
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Uncategorized amount of a txn in natural terms: + money out, − money in. */
const uncategorizedCents = (t: Txn, uncategorizedId: number | null) =>
  t.postings.filter((p) => p.categoryId !== null && p.categoryId === uncategorizedId).reduce((s, p) => s + p.amountCents, 0);

function UncategorizedCard({
  summary,
  accountName,
  uncategorizedId,
}: {
  summary: TodaySummary;
  accountName: (id: number | null) => string;
  uncategorizedId: number | null;
}) {
  const { total, txns } = summary.uncategorized;
  return (
    <Card title="Uncategorized" link={total > 0 ? { label: 'Categorize', href: href('transactions', { uncategorized: 1 }) } : undefined}>
      {total === 0 ? (
        <p className="text-green-700">Everything has a category.</p>
      ) : (
        <>
          <ul className="divide-y divide-stone-100">
            {txns.map((t) => {
              const cents = uncategorizedCents(t, uncategorizedId);
              const account = t.postings.find((p) => p.accountId !== null)?.accountId ?? null;
              return (
                <li key={t.id} className="flex justify-between gap-2 py-1.5">
                  <span>
                    <span className="text-stone-500">{t.date}</span> {t.payee || '(no payee)'}
                    <span className="ml-1 text-xs text-stone-400">{accountName(account)}</span>
                  </span>
                  <span className="money">{cents >= 0 ? formatCents(cents) : `+${formatCents(-cents)}`}</span>
                </li>
              );
            })}
          </ul>
          {total > txns.length && <p className="pt-1 text-xs text-stone-500">and {total - txns.length} more</p>}
        </>
      )}
    </Card>
  );
}
