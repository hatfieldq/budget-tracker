// Accounts screen: accounts in the current scope, grouped by type, with
// balances in natural terms (cards/loans show the positive amount owed).
// Later sessions add reconciliation and snapshot entry here.
import { useCallback, useEffect, useState } from 'react';
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  SUBTYPE_LABELS,
  formatCents,
  isLiability,
  ledgerToNatural,
  type Account,
  type AccountInput,
} from '@ledger/shared';
import { api } from '../api';
import { useScope } from '../scope';
import { AccountForm } from '../components/AccountForm';
import { href } from '../router';

export function AccountsPage() {
  const { people, scope, actingPersonId, personName } = useScope();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setAccounts(await api.accounts(scope, showArchived));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [scope, showArchived]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function save(input: AccountInput) {
    if (editing === 'new') {
      await api.createAccount(input);
    } else if (editing) {
      const { type: _type, ...patch } = input;
      await api.updateAccount(editing.id, patch);
    }
    setEditing(null);
    await reload();
  }

  async function toggleArchive(a: Account) {
    try {
      await api.archiveAccount(a.id, !a.archivedAt);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const scopeLabel =
    scope.type === 'household'
      ? 'Household: every account counted once'
      : `${personName(scope.personId)}: their own and joint accounts`;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Accounts</h1>
          <p className="text-sm text-stone-500">{scopeLabel}</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          <button
            className="rounded bg-stone-900 px-3 py-1.5 text-white"
            onClick={() => setEditing('new')}
            disabled={actingPersonId === null}
          >
            Add account
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {editing && actingPersonId !== null && (
        <AccountForm
          key={editing === 'new' ? 'new' : editing.id}
          people={people.filter((p) => !p.archivedAt)}
          actingPersonId={actingPersonId}
          account={editing === 'new' ? undefined : editing}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {accounts.length === 0 && !error && (
        <p className="rounded border border-dashed border-stone-300 p-6 text-center text-stone-500">
          No accounts in this view yet.
        </p>
      )}

      {ACCOUNT_TYPES.map((type) => {
        const group = accounts.filter((a) => a.type === type);
        if (group.length === 0) return null;
        const total = group.reduce((sum, a) => sum + ledgerToNatural(a.type, a.balanceCents), 0);
        return (
          <div key={type} className="overflow-x-auto rounded border border-stone-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-stone-100 text-left text-stone-600">
                <tr>
                  <th className="px-3 py-2">{ACCOUNT_TYPE_LABELS[type]}</th>
                  <th className="px-3 py-2">Owners</th>
                  <th className="px-3 py-2">Opened</th>
                  <th className="money px-3 py-2">{isLiability(type) ? 'Owed' : 'Balance'}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {group.map((a) => (
                  <tr key={a.id} className={`border-t border-stone-100 ${a.archivedAt ? 'text-stone-400' : ''}`}>
                    <td className="px-3 py-2">
                      <span className="font-medium">{a.name}</span>
                      {a.subtype && (
                        <span className="ml-2 text-xs text-stone-500">{SUBTYPE_LABELS[a.subtype]}</span>
                      )}
                      {a.archivedAt && <span className="ml-2 text-xs">(archived)</span>}
                    </td>
                    <td className="px-3 py-2">
                      {a.isJoint ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          Joint
                        </span>
                      ) : (
                        a.ownerIds.map(personName).join(', ')
                      )}
                    </td>
                    <td className="px-3 py-2 text-stone-500">{a.openingDate}</td>
                    <td className="money px-3 py-2">
                      {formatCents(ledgerToNatural(a.type, a.balanceCents))}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <a className="text-stone-600 hover:underline" href={href('transactions', { accountId: a.id })}>
                        Register
                      </a>
                      <button className="ml-3 text-stone-600 hover:underline" onClick={() => setEditing(a)}>
                        Edit
                      </button>
                      <button
                        className="ml-3 text-stone-600 hover:underline"
                        onClick={() => toggleArchive(a)}
                      >
                        {a.archivedAt ? 'Unarchive' : 'Archive'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-stone-200 font-medium">
                  <td className="px-3 py-2" colSpan={3}>
                    Total
                  </td>
                  <td className="money px-3 py-2">{formatCents(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        );
      })}
    </section>
  );
}
