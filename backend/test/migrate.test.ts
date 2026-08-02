import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { logEvent } from '../src/db/events.js';

const EXPECTED_TABLES = [
  'rounds', 'config_events', 'symbols', 'price_bars', 'positions', 'orders',
  'trades', 'ledger_entries', 'equity_snapshots', 'checkins', 'journal_entries',
  'daily_summaries', 'event_log', 'settings', 'users', 'sessions',
];

describe('migrate', () => {
  it('creates the full schema on an empty database', () => {
    const db = openDb(':memory:');
    migrate(db);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const table of EXPECTED_TABLES) expect(names).toContain(table);
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it('logs events', () => {
    const db = openDb(':memory:');
    migrate(db);
    logEvent(db, 'info', 'test', 'hello', null);
    const row = db.prepare('SELECT level, kind, message, round_id FROM event_log').get() as {
      level: string; kind: string; message: string; round_id: number | null;
    };
    expect(row).toMatchObject({ level: 'info', kind: 'test', message: 'hello', round_id: null });
  });
});
