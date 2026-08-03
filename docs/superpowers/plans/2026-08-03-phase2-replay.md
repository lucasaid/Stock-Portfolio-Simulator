# Phase 2 Replay / Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last item in spec §10 phase 2 — replay a round's config against stored OHLC history to answer "would a tighter stop have helped?" deterministically, with no agent calls and no cost.

**Architecture:** A pure simulator in `engine/replay.ts` that takes a starting balance, a guardrail config, a set of dated trades, and a price series, and re-runs the deterministic half of the system: stop-losses, drawdown pauses, fees and skims. **The agent's decisions are treated as fixed inputs** — the replay asks what different *rules* would have done with the same trades, not what a different agent would have done. A thin service reads the round's real trades and OHLC bars and feeds them in; routes expose it; the UI puts a guardrail sweep on the analytics tab.

**What this deliberately cannot answer:** "would Claude have traded differently under these guardrails?" Answering that needs real agent calls per historical check-in, which was scoped out (the user chose deterministic-only). The UI must say so plainly rather than implying otherwise.

**Tech Stack:** Unchanged.

---

## Prerequisites

Plans 1–5, the pre-flight fixes, and ideally Plan 6 are merged. This plan depends on `MarketHistoryService` / `ohlc_bars` (Plan 4) and reuses `engine/analytics.ts`'s statistics (Plan 5).

Read `CLAUDE.md` **Hard-won invariants**. The two that dominate here:

- **Money is integer AUD cents**, and `engine/` is pure with no I/O. `replay.ts` joins that rule: no database handle, no clock, no randomness — same inputs, same outputs, forever.
- **Replay must never write to the money tables.** It is a what-if calculator. A test asserts row counts are unchanged, exactly as Plan 5's analytics service does.

---

## File structure

**Created:** `backend/src/engine/replay.ts`, `backend/src/replay/service.ts`, `backend/src/api/replay-routes.ts`, `backend/test/replay-engine.test.ts`, `backend/test/replay-service.test.ts`, `backend/test/api-replay.test.ts`, `frontend/src/pages/round/ReplayPanel.tsx`, `frontend/test/replay.test.tsx`.

**Modified:** `backend/src/api/app.ts`, `backend/src/index.ts`, `backend/test/api-helper.ts`, `frontend/src/api/analytics.ts` (types + hook), `frontend/src/pages/round/AnalyticsTab.tsx`, `frontend/test/server.ts`.

---

## Task 1: The pure replay engine

**Files:** create `backend/src/engine/replay.ts`, `backend/test/replay-engine.test.ts`.

- [ ] **Step 1: Write the failing test**

`backend/test/replay-engine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { replayRound, type ReplayBar, type ReplayInput, type ReplayTrade } from '../src/engine/replay.js';

const day = (n: number): string => new Date(Date.UTC(2026, 0, n)).toISOString();

/** A flat 10.00 series unless a day is overridden. */
function bars(closes: Record<number, number>, days = 10): ReplayBar[] {
  return Array.from({ length: days }, (_, i) => ({
    symbol: 'AAPL', ts: day(i + 1), high: closes[i + 1] ?? 10, low: closes[i + 1] ?? 10, close: closes[i + 1] ?? 10,
  }));
}

function input(over: Partial<ReplayInput> = {}): ReplayInput {
  return {
    startingBalanceCents: 5000,
    guardrails: { stopLossPct: 10, maxPositionPct: null, drawdownPausePct: null, stopLossWhenPaused: true },
    fees: { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 },
    trades: [],
    bars: bars({}),
    ...over,
  };
}

const buyThenHold: ReplayTrade[] = [
  { symbol: 'AAPL', side: 'buy', quantity: 2, priceAud: 10, grossCents: 2000, feeCents: 0, executedAt: day(1) },
];

describe('replayRound', () => {
  it('is a no-op for a round that never traded', () => {
    const result = replayRound(input());
    expect(result.finalCashCents).toBe(5000);
    expect(result.skimmedCents).toBe(0);
    expect(result.stopLossFirings).toHaveLength(0);
  });

  it('replays a buy and sell to the same cash the real round reached', () => {
    const result = replayRound(input({
      trades: [
        ...buyThenHold,
        { symbol: 'AAPL', side: 'sell', quantity: 2, priceAud: 15, grossCents: 3000, feeCents: 0, executedAt: day(3) },
      ],
      guardrails: { stopLossPct: null, maxPositionPct: null, drawdownPausePct: null, stopLossWhenPaused: true },
    }));

    // 5000 − 2000 + 3000 = 6000, skim the 1000 above the 5000 baseline.
    expect(result.skimmedCents).toBe(1000);
    expect(result.finalCashCents).toBe(5000);
  });

  it('fires a stop-loss the real round did not, when the rule is tighter', () => {
    // Price dips to 9.20 on day 2 (−8%) then recovers. A 10% stop misses it; a 5% stop catches it.
    const dip = bars({ 2: 9.2, 5: 12 });

    const loose = replayRound(input({ trades: buyThenHold, bars: dip, guardrails: { stopLossPct: 10, maxPositionPct: null, drawdownPausePct: null, stopLossWhenPaused: true } }));
    const tight = replayRound(input({ trades: buyThenHold, bars: dip, guardrails: { stopLossPct: 5, maxPositionPct: null, drawdownPausePct: null, stopLossWhenPaused: true } }));

    expect(loose.stopLossFirings).toHaveLength(0);
    expect(tight.stopLossFirings).toHaveLength(1);
    expect(tight.stopLossFirings[0]!.symbol).toBe('AAPL');
  });

  it('uses the bar low, not the close, to decide whether a stop was hit', () => {
    // Closes at 10 every day but wicks to 8.50 on day 2 — a 10% stop must fire intraday.
    const wick: ReplayBar[] = bars({}).map((b, i) => (i === 1 ? { ...b, low: 8.5 } : b));
    const result = replayRound(input({ trades: buyThenHold, bars: wick }));
    expect(result.stopLossFirings).toHaveLength(1);
  });

  it('sells at the stop price, not the bar low, when the stop fires', () => {
    const wick: ReplayBar[] = bars({}).map((b, i) => (i === 1 ? { ...b, low: 5 } : b));
    const result = replayRound(input({ trades: buyThenHold, bars: wick }));
    // Stop at 10% below the 10.00 cost = 9.00 for 2 shares = 1800c, not 5.00 × 2.
    expect(result.stopLossFirings[0]!.proceedsCents).toBe(1800);
  });

  it('does not fire a stop before the position was opened', () => {
    const earlyCrash = bars({ 1: 1 });
    const lateBuy: ReplayTrade[] = [
      { symbol: 'AAPL', side: 'buy', quantity: 1, priceAud: 10, grossCents: 1000, feeCents: 0, executedAt: day(5) },
    ];
    expect(replayRound(input({ trades: lateBuy, bars: earlyCrash })).stopLossFirings).toHaveLength(0);
  });

  it('skims every time cash rises above the starting balance, never below it', () => {
    const result = replayRound(input({
      trades: [
        { symbol: 'AAPL', side: 'buy', quantity: 1, priceAud: 10, grossCents: 1000, feeCents: 0, executedAt: day(1) },
        { symbol: 'AAPL', side: 'sell', quantity: 1, priceAud: 20, grossCents: 2000, feeCents: 0, executedAt: day(2) },
        { symbol: 'AAPL', side: 'buy', quantity: 1, priceAud: 10, grossCents: 1000, feeCents: 0, executedAt: day(3) },
        { symbol: 'AAPL', side: 'sell', quantity: 1, priceAud: 20, grossCents: 2000, feeCents: 0, executedAt: day(4) },
      ],
      guardrails: { stopLossPct: null, maxPositionPct: null, drawdownPausePct: null, stopLossWhenPaused: true },
    }));

    expect(result.skimmedCents).toBe(2000);
    expect(result.finalCashCents).toBe(5000);
  });

  it('charges fees out of cash', () => {
    const result = replayRound(input({
      trades: [{ symbol: 'AAPL', side: 'buy', quantity: 1, priceAud: 10, grossCents: 1000, feeCents: 300, executedAt: day(1) }],
      guardrails: { stopLossPct: null, maxPositionPct: null, drawdownPausePct: null, stopLossWhenPaused: true },
    }));
    expect(result.finalCashCents).toBe(5000 - 1000 - 300);
    expect(result.feesCents).toBe(300);
  });

  it('pauses on a drawdown breach and stops opening new positions after it', () => {
    const crash = bars({ 3: 1 });
    const result = replayRound(input({
      trades: [
        ...buyThenHold,
        { symbol: 'AAPL', side: 'buy', quantity: 1, priceAud: 10, grossCents: 1000, feeCents: 0, executedAt: day(5) },
      ],
      bars: crash,
      guardrails: { stopLossPct: null, maxPositionPct: null, drawdownPausePct: 50, stopLossWhenPaused: true },
    }));

    expect(result.pausedAt).not.toBeNull();
    expect(result.skippedTrades).toBe(1);
  });

  it('is deterministic — the same input replays to the same output', () => {
    const one = replayRound(input({ trades: buyThenHold, bars: bars({ 2: 8 }) }));
    const two = replayRound(input({ trades: buyThenHold, bars: bars({ 2: 8 }) }));
    expect(one).toEqual(two);
  });

  it('keeps every money figure an integer', () => {
    const result = replayRound(input({
      trades: [{ symbol: 'AAPL', side: 'buy', quantity: 3, priceAud: 3.33, grossCents: 999, feeCents: 7, executedAt: day(1) }],
      bars: bars({ 2: 2 }),
    }));
    for (const value of [result.finalCashCents, result.skimmedCents, result.feesCents]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    for (const firing of result.stopLossFirings) expect(Number.isInteger(firing.proceedsCents)).toBe(true);
  });

  it('handles bars arriving out of order', () => {
    const shuffled = [...bars({ 2: 8 })].reverse();
    expect(replayRound(input({ trades: buyThenHold, bars: shuffled })).stopLossFirings).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npm test -- replay-engine` → FAIL.

- [ ] **Step 3: Write the engine**

`backend/src/engine/replay.ts`. It must reuse `stopLossTriggered` and `drawdownBreached` from `guardrails.ts` and `computeSkimCents` from `skim.ts` rather than reimplementing them — the whole value of the replay is that it applies the *same* rules.

Key modelling decisions to encode as comments, because they are the questions a reviewer will ask:

- **Trades are inputs, not decisions.** A trade the real agent made is replayed as-is unless a guardrail in the *simulated* config prevents it (position already stopped out, round paused).
- **Intraday stops use the bar low** — a stop that would have been hit intraday did happen, even if the close recovered. But the **fill is at the stop price**, not the low, matching how a real stop order behaves.
- **One stop check per bar**, evaluated before that day's trades, so a stop and a same-day buy can't both act on stale state.

```ts
import { drawdownBreached, stopLossTriggered } from './guardrails.js';
import { computeSkimCents } from './skim.js';
import type { FeeConfig, GuardrailConfig } from './types.js';

export interface ReplayTrade {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  priceAud: number;
  grossCents: number;
  feeCents: number;
  executedAt: string;
}

export interface ReplayBar {
  symbol: string;
  ts: string;
  high: number;
  low: number;
  close: number;
}

export interface ReplayInput {
  startingBalanceCents: number;
  guardrails: GuardrailConfig;
  fees: FeeConfig;
  trades: ReplayTrade[];
  bars: ReplayBar[];
}

export interface StopFiring {
  symbol: string;
  at: string;
  stopPrice: number;
  quantity: number;
  proceedsCents: number;
}

export interface ReplayResult {
  finalCashCents: number;
  skimmedCents: number;
  feesCents: number;
  stopLossFirings: StopFiring[];
  /** ISO timestamp of the drawdown pause, or null if it never breached. */
  pausedAt: string | null;
  /** Trades the simulated guardrails prevented (position gone, or round paused). */
  skippedTrades: number;
  /** Equity per bar, for charting against the real curve. */
  equityCurve: { ts: string; equityCents: number }[];
}

interface SimPosition {
  symbol: string;
  quantity: number;
  costCents: number;
}

// … implement the day-by-day loop here, per the modelling decisions above.
```

Write the loop out in full: sort bars and trades by timestamp, walk the merged timeline, and for each bar first evaluate stops for open positions (using `stopLossTriggered` with `avgCostPrice = costCents / 100 / quantity` and `currentPrice = bar.low`), then apply that day's trades, then mark equity and evaluate `drawdownBreached`. Sells run `computeSkimCents` exactly as `RoundService.sell` does.

- [ ] **Step 4: Run the tests**

Run: `cd backend && npm test -- replay-engine && npx tsc --noEmit` → 12 pass.

- [ ] **Step 5: Add a conservation property test**

Append a property test in the style of Plan 5's: over 200 seeded random trade/bar sequences, assert that `finalCashCents + skimmedCents + value-of-open-positions-at-cost` never exceeds `startingBalanceCents + realised gains`, that every money figure stays an integer, and that replaying twice gives identical output.

- [ ] **Step 6: Commit**

```bash
git add backend/src/engine/replay.ts backend/test/replay-engine.test.ts
git commit -m "feat: pure deterministic replay engine"
```

---

## Task 2: Replay service and routes

**Files:** create `backend/src/replay/service.ts`, `backend/src/api/replay-routes.ts`, `backend/test/replay-service.test.ts`, `backend/test/api-replay.test.ts`; modify `backend/src/api/app.ts`, `backend/src/index.ts`, `backend/test/api-helper.ts`.

- [ ] **Step 1: Write the failing tests**

`backend/test/replay-service.test.ts` — seed a round with trades (same `seedTrade` helper shape as `analytics-service.test.ts`) and a `BarFetcher`, then assert:

1. `replay(roundId, overrides)` returns a `ReplayResult` for the round's real config when `overrides` is empty.
2. A `stopLossPct` override changes the outcome (tighter stop → more firings).
3. `sweep(roundId, [5, 10, 15, 20])` returns one result per stop-loss percentage, each labelled.
4. The sweep marks which entry is the round's **actual** configuration, so the UI can anchor the comparison.
5. An unknown round throws (routes turn that into a 404).
6. A round with no OHLC history returns a result with an explicit `insufficientHistory: true` rather than a silently empty replay.
7. **Writes nothing** — row counts across `trades`, `orders`, `ledger_entries`, `positions`, `rounds` are unchanged after a sweep.

`backend/test/api-replay.test.ts` — auth on both routes; `GET /api/replay/rounds/:id/sweep` returns the sweep; `POST /api/replay/rounds/:id` accepts a guardrail override body and rejects a malformed one (400); unknown round 404s; every money field in the response is an integer.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test -- replay-service api-replay` → FAIL.

- [ ] **Step 3: Write the service**

`backend/src/replay/service.ts` — constructor `(db, rounds, history)`, mirroring `AnalyticsService`. It reads the round's trades, fetches `ALL`-range bars for every traded symbol, merges them into one `ReplayBar[]`, deep-merges the caller's guardrail overrides over the round's real config (**a partial override must not strip keys** — same rule as the config PATCH), and calls `replayRound`.

`SWEEP_STOP_LOSS_PCTS = [null, 5, 10, 15, 20]` — `null` meaning "no stop at all" is the most informative row in the table and must be included.

- [ ] **Step 4: Routes and wiring**

`backend/src/api/replay-routes.ts` with `GET /api/replay/rounds/:id/sweep` and `POST /api/replay/rounds/:id`. Validate the override body: each guardrail is a number or `null`, nothing else. Add `replay: ReplayService` to `ApiDeps`, mount, wire in `index.ts`, and add to `api-helper.ts`.

- [ ] **Step 5: Run everything**

Run: `cd backend && npm test && npx tsc --noEmit && npm run build`

- [ ] **Step 6: Commit**

```bash
git add backend/src backend/test
git commit -m "feat: replay service and read-only replay routes"
```

---

## Task 3: The replay panel

**Files:** create `frontend/src/pages/round/ReplayPanel.tsx`, `frontend/test/replay.test.tsx`; modify `frontend/src/api/analytics.ts`, `frontend/src/pages/round/AnalyticsTab.tsx`, `frontend/test/server.ts`.

- [ ] **Step 1: Write the failing test**

Assert that the panel:

1. Renders one row per swept stop-loss setting, including the "no stop" row.
2. Marks the round's actual setting distinctly (e.g. an "actual" badge) so the comparison has an anchor.
3. Shows pocketed, fees and final cash per row as formatted money.
4. States plainly that the replay holds the agent's trades fixed — assert on that caveat text. **This is a required assertion, not decoration:** without it the table reads as "a 5% stop would have made you $X", which is not what it computes.
5. Renders the insufficient-history state when the API says so.
6. Surfaces a load error via `role="alert"`.

Add fixtures and handlers to the base `handlers` array in `frontend/test/server.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- replay` → FAIL.

- [ ] **Step 3: Build it**

Types and a `useReplaySweep(id)` hook in `src/api/analytics.ts` (keys under `analyticsKeys`), then the panel in the established style. Put it in a `<section>` at the bottom of `AnalyticsTab`, under a heading like "What if the guardrails had been different?", with the caveat as visible prose:

> Trades are held fixed — this replays the same buys and sells against the same price history under different guardrail settings. It cannot tell you how the agent would have behaved with different rules.

- [ ] **Step 4: Run everything**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`

- [ ] **Step 5: Commit**

```bash
git add frontend/
git commit -m "feat: guardrail replay sweep on the analytics tab"
```

---

## Task 4: Review, docs, merge

- [ ] **Step 1: Full suites, both sides.**

- [ ] **Step 2: Whole-branch review.** Priorities:

1. **`engine/replay.ts` is pure** — no `Date.now()`, no `Math.random()`, no db handle. The determinism test proves it; confirm by reading.
2. **It reuses the real rule functions** (`stopLossTriggered`, `drawdownBreached`, `computeSkimCents`) rather than reimplementing them. A divergent copy is the failure mode that makes a backtest lie.
3. **Read-only** — `grep -rnE "INSERT|UPDATE|DELETE" backend/src/replay backend/src/api/replay-routes.ts` returns nothing.
4. **Money stays integer cents** end to end; the stop fill is at the stop price, not the bar low.
5. **Guardrail overrides deep-merge**, so a partial override can't null out a key it didn't mention.
6. **The UI caveat is present and accurate.**

- [ ] **Step 3: Update CLAUDE.md** — new `replay/` module and `engine/replay.ts`; spec §10 phase 2 complete; and the invariant that *replay is read-only and must reuse the engine's real rule functions, never a copy of them*. Record the deliberate limitation (agent decisions fixed) in the deferred list so nobody later mistakes the sweep for a true backtest.

- [ ] **Step 4: Merge** `--no-ff` into master and re-run both suites.
