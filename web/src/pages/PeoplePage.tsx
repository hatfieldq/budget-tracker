// Rename the people in the household ("Me" / "Partner" are just defaults).
import { useState } from 'react';
import { api } from '../api';
import { useScope } from '../scope';

export function PeoplePage() {
  const { people, reloadPeople } = useScope();
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">People</h1>
      <ul className="space-y-2">
        {people.map((p) => (
          <PersonRow key={p.id} id={p.id} name={p.displayName} onSaved={reloadPeople} />
        ))}
      </ul>
    </section>
  );
}

function PersonRow(props: { id: number; name: string; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(props.name);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== props.name;

  async function save() {
    try {
      setError(null);
      await api.renamePerson(props.id, name);
      await props.onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <li className="flex items-center gap-2">
      <input
        className="rounded border border-stone-300 px-2 py-1"
        value={name}
        aria-label={`Name for ${props.name}`}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
      />
      <button
        className="rounded bg-stone-900 px-3 py-1 text-sm text-white disabled:opacity-30"
        disabled={!dirty}
        onClick={save}
      >
        Save
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </li>
  );
}
