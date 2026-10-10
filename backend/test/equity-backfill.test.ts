import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { backfillEquity } from '../src/equity-backfill.js';
import type { BarFetcher, OhlcBar } from '../src/market/history.js';
import { RoundService } from '../src/rounds/service.js';

const config: RoundConfig = {
  name: 'backfill round',
  startingBalanceCents: cents(50),
  profitGoalCents: cents(1000),
  markets: ['US'],
  watchlist: ['AAPL'],
  riskProfile: 'balanced',
  tradingStyle: 'swing',
  guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null },
  fees: { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 },
  model: 'claude-sonnet-5',
  checkinCron: [],
};

const bar = (ts: string, close: number): OhlcBar => ({ ts, open: close, high: close, low: close, close, volume: 0 });
const LAST = '2026-08-03T14:00:00.000Z';
const NOW = new Date('2026-08-03T18:30:00.000Z');

describe('backfillEquity', () => {
  let db: DB;
  let rounds: RoundService;
  let id: number;
  let calls: string[];
  let series: Record<string, { currency: string; bars: OhlcBar[] }>;
  const fetchBars: BarFetcher = async (symbol) => {
    calls.push(symbol);
    return series[symbol];
  };
  const snapshots = () =>
    db.prepare('SELECT ts, cash_cents, holdings_cents, equity_cents FROM equity_snapshots WHERE round_id = ? ORDER BY ts').all(id) as {
      ts: string; cash_cents: number; holdings_cents: number; equity_cents: number;
    }[];

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    id = rounds.create(config);
    calls = [];
    // 2 AAPL bought at US$10 with AUDUSD 0.5 → AU$40 spent, AU$10 cash left.
    rounds.buy(id, 'AAPL', 'US', cents(40), { symbol: 'AAPL', market: 'US', price: 10, currency: 'USD', ts: LAST, stale: false }, 0.5, 'agent');
    // Pin the trade and the last snapshot to before the downtime.
    db.prepare('UPDATE trades SET executed_at = ?').run('2026-08-03T13:00:00.000Z');
    db.prepare('INSERT INTO equity_snapshots (round_id, ts, cash_cents, holdings_cents, equity_cents) VALUES (?, ?, 1000, 4000, 5000)').run(id, LAST);
    series = {
      AAPL: { currency: 'USD', bars: [bar('2026-08-03T14:00:00.000Z', 10), bar('2026-08-03T15:00:00.000Z', 11), bar('2026-08-03T16:00:00.000Z', 12), bar('2026-08-03T19:00:00.000Z', 99)] },
      'AUDUSD=X': { currency: 'USD', bars: [bar('2026-08-03T13:00:00.000Z', 0.5), bar('2026-08-03T16:00:00.000Z', 0.4)] },
    };
  });

  it('marks held positions to market at each bar inside the gap, converting USD to AUD', async () => {
    const qty = rounds.openPositions(id)[0].quantity;
    expect(await backfillEquity({ db, rounds, fetchBars }, NOW)).toBe(2);
    // Bars at/before the last snapshot and after `now` are excluded.
    expect(snapshots()).toEqual([
      { ts: LAST, cash_cents: 1000, holdings_cents: 4000, equity_cents: 5000 },
      { ts: '2026-08-03T15:00:00.000Z', cash_cents: 1000, holdings_cents: Math.round(qty * (11 / 0.5) * 100), equity_cents: 1000 + Math.round(qty * 22 * 100) },
      { ts: '2026-08-03T16:00:00.000Z', cash_cents: 1000, holdings_cents: Math.round(qty * (12 / 0.4) * 100), equity_cents: 1000 + Math.round(qty * 30 * 100) },
    ]);
  });

  it('does nothing for a normal short gap', async () => {
    expect(await backfillEquity({ db, rounds, fetchBars }, new Date('2026-08-03T14:20:00.000Z'))).toBe(0);
    expect(calls).toEqual([]);
  });

  it('skips a round that traded during the gap, since its holdings then are unknown', async () => {
    db.prepare('UPDATE trades SET executed_at = ?').run('2026-08-03T15:30:00.000Z');
    expect(await backfillEquity({ db, rounds, fetchBars }, NOW)).toBe(0);
    expect(snapshots()).toHaveLength(1);
  });

  it('fills an older gap that later snapshots have already closed, when given its end', async () => {
    db.prepare('INSERT INTO equity_snapshots (round_id, ts, cash_cents, holdings_cents, equity_cents) VALUES (?, ?, 1000, 6000, 7000)').run(id, NOW.toISOString());
    // At boot the latest snapshot is fresh, so nothing to do...
    expect(await backfillEquity({ db, rounds, fetchBars }, new Date('2026-08-03T18:35:00.000Z'))).toBe(0);
    // ...but targeting the gap's end fills it.
    expect(await backfillEquity({ db, rounds, fetchBars }, NOW)).toBe(2);
    expect(snapshots().map((s) => s.ts)).toEqual([LAST, '2026-08-03T15:00:00.000Z', '2026-08-03T16:00:00.000Z', NOW.toISOString()]);
  });

  it('never throws when the price fetch fails', async () => {
    const failing: BarFetcher = async () => {
      throw new Error('yahoo down');
    };
    expect(await backfillEquity({ db, rounds, fetchBars: failing }, NOW)).toBe(0);
    const event = db.prepare("SELECT kind FROM event_log WHERE kind = 'equity_backfill_failed'").get();
    expect(event).toEqual({ kind: 'equity_backfill_failed' });
  });
});
