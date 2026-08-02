import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { RoundService } from '../src/rounds/service.js';
import { pollOnce } from '../src/scheduler.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };
// Monday 2026-08-03 14:00 UTC = 10:00 New York (US open, ASX closed).
const US_SESSION = new Date('2026-08-03T14:00:00Z');

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'sched round',
    startingBalanceCents: cents(50),
    profitGoalCents: cents(1000),
    markets: ['US'],
    watchlist: ['AAPL'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null, stopLossPct: 10, drawdownPausePct: 50 },
    fees: NO_FEES,
    model: 'claude-sonnet-5',
    checkinCron: ['0 8 * * 1-5'],
    ...overrides,
  };
}

describe('pollOnce', () => {
  let db: DB;
  let rounds: RoundService;
  let prices: Record<string, { price: number; currency: string }>;
  let market: MarketDataService;

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

  async function buyAt(roundId: number, price: number): Promise<void> {
    prices['AAPL'] = { price, currency: 'USD' };
    const quotes = await market.poll(['AAPL']);
    rounds.buy(roundId, 'AAPL', 'US', cents(20), quotes.get('AAPL')!, 1, 'agent');
  }

  it('does nothing when all markets are closed', async () => {
    const id = rounds.create(config());
    // Sunday 12:00 UTC — both markets closed.
    await pollOnce({ db, rounds, market }, new Date('2026-08-02T12:00:00Z'));
    expect(db.prepare('SELECT COUNT(*) AS c FROM price_bars').get()).toEqual({ c: 0 });
    expect(rounds.get(id).status).toBe('active');
  });

  it('fires the stop-loss when price falls past the threshold', async () => {
    const id = rounds.create(config());
    await buyAt(id, 10);
    prices['AAPL'] = { price: 8.5, currency: 'USD' }; // −15% < −10% stop
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.openPositions(id)).toHaveLength(0);
    const sells = db.prepare("SELECT placed_by FROM orders WHERE side = 'sell'").all() as { placed_by: string }[];
    expect(sells).toEqual([{ placed_by: 'stop_loss' }]);
  });

  it('leaves positions alone above the stop threshold and snapshots equity', async () => {
    const id = rounds.create(config());
    await buyAt(id, 10);
    prices['AAPL'] = { price: 9.5, currency: 'USD' }; // −5%
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.openPositions(id)).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM equity_snapshots WHERE round_id = ?').get(id) as { c: number }).c).toBeGreaterThan(0);
  });

  it('pauses the round on drawdown breach', async () => {
    const id = rounds.create(config({ guardrails: { stopLossPct: null, maxPositionPct: null, drawdownPausePct: 50 } }));
    prices['AAPL'] = { price: 10, currency: 'USD' };
    const quotes = await market.poll(['AAPL']);
    rounds.buy(id, 'AAPL', 'US', cents(50), quotes.get('AAPL')!, 1, 'agent'); // all-in, 5 shares
    prices['AAPL'] = { price: 4, currency: 'USD' }; // equity $20 < $25 threshold
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.get(id).status).toBe('paused');
  });

  it('still fires stop-losses for paused rounds', async () => {
    const id = rounds.create(config());
    await buyAt(id, 10);
    rounds.setStatus(id, 'paused', 'manual');
    prices['AAPL'] = { price: 8, currency: 'USD' };
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.openPositions(id)).toHaveLength(0);
  });

  it('fires stop-losses on stale last-known prices during a data outage (spec §7)', async () => {
    const id = rounds.create(config());
    // Buy through the normal, non-stale market service so the fill succeeds.
    await buyAt(id, 10);
    // Price drops below the stop-loss threshold.
    prices['AAPL'] = { price: 8.5, currency: 'USD' }; // −15% < −10% stop

    // Sweep with a MarketDataService whose quotes are always stale — simulates a data
    // outage where the last-known price is all we have. staleAfterMs = -1 (rather than 0)
    // guarantees staleness deterministically regardless of clock resolution/timing.
    const staleMarket = new MarketDataService(db, fetcher, -1);
    await pollOnce({ db, rounds, market: staleMarket }, US_SESSION);

    expect(rounds.openPositions(id)).toHaveLength(0);
    const sells = db.prepare("SELECT placed_by FROM orders WHERE side = 'sell'").all() as { placed_by: string }[];
    expect(sells).toEqual([{ placed_by: 'stop_loss' }]);
  });
});
