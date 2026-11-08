import { buildApp } from './app';
import { BACKUPS_DIR, DB_PATH, HOST, PORT } from './config';
import { openDb } from './db/connection';

const db = openDb(DB_PATH, { backupsDir: BACKUPS_DIR });
const app = buildApp(db);

app
  .listen({ host: HOST, port: PORT })
  .then(() => console.log(`Ledger API on http://${HOST}:${PORT}  (db: ${DB_PATH})`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// Close the DB cleanly so the WAL is checkpointed into the main file.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
