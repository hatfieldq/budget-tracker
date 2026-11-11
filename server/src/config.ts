import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root = two levels up from server/src.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Always loopback. Deliberately not configurable: this app must never listen on a network interface.
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.LEDGER_PORT ?? 4317);

// A relative LEDGER_DB is taken relative to where you typed the command. npm runs
// workspace scripts from server/, but sets INIT_CWD to the directory npm was run in.
export const DB_PATH = process.env.LEDGER_DB
  ? path.resolve(process.env.INIT_CWD ?? process.cwd(), process.env.LEDGER_DB)
  : path.join(REPO_ROOT, 'data', 'finance.sqlite');
export const BACKUPS_DIR = path.join(REPO_ROOT, 'backups');
export const EXPORTS_DIR = path.join(REPO_ROOT, 'exports');
