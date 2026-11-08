import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** 2026-10-28 14:03:09 -> "20261028-140309" (local time). */
export function timestamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * Copy the DB to backups/finance-<timestamp>[-label].sqlite using SQLite's
 * online backup API, which is safe even while the server has the DB open
 * (it includes anything still sitting in the -wal file).
 */
export async function backupDb(
  dbPath: string,
  backupsDir: string,
  opts: { label?: string; now?: Date } = {},
): Promise<string> {
  if (!fs.existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);
  fs.mkdirSync(backupsDir, { recursive: true });
  const suffix = opts.label ? `-${opts.label}` : '';
  let dest = path.join(backupsDir, `finance-${timestamp(opts.now)}${suffix}.sqlite`);
  // Two backups in the same second: add a counter rather than overwrite.
  for (let i = 2; fs.existsSync(dest); i++) {
    dest = path.join(backupsDir, `finance-${timestamp(opts.now)}${suffix}-${i}.sqlite`);
  }
  const src = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await src.backup(dest);
  } finally {
    src.close();
  }
  // The copy inherits WAL mode, which would leave -wal/-shm files next to it
  // whenever it's opened. Switch it to a plain single-file database.
  const copy = new Database(dest);
  copy.pragma('journal_mode = DELETE');
  copy.close();
  return dest;
}

/** Throws unless the file is a SQLite DB created by this app. */
export function assertLedgerDb(file: string): void {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const version = db.pragma('user_version', { simple: true }) as number;
    const hasHousehold = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'household'")
      .get();
    if (version < 1 || !hasHousehold) throw new Error('not a ledger database');
  } catch (err) {
    throw new Error(`${file} is not a valid ledger backup (${(err as Error).message})`);
  } finally {
    db?.close();
  }
}

/**
 * Replace the live DB with a backup. The current DB is first backed up with
 * the label "pre-restore", so a restore can itself be undone.
 * The server must be stopped (the restore script checks the port).
 */
export async function restoreDb(
  dbPath: string,
  backupFile: string,
  backupsDir: string,
): Promise<{ safetyBackup: string | null }> {
  assertLedgerDb(backupFile);
  const safetyBackup = fs.existsSync(dbPath)
    ? await backupDb(dbPath, backupsDir, { label: 'pre-restore' })
    : null;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true });
  fs.copyFileSync(backupFile, dbPath);
  return { safetyBackup };
}
