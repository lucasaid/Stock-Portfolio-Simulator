# Phase 1 Analytics Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every analytics bullet in spec §6 — win rate, trade P/L histogram, average win vs average loss, hold-time vs return scatter, decision-outcome tracking, index benchmarking, the per-check-in token/action ledger, cross-round comparison overlays, config-era segmentation, and fee/FX accumulation — as a backend analytics API plus an Analytics section in the dashboard.

**Architecture:** All statistics derive from the append-only ledger; nothing new is written to the money tables. A pure engine module (`engine/analytics.ts`) does FIFO round-trip matching and the statistics — no I/O, so it is exhaustively unit-testable. A service layer (`analytics/service.ts`) reads rows, calls the pure functions, and reaches into `MarketHistoryService` for forward-return and benchmark data. Routes are read-only. On the frontend, analytics live at `/analytics` (cross-round) and in an `analytics` tab on each round; histogram and scatter are hand-rolled SVG components (a candle engine is the wrong tool), while the benchmark and comparison overlays reuse `lightweight-charts`.

**Tech Stack:** Unchanged from Plan 4 — backend TypeScript strict ESM + vitest, frontend React 19 + Vite + TanStack Query + `lightweight-charts` 5 + Testing Library + msw.

---

## Prerequisites

**Plan 4 must be merged to `master` first.** This plan depends on:
- `MarketHistoryService` and the `ohlc_bars` table (Plan 4 Task 1) for forward returns and benchmarks.
- `SymbolRegistry` (Plan 4 Task 2).
- The frontend workspace, `apiFetch`, `qk`, the chart components and `test/server.ts` (Plan 4 Tasks 4–7).
- `frontend/src/lib/format.ts`.

Read `CLAUDE.md` (**Hard-won invariants**) before starting. The two that matter most here:

- **Money is integer AUD cents.** Every statistic that is money stays in cents through the API. Percentages and ratios are floats, clearly named `...Pct` or `...Ratio`. Never send dollars.
- **Analytics is read-only.** No task in this plan may write to `trades`, `ledger_entries`, `positions`, `rounds` or `orders`. If a computation seems to need a write, it needs a cache table instead — and no task here does.

Record the observed test totals when you start; the numbers below assume Plan 4 landed at roughly 219 backend and roughly 90 frontend tests, but report what you actually see.

---

## File Structure

**Backend — created:**

| File | Responsibility |
| --- | --- |
| `backend/src/engine/analytics.ts` | Pure: FIFO round-trip matching, win/loss statistics, histogram bucketing, hold times. No I/O. |
| `backend/src/analytics/service.ts` | Reads rows, calls the pure functions, adds forward returns, benchmark series, era segmentation, cost and token totals. |
| `backend/src/api/analytics-routes.ts` | `/api/analytics/...` read-only endpoints. |
| `backend/test/analytics-engine.test.ts` | Pure-function tests, including the awkward partial-fill cases. |
| `backend/test/analytics-service.test.ts` | Service tests over a seeded in-memory database. |
| `backend/test/api-analytics.test.ts` | Route auth, shape and validation. |

**Backend — modified:** `backend/src/api/app.ts` (mount routes, `ApiDeps.analytics`), `backend/src/index.ts` (wire), `backend/test/api-helper.ts` (build the service), `backend/src/settings/store.ts` (benchmark symbol defaults).

**Frontend — created:**

| File | Responsibility |
| --- | --- |
| `src/api/analytics.ts` | Analytics response types + query hooks. |
| `src/components/charts/Histogram.tsx` | SVG bar histogram with a zero line. |
| `src/components/charts/Scatter.tsx` | SVG scatter with axes. |
| `src/components/charts/ComparisonChart.tsx` | Multi-series normalised line chart (lightweight-charts). |
| `src/pages/AnalyticsPage.tsx` | Cross-round page: comparison overlay, aggregate stats. |
| `src/pages/round/AnalyticsTab.tsx` | Per-round: stats cards, histogram, scatter, benchmark, eras, costs. |
| `src/pages/round/DecisionsTable.tsx` | Decision-outcome tracking. |
| `src/pages/round/CheckinLedger.tsx` | Per-check-in tokens, actions and linked reasoning. |
| `test/analytics-*.test.tsx` | Component and page tests. |

**Frontend — modified:** `src/App.tsx` (route), `src/shell/AppShell.tsx` (nav link), `src/pages/RoundDetailPage.tsx` (tab), `test/server.ts` (fixtures).

---

## Task 1: Pure round-trip matching and statistics

Everything downstream depends on turning a stream of buys and sells into closed round trips. FIFO, in cents, with fees allocated proportionally. Pure function, no database.

**Files:**
- Create: `backend/src/engine/analytics.ts`
- Create: `backend/test/analytics-engine.test.ts`

- [ ] **Step 1: Write the failing test**

`backend/test/analytics-engine.test.ts`:

```ts
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
    expect(stats).toMatchObject({ closed: 0, wins: 0, losses: 0, winRatePct: 0, avgWinCents: 0, avgLossCents: 0, totalNetCents: 0 });
    expect(stats.profitFactor).toBeNull();
  });

  it('reports a null profit factor when there are no losses', () => {
    const winners = matchRoundTrips([
      trade({ id: 1, side: 'buy', quantity: 1, grossCents: 1000 }),
      trade({ id: 2, side: 'sell', quantity: 1, grossCents: 1400, executedAt: '2026-08-02T00:00:00.000Z' }),
    ]);
    expect(summarizeRoundTrips(winners).profitFactor).toBeNull();
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test -- analytics-engine`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pure module**

`backend/src/engine/analytics.ts`:

```ts
/**
 * Pure analytics. No I/O, no database — every function here takes plain data.
 * Money is integer AUD cents throughout; percentages and ratios are floats.
 */

export interface AnalyticsTrade {
  id: number;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  grossCents: number;
  feeCents: number;
  executedAt: string;
}

export interface RoundTrip {
  symbol: string;
  quantity: number;
  buyTradeId: number;
  sellTradeId: number;
  openedAt: string;
  closedAt: string;
  costCents: number;
  proceedsCents: number;
  feesCents: number;
  /** proceeds − cost − fees. */
  netCents: number;
  /** Net return against the matched cost. */
  returnPct: number;
  holdMs: number;
}

interface OpenLot {
  tradeId: number;
  symbol: string;
  remaining: number;
  originalQty: number;
  grossCents: number;
  feeCents: number;
  executedAt: string;
}

/**
 * FIFO lot matching. A sell consumes the oldest open lots for its symbol; fees
 * on both sides are allocated in proportion to the matched quantity. Sells with
 * no open lot are skipped rather than fabricated — the round service guarantees
 * they cannot happen, and inventing a zero-cost lot would report a fake win.
 */
export function matchRoundTrips(trades: AnalyticsTrade[]): RoundTrip[] {
  const ordered = [...trades].sort(
    (a, b) => Date.parse(a.executedAt) - Date.parse(b.executedAt) || a.id - b.id,
  );
  const open = new Map<string, OpenLot[]>();
  const trips: RoundTrip[] = [];

  for (const trade of ordered) {
    if (trade.side === 'buy') {
      const lots = open.get(trade.symbol) ?? [];
      lots.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        remaining: trade.quantity,
        originalQty: trade.quantity,
        grossCents: trade.grossCents,
        feeCents: trade.feeCents,
        executedAt: trade.executedAt,
      });
      open.set(trade.symbol, lots);
      continue;
    }

    let unmatched = trade.quantity;
    const lots = open.get(trade.symbol) ?? [];
    while (unmatched > 1e-9 && lots.length > 0) {
      const lot = lots[0]!;
      const matched = Math.min(unmatched, lot.remaining);
      const buyShare = lot.originalQty === 0 ? 0 : matched / lot.originalQty;
      const sellShare = trade.quantity === 0 ? 0 : matched / trade.quantity;

      const costCents = Math.round(lot.grossCents * buyShare);
      const proceedsCents = Math.round(trade.grossCents * sellShare);
      const feesCents = Math.round(lot.feeCents * buyShare) + Math.round(trade.feeCents * sellShare);
      const netCents = proceedsCents - costCents - feesCents;

      trips.push({
        symbol: trade.symbol,
        quantity: matched,
        buyTradeId: lot.tradeId,
        sellTradeId: trade.id,
        openedAt: lot.executedAt,
        closedAt: trade.executedAt,
        costCents,
        proceedsCents,
        feesCents,
        netCents,
        returnPct: costCents === 0 ? 0 : (netCents / costCents) * 100,
        holdMs: Date.parse(trade.executedAt) - Date.parse(lot.executedAt),
      });

      lot.remaining -= matched;
      unmatched -= matched;
      if (lot.remaining <= 1e-9) lots.shift();
    }
    open.set(trade.symbol, lots);
  }

  return trips;
}

export interface RoundTripStats {
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinCents: number;
  /** Negative, or 0 when there were no losses. */
  avgLossCents: number;
  bestCents: number;
  worstCents: number;
  totalNetCents: number;
  totalFeesCents: number;
  /** Gross wins ÷ gross losses. Null when there are no losses to divide by. */
  profitFactor: number | null;
  avgHoldMs: number;
  medianHoldMs: number;
  avgReturnPct: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function summarizeRoundTrips(trips: RoundTrip[]): RoundTripStats {
  const wins = trips.filter((t) => t.netCents > 0);
  const losses = trips.filter((t) => t.netCents < 0);
  const grossWin = wins.reduce((sum, t) => sum + t.netCents, 0);
  const grossLoss = losses.reduce((sum, t) => sum + Math.abs(t.netCents), 0);

  return {
    closed: trips.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trips.length === 0 ? 0 : (wins.length / trips.length) * 100,
    avgWinCents: wins.length === 0 ? 0 : Math.round(grossWin / wins.length),
    avgLossCents: losses.length === 0 ? 0 : -Math.round(grossLoss / losses.length),
    bestCents: trips.length === 0 ? 0 : Math.max(...trips.map((t) => t.netCents)),
    worstCents: trips.length === 0 ? 0 : Math.min(...trips.map((t) => t.netCents)),
    totalNetCents: trips.reduce((sum, t) => sum + t.netCents, 0),
    totalFeesCents: trips.reduce((sum, t) => sum + t.feesCents, 0),
    profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    avgHoldMs: Math.round(mean(trips.map((t) => t.holdMs))),
    medianHoldMs: Math.round(median(trips.map((t) => t.holdMs))),
    avgReturnPct: mean(trips.map((t) => t.returnPct)),
  };
}

export interface ReturnBucket {
  fromPct: number;
  toPct: number;
  count: number;
}

/**
 * Buckets percentage returns into fixed-width bins aligned on zero, so wins and
 * losses stay visually symmetric. A value exactly on a boundary lands in the
 * upper bucket.
 */
export function bucketReturns(returnsPct: number[], widthPct = 5): ReturnBucket[] {
  if (returnsPct.length === 0) return [];
  const lowest = Math.floor(Math.min(...returnsPct) / widthPct) * widthPct;
  const highest = Math.floor(Math.max(...returnsPct) / widthPct) * widthPct + widthPct;

  const buckets: ReturnBucket[] = [];
  for (let from = lowest; from < highest; from += widthPct) {
    buckets.push({ fromPct: from, toPct: from + widthPct, count: 0 });
  }
  for (const value of returnsPct) {
    const index = Math.min(buckets.length - 1, Math.floor((value - lowest) / widthPct));
    buckets[index]!.count += 1;
  }
  return buckets;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npm test -- analytics-engine && npx tsc --noEmit`
Expected: 16 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/engine/analytics.ts backend/test/analytics-engine.test.ts
git commit -m "feat: pure FIFO round-trip matching and trade statistics"
```

---

## Task 2: Analytics service — per-round statistics, costs, eras and check-in ledger

**Files:**
- Create: `backend/src/analytics/service.ts`
- Create: `backend/test/analytics-service.test.ts`

- [ ] **Step 1: Write the failing test**

`backend/test/analytics-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsService } from '../src/analytics/service.js';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MarketHistoryService, type BarFetcher } from '../src/market/history.js';
import { RoundService } from '../src/rounds/service.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, type RoundConfig } from '../src/engine/types.js';

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
  over: { id: number; side: 'buy' | 'sell'; quantity: number; grossCents: number; feeCents?: number; at: string; symbol?: string },
): void {
  const symbol = over.symbol ?? 'AAPL';
  db.prepare(
    `INSERT INTO orders (id, round_id, client_order_id, symbol, side, status, placed_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'filled', 'agent', ?)`,
  ).run(over.id, roundId, `order-${over.id}`, symbol, over.side, over.at);
  db.prepare(
    `INSERT INTO trades (order_id, round_id, symbol, side, quantity, price_aud, gross_cents, fee_cents, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(over.id, roundId, symbol, over.side, over.quantity, over.grossCents / over.quantity / 100, over.grossCents, over.feeCents ?? 0, over.at);
}

describe('AnalyticsService', () => {
  let db: DB;
  let service: AnalyticsService;
  let roundId: number;

  const bars: BarFetcher = async () => ({
    currency: 'USD',
    bars: Array.from({ length: 30 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString(),
      open: 10 + i, high: 10 + i, low: 10 + i, close: 10 + i, volume: 100,
    })),
  });

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
    expect(result.scatter).toEqual([expect.objectContaining({ holdMs: 86_400_000, returnPct: 20, symbol: 'AAPL' })]);
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test -- analytics-service`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

`backend/src/analytics/service.ts`. Task 3 adds benchmarks and decision outcomes to this same class; write the file with those methods stubbed out only if the task text says so — here, write exactly what is below.

```ts
import type { DB } from '../db/connection.js';
import {
  bucketReturns, matchRoundTrips, summarizeRoundTrips,
  type AnalyticsTrade, type ReturnBucket, type RoundTrip, type RoundTripStats,
} from '../engine/analytics.js';
import type { MarketHistoryService } from '../market/history.js';
import type { RoundService } from '../rounds/service.js';

export interface ScatterPoint {
  symbol: string;
  holdMs: number;
  returnPct: number;
  netCents: number;
  closedAt: string;
}

export interface CostBreakdown {
  totalFeesCents: number;
  /** FX cost is charged inside fees at fill time; this is the US-symbol share of them. */
  usFeesCents: number;
  asxFeesCents: number;
  byDay: { day: string; feesCents: number }[];
}

export interface CheckinLedgerRow {
  id: number;
  ts: string;
  status: string;
  tokensUsed: number;
  actions: string[];
  reasoning: string[];
}

export interface ConfigEra {
  label: string;
  from: string;
  to: string | null;
  stats: RoundTripStats;
}

export interface RoundAnalytics {
  roundId: number;
  stats: RoundTripStats;
  trips: RoundTrip[];
  histogram: ReturnBucket[];
  scatter: ScatterPoint[];
  costs: CostBreakdown;
  checkins: CheckinLedgerRow[];
  tokenTotals: { checkinTokens: number; checkins: number };
  eras: ConfigEra[];
}

interface TradeRow {
  id: number;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  gross_cents: number;
  fee_cents: number;
  executed_at: string;
}

function toAnalyticsTrade(row: TradeRow): AnalyticsTrade {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    grossCents: row.gross_cents,
    feeCents: row.fee_cents,
    executedAt: row.executed_at,
  };
}

function parseActions(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as { tool?: string }[];
    return parsed.map((a) => a.tool).filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
}

export class AnalyticsService {
  constructor(private db: DB, private rounds: RoundService, private history: MarketHistoryService) {}

  async roundAnalytics(roundId: number): Promise<RoundAnalytics> {
    // Throws for an unknown round — the routes turn that into a 404.
    this.rounds.get(roundId);

    const trades = this.tradeRows(roundId);
    const trips = matchRoundTrips(trades.map(toAnalyticsTrade));

    return {
      roundId,
      stats: summarizeRoundTrips(trips),
      trips,
      histogram: bucketReturns(trips.map((t) => t.returnPct)),
      scatter: trips.map((t) => ({
        symbol: t.symbol, holdMs: t.holdMs, returnPct: t.returnPct, netCents: t.netCents, closedAt: t.closedAt,
      })),
      costs: this.costs(roundId),
      checkins: this.checkinLedger(roundId),
      tokenTotals: this.tokenTotals(roundId),
      eras: this.eras(roundId, trades),
    };
  }

  private tradeRows(roundId: number): TradeRow[] {
    return this.db
      .prepare('SELECT id, symbol, side, quantity, gross_cents, fee_cents, executed_at FROM trades WHERE round_id = ? ORDER BY executed_at, id')
      .all(roundId) as TradeRow[];
  }

  private costs(roundId: number): CostBreakdown {
    const rows = this.db
      .prepare("SELECT amount_cents, note, created_at FROM ledger_entries WHERE round_id = ? AND type = 'fee' ORDER BY id")
      .all(roundId) as { amount_cents: number; note: string | null; created_at: string }[];

    const byDay = new Map<string, number>();
    let total = 0;
    let asx = 0;
    for (const row of rows) {
      const cents = -row.amount_cents; // fees are stored as negative cash movements
      total += cents;
      const day = row.created_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + cents);
      if (row.note?.includes('.AX') === true) asx += cents;
    }

    return {
      totalFeesCents: total,
      asxFeesCents: asx,
      usFeesCents: total - asx,
      byDay: [...byDay.entries()].map(([day, feesCents]) => ({ day, feesCents })).sort((a, b) => (a.day < b.day ? -1 : 1)),
    };
  }

  private checkinLedger(roundId: number): CheckinLedgerRow[] {
    const rows = this.db
      .prepare('SELECT id, ts, status, tokens_used, actions_json FROM checkins WHERE round_id = ? ORDER BY id DESC LIMIT 500')
      .all(roundId) as { id: number; ts: string; status: string; tokens_used: number | null; actions_json: string }[];

    const notes = this.db
      .prepare('SELECT checkin_id, note FROM journal_entries WHERE round_id = ? AND checkin_id IS NOT NULL ORDER BY id')
      .all(roundId) as { checkin_id: number; note: string }[];

    const byCheckin = new Map<number, string[]>();
    for (const note of notes) {
      const list = byCheckin.get(note.checkin_id) ?? [];
      list.push(note.note);
      byCheckin.set(note.checkin_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      status: row.status,
      tokensUsed: row.tokens_used ?? 0,
      actions: parseActions(row.actions_json),
      reasoning: byCheckin.get(row.id) ?? [],
    }));
  }

  private tokenTotals(roundId: number): { checkinTokens: number; checkins: number } {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(tokens_used), 0) AS tokens, COUNT(*) AS n FROM checkins WHERE round_id = ?')
      .get(roundId) as { tokens: number; n: number };
    return { checkinTokens: row.tokens, checkins: row.n };
  }

  /**
   * Config-era segmentation (spec §6): a round's history is split at every
   * config change so a "the aggressive era lost money" comparison is possible.
   * A trip belongs to the era containing its close.
   */
  private eras(roundId: number, trades: TradeRow[]): ConfigEra[] {
    const round = this.rounds.get(roundId);
    const createdAt = (this.db.prepare('SELECT created_at FROM rounds WHERE id = ?').get(roundId) as { created_at: string })
      .created_at;

    const changes = this.db
      .prepare('SELECT field, new_value, created_at FROM config_events WHERE round_id = ? ORDER BY created_at, id')
      .all(roundId) as { field: string; new_value: string | null; created_at: string }[];

    const boundaries = [{ label: 'initial config', at: createdAt }].concat(
      changes.map((change) => ({ label: `${change.field} → ${change.new_value ?? 'null'}`, at: change.created_at })),
    );

    const trips = matchRoundTrips(trades.map(toAnalyticsTrade));
    return boundaries.map((boundary, index) => {
      const next = boundaries[index + 1]?.at ?? null;
      const inEra = trips.filter((trip) => {
        const closed = Date.parse(trip.closedAt);
        return closed >= Date.parse(boundary.at) && (next === null || closed < Date.parse(next));
      });
      return { label: boundary.label, from: boundary.at, to: next, stats: summarizeRoundTrips(inEra) };
    });
  }
}

/** Referenced by the round list endpoint in Task 4; kept here so the shape stays in one place. */
export type { RoundTrip, RoundTripStats };
```

Note the unused `round` and `history` members at this stage — `history` is used in Task 3 and `round` should be removed if the linter complains. Keep the constructor signature; Task 3 depends on it.

- [ ] **Step 4: Run the tests**

Run: `cd backend && npm test -- analytics-service && npx tsc --noEmit`
Expected: 7 tests pass. Remove the unused local `round` binding in `eras` if `noUnusedLocals` fires.

- [ ] **Step 5: Commit**

```bash
git add backend/src/analytics/service.ts backend/test/analytics-service.test.ts
git commit -m "feat: analytics service - stats, costs, check-in ledger, config eras"
```

---

## Task 3: Benchmarking and decision-outcome tracking

Spec §6: "Benchmark: round equity vs index-ETF-on-day-one over the same period" and "Decision-outcome tracking: price N days after each buy/sell/pass."

**Files:**
- Modify: `backend/src/analytics/service.ts`
- Modify: `backend/src/settings/store.ts` (benchmark symbol defaults)
- Modify: `backend/test/analytics-service.test.ts` (new cases)

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/analytics-service.test.ts`:

```ts
describe('AnalyticsService benchmarking', () => {
  let db: DB;
  let service: AnalyticsService;
  let roundId: number;

  const bars: BarFetcher = async () => ({
    currency: 'USD',
    bars: Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString(),
      // 10, 11, 12 … a clean +10% per bar off the base.
      open: 10 + i, high: 10 + i, low: 10 + i, close: 10 + i, volume: 100,
    })),
  });

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
    // Benchmark close moves 10 → 14 over five bars: +40% on a $50 bankroll.
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

  it('scores each trade against the price N bars later', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-01T00:00:00.000Z' });
    seedTrade(db, roundId, { id: 2, side: 'sell', quantity: 1, grossCents: 1100, at: '2026-08-03T00:00:00.000Z' });

    const outcomes = await service.decisionOutcomes(roundId);

    const sell = outcomes.find((o) => o.decision === 'sell')!;
    // Sold at bar 2 (close 12); five bars later would be bar 7 (close 17) but the
    // fixture only runs to bar 9, so the horizon still resolves.
    expect(sell.forward.find((f) => f.bars === 5)!.pricePct).toBeGreaterThan(0);
    expect(sell.verdict).toBe('sold early');
  });

  it('scores a pass — a check-in that placed no orders', async () => {
    db.prepare(
      `INSERT INTO checkins (id, round_id, ts, snapshot_json, actions_json, tokens_used, status)
       VALUES (1, ?, '2026-08-02T00:00:00.000Z', '{}', '[{"tool":"write_journal"}]', 900, 'success')`,
    ).run(roundId);

    const outcomes = await service.decisionOutcomes(roundId);

    const pass = outcomes.find((o) => o.decision === 'pass')!;
    expect(pass.symbol).toBe('AAPL');
    expect(pass.forward.some((f) => f.pricePct !== null)).toBe(true);
  });

  it('marks a horizon null when there is no bar that far forward', async () => {
    seedTrade(db, roundId, { id: 1, side: 'buy', quantity: 1, grossCents: 1000, at: '2026-08-09T00:00:00.000Z' });

    const outcomes = await service.decisionOutcomes(roundId);

    expect(outcomes[0]!.forward.find((f) => f.bars === 20)!.pricePct).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test -- analytics-service`
Expected: FAIL — `service.benchmark is not a function`.

- [ ] **Step 3: Add the benchmark default setting**

In `backend/src/settings/store.ts`, extend `IntegrationSettings` and its default:

```ts
export interface IntegrationSettings {
  ntfy: NtfySettings;
  pollIntervalMinutes: number;
  /** Index ETF the analytics benchmark compares each round against (spec §6). */
  benchmarkSymbol: string;
}
```

```ts
  integrations: {
    ntfy: { url: 'https://ntfy.sh', topic: '', enabled: false },
    pollIntervalMinutes: 5,
    benchmarkSymbol: 'IVV',
  },
```

`SettingsStore.get` shallow-merges over the defaults, so an existing settings row without the key still resolves to `IVV`. Update `settings-store.test.ts` if it asserts the exact defaults object, and report it as a sanctioned deviation.

- [ ] **Step 4: Add the methods**

Append to `AnalyticsService` in `backend/src/analytics/service.ts`, and add the exported types near the others:

```ts
export interface BenchmarkPoint {
  ts: string;
  equityCents: number;
  /** Null when the benchmark has no bar at or before this timestamp. */
  benchmarkCents: number | null;
}

export interface BenchmarkResult {
  symbol: string;
  points: BenchmarkPoint[];
  roundReturnPct: number | null;
  benchmarkReturnPct: number | null;
}

export type Decision = 'buy' | 'sell' | 'pass';

export interface ForwardReturn {
  bars: number;
  /** Percent move from the decision price to the price that many bars later. */
  pricePct: number | null;
}

export interface DecisionOutcome {
  at: string;
  decision: Decision;
  symbol: string;
  /** Trade price for buy/sell; the bar close at the check-in for a pass. */
  priceAud: number | null;
  forward: ForwardReturn[];
  /** Plain-language read of the forward moves. */
  verdict: string;
}
```

```ts
  /**
   * Round equity against "what if I had bought the index on day one".
   * Both series are rebased to the round's starting balance so they share an axis.
   */
  async benchmark(roundId: number, symbol: string): Promise<BenchmarkResult> {
    const round = this.rounds.get(roundId);
    const snapshots = this.db
      .prepare('SELECT ts, equity_cents FROM equity_snapshots WHERE round_id = ? ORDER BY ts')
      .all(roundId) as { ts: string; equity_cents: number }[];

    let bars: { ts: string; close: number }[] = [];
    try {
      bars = (await this.history.history(symbol, 'ALL')).bars.map((bar) => ({ ts: bar.ts, close: bar.close }));
    } catch {
      bars = []; // spec §7: a data outage degrades the comparison, it does not fail the page
    }

    const base = round.starting_balance_cents;
    const firstClose = bars.find((bar) => Date.parse(bar.ts) <= Date.parse(snapshots[0]?.ts ?? ''))?.close ?? bars[0]?.close;

    const points: BenchmarkPoint[] = snapshots.map((snapshot) => ({
      ts: snapshot.ts,
      equityCents: snapshot.equity_cents,
      benchmarkCents:
        firstClose === undefined ? null : this.benchmarkValue(bars, snapshot.ts, firstClose, base),
    }));

    const firstEquity = snapshots[0]?.equity_cents ?? null;
    const lastEquity = snapshots[snapshots.length - 1]?.equity_cents ?? null;
    const lastBenchmark = points[points.length - 1]?.benchmarkCents ?? null;

    return {
      symbol,
      points,
      roundReturnPct:
        firstEquity === null || lastEquity === null || firstEquity === 0
          ? null
          : ((lastEquity - firstEquity) / firstEquity) * 100,
      benchmarkReturnPct: lastBenchmark === null || base === 0 ? null : ((lastBenchmark - base) / base) * 100,
    };
  }

  /** Last close at or before `ts`, rebased onto the round's starting balance. */
  private benchmarkValue(bars: { ts: string; close: number }[], ts: string, firstClose: number, baseCents: number): number | null {
    const at = Date.parse(ts);
    let close: number | null = null;
    for (const bar of bars) {
      if (Date.parse(bar.ts) > at) break;
      close = bar.close;
    }
    if (close === null || firstClose === 0) return null;
    return Math.round((close / firstClose) * baseCents);
  }

  /**
   * Decision-outcome tracking (spec §6). Every trade, plus every check-in that
   * placed no orders (a "pass"), is scored against where the price went next.
   */
  async decisionOutcomes(roundId: number, horizons = [1, 5, 20]): Promise<DecisionOutcome[]> {
    const config = this.rounds.config(roundId);
    const trades = this.db
      .prepare('SELECT symbol, side, price_aud, executed_at FROM trades WHERE round_id = ? ORDER BY executed_at')
      .all(roundId) as { symbol: string; side: 'buy' | 'sell'; price_aud: number; executed_at: string }[];

    const passes = this.db
      .prepare(`SELECT id, ts, actions_json FROM checkins WHERE round_id = ? AND status = 'success' ORDER BY ts`)
      .all(roundId) as { id: number; ts: string; actions_json: string }[];

    const symbols = new Set<string>([...trades.map((t) => t.symbol), ...config.watchlist]);
    const barsBySymbol = new Map<string, { ts: string; close: number }[]>();
    for (const symbol of symbols) {
      try {
        barsBySymbol.set(symbol, (await this.history.history(symbol, 'ALL')).bars.map((b) => ({ ts: b.ts, close: b.close })));
      } catch {
        barsBySymbol.set(symbol, []);
      }
    }

    const outcomes: DecisionOutcome[] = [];

    for (const trade of trades) {
      const forward = this.forwardReturns(barsBySymbol.get(trade.symbol) ?? [], trade.executed_at, horizons);
      outcomes.push({
        at: trade.executed_at,
        decision: trade.side,
        symbol: trade.symbol,
        priceAud: trade.price_aud,
        forward,
        verdict: verdictFor(trade.side, forward),
      });
    }

    for (const checkin of passes) {
      if (parseActions(checkin.actions_json).includes('place_order')) continue;
      // A pass is judged against the first watchlist symbol — the cheapest useful
      // proxy for "what did doing nothing cost?".
      const symbol = config.watchlist[0];
      if (symbol === undefined) continue;
      const bars = barsBySymbol.get(symbol) ?? [];
      const forward = this.forwardReturns(bars, checkin.ts, horizons);
      outcomes.push({
        at: checkin.ts,
        decision: 'pass',
        symbol,
        priceAud: priceAt(bars, checkin.ts),
        forward,
        verdict: verdictFor('pass', forward),
      });
    }

    return outcomes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  private forwardReturns(bars: { ts: string; close: number }[], at: string, horizons: number[]): ForwardReturn[] {
    const index = lastIndexAtOrBefore(bars, at);
    if (index === -1) return horizons.map((h) => ({ bars: h, pricePct: null }));
    const basePrice = bars[index]!.close;
    return horizons.map((h) => {
      const target = bars[index + h];
      if (target === undefined || basePrice === 0) return { bars: h, pricePct: null };
      return { bars: h, pricePct: ((target.close - basePrice) / basePrice) * 100 };
    });
  }
```

And these module-level helpers, next to `parseActions`:

```ts
function lastIndexAtOrBefore(bars: { ts: string }[], at: string): number {
  const target = Date.parse(at);
  let found = -1;
  for (let i = 0; i < bars.length; i++) {
    if (Date.parse(bars[i]!.ts) > target) break;
    found = i;
  }
  return found;
}

function priceAt(bars: { ts: string; close: number }[], at: string): number | null {
  const index = lastIndexAtOrBefore(bars, at);
  return index === -1 ? null : bars[index]!.close;
}

/** The medium-horizon move is the one worth talking about. */
function verdictFor(decision: 'buy' | 'sell' | 'pass', forward: ForwardReturn[]): string {
  const medium = forward.find((f) => f.bars === 5) ?? forward[forward.length - 1];
  const move = medium?.pricePct ?? null;
  if (move === null) return 'too recent to judge';
  const rounded = move.toFixed(1);
  if (decision === 'buy') return move >= 0 ? `up ${rounded}% since` : `down ${rounded}% since`;
  if (decision === 'sell') return move > 2 ? 'sold early' : move < -2 ? 'sold well' : 'sold about right';
  return move > 2 ? `passing cost ${rounded}%` : move < -2 ? `passing avoided ${rounded}%` : 'passing was neutral';
}
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npm test -- analytics-service && npx tsc --noEmit`
Expected: 13 analytics-service tests pass (7 from Task 2, 6 new).

- [ ] **Step 6: Commit**

```bash
git add backend/src/analytics/service.ts backend/src/settings/store.ts backend/test/analytics-service.test.ts
git commit -m "feat: index benchmarking and decision-outcome tracking"
```

---

## Task 4: Analytics API routes

**Files:**
- Create: `backend/src/api/analytics-routes.ts`
- Modify: `backend/src/api/app.ts`, `backend/src/index.ts`, `backend/test/api-helper.ts`
- Create: `backend/test/api-analytics.test.ts`

- [ ] **Step 1: Write the failing test**

`backend/test/api-analytics.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('analytics API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let roundId: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const created = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'analytics', startingBalanceCents: cents(50), profitGoalCents: cents(100) });
    roundId = created.body.id as number;
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get(`/api/analytics/rounds/${roundId}`)).status).toBe(401);
    expect((await request(ctx.app).get('/api/analytics/summary')).status).toBe(401);
  });

  it('returns the per-round analytics payload', async () => {
    const res = await request(ctx.app).get(`/api/analytics/rounds/${roundId}`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      roundId,
      stats: expect.objectContaining({ closed: 0, wins: 0 }),
      histogram: [],
      scatter: [],
      costs: expect.objectContaining({ totalFeesCents: 0 }),
    });
    expect(Array.isArray(res.body.eras)).toBe(true);
  });

  it('404s for an unknown round', async () => {
    expect((await request(ctx.app).get('/api/analytics/rounds/9999').set('Cookie', cookie)).status).toBe(404);
  });

  it('serves the benchmark with the configured default symbol', async () => {
    const res = await request(ctx.app).get(`/api/analytics/rounds/${roundId}/benchmark`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('IVV');
    expect(Array.isArray(res.body.points)).toBe(true);
  });

  it('accepts a benchmark symbol override', async () => {
    const res = await request(ctx.app)
      .get(`/api/analytics/rounds/${roundId}/benchmark?symbol=vas.ax`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('VAS.AX');
  });

  it('rejects a malformed benchmark symbol', async () => {
    const res = await request(ctx.app)
      .get(`/api/analytics/rounds/${roundId}/benchmark?symbol=drop table`)
      .set('Cookie', cookie);

    expect(res.status).toBe(400);
  });

  it('serves decision outcomes', async () => {
    const res = await request(ctx.app).get(`/api/analytics/rounds/${roundId}/decisions`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('summarises every round for cross-round comparison', async () => {
    const res = await request(ctx.app).get('/api/analytics/summary').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.rounds).toEqual([
      expect.objectContaining({ id: roundId, name: 'analytics', stats: expect.any(Object) }),
    ]);
    expect(res.body.totals).toMatchObject({ closed: 0, totalNetCents: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test -- api-analytics`
Expected: FAIL — 404 on every analytics route.

- [ ] **Step 3: Write the routes**

`backend/src/api/analytics-routes.ts`:

```ts
import { Router } from 'express';
import type { AnalyticsService } from '../analytics/service.js';
import { summarizeRoundTrips } from '../engine/analytics.js';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import { normalizeSymbol } from '../market/symbols.js';
import type { SettingsStore } from '../settings/store.js';
import { requireSession } from './middleware.js';

export function analyticsRoutes(
  auth: AuthService,
  db: DB,
  analytics: AnalyticsService,
  settings: SettingsStore,
): Router {
  const router = Router();
  router.use('/api/analytics', requireSession(auth));

  function roundOr404(idParam: string, res: import('express').Response): number | null {
    const id = Number(idParam);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id)) {
      res.status(404).json({ error: 'round not found' });
      return null;
    }
    return id;
  }

  router.get('/api/analytics/rounds/:id', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    res.json(await analytics.roundAnalytics(id));
  });

  router.get('/api/analytics/rounds/:id/benchmark', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    const requested = req.query.symbol === undefined ? settings.get('integrations').benchmarkSymbol : String(req.query.symbol);
    const symbol = normalizeSymbol(requested);
    if (symbol === null) {
      res.status(400).json({ error: 'invalid benchmark symbol' });
      return;
    }
    res.json(await analytics.benchmark(id, symbol));
  });

  router.get('/api/analytics/rounds/:id/decisions', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    res.json(await analytics.decisionOutcomes(id));
  });

  /** Cross-round comparison (spec §6): one stats block per round plus the totals. */
  router.get('/api/analytics/summary', async (_req, res) => {
    const rounds = db.prepare('SELECT id, name, status FROM rounds ORDER BY id').all() as {
      id: number; name: string; status: string;
    }[];

    const perRound = [];
    const allTrips = [];
    for (const round of rounds) {
      const result = await analytics.roundAnalytics(round.id);
      perRound.push({
        id: round.id,
        name: round.name,
        status: round.status,
        stats: result.stats,
        costs: { totalFeesCents: result.costs.totalFeesCents },
        tokenTotals: result.tokenTotals,
      });
      allTrips.push(...result.trips);
    }

    res.json({ rounds: perRound, totals: summarizeRoundTrips(allTrips) });
  });

  return router;
}
```

- [ ] **Step 4: Wire it up**

`backend/src/api/app.ts`: add `analytics: AnalyticsService` to `ApiDeps`, import `analyticsRoutes`, and mount it after the market routes:

```ts
  app.use(analyticsRoutes(deps.auth, deps.db, deps.analytics, deps.settings));
```

`backend/src/index.ts`:

```ts
import { AnalyticsService } from './analytics/service.js';
```

```ts
const analytics = new AnalyticsService(db, rounds, history);
```

and add `analytics` to the `buildApp({ … })` call.

`backend/test/api-helper.ts`: construct `const analytics = new AnalyticsService(db, rounds, history);` after `history`, pass it to `buildApp`, and add it to `TestCtx` and the returned object.

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: everything green, 8 new tests. `api-helper.ts` is on every API test's path — a compile error there breaks all of them.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api backend/src/index.ts backend/test/api-helper.ts backend/test/api-analytics.test.ts
git commit -m "feat: analytics API routes for rounds, benchmark, decisions and summary"
```
---

## Task 5: Frontend analytics types, hooks and the SVG chart primitives

A histogram and a scatter plot do not need a candle engine. Both are hand-rolled SVG, which also makes them assertable in jsdom without mocking.

**Files:**
- Create: `frontend/src/api/analytics.ts`
- Create: `frontend/src/components/charts/Histogram.tsx`, `frontend/src/components/charts/Scatter.tsx`
- Modify: `frontend/test/server.ts` (analytics fixtures + handlers)
- Create: `frontend/test/analytics-charts.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/analytics-charts.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/components/charts/Histogram';
import { Scatter } from '../src/components/charts/Scatter';

const buckets = [
  { fromPct: -10, toPct: -5, count: 1 },
  { fromPct: -5, toPct: 0, count: 2 },
  { fromPct: 0, toPct: 5, count: 4 },
  { fromPct: 5, toPct: 10, count: 1 },
];

const points = [
  { symbol: 'AAPL', holdMs: 86_400_000, returnPct: 12, netCents: 400, closedAt: '2026-08-02T00:00:00.000Z' },
  { symbol: 'MSFT', holdMs: 3 * 86_400_000, returnPct: -4, netCents: -200, closedAt: '2026-08-05T00:00:00.000Z' },
];

describe('Histogram', () => {
  it('draws one bar per bucket', () => {
    const { container } = render(<Histogram buckets={buckets} />);
    expect(container.querySelectorAll('rect.bar')).toHaveLength(4);
  });

  it('scales bar height to the tallest bucket', () => {
    const { container } = render(<Histogram buckets={buckets} height={100} />);
    const heights = [...container.querySelectorAll('rect.bar')].map((r) => Number(r.getAttribute('height')));
    expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights));
    expect(Math.max(...heights)).toBeLessThanOrEqual(100);
  });

  it('colours losing buckets differently from winning ones', () => {
    const { container } = render(<Histogram buckets={buckets} />);
    const bars = [...container.querySelectorAll('rect.bar')];
    expect(bars[0]!.getAttribute('fill')).not.toBe(bars[2]!.getAttribute('fill'));
  });

  it('labels the axis extremes and is described for screen readers', () => {
    render(<Histogram buckets={buckets} />);
    expect(screen.getByText('-10%')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/distribution/i);
  });

  it('renders an empty state with no buckets', () => {
    render(<Histogram buckets={[]} />);
    expect(screen.getByText(/no closed trades/i)).toBeInTheDocument();
  });
});

describe('Scatter', () => {
  it('plots one point per round trip', () => {
    const { container } = render(<Scatter points={points} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('colours winners and losers differently', () => {
    const { container } = render(<Scatter points={points} />);
    const circles = [...container.querySelectorAll('circle')];
    expect(circles[0]!.getAttribute('fill')).not.toBe(circles[1]!.getAttribute('fill'));
  });

  it('titles each point with its symbol and return', () => {
    const { container } = render(<Scatter points={points} />);
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles.some((t) => t?.includes('AAPL') && t.includes('12.0%'))).toBe(true);
  });

  it('handles a single point without dividing by a zero range', () => {
    const { container } = render(<Scatter points={[points[0]!]} />);
    const circle = container.querySelector('circle')!;
    expect(Number(circle.getAttribute('cx'))).not.toBeNaN();
    expect(Number(circle.getAttribute('cy'))).not.toBeNaN();
  });

  it('renders an empty state with no points', () => {
    render(<Scatter points={[]} />);
    expect(screen.getByText(/no closed trades/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- analytics-charts`
Expected: FAIL — components missing.

- [ ] **Step 3: Write the analytics types and hooks**

`frontend/src/api/analytics.ts`:

```ts
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface RoundTripStats {
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinCents: number;
  avgLossCents: number;
  bestCents: number;
  worstCents: number;
  totalNetCents: number;
  totalFeesCents: number;
  profitFactor: number | null;
  avgHoldMs: number;
  medianHoldMs: number;
  avgReturnPct: number;
}

export interface ReturnBucket {
  fromPct: number;
  toPct: number;
  count: number;
}

export interface ScatterPoint {
  symbol: string;
  holdMs: number;
  returnPct: number;
  netCents: number;
  closedAt: string;
}

export interface RoundTrip {
  symbol: string;
  quantity: number;
  openedAt: string;
  closedAt: string;
  costCents: number;
  proceedsCents: number;
  feesCents: number;
  netCents: number;
  returnPct: number;
  holdMs: number;
}

export interface CostBreakdown {
  totalFeesCents: number;
  usFeesCents: number;
  asxFeesCents: number;
  byDay: { day: string; feesCents: number }[];
}

export interface CheckinLedgerRow {
  id: number;
  ts: string;
  status: string;
  tokensUsed: number;
  actions: string[];
  reasoning: string[];
}

export interface ConfigEra {
  label: string;
  from: string;
  to: string | null;
  stats: RoundTripStats;
}

export interface RoundAnalytics {
  roundId: number;
  stats: RoundTripStats;
  trips: RoundTrip[];
  histogram: ReturnBucket[];
  scatter: ScatterPoint[];
  costs: CostBreakdown;
  checkins: CheckinLedgerRow[];
  tokenTotals: { checkinTokens: number; checkins: number };
  eras: ConfigEra[];
}

export interface BenchmarkResult {
  symbol: string;
  points: { ts: string; equityCents: number; benchmarkCents: number | null }[];
  roundReturnPct: number | null;
  benchmarkReturnPct: number | null;
}

export interface DecisionOutcome {
  at: string;
  decision: 'buy' | 'sell' | 'pass';
  symbol: string;
  priceAud: number | null;
  forward: { bars: number; pricePct: number | null }[];
  verdict: string;
}

export interface AnalyticsSummary {
  rounds: {
    id: number;
    name: string;
    status: string;
    stats: RoundTripStats;
    costs: { totalFeesCents: number };
    tokenTotals: { checkinTokens: number; checkins: number };
  }[];
  totals: RoundTripStats;
}

export const analyticsKeys = {
  round: (id: number) => ['analytics', 'round', id] as const,
  benchmark: (id: number, symbol?: string) => ['analytics', 'benchmark', id, symbol ?? 'default'] as const,
  decisions: (id: number) => ['analytics', 'decisions', id] as const,
  summary: ['analytics', 'summary'] as const,
};

export function useRoundAnalytics(id: number): UseQueryResult<RoundAnalytics> {
  return useQuery({
    queryKey: analyticsKeys.round(id),
    queryFn: () => apiFetch<RoundAnalytics>(`/api/analytics/rounds/${id}`),
  });
}

export function useBenchmark(id: number, symbol?: string): UseQueryResult<BenchmarkResult> {
  const query = symbol === undefined ? '' : `?symbol=${encodeURIComponent(symbol)}`;
  return useQuery({
    queryKey: analyticsKeys.benchmark(id, symbol),
    queryFn: () => apiFetch<BenchmarkResult>(`/api/analytics/rounds/${id}/benchmark${query}`),
  });
}

export function useDecisions(id: number): UseQueryResult<DecisionOutcome[]> {
  return useQuery({
    queryKey: analyticsKeys.decisions(id),
    queryFn: () => apiFetch<DecisionOutcome[]>(`/api/analytics/rounds/${id}/decisions`),
  });
}

export function useAnalyticsSummary(): UseQueryResult<AnalyticsSummary> {
  return useQuery({
    queryKey: analyticsKeys.summary,
    queryFn: () => apiFetch<AnalyticsSummary>('/api/analytics/summary'),
  });
}
```

- [ ] **Step 4: Write the histogram**

`frontend/src/components/charts/Histogram.tsx`:

```tsx
import type { ReturnBucket } from '../../api/analytics';

const WIN = '#1a7f4b';
const LOSS = '#c0392b';

export function Histogram({
  buckets,
  width = 420,
  height = 140,
}: {
  buckets: ReturnBucket[];
  width?: number;
  height?: number;
}) {
  if (buckets.length === 0) return <p className="muted">No closed trades to plot yet.</p>;

  const max = Math.max(...buckets.map((b) => b.count));
  const barWidth = width / buckets.length;

  return (
    <figure style={{ margin: 0 }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Distribution of trade returns">
        {buckets.map((bucket, index) => {
          const barHeight = max === 0 ? 0 : (bucket.count / max) * height;
          return (
            <g key={bucket.fromPct}>
              <rect
                className="bar"
                x={index * barWidth + 1}
                y={height - barHeight}
                width={Math.max(1, barWidth - 2)}
                height={barHeight}
                fill={bucket.fromPct < 0 ? LOSS : WIN}
              >
                <title>{`${bucket.fromPct}% to ${bucket.toPct}%: ${bucket.count} trade(s)`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <figcaption className="row muted" style={{ justifyContent: 'space-between', fontSize: '0.8em' }}>
        <span>{buckets[0]!.fromPct}%</span>
        <span>return per closed trade</span>
        <span>{buckets[buckets.length - 1]!.toPct}%</span>
      </figcaption>
    </figure>
  );
}
```

- [ ] **Step 5: Write the scatter**

`frontend/src/components/charts/Scatter.tsx`:

```tsx
import type { ScatterPoint } from '../../api/analytics';

const WIN = '#1a7f4b';
const LOSS = '#c0392b';
const PAD = 6;

function days(ms: number): number {
  return ms / 86_400_000;
}

export function Scatter({
  points,
  width = 420,
  height = 200,
}: {
  points: ScatterPoint[];
  width?: number;
  height?: number;
}) {
  if (points.length === 0) return <p className="muted">No closed trades to plot yet.</p>;

  const xs = points.map((p) => days(p.holdMs));
  const ys = points.map((p) => p.returnPct);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys);
  // A single point (or a flat axis) has no range to scale against — centre it.
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const zeroY = PAD + ((yMax - 0) / ySpan) * (height - 2 * PAD);

  return (
    <figure style={{ margin: 0 }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Hold time versus return">
        <line x1={0} x2={width} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeWidth={1} />
        {points.map((point, index) => {
          const cx = PAD + ((days(point.holdMs) - xMin) / xSpan) * (width - 2 * PAD);
          const cy = PAD + ((yMax - point.returnPct) / ySpan) * (height - 2 * PAD);
          return (
            <circle key={`${point.closedAt}-${index}`} cx={cx} cy={cy} r={4} fill={point.netCents >= 0 ? WIN : LOSS} opacity={0.8}>
              <title>{`${point.symbol}: ${point.returnPct.toFixed(1)}% after ${days(point.holdMs).toFixed(1)} days`}</title>
            </circle>
          );
        })}
      </svg>
      <figcaption className="row muted" style={{ justifyContent: 'space-between', fontSize: '0.8em' }}>
        <span>{xMin.toFixed(1)}d</span>
        <span>hold time vs return</span>
        <span>{xMax.toFixed(1)}d</span>
      </figcaption>
    </figure>
  );
}
```

- [ ] **Step 6: Add the shared fixtures**

Append to `frontend/test/server.ts` and add each handler to the `handlers` array:

```ts
import type { AnalyticsSummary, BenchmarkResult, DecisionOutcome, RoundAnalytics } from '../src/api/analytics';

export const statsFixture = {
  closed: 3, wins: 2, losses: 1, winRatePct: 66.66666666666666,
  avgWinCents: 250, avgLossCents: -200, bestCents: 400, worstCents: -200,
  totalNetCents: 300, totalFeesCents: 90, profitFactor: 2.5,
  avgHoldMs: 115_200_000, medianHoldMs: 86_400_000, avgReturnPct: 8.3,
};

export const roundAnalyticsFixture: RoundAnalytics = {
  roundId: 1,
  stats: statsFixture,
  trips: [
    {
      symbol: 'AAPL', quantity: 1, openedAt: '2026-08-01T00:00:00.000Z', closedAt: '2026-08-02T00:00:00.000Z',
      costCents: 1000, proceedsCents: 1400, feesCents: 30, netCents: 370, returnPct: 37, holdMs: 86_400_000,
    },
  ],
  histogram: [
    { fromPct: -5, toPct: 0, count: 1 },
    { fromPct: 0, toPct: 5, count: 1 },
    { fromPct: 35, toPct: 40, count: 1 },
  ],
  scatter: [
    { symbol: 'AAPL', holdMs: 86_400_000, returnPct: 37, netCents: 370, closedAt: '2026-08-02T00:00:00.000Z' },
  ],
  costs: {
    totalFeesCents: 90, usFeesCents: 90, asxFeesCents: 0,
    byDay: [{ day: '2026-08-01', feesCents: 60 }, { day: '2026-08-02', feesCents: 30 }],
  },
  checkins: [
    { id: 2, ts: '2026-08-02T02:00:00.000Z', status: 'success', tokensUsed: 1800, actions: ['place_order', 'write_journal'], reasoning: ['Took profit into strength.'] },
    { id: 1, ts: '2026-08-01T02:00:00.000Z', status: 'success', tokensUsed: 1200, actions: ['write_journal'], reasoning: ['Nothing worth trading.'] },
  ],
  tokenTotals: { checkinTokens: 3000, checkins: 2 },
  eras: [
    { label: 'initial config', from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z', stats: statsFixture },
    { label: 'riskProfile → "aggressive"', from: '2026-08-02T00:00:00.000Z', to: null, stats: { ...statsFixture, closed: 1, wins: 0, losses: 1, winRatePct: 0, totalNetCents: -200 } },
  ],
};

export const benchmarkFixture: BenchmarkResult = {
  symbol: 'IVV',
  points: [
    { ts: '2026-08-01T00:00:00.000Z', equityCents: 5000, benchmarkCents: 5000 },
    { ts: '2026-08-02T00:00:00.000Z', equityCents: 5400, benchmarkCents: 5200 },
  ],
  roundReturnPct: 8,
  benchmarkReturnPct: 4,
};

export const decisionsFixture: DecisionOutcome[] = [
  {
    at: '2026-08-02T02:00:00.000Z', decision: 'sell', symbol: 'AAPL', priceAud: 14,
    forward: [{ bars: 1, pricePct: 2 }, { bars: 5, pricePct: 9.4 }, { bars: 20, pricePct: null }],
    verdict: 'sold early',
  },
  {
    at: '2026-08-01T02:00:00.000Z', decision: 'pass', symbol: 'AAPL', priceAud: 10,
    forward: [{ bars: 1, pricePct: -1 }, { bars: 5, pricePct: -6 }, { bars: 20, pricePct: null }],
    verdict: 'passing avoided -6.0%',
  },
];

export const analyticsSummaryFixture: AnalyticsSummary = {
  rounds: [
    { id: 1, name: 'first run', status: 'active', stats: statsFixture, costs: { totalFeesCents: 90 }, tokenTotals: { checkinTokens: 3000, checkins: 2 } },
    { id: 2, name: 'paused run', status: 'paused', stats: { ...statsFixture, closed: 0, wins: 0, losses: 0, winRatePct: 0, totalNetCents: 0, profitFactor: null }, costs: { totalFeesCents: 0 }, tokenTotals: { checkinTokens: 0, checkins: 0 } },
  ],
  totals: statsFixture,
};
```

```ts
  http.get('/api/analytics/rounds/:id/benchmark', () => HttpResponse.json(benchmarkFixture)),
  http.get('/api/analytics/rounds/:id/decisions', () => HttpResponse.json(decisionsFixture)),
  http.get('/api/analytics/rounds/:id', () => HttpResponse.json(roundAnalyticsFixture)),
  http.get('/api/analytics/summary', () => HttpResponse.json(analyticsSummaryFixture)),
```

Order matters: msw matches in registration order, so the two more specific `/benchmark` and `/decisions` handlers must come before `/api/analytics/rounds/:id`.

- [ ] **Step 7: Run the tests**

Run: `cd frontend && npm test -- analytics-charts && npx tsc --noEmit`
Expected: 10 tests pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/analytics.ts frontend/src/components/charts frontend/test/server.ts frontend/test/analytics-charts.test.tsx
git commit -m "feat: analytics types, hooks, histogram and scatter primitives"
```

---

## Task 6: Per-round analytics tab

Stats cards, the histogram, the scatter, fee accumulation and config-era segmentation, all on the round detail page.

**Files:**
- Create: `frontend/src/pages/round/AnalyticsTab.tsx`
- Modify: `frontend/src/pages/RoundDetailPage.tsx`
- Create: `frontend/test/analytics-tab.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/analytics-tab.test.tsx`:

```tsx
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsTab } from '../src/pages/round/AnalyticsTab';
import { renderWithProviders } from './render';
import { roundAnalyticsFixture, server } from './server';

vi.mock('../src/components/charts/BenchmarkChart', () => ({ BenchmarkChart: () => <div data-testid="benchmark" /> }));

describe('round analytics tab', () => {
  it('shows the headline statistics', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);

    expect(await screen.findByTestId('stat-win-rate')).toHaveTextContent('66.7%');
    expect(screen.getByTestId('stat-closed')).toHaveTextContent('3');
    expect(screen.getByTestId('stat-avg-win')).toHaveTextContent('$2.50');
    expect(screen.getByTestId('stat-avg-loss')).toHaveTextContent('-$2.00');
    expect(screen.getByTestId('stat-net')).toHaveTextContent('+$3.00');
    expect(screen.getByTestId('stat-profit-factor')).toHaveTextContent('2.50');
  });

  it('formats hold times in days', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);
    expect(await screen.findByTestId('stat-median-hold')).toHaveTextContent('1.0d');
  });

  it('shows a dash for a null profit factor', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id', () =>
        HttpResponse.json({ ...roundAnalyticsFixture, stats: { ...roundAnalyticsFixture.stats, profitFactor: null } }),
      ),
    );
    renderWithProviders(<AnalyticsTab roundId={1} />);

    expect(await screen.findByTestId('stat-profit-factor')).toHaveTextContent('—');
  });

  it('renders the histogram and the scatter', async () => {
    const { container } = renderWithProviders(<AnalyticsTab roundId={1} />);
    await screen.findByTestId('stat-win-rate');

    expect(container.querySelectorAll('rect.bar').length).toBe(3);
    expect(container.querySelectorAll('circle').length).toBe(1);
  });

  it('accumulates fees with a per-day breakdown', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);

    const costs = await screen.findByTestId('costs');
    expect(within(costs).getByText('$0.90')).toBeInTheDocument();
    expect(within(costs).getAllByRole('row')).toHaveLength(3); // header + two days
  });

  it('segments performance by config era', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);

    const eras = await screen.findByTestId('eras');
    expect(within(eras).getByText('initial config')).toBeInTheDocument();
    expect(within(eras).getByText(/riskProfile/)).toBeInTheDocument();
    expect(within(eras).getByText('-$2.00')).toBeInTheDocument();
  });

  it('shows token spend for the round', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);
    expect(await screen.findByTestId('stat-tokens')).toHaveTextContent('3,000');
  });

  it('handles a round with no closed trades', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id', () =>
        HttpResponse.json({
          ...roundAnalyticsFixture,
          stats: { ...roundAnalyticsFixture.stats, closed: 0, wins: 0, losses: 0, winRatePct: 0, totalNetCents: 0, profitFactor: null },
          trips: [], histogram: [], scatter: [],
        }),
      ),
    );
    renderWithProviders(<AnalyticsTab roundId={1} />);

    expect(await screen.findAllByText(/no closed trades/i)).toHaveLength(2);
  });

  it('surfaces a load error', async () => {
    server.use(http.get('/api/analytics/rounds/:id', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    renderWithProviders(<AnalyticsTab roundId={1} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- analytics-tab`
Expected: FAIL — component missing.

- [ ] **Step 3: Write the tab**

`frontend/src/pages/round/AnalyticsTab.tsx`. It references `BenchmarkChart`, `DecisionsTable` and `CheckinLedger` from Task 7 — create those three as one-line placeholders now and fill them in next task, exactly as Plan 4 did with the router pages.

```tsx
import { useRoundAnalytics } from '../../api/analytics';
import { Histogram } from '../../components/charts/Histogram';
import { Scatter } from '../../components/charts/Scatter';
import { ErrorBox } from '../../components/ErrorBox';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { formatCents } from '../../lib/format';
import { BenchmarkChart } from '../../components/charts/BenchmarkChart';
import { CheckinLedger } from './CheckinLedger';
import { DecisionsTable } from './DecisionsTable';

function Stat({ label, value, testId }: { label: string; value: React.ReactNode; testId: string }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div className="muted" style={{ fontSize: '0.8em' }}>{label}</div>
      <div data-testid={testId} style={{ fontSize: '1.1rem' }}>{value}</div>
    </div>
  );
}

function days(ms: number): string {
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

export function AnalyticsTab({ roundId }: { roundId: number }) {
  const analytics = useRoundAnalytics(roundId);

  if (analytics.isPending) return <Spinner label="Crunching analytics" />;
  if (analytics.error) return <ErrorBox error={analytics.error} />;
  if (!analytics.data) return null;

  const { stats, histogram, scatter, costs, eras, tokenTotals } = analytics.data;

  return (
    <div className="grid">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Stat label="Closed trades" value={stats.closed} testId="stat-closed" />
        <Stat label="Win rate" value={`${stats.winRatePct.toFixed(1)}%`} testId="stat-win-rate" />
        <Stat label="Avg win" value={<Money cents={stats.avgWinCents} />} testId="stat-avg-win" />
        <Stat label="Avg loss" value={<Money cents={stats.avgLossCents} />} testId="stat-avg-loss" />
        <Stat label="Net" value={<Money cents={stats.totalNetCents} signed />} testId="stat-net" />
        <Stat
          label="Profit factor"
          value={stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}
          testId="stat-profit-factor"
        />
        <Stat label="Median hold" value={days(stats.medianHoldMs)} testId="stat-median-hold" />
        <Stat label="Tokens" value={tokenTotals.checkinTokens.toLocaleString('en-AU')} testId="stat-tokens" />
      </div>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Return distribution</h3>
        <Histogram buckets={histogram} />
      </section>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Hold time vs return</h3>
        <Scatter points={scatter} />
      </section>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Benchmark</h3>
        <BenchmarkChart roundId={roundId} />
      </section>

      <section data-testid="costs">
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>
          Costs — {formatCents(costs.totalFeesCents)} total ({formatCents(costs.asxFeesCents)} ASX,{' '}
          {formatCents(costs.usFeesCents)} US/FX)
        </h3>
        {costs.byDay.length === 0 ? (
          <p className="muted">No fees charged yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Fees</th>
              </tr>
            </thead>
            <tbody>
              {costs.byDay.map((row) => (
                <tr key={row.day}>
                  <td>{row.day}</td>
                  <td className="num">
                    <Money cents={row.feesCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section data-testid="eras">
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Config eras</h3>
        <table>
          <thead>
            <tr>
              <th>Era</th>
              <th className="num">Closed</th>
              <th className="num">Win rate</th>
              <th className="num">Net</th>
            </tr>
          </thead>
          <tbody>
            {eras.map((era) => (
              <tr key={era.from}>
                <td>{era.label}</td>
                <td className="num">{era.stats.closed}</td>
                <td className="num">{era.stats.winRatePct.toFixed(0)}%</td>
                <td className="num">
                  <Money cents={era.stats.totalNetCents} signed />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Decision outcomes</h3>
        <DecisionsTable roundId={roundId} />
      </section>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Check-in ledger</h3>
        <CheckinLedger checkins={analytics.data.checkins} />
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Add the tab to the round page**

In `frontend/src/pages/RoundDetailPage.tsx`, add `'analytics'` to `TABS` (after `'summaries'`) and render it:

```tsx
        {tab === 'analytics' && <AnalyticsTab roundId={roundId} />}
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 9 new tests pass; existing round-detail tab tests still pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages frontend/test/analytics-tab.test.tsx
git commit -m "feat: per-round analytics tab with stats, histogram, scatter, costs and eras"
```

---

## Task 7: Benchmark chart, decision outcomes and the check-in ledger

**Files:**
- Create/replace: `frontend/src/components/charts/BenchmarkChart.tsx`, `frontend/src/pages/round/DecisionsTable.tsx`, `frontend/src/pages/round/CheckinLedger.tsx`
- Create: `frontend/test/analytics-decisions.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/analytics-decisions.test.tsx`:

```tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { BenchmarkChart } from '../src/components/charts/BenchmarkChart';
import { CheckinLedger } from '../src/pages/round/CheckinLedger';
import { DecisionsTable } from '../src/pages/round/DecisionsTable';
import { renderWithProviders } from './render';
import { benchmarkFixture, roundAnalyticsFixture, server } from './server';

const setData = vi.fn();
const addSeries = vi.fn(() => ({ setData, priceScale: vi.fn(() => ({ applyOptions: vi.fn() })) }));
vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries: (...args: unknown[]) => addSeries(...(args as [])),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
    remove: vi.fn(),
  })),
  createSeriesMarkers: vi.fn(),
  AreaSeries: 'AreaSeries',
  CandlestickSeries: 'CandlestickSeries',
  HistogramSeries: 'HistogramSeries',
  LineSeries: 'LineSeries',
  ColorType: { Solid: 'solid' },
}));

describe('benchmark chart', () => {
  it('summarises who is ahead', async () => {
    renderWithProviders(<BenchmarkChart roundId={1} />);

    expect(await screen.findByText(/round \+8\.0%/i)).toBeInTheDocument();
    expect(screen.getByText(/IVV \+4\.0%/i)).toBeInTheDocument();
    expect(screen.getByText(/ahead of the index/i)).toBeInTheDocument();
  });

  it('says when the round is behind', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id/benchmark', () =>
        HttpResponse.json({ ...benchmarkFixture, roundReturnPct: 1, benchmarkReturnPct: 9 }),
      ),
    );
    renderWithProviders(<BenchmarkChart roundId={1} />);

    expect(await screen.findByText(/behind the index/i)).toBeInTheDocument();
  });

  it('plots both series', async () => {
    renderWithProviders(<BenchmarkChart roundId={1} />);
    await screen.findByText(/round \+8\.0%/i);

    expect(addSeries).toHaveBeenCalledTimes(2);
    const equity = setData.mock.calls[0]![0] as { value: number }[];
    expect(equity.map((p) => p.value)).toEqual([50, 54]);
  });

  it('explains a missing benchmark instead of drawing nothing', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id/benchmark', () =>
        HttpResponse.json({ symbol: 'IVV', points: [], roundReturnPct: null, benchmarkReturnPct: null }),
      ),
    );
    renderWithProviders(<BenchmarkChart roundId={1} />);

    expect(await screen.findByText(/not enough history/i)).toBeInTheDocument();
  });
});

describe('decisions table', () => {
  it('lists each decision with its forward returns and verdict', async () => {
    renderWithProviders(<DecisionsTable roundId={1} />);

    const rows = await screen.findAllByRole('row');
    const sell = rows.find((row) => row.textContent?.includes('sold early'))!;
    expect(within(sell).getByText('sell')).toBeInTheDocument();
    expect(within(sell).getByText('+9.4%')).toBeInTheDocument();
    expect(within(sell).getByText('—')).toBeInTheDocument(); // 20-bar horizon not reached
  });

  it('marks passes distinctly', async () => {
    renderWithProviders(<DecisionsTable roundId={1} />);

    const rows = await screen.findAllByRole('row');
    const pass = rows.find((row) => row.textContent?.includes('passing avoided'))!;
    expect(within(pass).getByText('pass')).toBeInTheDocument();
  });

  it('filters to a single decision type', async () => {
    renderWithProviders(<DecisionsTable roundId={1} />);
    await screen.findAllByRole('row');

    await userEvent.selectOptions(screen.getByLabelText(/show/i), 'pass');

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('pass');
  });

  it('shows an empty state', async () => {
    server.use(http.get('/api/analytics/rounds/:id/decisions', () => HttpResponse.json([])));
    renderWithProviders(<DecisionsTable roundId={1} />);

    expect(await screen.findByText(/no decisions to score/i)).toBeInTheDocument();
  });
});

describe('check-in ledger', () => {
  it('shows tokens, actions and the linked reasoning', () => {
    renderWithProviders(<CheckinLedger checkins={roundAnalyticsFixture.checkins} />);

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('1,800');
    expect(rows[0]).toHaveTextContent('place_order, write_journal');
    expect(rows[0]).toHaveTextContent('Took profit into strength.');
  });

  it('totals token spend', () => {
    renderWithProviders(<CheckinLedger checkins={roundAnalyticsFixture.checkins} />);
    expect(screen.getByText(/3,000 tokens across 2 check-ins/i)).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    renderWithProviders(<CheckinLedger checkins={[]} />);
    expect(screen.getByText(/no check-ins yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- analytics-decisions`
Expected: FAIL — the three components are still placeholders.

- [ ] **Step 3: Write the benchmark chart**

`frontend/src/components/charts/BenchmarkChart.tsx`:

```tsx
import { createChart, LineSeries, type IChartApi } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { useBenchmark } from '../../api/analytics';
import { ErrorBox } from '../ErrorBox';
import { Spinner } from '../Spinner';
import { baseChartOptions, CHART_COLORS, toChartTime } from './chartTheme';

export function BenchmarkChart({ roundId, height = 220 }: { roundId: number; height?: number }) {
  const benchmark = useBenchmark(roundId);
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const points = benchmark.data?.points ?? [];

  useEffect(() => {
    if (container.current === null || points.length === 0) return;

    const chart = createChart(container.current, baseChartOptions(height));
    chartRef.current = chart;

    const equity = chart.addSeries(LineSeries, { color: CHART_COLORS.accent, lineWidth: 2 });
    equity.setData(points.map((p) => ({ time: toChartTime(p.ts), value: p.equityCents / 100 })));

    const index = chart.addSeries(LineSeries, { color: '#8a8a95', lineWidth: 1, lineStyle: 2 });
    index.setData(
      points
        .filter((p) => p.benchmarkCents !== null)
        .map((p) => ({ time: toChartTime(p.ts), value: p.benchmarkCents! / 100 })),
    );

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [points, height]);

  if (benchmark.isPending) return <Spinner label="Loading benchmark" />;
  if (benchmark.error) return <ErrorBox error={benchmark.error} />;
  if (!benchmark.data) return null;

  const { roundReturnPct, benchmarkReturnPct, symbol } = benchmark.data;
  if (points.length === 0 || roundReturnPct === null) {
    return <p className="muted">Not enough history to compare against {symbol} yet.</p>;
  }

  const ahead = benchmarkReturnPct === null ? null : roundReturnPct >= benchmarkReturnPct;

  return (
    <div className="grid" style={{ gap: '0.4rem' }}>
      <div className="row" style={{ gap: '1rem' }}>
        <span className={roundReturnPct >= 0 ? 'gain' : 'loss'}>
          Round {roundReturnPct >= 0 ? '+' : ''}
          {roundReturnPct.toFixed(1)}%
        </span>
        <span className="muted">
          {symbol} {benchmarkReturnPct === null ? '—' : `${benchmarkReturnPct >= 0 ? '+' : ''}${benchmarkReturnPct.toFixed(1)}%`}
        </span>
        {ahead !== null && <span className={ahead ? 'gain' : 'loss'}>{ahead ? 'ahead of the index' : 'behind the index'}</span>}
      </div>
      <div ref={container} style={{ width: '100%', height }} />
    </div>
  );
}
```

- [ ] **Step 4: Write the decisions table**

`frontend/src/pages/round/DecisionsTable.tsx`:

```tsx
import { useState } from 'react';
import { useDecisions, type DecisionOutcome } from '../../api/analytics';
import { ErrorBox } from '../../components/ErrorBox';
import { Spinner } from '../../components/Spinner';
import { formatTs } from '../../lib/format';

const FILTERS = ['all', 'buy', 'sell', 'pass'] as const;

function pct(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function toneFor(outcome: DecisionOutcome): string | undefined {
  const medium = outcome.forward.find((f) => f.bars === 5)?.pricePct ?? null;
  if (medium === null) return undefined;
  if (outcome.decision === 'buy') return medium >= 0 ? 'gain' : 'loss';
  if (outcome.decision === 'sell') return medium > 2 ? 'loss' : 'gain';
  return medium > 2 ? 'loss' : 'gain';
}

export function DecisionsTable({ roundId }: { roundId: number }) {
  const decisions = useDecisions(roundId);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');

  if (decisions.isPending) return <Spinner label="Scoring decisions" />;
  if (decisions.error) return <ErrorBox error={decisions.error} />;

  const rows = (decisions.data ?? []).filter((row) => filter === 'all' || row.decision === filter);
  const horizons = decisions.data?.[0]?.forward.map((f) => f.bars) ?? [1, 5, 20];

  return (
    <div className="grid" style={{ gap: '0.4rem' }}>
      <label className="row">
        Show
        <select value={filter} onChange={(e) => setFilter(e.target.value as (typeof FILTERS)[number])}>
          {FILTERS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      {(decisions.data ?? []).length === 0 ? (
        <p className="muted">No decisions to score yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Decision</th>
              <th>Symbol</th>
              {horizons.map((bars) => (
                <th key={bars} className="num">
                  +{bars} bar{bars === 1 ? '' : 's'}
                </th>
              ))}
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.at}-${row.decision}-${row.symbol}`}>
                <td>{formatTs(row.at)}</td>
                <td>{row.decision}</td>
                <td>{row.symbol}</td>
                {row.forward.map((forward) => (
                  <td key={forward.bars} className="num">
                    {pct(forward.pricePct)}
                  </td>
                ))}
                <td className={toneFor(row)}>{row.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Write the check-in ledger**

`frontend/src/pages/round/CheckinLedger.tsx`:

```tsx
import type { CheckinLedgerRow } from '../../api/analytics';
import { formatTs } from '../../lib/format';

export function CheckinLedger({ checkins }: { checkins: CheckinLedgerRow[] }) {
  if (checkins.length === 0) return <p className="muted">No check-ins yet.</p>;

  const totalTokens = checkins.reduce((sum, row) => sum + row.tokensUsed, 0);

  return (
    <div className="grid" style={{ gap: '0.4rem' }}>
      <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
        {totalTokens.toLocaleString('en-AU')} tokens across {checkins.length} check-in
        {checkins.length === 1 ? '' : 's'}
      </p>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Status</th>
            <th className="num">Tokens</th>
            <th>Actions</th>
            <th>Reasoning</th>
          </tr>
        </thead>
        <tbody>
          {checkins.map((row) => (
            <tr key={row.id}>
              <td>{formatTs(row.ts)}</td>
              <td className={row.status === 'success' ? undefined : 'loss'}>{row.status}</td>
              <td className="num">{row.tokensUsed.toLocaleString('en-AU')}</td>
              <td>{row.actions.length === 0 ? '—' : row.actions.join(', ')}</td>
              <td className="muted">{row.reasoning.join(' ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 11 new tests pass. The `analytics-tab` test mocks `BenchmarkChart`, so it stays isolated from the chart library.

- [ ] **Step 7: Commit**

```bash
git add frontend/src frontend/test/analytics-decisions.test.tsx
git commit -m "feat: benchmark chart, decision-outcome table, check-in ledger"
```

---

## Task 8: Cross-round analytics page

Spec §6: "Cross-round comparison overlays." A dedicated page with a normalised multi-round equity overlay and an aggregate stats table.

**Files:**
- Create: `frontend/src/components/charts/ComparisonChart.tsx`
- Create: `frontend/src/pages/AnalyticsPage.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/shell/AppShell.tsx`
- Create: `frontend/test/analytics-page.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/analytics-page.test.tsx`:

```tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsPage } from '../src/pages/AnalyticsPage';
import { renderWithProviders } from './render';
import { analyticsSummaryFixture, server } from './server';

const comparisonProps = vi.fn();
vi.mock('../src/components/charts/ComparisonChart', () => ({
  ComparisonChart: (props: Record<string, unknown>) => {
    comparisonProps(props);
    return <div data-testid="comparison" />;
  },
}));

describe('cross-round analytics page', () => {
  it('shows aggregate totals across every round', async () => {
    renderWithProviders(<AnalyticsPage />);

    expect(await screen.findByTestId('total-net')).toHaveTextContent('+$3.00');
    expect(screen.getByTestId('total-closed')).toHaveTextContent('3');
    expect(screen.getByTestId('total-win-rate')).toHaveTextContent('66.7%');
  });

  it('lists a comparison row per round', async () => {
    renderWithProviders(<AnalyticsPage />);

    const table = await screen.findByTestId('round-comparison');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(analyticsSummaryFixture.rounds.length);
    expect(rows[0]).toHaveTextContent('first run');
    expect(rows[0]).toHaveTextContent('$0.90');
  });

  it('links each row to the round', async () => {
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByRole('link', { name: 'first run' })).toHaveAttribute('href', '/rounds/1');
  });

  it('overlays the selected rounds, defaulting to all of them', async () => {
    renderWithProviders(<AnalyticsPage />);
    await screen.findByTestId('comparison');

    const first = comparisonProps.mock.calls.at(-1)![0] as { roundIds: number[] };
    expect(first.roundIds).toEqual([1, 2]);

    await userEvent.click(screen.getByRole('checkbox', { name: /paused run/i }));

    const after = comparisonProps.mock.calls.at(-1)![0] as { roundIds: number[] };
    expect(after.roundIds).toEqual([1]);
  });

  it('shows an empty state when no rounds exist', async () => {
    server.use(
      http.get('/api/analytics/summary', () =>
        HttpResponse.json({ rounds: [], totals: { ...analyticsSummaryFixture.totals, closed: 0, totalNetCents: 0 } }),
      ),
    );
    renderWithProviders(<AnalyticsPage />);

    expect(await screen.findByText(/no rounds to analyse/i)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    server.use(http.get('/api/analytics/summary', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    renderWithProviders(<AnalyticsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- analytics-page`
Expected: FAIL — page missing.

- [ ] **Step 3: Write the comparison chart**

`frontend/src/components/charts/ComparisonChart.tsx`:

```tsx
import { useQueries } from '@tanstack/react-query';
import { createChart, LineSeries, type IChartApi } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { apiFetch } from '../../api/client';
import { qk } from '../../api/hooks';
import type { EquityPoint } from '../../api/types';
import { baseChartOptions, toChartTime } from './chartTheme';

const SERIES_COLORS = ['#6e56cf', '#1a7f4b', '#c0392b', '#e0a020', '#2f8fd8', '#a24bd8'];

/**
 * Rounds start at different bankrolls and on different days, so raw equity is
 * not comparable. Every series is normalised to 100 at its own first snapshot.
 */
export function ComparisonChart({ roundIds, height = 300 }: { roundIds: number[]; height?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const results = useQueries({
    queries: roundIds.map((id) => ({
      queryKey: qk.equity(id),
      queryFn: () => apiFetch<EquityPoint[]>(`/api/rounds/${id}/equity`),
    })),
  });

  const series = results.map((result, index) => {
    const points = [...(result.data ?? [])].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const base = points[0]?.equity_cents ?? 0;
    return {
      roundId: roundIds[index]!,
      data:
        base === 0
          ? []
          : points.map((point) => ({ time: toChartTime(point.ts), value: (point.equity_cents / base) * 100 })),
    };
  });
  const key = JSON.stringify(series.map((s) => [s.roundId, s.data.length]));

  useEffect(() => {
    if (container.current === null || series.every((s) => s.data.length === 0)) return;

    const chart = createChart(container.current, baseChartOptions(height));
    chartRef.current = chart;
    series.forEach((entry, index) => {
      if (entry.data.length === 0) return;
      const line = chart.addSeries(LineSeries, {
        color: SERIES_COLORS[index % SERIES_COLORS.length],
        lineWidth: 2,
        title: `round ${entry.roundId}`,
      });
      line.setData(entry.data);
    });
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
    // `key` captures the shape of every series; the array identity changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, height]);

  if (roundIds.length === 0) return <p className="muted">Select at least one round to compare.</p>;
  if (series.every((s) => s.data.length === 0)) return <p className="muted">No equity history to compare yet.</p>;
  return <div ref={container} style={{ width: '100%', height }} />;
}
```

- [ ] **Step 4: Write the page**

`frontend/src/pages/AnalyticsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAnalyticsSummary } from '../api/analytics';
import { ComparisonChart } from '../components/charts/ComparisonChart';
import { ErrorBox } from '../components/ErrorBox';
import { Money } from '../components/Money';
import { Spinner } from '../components/Spinner';

export function AnalyticsPage() {
  const summary = useAnalyticsSummary();
  const [selected, setSelected] = useState<number[] | null>(null);

  // Default to every round the first time the summary lands.
  useEffect(() => {
    if (selected === null && summary.data) setSelected(summary.data.rounds.map((round) => round.id));
  }, [summary.data, selected]);

  if (summary.isPending) return <Spinner label="Loading analytics" />;
  if (summary.error) return <ErrorBox error={summary.error} />;
  if (!summary.data) return null;

  const { rounds, totals } = summary.data;
  const chosen = selected ?? rounds.map((round) => round.id);

  if (rounds.length === 0) return <p className="muted">No rounds to analyse yet.</p>;

  return (
    <section className="grid">
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Analytics</h1>

      <div className="panel row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="muted" style={{ fontSize: '0.8em' }}>Closed trades</div>
          <div data-testid="total-closed" style={{ fontSize: '1.2rem' }}>{totals.closed}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: '0.8em' }}>Win rate</div>
          <div data-testid="total-win-rate" style={{ fontSize: '1.2rem' }}>{totals.winRatePct.toFixed(1)}%</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: '0.8em' }}>Net</div>
          <div data-testid="total-net" style={{ fontSize: '1.2rem' }}>
            <Money cents={totals.totalNetCents} signed />
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: '0.8em' }}>Fees</div>
          <div style={{ fontSize: '1.2rem' }}>
            <Money cents={totals.totalFeesCents} />
          </div>
        </div>
      </div>

      <div className="panel grid">
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Equity comparison (each round indexed to 100)</h2>
        <div className="row">
          {rounds.map((round) => (
            <label key={round.id} className="row">
              <input
                type="checkbox"
                checked={chosen.includes(round.id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked ? [...chosen, round.id].sort((a, b) => a - b) : chosen.filter((id) => id !== round.id),
                  )
                }
              />
              {round.name}
            </label>
          ))}
        </div>
        <ComparisonChart roundIds={chosen} />
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Per round</h2>
        <table data-testid="round-comparison">
          <thead>
            <tr>
              <th>Round</th>
              <th>Status</th>
              <th className="num">Closed</th>
              <th className="num">Win rate</th>
              <th className="num">Net</th>
              <th className="num">Fees</th>
              <th className="num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => (
              <tr key={round.id}>
                <td>
                  <Link to={`/rounds/${round.id}`}>{round.name}</Link>
                </td>
                <td>{round.status}</td>
                <td className="num">{round.stats.closed}</td>
                <td className="num">{round.stats.winRatePct.toFixed(0)}%</td>
                <td className="num">
                  <Money cents={round.stats.totalNetCents} signed />
                </td>
                <td className="num">
                  <Money cents={round.costs.totalFeesCents} />
                </td>
                <td className="num">{round.tokenTotals.checkinTokens.toLocaleString('en-AU')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Route and navigation**

In `frontend/src/App.tsx`, import `AnalyticsPage` and add:

```tsx
            <Route path="/analytics" element={<AnalyticsPage />} />
```

In `frontend/src/shell/AppShell.tsx`, add `{ to: '/analytics', label: 'Analytics' }` to `LINKS`, between Rounds and Markets.

- [ ] **Step 6: Run everything**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`
Expected: 6 new tests pass, build succeeds. The `auth.test.tsx` nav assertions still pass — they check for specific links, not a link count. If one asserts an exact count, update it and report the sanctioned deviation.

- [ ] **Step 7: Commit**

```bash
git add frontend/src frontend/test/analytics-page.test.tsx
git commit -m "feat: cross-round analytics page with normalised comparison overlay"
```

---

## Task 9: Whole-branch review and documentation

- [ ] **Step 1: Run everything**

```bash
cd backend  && npm test && npx tsc --noEmit && npm run build
cd ../frontend && npm test && npx tsc --noEmit && npm run build
```

Record the observed totals for both suites.

- [ ] **Step 2: Dispatch the whole-branch review**

Two stages — spec-compliance then code-quality — reading the code rather than trusting task reports. Priorities:

1. **`engine/analytics.ts` gets the money-path treatment** (two separate reviewers). FIFO correctness, fee allocation, rounding. Specifically: does the sum of `costCents` across trips derived from one buy ever exceed that buy's `grossCents` after `Math.round`? Construct the adversarial case (three partial sells of an odd-cent lot) and check.
2. **Read-only guarantee.** `grep -rn "INSERT\|UPDATE\|DELETE" backend/src/analytics backend/src/api/analytics-routes.ts` must return nothing.
3. **Cents discipline.** No analytics endpoint may return dollars. Percentages must be named `...Pct`.
4. **Performance.** `/api/analytics/summary` calls `roundAnalytics` per round, which re-runs FIFO matching and re-reads the check-in ledger. With a handful of rounds that is fine; note it as a known limit and confirm nothing there is quadratic in trade count.
5. **Benchmark rebasing.** Confirm both series share a base and that `benchmarkValue` cannot return a stale close from before the round started.
6. **Empty and single-element cases** in `Histogram`, `Scatter` and `ComparisonChart` — division by a zero range is the classic bug here.

- [ ] **Step 3: Apply review fixes**

Send fixes back to the implementer that owns each file, then re-review. Findings in `engine/analytics.ts` require a re-run of both reviewers.

- [ ] **Step 4: Update CLAUDE.md**

- Update **CURRENT STATE**: Phase 1 complete — engine, API, Claude agent, dashboard, analytics. Record both test totals.
- Add to **Repo layout**: `analytics/` (service) and `engine/analytics.ts` (pure FIFO matching + statistics); note the frontend `pages/AnalyticsPage.tsx` and `pages/round/AnalyticsTab.tsx`.
- Add to **Hard-won invariants**: *analytics is strictly read-only — it derives everything from the append-only ledger and writes nothing*; and *`engine/analytics.ts` is pure and hardened like the rest of `engine/`*.
- Under **Deferred / tracked for later**, record:
  - `/api/analytics/summary` recomputes every round on each request; add a cache if round counts grow.
  - A "pass" is scored against the first watchlist symbol only.
  - Forward returns use daily/weekly `ALL` bars, so intraday decisions are scored against daily closes.
  - Unrealised P/L for USD-quoted positions is still unavailable in the UI (carried over from Plan 4) — the AUD/USD rate is not exposed over the API.
- Point at spec §10 phase 2 remnants (replay/backtest mode) and phase 3 (research briefings) as what comes next, with **phase 4 tax reporting required before any real-money work**.

- [ ] **Step 5: Commit and merge**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for the merged analytics suite"
git checkout master
git merge --no-ff feature/analytics -m "Merge Plan 5: full analytics suite (reviewed)"
cd backend && npm test
cd ../frontend && npm test
```

---

## Self-review notes

Every analytics bullet in spec §6 maps to a task:

| Spec bullet | Where |
| --- | --- |
| Win rate, trade P/L histogram, avg win vs avg loss | Tasks 1, 2, 6 |
| Hold-time vs return scatter | Tasks 1, 5, 6 |
| Decision-outcome tracking (price N days after each buy/sell/pass) | Tasks 3, 7 |
| Benchmark vs index ETF on day one | Tasks 3, 7 |
| Per-check-in ledger: tokens, actions, linked reasoning | Tasks 2, 7 |
| Cross-round comparison overlays | Task 8 |
| Config-era segmentation | Tasks 2, 6 |
| Fee/FX cost accumulation per round | Tasks 2, 6 |

Deliberate limitations, all recorded in CLAUDE.md at Task 9:

- FX cost is not separable from brokerage. Fees are stored as a single `fee_cents` per fill, with the FX spread already inside it, so `costs` splits fees by market (ASX vs US/FX) rather than by fee type. Splitting them properly means changing what `PaperBroker` writes — a hardened money-path file — and that is not worth doing for a reporting nicety.
- A "pass" is scored against the first watchlist symbol. Scoring every watchlist symbol per passed check-in multiplies history fetches for a marginal gain.
- Forward returns come from daily (or weekly, for long rounds) bars, so a day-trading round's decisions get scored against daily closes. Intraday scoring would need per-decision intraday fetches with a much shorter Yahoo retention window.
