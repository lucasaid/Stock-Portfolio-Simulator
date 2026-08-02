import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/broker/types.js';
import { openDb, type DB } from '../src/db/connection.js';
import { logEvent } from '../src/db/events.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { RoundService } from '../src/rounds/service.js';
import { buildSnapshot } from '../src/agent/snapshot.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'snap', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL', 'MSFT'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
    model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'], ...overrides,
  };
}

function q(symbol: string, price: number, stale = false): Quote {
  return { symbol, market: 'US', price, currency: 'USD', ts: new Date().toISOString(), stale };
}

describe('buildSnapshot', () => {
  let db: DB;
  let rounds: RoundService;
  let id: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    id = rounds.create(config());
  });

  it('includes cash, goal progress, watchlist quotes and staleness markers', () => {
    const text = buildSnapshot(db, rounds, id, new Map([['AAPL', q('AAPL', 10)], ['MSFT', q('MSFT', 300, true)]]), 1);
    expect(text).toContain('Cash: $50.00');
    expect(text).toContain('Pocketed so far: $0.00 of $1000.00 goal');
    expect(text).toMatch(/AAPL.*\$10/);
    expect(text).toMatch(/MSFT.*STALE/);
  });

  it('lists open positions with cost basis and unrealised P/L', () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q('AAPL', 10), 1, 'agent');
    const text = buildSnapshot(db, rounds, id, new Map([['AAPL', q('AAPL', 15)]]), 1);
    expect(text).toMatch(/AAPL.*2 shares.*avg cost \$10\.00.*now \$15\.00/);
    expect(text).toContain('+$10.00'); // unrealised P/L
  });

  it('includes recent trades, rejected orders, and events since the last check-in', () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q('AAPL', 10), 1, 'agent');
    rounds.setStatus(id, 'paused', 'drawdown pause breached');
    rounds.setStatus(id, 'active', 'operator resume');
    logEvent(db, 'info', 'config_change', `round ${id}: operator changed 1 config field(s)`, id);
    const text = buildSnapshot(db, rounds, id, new Map(), 1);
    expect(text).toMatch(/buy 2.*AAPL/);
    expect(text).toContain('config_change');
    expect(text).toContain('operator resume');
  });

  it('includes rolling history: recent daily summaries and the last journal note', () => {
    db.prepare(
      "INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, '2026-08-01', '{}', 'Bought AAPL on momentum.', ?)",
    ).run(id, new Date().toISOString());
    db.prepare(
      "INSERT INTO journal_entries (round_id, author, note, created_at) VALUES (?, 'agent', 'Watching MSFT for entry.', ?)",
    ).run(id, new Date().toISOString());
    const text = buildSnapshot(db, rounds, id, new Map(), 1);
    expect(text).toContain('Bought AAPL on momentum.');
    expect(text).toContain('Watching MSFT for entry.');
  });

  it('always carries the (currently empty) research briefing slot', () => {
    const text = buildSnapshot(db, rounds, id, new Map(), 1);
    expect(text).toContain('Research briefing: none');
  });
});
