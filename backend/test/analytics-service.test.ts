import { beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsService } from '../src/analytics/service.js';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, type RoundConfig } from '../src/engine/types.js';
import { MarketHistoryService, type BarFetcher } from '../src/market/history.js';
import { RoundService } from '../src/rounds/service.js';

const CONFIG: RoundConfig = {
  name: 'analytics round',
  startingBalanceCents: 5000,
  profitGoalCents: 100000,
  markets: ['US'],
  watchlist: ['AAPL'],
  riskProfile: 'balanced',
  tradingStyle: 'swing',
  guardrails: DEFAULT_GUARDRAILS,
  fees: DEFAULT_FEES,
  model: 'claude-sonnet-5',
  checkinCron: ['30 23 * * 1-5'],
};

/** Insert a trade + its order row directly: analytics is read-only, so seeding is explicit. */
function seedTrade(
  db: DB,
  roundId: number,
  over: {
    id: number; side: 'buy' | 'sell'; quantity: number; grossCents: number;
    feeCents?: number; at: string; symbol?: string;
  },
): void {
  const symbol = over.symbol ?? 'AAPL';
  db.prepare(
    `INSERT INTO orders (id, round_id, client_order_id, symbol, side, status, placed_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'filled', 'agent', ?)`,
  ).run(over.id, roundId, `order-${over.id}`, symbol, over.side, over.at);
  db.prepare(
    `INSERT INTO trades (order_id, round_id, symbol, side, quantity, price_aud, gross_cents, fee_cents, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    over.id, roundId, symbol, over.side, over.quantity,
    over.grossCents / over.quantity / 100, over.grossCents, over.feeCents ?? 0, over.at,
  );
}

const bars: BarFetcher = async () => ({
  currency: 'USD',
  bars: Array.from({ length: 30 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString(),
    open: 10 + i, high: 10 + i, low: 10 + i, close: 10 + i, volume: 100,
  })),
});

describe('AnalyticsService', () => {
  let db: DB;
  let service: AnalyticsService;
  let roundId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    const rounds = new RoundService(db, new PaperBroker(db));
    roundId = rounds.create(CONFIG);
    service = new AnalyticsService(db, rounds, new MarketHistoryService(db, bars));
  });

  it('summarises round trips for a round', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 2, grossCents: 2000, feeCents: 30, at: '2026-08-01T00:00:00.000Z' });
    seedTrade(db, roundId, { id: 2, side: 'sell', quantity: 2, grossCents: 3000, feeCents: 30, at: '2026-08-03T00:00:00.000Z' });

    const result = await service.roundAnalytics(roundId);

    expect(result.stats.closed).toBe(1);
    expect(result.stats.wins).toBe(1);
    expect(result.stats.totalNetCents).toBe(940);
    expect(result.trips[0]!.symbol).toBe('AAPL');
  });

  it('buckets returns for the histogram and exposes scatter points', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-01T00:00:00.000Z' });
    seedTrade(db, roundId, { id: 2, side: 'sell', quantity: 1, grossCents: 1200, at: '2026-08-02T00:00:00.000Z' });

    const result = await service.roundAnalytics(roundId);

    expect(result.histogram.reduce((sum, b) => sum + b.count, 0)).toBe(1);
    expect(result.scatter).toEqual([
      expect.objectContaining({ holdMs: 86_400_000, returnPct: 20, symbol: 'AAPL' }),
    ]);
  });

  it('accumulates fee and FX costs from the ledger', async () => {
    db.prepare(
      `INSERT INTO ledger_entries (round_id, type, amount_cents, balance_after_cents, note, created_at)
       VALUES (?, 'fee', -300, 4700, 'fee for buy AAPL', '2026-08-01T00:00:00.000Z')`,
    ).run(roundId);
    db.prepare(
      `INSERT INTO ledger_entries (round_id, type, amount_cents, balance_after_cents, note, created_at)
       VALUES (?, 'fee', -120, 4580, 'fee for sell AAPL', '2026-08-02T00:00:00.000Z')`,
    ).run(roundId);

    const result = await service.roundAnalytics(roundId);

    expect(result.costs.totalFeesCents).toBe(420);
    expect(result.costs.byDay).toEqual([
      { day: '2026-08-01', feesCents: 300 },
      { day: '2026-08-02', feesCents: 120 },
    ]);
  });

  it('splits fees by market using the ledger note', async () => {
    db.prepare(
      `INSERT INTO ledger_entries (round_id, type, amount_cents, balance_after_cents, note, created_at)
       VALUES (?, 'fee', -300, 4700, 'fee for buy BHP.AX', '2026-08-01T00:00:00.000Z')`,
    ).run(roundId);
    db.prepare(
      `INSERT INTO ledger_entries (round_id, type, amount_cents, balance_after_cents, note, created_at)
       VALUES (?, 'fee', -120, 4580, 'fee for buy AAPL', '2026-08-01T00:00:00.000Z')`,
    ).run(roundId);

    const result = await service.roundAnalytics(roundId);

    expect(result.costs.asxFeesCents).toBe(300);
    expect(result.costs.usFeesCents).toBe(120);
  });

  it('reports token spend and actions per check-in', async () => {
    db.prepare(
      `INSERT INTO checkins (id, round_id, ts, snapshot_json, actions_json, tokens_used, status)
       VALUES (1, ?, '2026-08-01T00:00:00.000Z', '{}', '[{"tool":"place_order"}]', 1200, 'success')`,
    ).run(roundId);
    db.prepare(
      `INSERT INTO journal_entries (round_id, checkin_id, author, note, created_at)
       VALUES (?, 1, 'agent', 'Bought the dip.', '2026-08-01T00:01:00.000Z')`,
    ).run(roundId);

    const result = await service.roundAnalytics(roundId);

    expect(result.checkins[0]).toMatchObject({ id: 1, tokensUsed: 1200, status: 'success', actions: ['place_order'] });
    expect(result.checkins[0]!.reasoning).toContain('Bought the dip.');
    expect(result.tokenTotals.checkinTokens).toBe(1200);
  });

  it('segments trades into config eras', async () => {
    db.prepare(
      `INSERT INTO config_events (round_id, changed_by, field, old_value, new_value, created_at)
       VALUES (?, 'operator', 'riskProfile', '"balanced"', '"aggressive"', '2026-08-02T00:00:00.000Z')`,
    ).run(roundId);
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-01T00:00:00.000Z' });
    seedTrade(db, roundId, { id: 2, side: 'sell', quantity: 1, grossCents: 1200, at: '2026-08-01T12:00:00.000Z' });
    seedTrade(db, roundId, { id: 3, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-03T00:00:00.000Z' });
    seedTrade(db, roundId, { id: 4, side: 'sell', quantity: 1, grossCents: 800, at: '2026-08-04T00:00:00.000Z' });

    const result = await service.roundAnalytics(roundId);

    expect(result.eras).toHaveLength(2);
    expect(result.eras[0]!.stats.closed).toBe(1);
    expect(result.eras[0]!.stats.totalNetCents).toBe(200);
    expect(result.eras[1]!.label).toContain('riskProfile');
    expect(result.eras[1]!.stats.totalNetCents).toBe(-200);
  });

  it('returns an empty-but-valid payload for a round that never traded', async () => {
    const result = await service.roundAnalytics(roundId);

    expect(result.stats.closed).toBe(0);
    expect(result.histogram).toEqual([]);
    expect(result.scatter).toEqual([]);
    expect(result.eras).toHaveLength(1);
  });

  it('throws for an unknown round', async () => {
    await expect(service.roundAnalytics(9999)).rejects.toThrow();
  });

  it('writes nothing to the database', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-01T00:00:00.000Z' });
    seedTrade(db, roundId, { id: 2, side: 'sell', quantity: 1, grossCents: 1200, at: '2026-08-02T00:00:00.000Z' });
    const before = ['trades', 'orders', 'ledger_entries', 'positions', 'rounds', 'checkins'].map(
      (t) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c,
    );

    await service.roundAnalytics(roundId);

    const after = ['trades', 'orders', 'ledger_entries', 'positions', 'rounds', 'checkins'].map(
      (t) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c,
    );
    expect(after).toEqual(before);
  });
});

describe('AnalyticsService era partitioning', () => {
  let db: DB;
  let service: AnalyticsService;
  let roundId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    const rounds = new RoundService(db, new PaperBroker(db));
    roundId = rounds.create(CONFIG);
    service = new AnalyticsService(db, rounds, new MarketHistoryService(db, bars));
  });

  it('eras always sum to the round total, even for trips predating the round row', async () => {
    db.prepare(
      `INSERT INTO config_events (round_id, changed_by, field, old_value, new_value, created_at)
       VALUES (?, 'operator', 'model', '"a"', '"b"', '2026-08-02T00:00:00.000Z')`,
    ).run(roundId);
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-01T00:00:00.000Z' });
    seedTrade(db, roundId, { id: 2, side: 'sell', quantity: 1, grossCents: 1200, at: '2026-08-01T12:00:00.000Z' });
    seedTrade(db, roundId, { id: 3, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-03T00:00:00.000Z' });
    seedTrade(db, roundId, { id: 4, side: 'sell', quantity: 1, grossCents: 900, at: '2026-08-04T00:00:00.000Z' });

    const result = await service.roundAnalytics(roundId);

    const eraClosed = result.eras.reduce((sum, era) => sum + era.stats.closed, 0);
    const eraNet = result.eras.reduce((sum, era) => sum + era.stats.totalNetCents, 0);
    expect(eraClosed).toBe(result.stats.closed);
    expect(eraNet).toBe(result.stats.totalNetCents);
  });
});

describe('AnalyticsService benchmarking', () => {
  let db: DB;
  let service: AnalyticsService;
  let roundId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    const rounds = new RoundService(db, new PaperBroker(db));
    roundId = rounds.create(CONFIG);
    service = new AnalyticsService(db, rounds, new MarketHistoryService(db, bars));
    db.prepare('UPDATE rounds SET created_at = ? WHERE id = ?').run('2026-08-01T00:00:00.000Z', roundId);
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO equity_snapshots (round_id, ts, cash_cents, holdings_cents, equity_cents)
         VALUES (?, ?, 0, 0, ?)`,
      ).run(roundId, new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString(), 5000 + i * 100);
    }
  });

  it('rebases the benchmark to the round starting balance', async () => {
    const benchmark = await service.benchmark(roundId, 'IVV');

    expect(benchmark.symbol).toBe('IVV');
    expect(benchmark.points[0]).toMatchObject({ equityCents: 5000, benchmarkCents: 5000 });
    // Benchmark close moves 10 -> 14 over five bars: +40% on a $50 bankroll.
    expect(benchmark.points[4]!.benchmarkCents).toBe(7000);
    expect(benchmark.points[4]!.equityCents).toBe(5400);
  });

  it('reports who is ahead', async () => {
    const benchmark = await service.benchmark(roundId, 'IVV');
    expect(benchmark.roundReturnPct).toBeCloseTo(8, 5);
    expect(benchmark.benchmarkReturnPct).toBeCloseTo(40, 5);
  });

  it('degrades gracefully when the benchmark has no data', async () => {
    const rounds = new RoundService(db, new PaperBroker(db));
    const empty = new AnalyticsService(db, rounds, new MarketHistoryService(db, async () => ({ currency: 'USD', bars: [] })));

    const benchmark = await empty.benchmark(roundId, 'IVV');

    expect(benchmark.points.every((p) => p.benchmarkCents === null)).toBe(true);
    expect(benchmark.benchmarkReturnPct).toBeNull();
  });

  it('survives a benchmark fetch failure', async () => {
    const rounds = new RoundService(db, new PaperBroker(db));
    const broken = new AnalyticsService(db, rounds, new MarketHistoryService(db, async () => {
      throw new Error('yahoo down');
    }));

    const benchmark = await broken.benchmark(roundId, 'IVV');

    expect(benchmark.points).toHaveLength(5);
    expect(benchmark.roundReturnPct).toBeCloseTo(8, 5);
    expect(benchmark.benchmarkReturnPct).toBeNull();
  });

  it('scores each trade against the price N bars later', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-01T00:00:00.000Z' });
    seedTrade(db, roundId, { id: 2, side: 'sell', quantity: 1, grossCents: 1100, at: '2026-08-03T00:00:00.000Z' });

    const outcomes = await service.decisionOutcomes(roundId);

    const sell = outcomes.find((o) => o.decision === 'sell')!;
    expect(sell.forward.find((f) => f.bars === 5)!.pricePct).toBeGreaterThan(0);
    expect(sell.verdict).toBe('sold early');
  });

  it('scores a pass - a check-in that placed no orders', async () => {
    db.prepare(
      `INSERT INTO checkins (id, round_id, ts, snapshot_json, actions_json, tokens_used, status)
       VALUES (1, ?, '2026-08-02T00:00:00.000Z', '{}', '[{"tool":"write_journal"}]', 900, 'success')`,
    ).run(roundId);

    const outcomes = await service.decisionOutcomes(roundId);

    const pass = outcomes.find((o) => o.decision === 'pass')!;
    expect(pass.symbol).toBe('AAPL');
    expect(pass.forward.some((f) => f.pricePct !== null)).toBe(true);
  });

  it('does not score a check-in that placed an order as a pass', async () => {
    db.prepare(
      `INSERT INTO checkins (id, round_id, ts, snapshot_json, actions_json, tokens_used, status)
       VALUES (1, ?, '2026-08-02T00:00:00.000Z', '{}', '[{"tool":"place_order"}]', 900, 'success')`,
    ).run(roundId);

    const outcomes = await service.decisionOutcomes(roundId);

    expect(outcomes.filter((o) => o.decision === 'pass')).toHaveLength(0);
  });

  it('marks a horizon null when there is no bar that far forward', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-29T00:00:00.000Z' });

    const outcomes = await service.decisionOutcomes(roundId);

    expect(outcomes[0]!.forward.find((f) => f.bars === 20)!.pricePct).toBeNull();
  });
});
