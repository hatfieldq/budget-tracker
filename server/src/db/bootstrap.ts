import type Database from 'better-sqlite3';
import type { CategoryKind } from '@ledger/shared';

// Rows every database needs. Inserted once, on first open. Users can rename
// people and edit/archive non-system categories afterwards.

export const SYSTEM_CATEGORIES: { name: string; kind: CategoryKind }[] = [
  { name: 'Opening Balance', kind: 'opening_equity' },
  { name: 'Valuation Change', kind: 'valuation' },
  { name: 'Uncategorized', kind: 'uncategorized' },
];

export const DEFAULT_CATEGORIES: { name: string; kind: CategoryKind }[] = [
  { name: 'Salary', kind: 'income' },
  { name: 'Interest Income', kind: 'income' },
  { name: 'Other Income', kind: 'income' },
  { name: 'Federal Income Tax', kind: 'tax' },
  { name: 'State Income Tax', kind: 'tax' },
  { name: 'Social Security & Medicare', kind: 'tax' },
  { name: 'Groceries', kind: 'expense' },
  { name: 'Dining', kind: 'expense' },
  { name: 'Housing', kind: 'expense' },
  { name: 'Utilities', kind: 'expense' },
  { name: 'Transportation', kind: 'expense' },
  { name: 'Health', kind: 'expense' },
  { name: 'Clothing', kind: 'expense' },
  { name: 'Entertainment', kind: 'expense' },
  { name: 'Interest Expense', kind: 'expense' },
  { name: 'Fees', kind: 'expense' },
  { name: 'Other Expense', kind: 'expense' },
];

export function bootstrap(db: Database.Database): void {
  const existing = db.prepare('SELECT id FROM household LIMIT 1').get();
  if (existing) return;

  const now = new Date().toISOString();
  db.transaction(() => {
    const { lastInsertRowid: householdId } = db
      .prepare('INSERT INTO household (name, created_at) VALUES (?, ?)')
      .run('Household', now);

    const addPerson = db.prepare(
      'INSERT INTO person (household_id, display_name, created_at) VALUES (?, ?, ?)',
    );
    addPerson.run(householdId, 'Me', now);
    addPerson.run(householdId, 'Partner', now);

    const addCategory = db.prepare(
      'INSERT INTO category (household_id, name, kind, is_system) VALUES (?, ?, ?, ?)',
    );
    for (const c of SYSTEM_CATEGORIES) addCategory.run(householdId, c.name, c.kind, 1);
    for (const c of DEFAULT_CATEGORIES) addCategory.run(householdId, c.name, c.kind, 0);
  })();
}

/** v1 has exactly one household. Services call this instead of passing ids around. */
export function householdId(db: Database.Database): number {
  const row = db.prepare('SELECT id FROM household ORDER BY id LIMIT 1').get() as { id: number };
  return row.id;
}

export function systemCategoryId(db: Database.Database, kind: CategoryKind): number {
  const row = db
    .prepare('SELECT id FROM category WHERE kind = ? AND is_system = 1 AND household_id = ?')
    .get(kind, householdId(db)) as { id: number } | undefined;
  if (!row) throw new Error(`System category missing: ${kind}`);
  return row.id;
}
