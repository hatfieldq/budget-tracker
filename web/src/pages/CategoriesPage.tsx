// Manage income / expense / tax categories. System categories (Opening Balance,
// Valuation Change, Uncategorized) are listed but locked. Changing a category's
// kind reclassifies its past transactions in reports.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Category, CategoryInput } from '@ledger/shared';
import { api } from '../api';

const KINDS: { kind: CategoryInput['kind']; label: string }[] = [
  { kind: 'expense', label: 'Expenses' },
  { kind: 'income', label: 'Income' },
  { kind: 'tax', label: 'Taxes' },
];

export function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setCategories(await api.categories());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const visible = categories.filter((c) => showArchived || !c.archivedAt);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-xl font-semibold">Categories</h1>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      <AddCategory onAdd={(input) => run(() => api.createCategory(input))} />
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 md:grid-cols-3">
        {KINDS.map(({ kind, label }) => (
          <div key={kind} className="rounded border border-stone-200 bg-white">
            <h2 className="border-b border-stone-100 bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-600">{label}</h2>
            <ul>
              {visible
                .filter((c) => c.kind === kind)
                .map((c) => (
                  <CategoryRow
                    key={c.id}
                    category={c}
                    onSave={(patch) => run(() => api.updateCategory(c.id, patch))}
                    onArchive={() => run(() => api.archiveCategory(c.id, !c.archivedAt))}
                  />
                ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="text-xs text-stone-500">
        Managed by the app: {categories.filter((c) => c.isSystem).map((c) => c.name).join(', ')}.
      </p>
    </section>
  );
}

function AddCategory({ onAdd }: { onAdd: (input: CategoryInput) => Promise<void> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CategoryInput['kind']>('expense');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await onAdd({ name, kind });
    setName('');
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 text-sm">
      <input
        className="rounded border border-stone-300 bg-white px-2 py-1"
        placeholder="New category name"
        aria-label="New category name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        aria-label="New category kind"
        className="rounded border border-stone-300 bg-white px-2 py-1"
        value={kind}
        onChange={(e) => setKind(e.target.value as CategoryInput['kind'])}
      >
        {KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      <button className="rounded bg-stone-900 px-3 py-1 text-white">Add</button>
    </form>
  );
}

function CategoryRow(props: {
  category: Category;
  onSave: (patch: Partial<CategoryInput>) => Promise<void>;
  onArchive: () => Promise<void>;
}) {
  const { category: c } = props;
  const [name, setName] = useState(c.name);
  const [kind, setKind] = useState(c.kind as CategoryInput['kind']);
  const dirty = name.trim() !== c.name || kind !== c.kind;

  return (
    <li className={`flex items-center gap-2 border-t border-stone-100 px-3 py-1.5 text-sm first:border-t-0 ${c.archivedAt ? 'opacity-50' : ''}`}>
      <input
        aria-label={`Name for ${c.name}`}
        className="min-w-0 flex-1 rounded border border-transparent px-1 py-0.5 hover:border-stone-300 focus:border-stone-300"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        aria-label={`Kind for ${c.name}`}
        className="rounded border border-stone-200 bg-white px-1 py-0.5 text-xs"
        value={kind}
        onChange={(e) => setKind(e.target.value as CategoryInput['kind'])}
      >
        {KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.kind}
          </option>
        ))}
      </select>
      {dirty && (
        <button className="text-xs text-stone-900 underline" onClick={() => props.onSave({ name, kind })}>
          Save
        </button>
      )}
      <button className="text-xs text-stone-500 hover:underline" onClick={props.onArchive}>
        {c.archivedAt ? 'Unarchive' : 'Archive'}
      </button>
    </li>
  );
}
