import fs from 'node:fs';
import type Database from 'better-sqlite3';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/** Migration files newer than the DB's PRAGMA user_version, in order. */
export function pendingMigrations(db: Database.Database): { version: number; file: string }[] {
  const current = db.pragma('user_version', { simple: true }) as number;
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .map((file) => ({ version: Number(file.slice(0, 3)), file }))
    .filter((m) => m.version > current);
}

/**
 * Apply migrations/NNN_name.sql files in order. The current schema version is
 * stored in SQLite's built-in PRAGMA user_version. Each file runs in its own
 * DB transaction. Never edit a migration that has shipped: add a new file.
 *
 * Foreign keys are switched off while migrating (the pragma can't change inside
 * a transaction) so a migration can rebuild a table without cascading deletes.
 * Each migration must leave foreign_key_check clean or it is rolled back.
 */
export function migrate(db: Database.Database): void {
  const pending = pendingMigrations(db);
  if (pending.length === 0) return;

  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    for (const { version, file } of pending) {
      const sql = fs.readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        const problems = db.pragma('foreign_key_check') as unknown[];
        if (problems.length > 0) {
          throw new Error(`Migration ${file} broke ${problems.length} foreign key reference(s)`);
        }
        db.pragma(`user_version = ${version}`);
      })();
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}
