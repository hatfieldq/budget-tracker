// "Viewing as: Me / Partner / Household". In Household view, an extra
// "Entering as" picker decides who new entries are attributed to.
import { useScope } from '../scope';

export function ScopeSwitcher() {
  const { people, scope, setScope, actingPersonId, setActingPersonId } = useScope();
  const value = scope.type === 'household' ? 'household' : String(scope.personId);
  const active = people.filter((p) => !p.archivedAt);

  return (
    <div className="flex items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-stone-500">Viewing as</span>
        <select
          className="rounded border border-stone-300 bg-white px-2 py-1"
          value={value}
          onChange={(e) =>
            setScope(
              e.target.value === 'household'
                ? { type: 'household' }
                : { type: 'person', personId: Number(e.target.value) },
            )
          }
        >
          {active.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
          <option value="household">Household</option>
        </select>
      </label>
      {scope.type === 'household' && (
        <label className="flex items-center gap-2">
          <span className="text-stone-500">Entering as</span>
          <select
            className="rounded border border-stone-300 bg-white px-2 py-1"
            value={actingPersonId ?? ''}
            onChange={(e) => setActingPersonId(Number(e.target.value))}
          >
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
