import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { dueMarketScanRoundIds } from '../src/market-scan/scheduler.js';
import { RoundService } from '../src/rounds/service.js';

function config(over: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'r', startingBalanceCents: cents(50), profitGoalCents: cents(1000),
    markets: ['US'], watchlist: [], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS, fees: DEFAULT_FEES, model: 'claude-sonnet-5',
    checkinCron: [], researchCron: [], autoWatchlist: false,
    ...over,
  };
}

describe('dueMarketScanRoundIds', () => {
  let db: DB;
  let rounds: RoundService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
  });

  it('is due for a bootstrap: autoWatchlist off, empty watchlist, never scanned', () => {
    const id = rounds.create(config({ watchlist: [] }));
    expect(dueMarketScanRoundIds(db, new Date())).toContain(id);
  });

  it('is NOT due when autoWatchlist is off and the watchlist is non-empty', () => {
    const id = rounds.create(config({ watchlist: ['AAPL'] }));
    expect(dueMarketScanRoundIds(db, new Date())).not.toContain(id);
  });

  it('bootstrap fires only once — a prior scan row (even an error) freezes it', () => {
    const id = rounds.create(config({ watchlist: [] }));
    db.prepare(
      `INSERT INTO market_scans (round_id, created_at, status, candidates_json, added_json, removed_json, detail)
       VALUES (?, ?, 'error', '[]', '[]', '[]', 'x')`,
    ).run(id, new Date().toISOString());
    expect(dueMarketScanRoundIds(db, new Date())).not.toContain(id);
  });

  it('is due immediately for a fresh autoWatchlist:true round with no prior scan', () => {
    const id = rounds.create(config({ autoWatchlist: true }));
    expect(dueMarketScanRoundIds(db, new Date())).toContain(id);
  });

  it('is NOT due for autoWatchlist:true less than a week after the last scan', () => {
    const id = rounds.create(config({ autoWatchlist: true }));
    db.prepare(
      `INSERT INTO market_scans (round_id, created_at, status, candidates_json, added_json, removed_json, detail)
       VALUES (?, ?, 'success', '[]', '[]', '[]', 'x')`,
    ).run(id, new Date().toISOString());
    expect(dueMarketScanRoundIds(db, new Date())).not.toContain(id);
  });

  it('IS due for autoWatchlist:true a week after the last scan', () => {
    const id = rounds.create(config({ autoWatchlist: true }));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
    db.prepare(
      `INSERT INTO market_scans (round_id, created_at, status, candidates_json, added_json, removed_json, detail)
       VALUES (?, ?, 'success', '[]', '[]', '[]', 'x')`,
    ).run(id, eightDaysAgo);
    expect(dueMarketScanRoundIds(db, new Date())).toContain(id);
  });

  it('ignores non-active rounds', () => {
    const id = rounds.create(config({ autoWatchlist: true }));
    rounds.setStatus(id, 'paused', 'test');
    expect(dueMarketScanRoundIds(db, new Date())).not.toContain(id);
  });
});
