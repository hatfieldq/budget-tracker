import type { Scope } from '@ledger/shared';
import type { DB } from '../db/connection';
import { ValidationError } from '../errors';
import { householdId } from '../db/bootstrap';

/** Parse the ?scope= query param: "household" (default) or "person:<id>". */
export function parseScope(db: DB, param: unknown): Scope {
  if (param === undefined || param === '' || param === 'household') return { type: 'household' };
  const match = typeof param === 'string' ? /^person:(\d+)$/.exec(param) : null;
  if (!match) throw new ValidationError(`Invalid scope "${String(param)}"`);
  const personId = Number(match[1]);
  const exists = db
    .prepare('SELECT 1 FROM person WHERE id = ? AND household_id = ?')
    .get(personId, householdId(db));
  if (!exists) throw new ValidationError(`Unknown person ${personId}`);
  return { type: 'person', personId };
}

/**
 * SQL fragment + params selecting the account ids in a scope.
 * Household = every account once (so joint accounts are never double counted).
 * Person    = accounts that person owns, alone or jointly.
 */
export function scopeAccountFilter(db: DB, scope: Scope): { sql: string; params: number[] } {
  if (scope.type === 'household') {
    return { sql: 'SELECT id FROM account WHERE household_id = ?', params: [householdId(db)] };
  }
  return {
    sql: 'SELECT account_id FROM account_owner WHERE person_id = ?',
    params: [scope.personId],
  };
}
