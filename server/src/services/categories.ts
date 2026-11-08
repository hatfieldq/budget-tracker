import type { Category, CategoryInput, CategoryKind } from '@ledger/shared';
import type { DB } from '../db/connection';
import { householdId } from '../db/bootstrap';
import { NotFoundError, ValidationError } from '../errors';

interface CategoryRow {
  id: number;
  name: string;
  kind: CategoryKind;
  is_system: number;
  archived_at: string | null;
}

const USER_KINDS = ['income', 'expense', 'tax'] as const;

const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  isSystem: r.is_system === 1,
  archivedAt: r.archived_at,
});

export function listCategories(db: DB): Category[] {
  const rows = db
    .prepare(
      `SELECT id, name, kind, is_system, archived_at FROM category
       WHERE household_id = ? ORDER BY is_system, kind, name COLLATE NOCASE`,
    )
    .all(householdId(db)) as CategoryRow[];
  return rows.map(toCategory);
}

function getRow(db: DB, id: number): CategoryRow {
  const row = db
    .prepare('SELECT id, name, kind, is_system, archived_at FROM category WHERE id = ? AND household_id = ?')
    .get(id, householdId(db)) as CategoryRow | undefined;
  if (!row) throw new NotFoundError('Category');
  return row;
}

function cleanName(db: DB, name: unknown, exceptId?: number): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new ValidationError('Category name is required');
  if (n.length > 50) throw new ValidationError('Category name must be 50 characters or fewer');
  const clash = db
    .prepare('SELECT id FROM category WHERE household_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
    .get(householdId(db), n, exceptId ?? -1);
  if (clash) throw new ValidationError(`A category named "${n}" already exists`);
  return n;
}

function checkKind(kind: unknown): (typeof USER_KINDS)[number] {
  if (!USER_KINDS.includes(kind as never)) {
    throw new ValidationError('Kind must be income, expense or tax');
  }
  return kind as (typeof USER_KINDS)[number];
}

export function createCategory(db: DB, input: CategoryInput): Category {
  const name = cleanName(db, input?.name);
  const kind = checkKind(input?.kind);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO category (household_id, name, kind) VALUES (?, ?, ?)')
    .run(householdId(db), name, kind);
  return toCategory(getRow(db, Number(lastInsertRowid)));
}

/**
 * Rename and/or change kind. Changing kind reclassifies past transactions too
 * (reports read the category's current kind). System categories are locked.
 */
export function updateCategory(db: DB, id: number, patch: Partial<CategoryInput>): Category {
  const row = getRow(db, id);
  if (row.is_system) throw new ValidationError(`${row.name} is managed by the app`);
  const name = patch.name !== undefined ? cleanName(db, patch.name, id) : row.name;
  const kind = patch.kind !== undefined ? checkKind(patch.kind) : row.kind;
  db.prepare('UPDATE category SET name = ?, kind = ? WHERE id = ?').run(name, kind, id);
  return toCategory(getRow(db, id));
}

/** Archived categories disappear from pickers; existing transactions keep them. */
export function setCategoryArchived(db: DB, id: number, archived: boolean): Category {
  const row = getRow(db, id);
  if (row.is_system) throw new ValidationError(`${row.name} is managed by the app`);
  db.prepare('UPDATE category SET archived_at = ? WHERE id = ?').run(
    archived ? new Date().toISOString() : null,
    id,
  );
  return toCategory(getRow(db, id));
}
