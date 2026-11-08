// npm run restore -- backups/finance-20261028-140309.sqlite
// npm run restore            (no argument: lists available backups)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { BACKUPS_DIR, DB_PATH, HOST, PORT } from '../src/config';
import { restoreDb } from '../src/ops/backup';

const arg = process.argv[2];
if (!arg) {
  const files = fs.existsSync(BACKUPS_DIR)
    ? fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith('.sqlite')).sort()
    : [];
  console.log(files.length ? 'Available backups:' : `No backups in ${BACKUPS_DIR}`);
  for (const f of files) console.log(`  backups/${f}`);
  console.log('\nUsage: npm run restore -- backups/<file>.sqlite');
  process.exit(files.length ? 0 : 1);
}

// npm runs this script from server/, so resolve relative paths against
// where the user actually typed the command (INIT_CWD).
const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), arg);

const serverRunning = await new Promise<boolean>((resolve) => {
  const sock = net.connect(PORT, HOST);
  sock.once('connect', () => (sock.destroy(), resolve(true)));
  sock.once('error', () => resolve(false));
});
if (serverRunning) {
  console.error(`The server is running on ${HOST}:${PORT}. Stop it (Ctrl+C in the dev terminal) first.`);
  process.exit(1);
}

const { safetyBackup } = await restoreDb(DB_PATH, file, BACKUPS_DIR);
if (safetyBackup) console.log(`Saved current DB first: ${safetyBackup}`);
console.log(`Restored ${DB_PATH}\n    from ${file}`);
