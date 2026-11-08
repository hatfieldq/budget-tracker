// npm run seed            -> fill an EMPTY database with fabricated demo data
// npm run seed -- --force -> back up the current DB, wipe it, then seed
//
// Everything here is made up. Never put real account names or numbers in this file.
import fs from 'node:fs';
import { BACKUPS_DIR, DB_PATH } from '../src/config';
import { openDb } from '../src/db/connection';
import { backupDb } from '../src/ops/backup';
import { seedDemoData } from '../src/db/seed';

const force = process.argv.includes('--force');

if (fs.existsSync(DB_PATH)) {
  const db = openDb(DB_PATH, { backupsDir: BACKUPS_DIR });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number };
  db.close();
  if (n > 0 && !force) {
    console.error(`Database already has ${n} account(s). Use "npm run seed -- --force" to replace it.`);
    process.exit(1);
  }
  if (force) {
    console.log(`Backed up first: ${await backupDb(DB_PATH, BACKUPS_DIR, { label: 'pre-seed' })}`);
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + ext, { force: true });
  }
}

const db = openDb(DB_PATH, { backupsDir: BACKUPS_DIR });
const summary = seedDemoData(db);
db.close();
console.log(`Seeded ${DB_PATH}: ${summary}`);
