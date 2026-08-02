import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { RoundService } from '../src/rounds/service.js';
import { pollOnce } from '../src/scheduler.js';

const US_SESSION = new Date('2026-08-03T14:00:00Z'); // Monday, US market open

describe('round lifecycle (spec §2.2 worked example, goal $20)', () => {
  let db: DB;
  let rounds: RoundService;
  let market: MarketDataService;
  let prices: Record<string, { price: number; currency: string }>;

  const fetcher: QuoteFetcher = async (symbols) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    market = new MarketDataService(db, fetcher);
    prices = { 'AAPL': { price: 10, currency: 'USD' }, 'AUDUSD=X': { price: 1, currency: 'USD' } };
  });

  it('deposit → buy $20 → price doubles → sell → skim $20 → goal reached', async () => {
    const config: RoundConfig = {
      name: 'lifecycle',
      startingBalanceCents: cents(50),
      profitGoalCents: cents(20),
      markets: ['US'],
      watchlist: ['AAPL'],
      riskProfile: 'balanced',
      tradingStyle: 'swing',
      guardrails: { stopLossPct: 10, maxPositionPct: null, drawdownPausePct: 50 },
      fees: { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 },
      model: 'claude-sonnet-5',
      checkinCron: ['0 8 * * 1-5'],
    };
    const id = rounds.create(config);

    // Day 1: agent buys $20 of AAPL at $10.
    let quotes = await market.poll(['AAPL']);
    const buy = rounds.buy(id, 'AAPL', 'US', cents(20), quotes.get('AAPL')!, 1, 'agent');
    expect(buy.status).toBe('filled');
    expect(rounds.get(id).cash_cents).toBe(cents(30));

    // Protective sweep at $9.50 (−5%): nothing fires.
    prices['AAPL'] = { price: 9.5, currency: 'USD' };
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.openPositions(id)).toHaveLength(1);
    expect(rounds.get(id).status).toBe('active');

    // Day 2: price doubles; agent sells everything for $40.
    prices['AAPL'] = { price: 20, currency: 'USD' };
    quotes = await market.poll(['AAPL']);
    const sell = rounds.sell(id, 'AAPL', 'all', quotes.get('AAPL')!, 1, 'agent');
    expect(sell.skimCents).toBe(cents(20));

    // Cash restored to the starting balance; $20 pocketed; goal reached.
    const round = rounds.get(id);
    expect(round.cash_cents).toBe(cents(50));
    expect(rounds.totalSkimsCents(id)).toBe(cents(20));
    expect(round.status).toBe('goal_reached');

    // Ledger is append-only and complete: deposit, buy, sell, skim.
    const types = (db.prepare('SELECT type FROM ledger_entries WHERE round_id = ? ORDER BY id').all(id) as { type: string }[]).map((r) => r.type);
    expect(types).toEqual(['deposit', 'buy', 'sell', 'skim']);

    // Post-goal: agent can no longer trade.
    expect(rounds.buy(id, 'AAPL', 'US', cents(10), quotes.get('AAPL')!, 1, 'agent').status).toBe('rejected');
  });
});
