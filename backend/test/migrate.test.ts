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

  it('defaults cost_usd to 0 on checkins', () => {
    const db = openDb(':memory:');
    migrate(db);
    const now = new Date().toISOString();
    const round = db
      .prepare(
        `INSERT INTO rounds (name, status, starting_balance_cents, cash_cents, profit_goal_cents, config_json, created_at, updated_at)
         VALUES ('t', 'active', 5000, 5000, 100000, '{}', ?, ?)`,
      )
      .run(now, now);
    const roundId = Number(round.lastInsertRowid);
    db.prepare("INSERT INTO checkins (round_id, ts, snapshot_json, actions_json, status) VALUES (?, ?, '{}', '[]', 'success')")
      .run(roundId, now);
    const row = db.prepare('SELECT cost_usd FROM checkins ORDER BY id DESC LIMIT 1').get() as { cost_usd: number };
    expect(row.cost_usd).toBe(0);
  });

  it('creates optimizer_runs with no round_id column (a global, non-round-scoped table)', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO optimizer_runs (created_at, status, web_search_enabled, output, detail, tokens_used, cost_usd)
       VALUES (?, 'success', 0, 'findings...', '3 patterns found', 500, 0.02)`,
    ).run(new Date().toISOString());
    const row = db.prepare('SELECT * FROM optimizer_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row.round_id).toBeUndefined(); // column does not exist at all
    expect(row.status).toBe('success');
    expect(row.web_search_enabled).toBe(0);
  });
});
