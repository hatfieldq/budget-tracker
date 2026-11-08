import type { Person } from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId } from '../db/bootstrap';
import { NotFoundError, ValidationError } from '../errors';

interface PersonRow {
  id: number;
  display_name: string;
  archived_at: string | null;
}

const toPerson = (r: PersonRow): Person => ({
  id: r.id,
  displayName: r.display_name,
  archivedAt: r.archived_at,
});

export function listPeople(db: DB): Person[] {
  const rows = db
    .prepare('SELECT id, display_name, archived_at FROM person WHERE household_id = ? ORDER BY id')
    .all(householdId(db)) as PersonRow[];
  return rows.map(toPerson);
}

export function renamePerson(db: DB, id: number, displayName: unknown): Person {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) throw new ValidationError('Name is required');
  if (name.length > 40) throw new ValidationError('Name must be 40 characters or fewer');
  const result = db
    .prepare('UPDATE person SET display_name = ? WHERE id = ? AND household_id = ?')
    .run(name, id, householdId(db));
  if (result.changes === 0) throw new NotFoundError('Person');
  return listPeople(db).find((p) => p.id === id)!;
}

/** Throws unless every id is an active person in this household. */
export function assertActivePeople(db: DB, ids: number[], label: string): void {
  const check = db.prepare(
    'SELECT 1 FROM person WHERE id = ? AND household_id = ? AND archived_at IS NULL',
  );
  for (const id of ids) {
    if (!Number.isInteger(id) || !check.get(id, householdId(db))) {
      throw new ValidationError(`${label}: unknown person ${id}`);
    }
  }
}
