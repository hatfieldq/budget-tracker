import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate, pendingMigrations } from './migrate';
import { bootstrap } from './bootstrap';
import { timestamp } from '../ops/backup';

export type DB = Database.Database;

/**
 * Open (or create) the database, apply pending migrations and make sure the
 * household, people and system categories exist. Use ':memory:' in tests.
 *
 * With backupsDir set, an existing database is copied to
 * backups/finance-<timestamp>-pre-migrate.sqlite before any pending migration runs.
 */
export function openDb(file: string, opts: { backupsDir?: string } = {}): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const hasData = (db.pragma('user_version', { simple: true }) as number) > 0;
  if (opts.backupsDir && hasData && pendingMigrations(db).length > 0) {
    fs.mkdirSync(opts.backupsDir, { recursive: true });
    const dest = path.join(opts.backupsDir, `finance-${timestamp()}-pre-migrate.sqlite`);
    db.prepare('VACUUM INTO ?').run(dest); // consistent single-file copy
    console.log(`Backed up before migrating: ${dest}`);
  }

  migrate(db);
  bootstrap(db);
  return db;
}
