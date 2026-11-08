// "Viewing as" state shared by every screen:
//   scope         - which accounts reports/lists include (one person, or household)
//   actingPerson  - who is recorded as created_by on anything entered. When viewing
//                   as a person it's that person; in Household view it's chosen
//                   separately ("Entering as").
// Both are remembered in localStorage (this browser only).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Person, Scope } from '@ledger/shared';
import { api } from './api';

interface ScopeState {
  people: Person[];
  scope: Scope;
  setScope: (s: Scope) => void;
  actingPersonId: number | null;
  setActingPersonId: (id: number) => void;
  reloadPeople: () => Promise<void>;
  personName: (id: number) => string;
}

const ScopeContext = createContext<ScopeState | null>(null);

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private window etc.): state just won't persist
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [scope, setScopeState] = useState<Scope>(() => load('ledger.scope', { type: 'household' }));
  const [householdActor, setHouseholdActor] = useState<number | null>(() =>
    load('ledger.actingPerson', null),
  );

  const reloadPeople = useCallback(async () => setPeople(await api.people()), []);
  useEffect(() => {
    reloadPeople().catch(console.error);
  }, [reloadPeople]);

  const setScope = (s: Scope) => {
    setScopeState(s);
    save('ledger.scope', s);
  };
  const setActingPersonId = (id: number) => {
    setHouseholdActor(id);
    save('ledger.actingPerson', id);
  };

  const actingPersonId =
    scope.type === 'person' ? scope.personId : (householdActor ?? people[0]?.id ?? null);
  const personName = (id: number) => people.find((p) => p.id === id)?.displayName ?? `#${id}`;

  return (
    <ScopeContext.Provider
      value={{ people, scope, setScope, actingPersonId, setActingPersonId, reloadPeople, personName }}
    >
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope(): ScopeState {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error('useScope must be used inside <ScopeProvider>');
  return ctx;
}
