import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/connection';
import { createAccount } from '../src/services/accounts';
import { accountInput, testDb } from './helpers';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-mig-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A database exactly as Session 1 left it: schema version 1, with data. */
function makeVersion1Db(file: string) {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(new URL('../src/db/migrations/001_initial.sql', import.meta.url), 'utf8'));
  db.pragma('user_version = 1');
  const now = '2026-01-01T00:00:00Z';
  db.exec(`
    INSERT INTO household (id, name, created_at) VALUES (1, 'H', '${now}');
    INSERT INTO person (id, household_id, display_name, created_at) VALUES (1, 1, 'Me', '${now}'), (2, 1, 'Partner', '${now}');
    INSERT INTO category (id, household_id, name, kind, is_system) VALUES (1, 1, 'Opening Balance', 'opening_equity', 1);
    INSERT INTO account (id, household_id, name, type, subtype, opening_date, created_at, updated_at)
      VALUES (7, 1, 'Old 401k', 'retirement', '401k', '2026-01-01', '${now}', '${now}');
    INSERT INTO account_owner VALUES (7, 1), (7, 2);
    INSERT INTO txn (id, household_id, date, kind, created_by_person_id, created_at, updated_at)
      VALUES (1, 1, '2026-01-01', 'opening', 1, '${now}', '${now}');
    INSERT INTO posting (txn_id, account_id, category_id, amount_cents, status) VALUES (1, 7, NULL, 5000, 'reconciled');
    INSERT INTO posting (txn_id, account_id, category_id, amount_cents, status) VALUES (1, NULL, 1, -5000, NULL);
  `);
  db.close();
}

describe('migration 002 (Roth 401k)', () => {
  it('rebuilds the account table without losing owners or postings', () => {
    const file = path.join(dir, 'finance.sqlite');
    makeVersion1Db(file);
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(2);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT * FROM account_owner ORDER BY person_id').all()).toEqual([
      { account_id: 7, person_id: 1 },
      { account_id: 7, person_id: 2 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM posting WHERE account_id = 7').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // the cascade from account_owner -> account still works after the rebuild
    db.prepare('DELETE FROM posting').run();
    db.prepare('DELETE FROM txn').run();
    db.prepare('DELETE FROM account WHERE id = 7').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_owner').get()).toEqual({ n: 0 });
    db.close();
  });

  it('backs up an existing database before migrating it', () => {
    const file = path.join(dir, 'finance.sqlite');
    const backups = path.join(dir, 'backups');
    makeVersion1Db(file);
    openDb(file, { backupsDir: backups }).close();
    const [backup] = fs.readdirSync(backups);
    expect(backup).toMatch(/^finance-\d{8}-\d{6}-pre-migrate\.sqlite$/);
    const copy = new Database(path.join(backups, backup), { readonly: true });
    expect(copy.pragma('user_version', { simple: true })).toBe(1); // the pre-migration state
    copy.close();

    openDb(file, { backupsDir: backups }).close(); // nothing pending now: no new backup
    expect(fs.readdirSync(backups)).toHaveLength(1);
  });

  it('accepts roth_401k as a retirement subtype', () => {
    const { db, me } = testDb();
    const a = createAccount(db, accountInput(me, { type: 'retirement', subtype: 'roth_401k', name: 'Roth 401(k)' }));
    expect(a.subtype).toBe('roth_401k');
  });
});
