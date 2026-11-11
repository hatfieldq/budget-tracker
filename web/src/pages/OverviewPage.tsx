// Overview (PLAN §3): income, taxes, spending, savings and investment flows for
// a period, plus net worth and debts at its end, for the "Viewing as" scope.
// The period lives in the URL (#/overview?from=…&to=…); default = this month.
// Every figure comes from the server's report engine; this page only lays it out.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ACCOUNT_TYPE_LABELS,
  PERIOD_PRESETS,
  SUBTYPE_LABELS,
  formatCents,
  ledgerToNatural,
  presetRange,
  type AccountType,
  type CategorySection,
  type NetWorthLine,
  type OverviewReport,
} from '@ledger/shared';
import { api } from '../api';
import { href } from '../router';
import { useScope } from '../scope';
import { today } from '../components/TxnForm';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const GROUPS: { label: string; types: AccountType[] }[] = [
  { label: 'Cash', types: ['checking', 'savings'] },
  { label: 'Investments', types: ['brokerage', 'retirement'] },
  { label: 'Debts', types: ['credit_card', 'loan'] },
];

const signedClass = (cents: number) => (cents < 0 ? 'text-red-700' : cents > 0 ? 'text-green-700' : '');
const signed = (cents: number) => (cents > 0 ? '+' : '') + formatCents(cents);

export function OverviewPage({ params }: { params: URLSearchParams }) {
  const { scope } = useScope();
  const fallback = presetRange('this-month', today());
  const from = DATE.test(params.get('from') ?? '') ? params.get('from')! : fallback.from;
  const to = DATE.test(params.get('to') ?? '') ? params.get('to')! : fallback.to;
  const [report, setReport] = useState<OverviewReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api.overview(scope, from, to);
      if (mine === seq.current) {
        setReport(r);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    }
  }, [scope, from, to]);

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

  const go = (range: { from: string; to: string }) => {
    window.location.hash = href('overview', range);
  };
  const txnsHref = (extra: Record<string, string | number>) => href('transactions', { ...extra, from, to });

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Overview</h1>
          {report && (
            <p className="text-sm text-stone-600">
              {report.scope.label}
              {report.scope.includesJointAccounts && ' (includes joint accounts at full value)'} · {from} to {to}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {PERIOD_PRESETS.map((p) => {
            const range = presetRange(p.id, today());
            const active = range.from === from && range.to === to;
            return (
              <button
                key={p.id}
                className={`rounded px-2.5 py-1 ${active ? 'bg-stone-900 text-white' : 'hover:bg-stone-200'}`}
                onClick={() => go(range)}
              >
                {p.label}
              </button>
            );
          })}
          <input type="date" aria-label="From" className="ml-2 rounded border border-stone-300 bg-white px-2 py-1" value={from} max={to} onChange={(e) => DATE.test(e.target.value) && go({ from: e.target.value, to })} />
          <span>to</span>
          <input type="date" aria-label="To" className="rounded border border-stone-300 bg-white px-2 py-1" value={to} min={from} onChange={(e) => DATE.test(e.target.value) && go({ from, to: e.target.value })} />
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {report && (
        <>
          {report.uncategorized.count > 0 && (
            <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {report.uncategorized.count} uncategorized item{report.uncategorized.count === 1 ? '' : 's'} (
              <span className="money">{formatCents(report.uncategorized.cents)}</span>) are counted as income or spending by
              direction.{' '}
              <a className="underline" href={txnsHref({ uncategorized: 1 })}>
                Categorize them
              </a>
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Gross income" cents={report.income.totalCents} />
            <Stat label="Taxes" cents={report.taxes.totalCents} />
            <Stat label="Spending" cents={report.spending.totalCents} />
            <Stat label="Income − taxes − spending" cents={report.netCents} colored />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Moved into savings (net)" cents={report.savingsCents} hint="Transfers and interest into savings accounts" />
            <Stat label="Invested (net contributions)" cents={report.investmentContributionsCents} hint="Money into brokerage and retirement accounts" />
            <Stat label="Market change" cents={report.valuationChangeCents} colored hint="Growth or loss from value updates; not income" />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Breakdown title="Income" section={report.income} link={txnsHref} />
            <Breakdown title="Taxes" section={report.taxes} link={txnsHref} />
            <Breakdown title="Spending" section={report.spending} link={txnsHref} />
          </div>

          <NetWorth report={report} />
        </>
      )}
    </section>
  );
}

function Stat({ label, cents, colored, hint }: { label: string; cents: number; colored?: boolean; hint?: string }) {
  return (
    <div className="rounded border border-stone-200 bg-white px-4 py-3" title={hint}>
      <div className="text-xs text-stone-500">{label}</div>
      <div className={`money text-left text-lg font-semibold ${colored ? signedClass(cents) : ''}`}>{formatCents(cents)}</div>
    </div>
  );
}

function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="rounded border border-stone-200 bg-white">
      <div className="flex items-center justify-between border-b border-stone-100 bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-600">
        <h2>{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Breakdown({
  title,
  section,
  link,
}: {
  title: string;
  section: CategorySection;
  link: (extra: Record<string, string | number>) => string;
}) {
  return (
    <Card title={title} right={<span className="money">{formatCents(section.totalCents)}</span>}>
      {section.lines.length === 0 ? (
        <p className="px-3 py-2 text-sm text-stone-400">Nothing in this period.</p>
      ) : (
        <ul className="text-sm">
          {section.lines.map((l) => (
            <li key={`${l.categoryId}-${l.name}`} className="flex justify-between border-t border-stone-100 px-3 py-1.5 first:border-t-0">
              <a
                className={`hover:underline ${l.uncategorized ? 'text-amber-800' : ''}`}
                href={link(l.uncategorized ? { uncategorized: 1 } : { categoryId: l.categoryId })}
              >
                {l.name}
              </a>
              <span className="money">{formatCents(l.cents)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function basis(l: NetWorthLine): string | null {
  if (!l.valuation) return null;
  if (l.valuation.kind === 'opening') return `opening balance ${l.valuation.date}, no value update yet`;
  return `value as of ${l.valuation.date}${l.valuation.transfersSince ? ' + transfers since' : ''}`;
}

function NetWorth({ report }: { report: OverviewReport }) {
  const { netWorth, identity, period } = report;
  const person = report.scope.type === 'person';
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card title={`Net worth at end of ${period.to}`} right={<span className="money">{formatCents(netWorth.endCents)}</span>}>
          <table className="w-full text-sm">
            <tbody>
              {GROUPS.map((g) => {
                const lines = netWorth.lines.filter((l) => g.types.includes(l.type));
                if (lines.length === 0) return null;
                const debt = g.label === 'Debts';
                const subtotal = lines.reduce((s, l) => s + l.balanceCents, 0);
                return [
                  <tr key={g.label} className="border-t border-stone-200 bg-stone-50">
                    <th className="px-3 py-1.5 text-left font-semibold">{g.label}</th>
                    <td className="money px-3 py-1.5 font-semibold">
                      {debt ? `${formatCents(-subtotal)} owed` : formatCents(subtotal)}
                    </td>
                  </tr>,
                  ...lines.map((l) => (
                    <tr key={l.accountId} className="border-t border-stone-100">
                      <td className="px-3 py-1.5 pl-6">
                        {l.name}
                        <span className="ml-2 text-xs text-stone-400">
                          {l.subtype ? SUBTYPE_LABELS[l.subtype] : ACCOUNT_TYPE_LABELS[l.type]}
                          {person && l.isJoint && ' · joint'}
                          {l.archived && ' · archived'}
                        </span>
                        {basis(l) && <div className="text-xs text-stone-500">{basis(l)}</div>}
                      </td>
                      <td className="money px-3 py-1.5">
                        {formatCents(ledgerToNatural(l.type, l.balanceCents))}
                        {debt && <span className="text-xs text-stone-400"> owed</span>}
                      </td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </Card>
      </div>

      <Card title="Change in net worth">
        <dl className="space-y-1 px-3 py-2 text-sm">
          <Row label={`Start (end of day before ${period.from})`} value={formatCents(netWorth.startCents)} />
          <Row label="Income − taxes − spending" value={signed(report.netCents)} />
          <Row label="Market change" value={signed(report.valuationChangeCents)} />
          {identity.openingCents !== 0 && <Row label="Opening balances added" value={signed(identity.openingCents)} />}
          {identity.outsideTransfersCents !== null && identity.outsideTransfersCents !== 0 && (
            <Row label="Transfers with accounts outside this scope" value={signed(identity.outsideTransfersCents)} />
          )}
          <div className="border-t border-stone-200 pt-1">
            <Row label="End" value={formatCents(netWorth.endCents)} strong />
            <Row label="Change" value={signed(identity.changeCents)} className={signedClass(identity.changeCents)} />
          </div>
          {identity.balanced ? (
            <p className="pt-1 text-xs text-green-700">✓ Everything adds up.</p>
          ) : (
            <p className="pt-1 text-xs text-red-700">These don't add up. This is a bug; please note the period and scope.</p>
          )}
        </dl>
      </Card>
    </div>
  );
}

function Row({ label, value, strong, className = '' }: { label: string; value: string; strong?: boolean; className?: string }) {
  return (
    <div className={`flex justify-between gap-2 ${strong ? 'font-semibold' : ''}`}>
      <dt className="text-stone-600">{label}</dt>
      <dd className={`money ${className}`}>{value}</dd>
    </div>
  );
}
