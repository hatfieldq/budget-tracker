// Read-only SQL against the live DB, for poking around without a sqlite3 CLI.
//   npm run sql -- "SELECT * FROM account"
//   npm run sql -- tables
import Database from 'better-sqlite3';
import { DB_PATH } from '../src/config';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.log('Usage: npm run sql -- "SELECT ..."   or   npm run sql -- tables');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const sql =
  query === 'tables'
    ? "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    : query;
const rows = db.prepare(sql).all();
console.table(rows);
console.log(`${rows.length} row(s)`);
