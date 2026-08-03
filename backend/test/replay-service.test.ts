import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, type RoundConfig } from '../src/engine/types.js';
import { MarketHistoryService, type BarFetcher } from '../src/market/history.js';
import { ReplayService, SWEEP_STOP_LOSS_PCTS } from '../src/replay/service.js';
import { RoundService } from '../src/rounds/service.js';

const CONFIG: RoundConfig = {
  name: 'replay round',
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

/** Insert a trade + its order row directly, mirroring analytics-service.test.ts. */
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

const NOW = Date.UTC(2026, 7, 3);

/** 10 daily bars, flat at 10, unless a day index is overridden. */
function makeBars(overrides: Record<number, number> = {}): BarFetcher {
  return async () => ({
    currency: 'USD',
    bars: Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(NOW - (9 - i) * 86_400_000).toISOString(),
      open: overrides[i] ?? 10, high: overrides[i] ?? 10, low: overrides[i] ?? 10, close: overrides[i] ?? 10,
      volume: 100,
    })),
  });
}

describe('ReplayService', () => {
  let db: DB;
  let rounds: RoundService;
  let roundId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    roundId = rounds.create(CONFIG);
  });

  it('replays a round under its own real config when there are no overrides', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: new Date(NOW - 8 * 86_400_000).toISOString() });
    const service = new ReplayService(db, rounds, new MarketHistoryService(db, makeBars()));

    const result = await service.replay(roundId, {});
    expect(result.insufficientHistory).toBe(false);
    expect(result.finalCashCents).toBe(5000 - 1000);
  });

  it('a tighter stopLossPct override fires more stops', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: new Date(NOW - 8 * 86_400_000).toISOString() });
    const bars = makeBars({ 3: 9.2 }); // -8% dip on day index 3, then flat
    const service = new ReplayService(db, rounds, new MarketHistoryService(db, bars));

    const loose = await service.replay(roundId, { stopLossPct: 10 });
    const tight = await service.replay(roundId, { stopLossPct: 5 });

    expect(loose.stopLossFirings).toHaveLength(0);
    expect(tight.stopLossFirings).toHaveLength(1);
  });

  it('sweeps every configured stop-loss percentage, one result each, labelled', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: new Date(NOW - 8 * 86_400_000).toISOString() });
    const service = new ReplayService(db, rounds, new MarketHistoryService(db, makeBars()));

    const sweep = await service.sweep(roundId);
    expect(sweep).toHaveLength(SWEEP_STOP_LOSS_PCTS.length);
    for (const entry of sweep) expect(typeof entry.label).toBe('string');
  });

  it('marks which sweep entry is the round real configuration', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: new Date(NOW - 8 * 86_400_000).toISOString() });
    const service = new ReplayService(db, rounds, new MarketHistoryService(db, makeBars()));

    const sweep = await service.sweep(roundId);
    const actual = sweep.filter((entry) => entry.actual);
    expect(actual).toHaveLength(1);
    expect(actual[0]!.stopLossPct).toBe(CONFIG.guardrails.stopLossPct);
  });

  it('throws for an unknown round', async () => {
    const service = new ReplayService(db, rounds, new MarketHistoryService(db, makeBars()));
    await expect(service.replay(9999, {})).rejects.toThrow();
    await expect(service.sweep(9999)).rejects.toThrow();
  });

  it('flags insufficientHistory when the round has no OHLC bars', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: new Date(NOW - 8 * 86_400_000).toISOString() });
    const emptyBars: BarFetcher = async () => ({ currency: 'USD', bars: [] });
    const service = new ReplayService(db, rounds, new MarketHistoryService(db, emptyBars));

    const result = await service.replay(roundId, {});
    expect(result.insufficientHistory).toBe(true);
  });

  it('writes nothing to the database', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: new Date(NOW - 8 * 86_400_000).toISOString() });
    seedTrade(db, roundId, { id: 2, side: 'sell', quantity: 1, grossCents: 1200, at: new Date(NOW - 6 * 86_400_000).toISOString() });
    const service = new ReplayService(db, rounds, new MarketHistoryService(db, makeBars()));

    const tables = ['trades', 'orders', 'ledger_entries', 'positions', 'rounds', 'checkins'];
    const before = tables.map((t) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);

    await service.sweep(roundId);

    const after = tables.map((t) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
    expect(after).toEqual(before);
  });
});
