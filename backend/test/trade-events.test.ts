import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/broker/types.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { RoundService } from '../src/rounds/service.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function q(price: number): Quote {
  return { symbol: 'AAPL', market: 'US', price, currency: 'USD', ts: new Date().toISOString(), stale: false };
}

describe('trade events', () => {
  let db: DB;
  let rounds: RoundService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
  });

  it('logs one trade event per fill with side, symbol, and quantity', () => {
    const config: RoundConfig = {
      name: 't', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
      watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
      guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
      model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'],
    };
    const id = rounds.create(config);
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    rounds.sell(id, 'AAPL', 'all', q(20), 1, 'agent');
    const events = db
      .prepare("SELECT message FROM event_log WHERE kind = 'trade' AND round_id = ? ORDER BY id")
      .all(id) as { message: string }[];
    expect(events).toHaveLength(2);
    expect(events[0]!.message).toMatch(/buy 2.* AAPL/);
    expect(events[1]!.message).toMatch(/sell 2.* AAPL/);
  });

  it('does not log trade events for rejected orders', () => {
    const config: RoundConfig = {
      name: 't', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
      watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
      guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
      model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'],
    };
    const id = rounds.create(config);
    rounds.setStatus(id, 'paused', 'test');
    rounds.buy(id, 'AAPL', 'US', cents(10), q(10), 1, 'agent');
    expect(db.prepare("SELECT COUNT(*) AS c FROM event_log WHERE kind = 'trade'").get()).toEqual({ c: 0 });
  });
});
