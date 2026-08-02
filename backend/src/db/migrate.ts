import type { DB } from './connection.js';
import { migrations } from './migrations.js';

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number };
  for (let i = c; i < migrations.length; i++) {
    const migration = migrations[i];
    if (migration !== undefined) {
      db.transaction(() => {
        db.exec(migration);
        db.prepare('INSERT INTO _migrations (idx, applied_at) VALUES (?, ?)').run(i, new Date().toISOString());
      })();
    }
  }
}
