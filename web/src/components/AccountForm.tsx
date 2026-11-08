// Create / edit an account. The user types the opening balance in natural
// terms (a card balance is "amount owed", positive); this form converts to
// ledger sign before calling onSubmit, so the API only ever sees ledger sign.
import { useState, type FormEvent } from 'react';
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  SUBTYPES_BY_TYPE,
  SUBTYPE_LABELS,
  isLiability,
  ledgerToNatural,
  naturalToLedger,
  parseMoney,
  type Account,
  type AccountInput,
  type AccountType,
  type Person,
} from '@ledger/shared';

interface Props {
  people: Person[];
  actingPersonId: number;
  /** When given, the form edits this account (type can't be changed). */
  account?: Account;
  onSubmit: (input: AccountInput) => Promise<void>;
  onCancel: () => void;
}

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local

export function AccountForm({ people, actingPersonId, account, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>(account?.type ?? 'checking');
  const [subtype, setSubtype] = useState<string | null>(account?.subtype ?? null);
  const [ownerIds, setOwnerIds] = useState<number[]>(account?.ownerIds ?? [actingPersonId]);
  const [openingDate, setOpeningDate] = useState(account?.openingDate ?? today());
  const [opening, setOpening] = useState(
    account ? (ledgerToNatural(account.type, account.openingBalanceCents) / 100).toFixed(2) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const subtypes = SUBTYPES_BY_TYPE[type];

  function changeType(t: AccountType) {
    setType(t);
    setSubtype(SUBTYPES_BY_TYPE[t]?.[0] ?? null);
  }

  function toggleOwner(id: number) {
    setOwnerIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const natural = opening.trim() === '' ? 0 : parseMoney(opening);
    if (natural === null) return setError('Opening balance must be an amount like 1234.56');
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name,
        type,
        subtype: subtype as AccountInput['subtype'],
        ownerIds,
        openingDate,
        openingBalanceCents: naturalToLedger(type, natural),
        createdByPersonId: actingPersonId,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const input = 'w-full rounded border border-stone-300 bg-white px-2 py-1';

  return (
    <form onSubmit={submit} className="space-y-3 rounded border border-stone-300 bg-white p-4">
      <h2 className="font-semibold">{account ? `Edit ${account.name}` : 'New account'}</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          Name
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="block text-sm">
          Type
          <select
            className={input}
            value={type}
            disabled={!!account}
            onChange={(e) => changeType(e.target.value as AccountType)}
          >
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        {subtypes && (
          <label className="block text-sm">
            {type === 'loan' ? 'Loan category' : 'Retirement type'}
            <select
              className={input}
              value={subtype ?? ''}
              onChange={(e) => setSubtype(e.target.value)}
            >
              {subtypes.map((s) => (
                <option key={s} value={s}>
                  {SUBTYPE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        )}

        <fieldset className="text-sm">
          <legend>Owners (two or more = joint)</legend>
          <div className="mt-1 flex gap-4">
            {people.map((p) => (
              <label key={p.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={ownerIds.includes(p.id)}
                  onChange={() => toggleOwner(p.id)}
                />
                {p.displayName}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block text-sm">
          Opening date
          <input
            type="date"
            className={input}
            value={openingDate}
            onChange={(e) => setOpeningDate(e.target.value)}
          />
        </label>

        <label className="block text-sm">
          {isLiability(type) ? 'Opening amount owed' : 'Opening balance'}
          <input
            className={`${input} money`}
            inputMode="decimal"
            placeholder="0.00"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
          />
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {account ? 'Save' : 'Create account'}
        </button>
        <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
