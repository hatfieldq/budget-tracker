// "Update value" for a brokerage/retirement account: record what it was worth
// at the end of a date. The server books the difference the ledger can't
// explain as a Valuation change (growth or loss); contributions stay separate.
// Lists past snapshots with the valuation each produced; edit or delete any.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatCents, parseMoney, type Account, type Snapshot } from '@ledger/shared';
import { api } from '../api';
import { today } from './TxnForm';

interface Props {
  account: Account;
  actingPersonId: number;
  onChanged: () => void;
  onClose: () => void;
}

const toAmount = (cents: number) => (cents / 100).toFixed(2);
const signed = (cents: number) => (cents > 0 ? '+' : '') + formatCents(cents);
const input = 'rounded border border-stone-300 bg-white px-2 py-1';

export function SnapshotPanel({ account, actingPersonId, onChanged, onClose }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [date, setDate] = useState(today());
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSnapshots(await api.snapshots(account.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [account.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  function startEdit(s: Snapshot) {
    setEditingId(s.id);
    setDate(s.date);
    setValue(toAmount(s.balanceCents));
    setNote(s.note ?? '');
  }

  function resetForm() {
    setEditingId(null);
    setDate(today());
    setValue('');
    setNote('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(value);
    if (cents === null || cents < 0) return setError('Enter the value like 44210.00');
    const ok = await run(() =>
      editingId
        ? api.updateSnapshot(editingId, { date, balanceCents: cents, note })
        : api.createSnapshot(account.id, { date, balanceCents: cents, note, createdByPersonId: actingPersonId }),
    );
    if (ok) resetForm();
  }

  return (
    <div className="space-y-3 rounded border border-stone-300 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Update value: {account.name}</h2>
        <button className="text-sm text-stone-500 hover:underline" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="text-xs text-stone-500">
        Enter the value from the statement or website at the end of that day. Contributions you entered stay as
        contributions; only the rest is booked as growth or loss.
      </p>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 text-sm">
        <label className="block">
          Date
          <input type="date" className={`${input} block`} value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block">
          Value
          <input className={`${input} money block w-36`} inputMode="decimal" placeholder="0.00" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <label className="block flex-1">
          Note
          <input className={`${input} block w-full`} value={note} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
        </label>
        <button className="rounded bg-stone-900 px-3 py-1.5 text-white">{editingId ? 'Save' : 'Add value'}</button>
        {editingId && (
          <button type="button" className="px-2 py-1.5" onClick={resetForm}>
            Cancel
          </button>
        )}
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {snapshots.length === 0 ? (
        <p className="text-sm text-stone-500">No values recorded yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="py-1">Date</th>
              <th className="money py-1">Value</th>
              <th className="money py-1">Growth / loss</th>
              <th className="py-1 pl-4">Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.id} className={`border-t border-stone-100 ${editingId === s.id ? 'bg-amber-50' : ''}`}>
                <td className="py-1">{s.date}</td>
                <td className="money py-1">{formatCents(s.balanceCents)}</td>
                <td className={`money py-1 ${s.valuationCents < 0 ? 'text-red-700' : s.valuationCents > 0 ? 'text-green-700' : 'text-stone-400'}`}>
                  {s.valuationCents === 0 ? '—' : signed(s.valuationCents)}
                </td>
                <td className="py-1 pl-4 text-stone-500">{s.note}</td>
                <td className="py-1 text-right whitespace-nowrap">
                  {confirmDelete === s.id ? (
                    <>
                      <span className="mr-2 text-red-700">Delete?</span>
                      <button
                        className="text-red-700 hover:underline"
                        onClick={async () => {
                          await run(() => api.deleteSnapshot(s.id));
                          setConfirmDelete(null);
                          if (editingId === s.id) resetForm();
                        }}
                      >
                        Yes
                      </button>
                      <button className="ml-2 hover:underline" onClick={() => setConfirmDelete(null)}>
                        No
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="text-stone-600 hover:underline" onClick={() => startEdit(s)}>
                        Edit
                      </button>
                      <button className="ml-3 text-stone-600 hover:text-red-700 hover:underline" onClick={() => setConfirmDelete(s.id)}>
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
