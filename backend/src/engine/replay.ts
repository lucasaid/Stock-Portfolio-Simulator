import { clipBuy, drawdownBreached, stopLossTriggered } from './guardrails.js';
import { computeSkimCents } from './skim.js';
import type { FeeConfig, GuardrailConfig } from './types.js';

/**
 * Deterministic what-if replay of a round (spec §10 phase 2).
 *
 * Pure: no clock, no randomness, no database handle. The same input replays to
 * the same output forever, which is what makes the sweep in the UI trustworthy.
 *
 * Modelling decisions, because these are the questions a reviewer will ask:
 *
 * - **Trades are inputs, not decisions.** A trade the real agent made is replayed
 *   as-is unless a guardrail in the *simulated* config prevents it (the position
 *   was already stopped out, the round is paused, the position cap is hit). This
 *   asks what different *rules* would have done with the same trades — it cannot
 *   say how the agent would have behaved under different rules.
 * - **Intraday stops use the bar low.** A stop that would have been hit intraday
 *   did happen, even if the close recovered. Using the close would systematically
 *   flatter every tight-stop scenario.
 * - **But the fill is at the stop price, not the bar low**, matching how a real
 *   stop order behaves. Filling at the low would make tight stops look
 *   catastrophic for the opposite, equally wrong, reason.
 * - **One stop check per bar, evaluated before that day's trades**, so a stop and
 *   a same-day buy can't both act on stale state.
 *
 * Every rule comes from the real engine functions — `stopLossTriggered`,
 * `drawdownBreached`, `clipBuy`, `computeSkimCents`. A divergent copy of the
 * rules is the failure mode that makes a backtest lie, so there are none here.
 */

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

/** ISO-8601 strings sort lexicographically in chronological order. */
function byTimestamp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export function replayRound(input: ReplayInput): ReplayResult {
  const { startingBalanceCents, guardrails, trades, bars } = input;

  let cashCents = startingBalanceCents;
  let skimmedCents = 0;
  let feesCents = 0;
  let pausedAt: string | null = null;
  let skippedTrades = 0;
  const stopLossFirings: StopFiring[] = [];
  const equityCurve: { ts: string; equityCents: number }[] = [];

  const positions = new Map<string, SimPosition>();
  /** Last close seen per symbol, for marking equity between bars. */
  const lastClose = new Map<string, number>();

  const barsByTs = groupBy(bars, (b) => b.ts);
  const tradesByTs = groupBy(trades, (t) => t.executedAt);
  const timeline = [...new Set([...barsByTs.keys(), ...tradesByTs.keys()])].sort(byTimestamp);

  /** Cash rising above the starting balance is pocketed, exactly as RoundService.sell does. */
  function skim(): void {
    const excess = computeSkimCents(cashCents, startingBalanceCents);
    if (excess > 0) {
      skimmedCents += excess;
      cashCents -= excess;
    }
  }

  function markToMarketCents(): number {
    let total = cashCents;
    for (const position of positions.values()) {
      const price = lastClose.get(position.symbol);
      // No price yet means no basis for a mark; hold the position at cost.
      total += price === undefined ? position.costCents : Math.round(position.quantity * price * 100);
    }
    return total;
  }

  for (const ts of timeline) {
    // 1. Stops fire before the day's trades, against this bar's low.
    for (const bar of barsByTs.get(ts) ?? []) {
      const position = positions.get(bar.symbol);
      const stopsActive = pausedAt === null || guardrails.stopLossWhenPaused;

      if (position !== undefined && stopsActive && guardrails.stopLossPct !== null) {
        const avgCostPrice = position.costCents / 100 / position.quantity;
        if (stopLossTriggered({ avgCostPrice, currentPrice: bar.low, stopLossPct: guardrails.stopLossPct, stopPrice: null })) {
          // Filled at the stop, not at the low — a real stop order does not chase the wick down.
          const stopPrice = avgCostPrice * (1 - guardrails.stopLossPct / 100);
          const proceedsCents = Math.round(position.quantity * stopPrice * 100);
          stopLossFirings.push({ symbol: bar.symbol, at: ts, stopPrice, quantity: position.quantity, proceedsCents });
          cashCents += proceedsCents;
          positions.delete(bar.symbol);
          skim();
        }
      }
      lastClose.set(bar.symbol, bar.close);
    }

    // 2. The day's real trades, subject to the simulated guardrails.
    for (const trade of tradesByTs.get(ts) ?? []) {
      if (trade.side === 'buy') {
        // A paused round opens no new exposure. Sells still run: they reduce risk,
        // and both the operator and the protective stops keep selling while paused.
        if (pausedAt !== null) {
          skippedTrades += 1;
          continue;
        }
        const held = positions.get(trade.symbol);
        const clip = clipBuy({
          requestedCents: trade.grossCents,
          cashCents: cashCents - trade.feeCents,
          heldCostCents: held?.costCents ?? 0,
          startingBalanceCents,
          maxPositionPct: guardrails.maxPositionPct,
        });
        if (clip.rejected) {
          skippedTrades += 1;
          continue;
        }
        // A clipped buy takes the same trade at a smaller size, scaled by value.
        const scale = clip.allowedCents / trade.grossCents;
        const grossCents = clip.allowedCents;
        const feeCents = Math.round(trade.feeCents * scale);
        const quantity = trade.quantity * scale;

        cashCents -= grossCents + feeCents;
        feesCents += feeCents;
        positions.set(trade.symbol, {
          symbol: trade.symbol,
          quantity: (held?.quantity ?? 0) + quantity,
          costCents: (held?.costCents ?? 0) + grossCents,
        });
      } else {
        const held = positions.get(trade.symbol);
        // The position is gone — an earlier simulated stop already sold it.
        if (held === undefined || held.quantity <= 0) {
          skippedTrades += 1;
          continue;
        }
        // Sell no more than the simulation still holds, scaling the trade to fit.
        const quantity = Math.min(held.quantity, trade.quantity);
        const scale = quantity / trade.quantity;
        if (scale < 1) skippedTrades += 1;

        const grossCents = Math.round(trade.grossCents * scale);
        const feeCents = Math.round(trade.feeCents * scale);
        const costOut = Math.round(held.costCents * (quantity / held.quantity));

        cashCents += grossCents - feeCents;
        feesCents += feeCents;
        const remaining = held.quantity - quantity;
        if (remaining <= 0) positions.delete(trade.symbol);
        else positions.set(trade.symbol, { ...held, quantity: remaining, costCents: held.costCents - costOut });
        skim();
      }
    }

    // 3. Mark equity and test the drawdown rule. The pause is sticky: the real
    //    round stops and waits for the operator, it does not resume on a recovery.
    if (barsByTs.has(ts)) {
      const equityCents = markToMarketCents();
      equityCurve.push({ ts, equityCents });
      if (pausedAt === null && drawdownBreached(equityCents, startingBalanceCents, guardrails.drawdownPausePct)) {
        pausedAt = ts;
      }
    }
  }

  return { finalCashCents: cashCents, skimmedCents, feesCents, stopLossFirings, pausedAt, skippedTrades, equityCurve };
}
