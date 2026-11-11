// npm run export -> exports/<timestamp>/
//   <table>.csv        one per table, raw columns (money in integer cents, ledger sign)
//   transactions.csv   one row per posting with names and dollar amounts, for spreadsheets
//   finance-<ts>.sqlite a full database copy (same as a backup)
// Reads through a read-only connection, so it's safe while the server runs.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupDb, timestamp } from './backup';

/** RFC 4180 field: quote when needed, double embedded quotes. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(csvField).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvField(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Integer cents -> "1234.56" / "-0.05" without floats. */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const READABLE = `
  SELECT t.date, t.id AS txn_id, t.kind, t.payee, t.memo AS txn_memo,
         CASE WHEN p.account_id IS NOT NULL THEN 'account' ELSE 'category' END AS target_type,
         COALESCE(a.name, c.name) AS target,
         COALESCE(a.type, c.kind) AS target_kind,
         p.amount_cents, p.status, p.memo AS line_memo,
         pr.display_name AS entered_by
  FROM posting p
  JOIN txn t ON t.id = p.txn_id
  LEFT JOIN account a ON a.id = p.account_id
  LEFT JOIN category c ON c.id = p.category_id
  JOIN person pr ON pr.id = t.created_by_person_id
  ORDER BY t.date, t.id, p.id`;

export async function exportDb(
  dbPath: string,
  exportsDir: string,
  opts: { now?: Date } = {},
): Promise<{ dir: string; files: string[] }> {
  if (!fs.existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);
  let dir = path.join(exportsDir, timestamp(opts.now));
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(exportsDir, `${timestamp(opts.now)}-${i}`);
  fs.mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((t) => t.name);
    for (const table of tables) {
      const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
      const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[];
      const file = `${table}.csv`;
      fs.writeFileSync(path.join(dir, file), toCsv(columns, rows));
      files.push(file);
    }

    const readable = (db.prepare(READABLE).all() as Record<string, unknown>[]).map((r) => ({
      ...r,
      amount: centsToDecimal(r.amount_cents as number),
    }));
    const columns = ['date', 'txn_id', 'kind', 'payee', 'txn_memo', 'target_type', 'target', 'target_kind', 'amount', 'amount_cents', 'status', 'line_memo', 'entered_by'];
    fs.writeFileSync(path.join(dir, 'transactions.csv'), toCsv(columns, readable));
    files.push('transactions.csv');
  } finally {
    db.close();
  }

  const copy = await backupDb(dbPath, dir, { now: opts.now });
  files.push(path.basename(copy));
  return { dir, files };
}
