/**
 * Take a consistent snapshot of the database.
 *
 *   npm run backup                 -> data/backups/zahhood-<timestamp>.db
 *   npm run backup -- /some/path.db
 *
 * Uses SQLite's VACUUM INTO, which is safe to run while the server is live:
 * it produces a defragmented copy at a single point in time, with no risk of
 * catching a half-written transaction. The output is an ordinary database
 * file - open it, copy it to another host, or keep it as an archive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { db } from '../src/db.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(path.dirname(config.dbPath), 'backups', `zahhood-${stamp}.db`);

fs.mkdirSync(path.dirname(target), { recursive: true });

if (fs.existsSync(target)) {
  console.error(`Refusing to overwrite an existing file: ${target}`);
  process.exit(1);
}

const started = Date.now();
// VACUUM INTO takes its own read lock, so a live server carries on serving.
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const size = fs.statSync(target).size;
const counts = {};
for (const table of ['users', 'players', 'punishments', 'whitelist', 'audit_log', 'page_views', 'chat_messages']) {
  try {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    counts[table] = '-';
  }
}

console.log(`\nBackup written in ${Date.now() - started}ms`);
console.log(`  ${target}`);
console.log(`  ${(size / 1024).toFixed(1)} KB\n`);
console.table(counts);
console.log('\nRestore by stopping the server and putting this file at:');
console.log(`  ${config.dbPath}\n`);
