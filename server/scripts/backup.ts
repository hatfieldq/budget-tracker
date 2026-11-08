// npm run backup  ->  backups/finance-YYYYMMDD-HHMMSS.sqlite
import { BACKUPS_DIR, DB_PATH } from '../src/config';
import { backupDb } from '../src/ops/backup';

const dest = await backupDb(DB_PATH, BACKUPS_DIR);
console.log(`Backed up ${DB_PATH}\n       to ${dest}`);
