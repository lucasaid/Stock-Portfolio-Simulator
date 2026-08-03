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
    // 2 shares at $10 leaves 3000c cash, so a crash to $1 on day 3 marks equity at
    // 3000 + 200 = 3200c. That clears a 50% pause (threshold 2500c) — the cash held
    // back keeps equity above the line however far the position falls — but breaches
    // a 20% one (threshold 4000c), which is the rule this test is about.
    const crash = bars({ 3: 1 });
    const result = replayRound(input({
      trades: [
        ...buyThenHold,
        { symbol: 'AAPL', side: 'buy', quantity: 1, priceAud: 10, grossCents: 1000, feeCents: 0, executedAt: day(5) },
      ],
      bars: crash,
      guardrails: { stopLossPct: null, maxPositionPct: null, drawdownPausePct: 20, stopLossWhenPaused: true },
    }));

    expect(result.pausedAt).toBe(day(3));

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

/** Deterministic PRNG so a failure is reproducible from its seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOLS = ['AAPL', 'BHP.AX', 'TSLA'];

interface Generated {
  trades: ReplayTrade[];
  bars: ReplayBar[];
  startingBalanceCents: number;
}

/**
 * A random but *valid* history: only sells what is held, only buys what cash
 * covers. Starting balance is deliberately large relative to trade size so the
 * generator never has to model the skim to stay solvent.
 */
function generate(rand: () => number): Generated {
  const startingBalanceCents = 100_000;
  const held = new Map<string, number>();
  const trades: ReplayTrade[] = [];
  const barList: ReplayBar[] = [];
  const tradeCount = 1 + Math.floor(rand() * 12);

  for (let d = 1; d <= 14; d += 1) {
    for (const symbol of SYMBOLS) {
      const close = Math.round((1 + rand() * 40) * 100) / 100;
      const low = Math.round(close * (0.7 + rand() * 0.3) * 100) / 100;
      const high = Math.round(close * (1 + rand() * 0.3) * 100) / 100;
      barList.push({ symbol, ts: day(d), high, low, close });
    }
  }

  for (let i = 0; i < tradeCount; i += 1) {
    const symbol = SYMBOLS[Math.floor(rand() * SYMBOLS.length)]!;
    const owned = held.get(symbol) ?? 0;
    const side: 'buy' | 'sell' = owned > 0 && rand() < 0.45 ? 'sell' : 'buy';
    const quantity = side === 'sell' ? 1 + Math.floor(rand() * owned) : 1 + Math.floor(rand() * 5);
    const priceAud = Math.round((1 + rand() * 40) * 100) / 100;
    trades.push({
      symbol,
      side,
      quantity,
      priceAud,
      grossCents: Math.round(quantity * priceAud * 100),
      feeCents: Math.floor(rand() * 300),
      executedAt: day(1 + Math.floor(rand() * 14)),
    });
    held.set(symbol, side === 'buy' ? owned + quantity : owned - quantity);
  }

  // Trades are emitted with random timestamps; the engine sorts, but a sell must
  // not land before its buy, so replay them in the order generated.
  trades.sort((a, b) => (a.executedAt < b.executedAt ? -1 : a.executedAt > b.executedAt ? 1 : 0));
  return { trades, bars: barList, startingBalanceCents };
}

/** Only sells that the sorted timeline still has stock for — mirrors the engine's own clamp. */
function solvent(trades: ReplayTrade[]): ReplayTrade[] {
  const held = new Map<string, number>();
  const out: ReplayTrade[] = [];
  for (const trade of trades) {
    const owned = held.get(trade.symbol) ?? 0;
    if (trade.side === 'sell' && trade.quantity > owned) continue;
    held.set(trade.symbol, trade.side === 'buy' ? owned + trade.quantity : owned - trade.quantity);
    out.push(trade);
  }
  return out;
}

describe('replayRound money conservation (property)', () => {
  const OFF = { stopLossPct: null, maxPositionPct: null, drawdownPausePct: null, stopLossWhenPaused: true };

  it('conserves money exactly over 200 random histories with guardrails off', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = mulberry32(seed);
      const { bars: barList, startingBalanceCents } = generate(rand);
      const trades = solvent(generate(mulberry32(seed)).trades);

      const result = replayRound({
        startingBalanceCents,
        guardrails: OFF,
        fees: { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 },
        trades,
        bars: barList,
      });

      // With no guardrails every trade executes as given, so the books must balance
      // to the penny: cash + pocketed = start − buys − fees + sells.
      let expected = startingBalanceCents;
      let expectedFees = 0;
      for (const trade of trades) {
        expected += trade.side === 'buy' ? -trade.grossCents : trade.grossCents;
        expected -= trade.feeCents;
        expectedFees += trade.feeCents;
      }

      expect(result.finalCashCents + result.skimmedCents, `seed ${seed}`).toBe(expected);
      expect(result.feesCents, `seed ${seed}`).toBe(expectedFees);
      expect(result.stopLossFirings, `seed ${seed}`).toHaveLength(0);
      expect(result.skippedTrades, `seed ${seed}`).toBe(0);
    }
  });

  it('holds its invariants over 200 random histories with random guardrails', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = mulberry32(seed);
      const { bars: barList, startingBalanceCents } = generate(rand);
      const trades = solvent(generate(mulberry32(seed)).trades);
      const guardrails = {
        stopLossPct: rand() < 0.5 ? null : Math.round(rand() * 30),
        maxPositionPct: rand() < 0.5 ? null : Math.round(rand() * 100),
        drawdownPausePct: rand() < 0.5 ? null : Math.round(rand() * 90),
        stopLossWhenPaused: rand() < 0.5,
      };
      const args = {
        startingBalanceCents,
        guardrails,
        fees: { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 },
        trades,
        bars: barList,
      };

      const result = replayRound(args);

      // Never conjures or loses money: cash stays solvent and capped at the skim
      // baseline, and nothing pocketed or charged can be negative.
      expect(result.finalCashCents, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(result.finalCashCents, `seed ${seed}`).toBeLessThanOrEqual(startingBalanceCents);
      expect(result.skimmedCents, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(result.feesCents, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(result.skippedTrades, `seed ${seed}`).toBeGreaterThanOrEqual(0);

      for (const value of [result.finalCashCents, result.skimmedCents, result.feesCents]) {
        expect(Number.isInteger(value), `seed ${seed}`).toBe(true);
      }
      for (const firing of result.stopLossFirings) {
        expect(Number.isInteger(firing.proceedsCents), `seed ${seed}`).toBe(true);
        expect(firing.proceedsCents, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      }
      for (const point of result.equityCurve) {
        expect(Number.isInteger(point.equityCents), `seed ${seed}`).toBe(true);
      }

      // Pure: replaying the same input must give byte-identical output.
      expect(replayRound(args), `seed ${seed}`).toEqual(result);
    }
  });
});
