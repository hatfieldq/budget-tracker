// Accounts and categories for pickers and for showing names in tables.
// Loaded for the whole household (pickers can target any account, e.g. a
// transfer to a partner's account), including archived ones so old
// transactions still show names. Filter `archivedAt` for pickers.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Account, Category } from '@ledger/shared';
import { api } from './api';

export interface Lookups {
  accounts: Account[];
  categories: Category[];
  accountName: (id: number | null) => string;
  categoryName: (id: number | null) => string;
  uncategorizedId: number | null;
  reload: () => Promise<void>;
  error: string | null;
}

export function useLookups(): Lookups {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([api.accounts({ type: 'household' }, true), api.categories()]);
      setAccounts(a);
      setCategories(c);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return useMemo(() => {
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const categoriesById = new Map(categories.map((c) => [c.id, c]));
    return {
      accounts,
      categories,
      accountName: (id) => (id === null ? '' : (accountsById.get(id)?.name ?? `Account #${id}`)),
      categoryName: (id) => (id === null ? '' : (categoriesById.get(id)?.name ?? `Category #${id}`)),
      uncategorizedId: categories.find((c) => c.kind === 'uncategorized')?.id ?? null,
      reload,
      error,
    };
  }, [accounts, categories, reload, error]);
}
