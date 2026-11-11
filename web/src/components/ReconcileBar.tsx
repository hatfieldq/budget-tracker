// Reconcile bar shown above the register in reconcile mode. The user types the
// statement date and ending balance (natural terms: cards/loans as amount
// owed) and ticks rows as cleared; the bar shows the difference and enables
// Finish only at exactly 0.00. Ticks are saved as they're made, so stopping
// halfway is safe; the typed statement fields are remembered per account.
import { useEffect, useState } from 'react';
import {
  formatCents,
  isLiability,
  ledgerToNatural,
  naturalToLedger,
  parseMoney,
  type Account,
  type ReconcileSummary,
} from '@ledger/shared';
import { api } from '../api';

export interface StatementFields {
  date: string;
  balance: string; // as typed, natural terms
}

interface Props {
  account: Account;
  statement: StatementFields;
  onStatementChange: (s: StatementFields) => void;
  /** Bump to refetch the summary (after a tick or an edit). */
  version: number;
  actingPersonId: number | null;
  onFinished: (statementDate: string) => void;
  onUndone: () => void;
  onExit: () => void;
}

const input = 'rounded border border-stone-300 bg-white px-2 py-1';

export function ReconcileBar(props: Props) {
  const { account, statement, onStatementChange, version, actingPersonId } = props;
  const [summary, setSummary] = useState<ReconcileSummary | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liability = isLiability(account.type);

  useEffect(() => {
    if (!statement.date) return;
    api
      .reconcileSummary(account.id, statement.date)
      .then((s) => {
        setSummary(s);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [account.id, statement.date, version]);

  const typed = parseMoney(statement.balance);
  const statementLedger = typed === null ? null : naturalToLedger(account.type, typed);
  const clearedLedger = summary ? summary.reconciledCents + summary.clearedCents : null;
  const diff = statementLedger !== null && clearedLedger !== null ? statementLedger - clearedLedger : null;

  async function finish() {
    if (statementLedger === null || actingPersonId === null) return;
    try {
      await api.reconcile(account.id, {
        statementDate: statement.date,
        statementBalanceCents: statementLedger,
        personId: actingPersonId,
      });
      props.onFinished(statement.date);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function undo() {
    try {
      await api.undoReconcile(account.id);
      setConfirmUndo(false);
      props.onUndone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const last = summary?.last;

  return (
    <div className="space-y-2 rounded border-2 border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Reconciling {account.name}</h2>
        <button className="text-stone-600 hover:underline" onClick={props.onExit}>
          Exit reconcile
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          Statement date
          <input
            type="date"
            className={`${input} block`}
            value={statement.date}
            onChange={(e) => onStatementChange({ ...statement, date: e.target.value })}
          />
        </label>
        <label className="block">
          {liability ? 'Statement balance owed' : 'Statement ending balance'}
          <input
            className={`${input} money block w-40`}
            inputMode="decimal"
            placeholder="0.00"
            value={statement.balance}
            onChange={(e) => onStatementChange({ ...statement, balance: e.target.value })}
          />
        </label>
        {clearedLedger !== null && (
          <div>
            <div className="text-xs text-stone-500">Cleared balance ({summary!.clearedCount} new items)</div>
            <div className="money">{formatCents(ledgerToNatural(account.type, clearedLedger))}</div>
          </div>
        )}
        {diff !== null && (
          <div>
            <div className="text-xs text-stone-500">Difference</div>
            <div className={`money font-semibold ${diff === 0 ? 'text-green-700' : 'text-amber-800'}`}>
              {formatCents(Math.abs(diff))}
            </div>
          </div>
        )}
        <button
          className="rounded bg-stone-900 px-3 py-1.5 text-white disabled:opacity-40"
          disabled={diff !== 0 || actingPersonId === null}
          onClick={finish}
        >
          Finish
        </button>
      </div>
      <p className="text-xs text-stone-600">
        Tick each item that appears on the statement. Only items dated on or before the statement date are listed
        {summary && summary.clearedAfterCount > 0 && ` (${summary.clearedAfterCount} cleared item(s) dated later are not counted)`}.
        Missing something? Add it with the form below, or check its date.
      </p>
      {last && (
        <p className="text-xs text-stone-600">
          Last reconciled through {last.statementDate} at{' '}
          {formatCents(ledgerToNatural(account.type, last.statementBalanceCents))} ({last.postingCount} items).{' '}
          {confirmUndo ? (
            <>
              <span className="text-red-700">Undo it? Its items go back to cleared.</span>{' '}
              <button className="text-red-700 hover:underline" onClick={undo}>
                Yes
              </button>{' '}
              <button className="hover:underline" onClick={() => setConfirmUndo(false)}>
                No
              </button>
            </>
          ) : (
            <button className="underline" onClick={() => setConfirmUndo(true)}>
              Undo
            </button>
          )}
        </p>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
