import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/connection';
import { seedDemoData } from '../src/db/seed';
import { backupDb, restoreDb } from '../src/ops/backup';
import { centsToDecimal, csvField, exportDb } from '../src/ops/export';

// AT-19 (backup/restore part). Runs against a throwaway temp directory.
let dir: string;
let dbPath: string;
let backupsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-ops-'));
  dbPath = path.join(dir, 'data', 'finance.sqlite');
  backupsDir = path.join(dir, 'backups');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const countAccounts = (file: string) => {
  const db = new Database(file, { readonly: true });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number };
  db.close();
  return n;
};

describe('backup and restore', () => {
  it('backup is a timestamped, complete copy, even while the DB is open', async () => {
    const db = openDb(dbPath);
    seedDemoData(db); // still open: recent writes may only be in the -wal file
    const file = await backupDb(dbPath, backupsDir, { now: new Date(2026, 9, 28, 14, 3, 9) });
    db.close();
    expect(path.basename(file)).toBe('finance-20261028-140309.sqlite');
    expect(countAccounts(file)).toBe(countAccounts(dbPath));
    expect(countAccounts(file)).toBeGreaterThan(0);
  });

  it('a backup is a single self-contained file', async () => {
    openDb(dbPath).close();
    const file = await backupDb(dbPath, backupsDir);
    await restoreDb(dbPath, file, backupsDir); // opens the backup to validate it
    expect(fs.readdirSync(backupsDir).filter((f) => /-(wal|shm)$/.test(f))).toEqual([]);
  });

  it('two backups in the same second do not overwrite each other', async () => {
    openDb(dbPath).close();
    const now = new Date(2026, 0, 1);
    const a = await backupDb(dbPath, backupsDir, { now });
    const b = await backupDb(dbPath, backupsDir, { now });
    expect(a).not.toBe(b);
  });

  it('restore replaces the DB and first saves a pre-restore copy', async () => {
    openDb(dbPath).close(); // empty ledger
    const emptyBackup = await backupDb(dbPath, backupsDir, { label: 'empty' });
    const db = openDb(dbPath);
    seedDemoData(db);
    db.close();

    const { safetyBackup } = await restoreDb(dbPath, emptyBackup, backupsDir);
    expect(countAccounts(dbPath)).toBe(0);
    expect(safetyBackup).toMatch(/pre-restore/);
    expect(countAccounts(safetyBackup!)).toBeGreaterThan(0);
  });

  it('refuses to restore a file that is not a ledger DB', async () => {
    openDb(dbPath).close();
    const junk = path.join(dir, 'junk.sqlite');
    fs.writeFileSync(junk, 'not a database');
    await expect(restoreDb(dbPath, junk, backupsDir)).rejects.toThrow(/not a valid ledger backup/);
  });
});

// AT-19 (export part).
describe('export', () => {
  it('writes a CSV per table, a readable transactions.csv and a DB copy, while the DB is open', async () => {
    const db = openDb(dbPath);
    seedDemoData(db);
    const exportsDir = path.join(dir, 'exports');
    const { dir: out, files } = await exportDb(dbPath, exportsDir, { now: new Date(2026, 10, 10, 9, 0, 0) });
    expect(path.basename(out)).toBe('20261110-090000');
    for (const t of ['account', 'budget', 'category', 'posting', 'txn', 'balance_snapshot', 'reconciliation', 'person']) {
      expect(files).toContain(`${t}.csv`);
    }
    expect(files).toContain('finance-20261110-090000.sqlite');

    // Raw table CSV: header + one row per DB row.
    const postings = fs.readFileSync(path.join(out, 'posting.csv'), 'utf8').trim().split('\r\n');
    const n = (db.prepare('SELECT COUNT(*) AS n FROM posting').get() as { n: number }).n;
    expect(postings).toHaveLength(n + 1);
    expect(postings[0]).toBe('id,txn_id,account_id,category_id,amount_cents,memo,status,reconciliation_id');

    // Readable CSV: names and dollar amounts.
    const readable = fs.readFileSync(path.join(out, 'transactions.csv'), 'utf8').trim().split('\r\n');
    expect(readable[0]).toBe(
      'date,txn_id,kind,payee,txn_memo,target_type,target,target_kind,amount,amount_cents,status,line_memo,entered_by',
    );
    expect(readable.some((l) => l.includes('Corner Bistro') && l.includes(',Dining,expense,64.50,'))).toBe(true);
    expect(countAccounts(path.join(out, 'finance-20261110-090000.sqlite'))).toBe(countAccounts(dbPath));
    db.close();
  });

  it('CSV quoting and float-free amounts', () => {
    expect(csvField('Big Box, Inc.')).toBe('"Big Box, Inc."');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a\nb')).toBe('"a\nb"');
    expect(csvField(null)).toBe('');
    expect(csvField(42)).toBe('42');
    expect(centsToDecimal(123_456)).toBe('1234.56');
    expect(centsToDecimal(-5)).toBe('-0.05');
    expect(centsToDecimal(0)).toBe('0.00');
  });
});
