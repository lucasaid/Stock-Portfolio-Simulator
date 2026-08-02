import { describe, expect, it } from 'vitest';
import {
  bucketReturns, matchRoundTrips, summarizeRoundTrips, type AnalyticsTrade,
} from '../src/engine/analytics.js';

function trade(over: Partial<AnalyticsTrade> & Pick<AnalyticsTrade, 'id' | 'side'>): AnalyticsTrade {
  return {
    symbol: 'AAPL',
    quantity: 1,
    grossCents: 1000,
    feeCents: 0,
    executedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('matchRoundTrips', () => {
  it('matches one buy to one sell', () => {
    const trips = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 2, grossCents: 2000, feeCents: 30, executedAt: '2026-08-01T00:00:00.000Z' }),
      trade({ id: 2, side: 'sell', quantity: 2, grossCents: 3000, feeCents: 30, executedAt: '2026-08-03T00:00:00.000Z' }),
    ]);

    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      symbol: 'AAPL', quantity: 2, costCents: 2000, proceedsCents: 3000, feesCents: 60, netCents: 940,
    });
    expect(trips[0]!.returnPct).toBeCloseTo(47, 0);
    expect(trips[0]!.holdMs).toBe(2 * 86_400_000);
  });

  it('splits one sell across two earlier buys, oldest first', () => {
    const trips = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 1, grossCents: 1000, executedAt: '2026-08-01T00:00:00.000Z' }),
      trade({ id: 2, side: 'buy', quantity: 1, grossCents: 2000, executedAt: '2026-08-02T00:00:00.000Z' }),
      trade({ id: 3, side: 'sell', quantity: 2, grossCents: 4000, executedAt: '2026-08-03T00:00:00.000Z' }),
    ]);

    expect(trips).toHaveLength(2);
    expect(trips[0]!.costCents).toBe(1000);
    expect(trips[0]!.proceedsCents).toBe(2000);
    expect(trips[1]!.costCents).toBe(2000);
    expect(trips[1]!.proceedsCents).toBe(2000);
  });

  it('leaves a partially sold lot open for the remainder', () => {
    const trips = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 4, grossCents: 4000 }),
      trade({ id: 2, side: 'sell', quantity: 1, grossCents: 1500, executedAt: '2026-08-02T00:00:00.000Z' }),
    ]);

    expect(trips).toHaveLength(1);
    expect(trips[0]!.quantity).toBe(1);
    expect(trips[0]!.costCents).toBe(1000);
    expect(trips[0]!.proceedsCents).toBe(1500);
  });

  it('allocates fees proportionally to the matched quantity', () => {
    const trips = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 4, grossCents: 4000, feeCents: 400 }),
      trade({ id: 2, side: 'sell', quantity: 2, grossCents: 3000, feeCents: 100, executedAt: '2026-08-02T00:00:00.000Z' }),
    ]);

    // Half the buy fee (200) plus the whole sell fee (100).
    expect(trips[0]!.feesCents).toBe(300);
    expect(trips[0]!.netCents).toBe(3000 - 2000 - 300);
  });

  it('keeps symbols independent', () => {
    const trips = matchRoundTrips([
      trade({ id: 1, side: 'buy', symbol: 'AAPL', quantity: 1, grossCents: 1000 }),
      trade({ id: 2, side: 'buy', symbol: 'MSFT', quantity: 1, grossCents: 2000 }),
      trade({ id: 3, side: 'sell', symbol: 'MSFT', quantity: 1, grossCents: 2500, executedAt: '2026-08-02T00:00:00.000Z' }),
    ]);

    expect(trips).toHaveLength(1);
    expect(trips[0]!.symbol).toBe('MSFT');
  });

  it('ignores a sell with no matching lot rather than inventing one', () => {
    const trips = matchRoundTrips([trade({ id: 1, side: 'sell', quantity: 1, grossCents: 1000 })]);
    expect(trips).toEqual([]);
  });

  it('sorts input by execution time before matching', () => {
    const trips = matchRoundTrips([
      trade({ id: 2, side: 'sell', quantity: 1, grossCents: 1500, executedAt: '2026-08-05T00:00:00.000Z' }),
      trade({ id: 1, side: 'buy', quantity: 1, grossCents: 1000, executedAt: '2026-08-01T00:00:00.000Z' }),
    ]);

    expect(trips).toHaveLength(1);
    expect(trips[0]!.netCents).toBe(500);
  });

  it('handles fractional share quantities without cent drift', () => {
    const trips = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 0.3, grossCents: 1000 }),
      trade({ id: 2, side: 'sell', quantity: 0.3, grossCents: 1100, executedAt: '2026-08-02T00:00:00.000Z' }),
    ]);

    expect(trips[0]!.costCents).toBe(1000);
    expect(trips[0]!.proceedsCents).toBe(1100);
    expect(Number.isInteger(trips[0]!.netCents)).toBe(true);
  });

  it('never allocates more cost than the buy actually cost, across odd-cent partial sells', () => {
    // The adversarial case: an odd-cent lot sold in three uneven pieces. Rounding
    // each slice independently must not conjure or destroy cents overall.
    const trips = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 3, grossCents: 1000, feeCents: 101 }),
      trade({ id: 2, side: 'sell', quantity: 1, grossCents: 400, executedAt: '2026-08-02T00:00:00.000Z' }),
      trade({ id: 3, side: 'sell', quantity: 1, grossCents: 400, executedAt: '2026-08-03T00:00:00.000Z' }),
      trade({ id: 4, side: 'sell', quantity: 1, grossCents: 400, executedAt: '2026-08-04T00:00:00.000Z' }),
    ]);

    expect(trips).toHaveLength(3);
    // Exact, not merely close: allocation tracks the remainder, so a fully
    // consumed lot distributes every cent of its cost and fees. Rounding each
    // slice independently would give 999c and 99c here.
    expect(trips.reduce((sum, t) => sum + t.costCents, 0)).toBe(1000);
    expect(trips.reduce((sum, t) => sum + t.feesCents, 0)).toBe(101);
  });

  it('distributes the whole sell proceeds when one sell closes several lots', () => {
    const trips = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 1, grossCents: 500 }),
      trade({ id: 2, side: 'buy', quantity: 1, grossCents: 500, executedAt: '2026-08-02T00:00:00.000Z' }),
      trade({ id: 3, side: 'buy', quantity: 1, grossCents: 500, executedAt: '2026-08-03T00:00:00.000Z' }),
      trade({ id: 4, side: 'sell', quantity: 3, grossCents: 1000, feeCents: 100, executedAt: '2026-08-04T00:00:00.000Z' }),
    ]);

    expect(trips).toHaveLength(3);
    expect(trips.reduce((sum, t) => sum + t.proceedsCents, 0)).toBe(1000);
    expect(trips.reduce((sum, t) => sum + t.feesCents, 0)).toBe(100);
  });

  it('closes a lot exactly when the final slice is sold', () => {
    const trips = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 2, grossCents: 2000 }),
      trade({ id: 2, side: 'sell', quantity: 1, grossCents: 1200, executedAt: '2026-08-02T00:00:00.000Z' }),
      trade({ id: 3, side: 'sell', quantity: 1, grossCents: 1300, executedAt: '2026-08-03T00:00:00.000Z' }),
      // No lot remains, so this one must be ignored rather than matched.
      trade({ id: 4, side: 'sell', quantity: 1, grossCents: 999, executedAt: '2026-08-04T00:00:00.000Z' }),
    ]);

    expect(trips).toHaveLength(2);
    expect(trips.reduce((sum, t) => sum + t.costCents, 0)).toBe(2000);
  });
});

describe('summarizeRoundTrips', () => {
  const trips = matchRoundTrips([
    trade({ id: 1, side: 'buy', quantity: 1, grossCents: 1000, executedAt: '2026-08-01T00:00:00.000Z' }),
    trade({ id: 2, side: 'sell', quantity: 1, grossCents: 1400, executedAt: '2026-08-02T00:00:00.000Z' }),
    trade({ id: 3, side: 'buy', quantity: 1, grossCents: 1000, executedAt: '2026-08-03T00:00:00.000Z' }),
    trade({ id: 4, side: 'sell', quantity: 1, grossCents: 800, executedAt: '2026-08-04T00:00:00.000Z' }),
    trade({ id: 5, side: 'buy', quantity: 1, grossCents: 1000, executedAt: '2026-08-05T00:00:00.000Z' }),
    trade({ id: 6, side: 'sell', quantity: 1, grossCents: 1100, executedAt: '2026-08-07T00:00:00.000Z' }),
  ]);

  it('computes win rate, averages and profit factor', () => {
    const stats = summarizeRoundTrips(trips);

    expect(stats.closed).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRatePct).toBeCloseTo(66.67, 1);
    expect(stats.avgWinCents).toBe(250);
    expect(stats.avgLossCents).toBe(-200);
    expect(stats.totalNetCents).toBe(300);
    expect(stats.profitFactor).toBeCloseTo(2.5, 2);
  });

  it('reports median and average hold time', () => {
    const stats = summarizeRoundTrips(trips);
    expect(stats.medianHoldMs).toBe(86_400_000);
    expect(stats.avgHoldMs).toBeCloseTo((86_400_000 + 86_400_000 + 2 * 86_400_000) / 3, 0);
  });

  it('returns zeroed statistics for no trips rather than NaN', () => {
    const stats = summarizeRoundTrips([]);
    expect(stats).toMatchObject({
      closed: 0, wins: 0, losses: 0, winRatePct: 0, avgWinCents: 0, avgLossCents: 0, totalNetCents: 0,
    });
    expect(stats.profitFactor).toBeNull();
  });

  it('reports a null profit factor when there are no losses', () => {
    const winners = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 1, grossCents: 1000 }),
      trade({ id: 2, side: 'sell', quantity: 1, grossCents: 1400, executedAt: '2026-08-02T00:00:00.000Z' }),
    ]);
    expect(summarizeRoundTrips(winners).profitFactor).toBeNull();
  });

  it('treats a scratch trade as neither a win nor a loss', () => {
    const scratch = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 1, grossCents: 1000 }),
      trade({ id: 2, side: 'sell', quantity: 1, grossCents: 1000, executedAt: '2026-08-02T00:00:00.000Z' }),
    ]);
    const stats = summarizeRoundTrips(scratch);
    expect(stats).toMatchObject({ closed: 1, wins: 0, losses: 0, winRatePct: 0, totalNetCents: 0 });
  });
});

describe('bucketReturns', () => {
  it('buckets returns symmetrically around zero', () => {
    const buckets = bucketReturns([-12, -3, 0.5, 4, 4.5, 22], 5);
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(6);
    const positive = buckets.filter((b) => b.fromPct >= 0).reduce((sum, b) => sum + b.count, 0);
    expect(positive).toBe(4);
  });

  it('puts a value on a boundary in the upper bucket', () => {
    const buckets = bucketReturns([5], 5);
    const hit = buckets.find((b) => b.count === 1)!;
    expect(hit.fromPct).toBe(5);
  });

  it('returns an empty array for no data', () => {
    expect(bucketReturns([], 5)).toEqual([]);
  });
});
