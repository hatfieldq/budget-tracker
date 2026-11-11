// npm run export -> exports/<timestamp>/ : a CSV per table, transactions.csv, and a DB copy.
import { DB_PATH, EXPORTS_DIR } from '../src/config';
import { exportDb } from '../src/ops/export';

const { dir, files } = await exportDb(DB_PATH, EXPORTS_DIR);
console.log(`Exported ${DB_PATH}\n      to ${dir}\n  files: ${files.join(', ')}`);
