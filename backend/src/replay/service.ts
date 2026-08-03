import type { DB } from '../db/connection.js';
import { replayRound, type ReplayBar, type ReplayResult, type ReplayTrade } from '../engine/replay.js';
import type { GuardrailConfig } from '../engine/types.js';
import { RANGES, type Range } from '../market/history.js';
import type { MarketHistoryService } from '../market/history.js';
import type { RoundService } from '../rounds/service.js';

/**
 * `[null, ...]` first: "no stop at all" is the most informative row in the sweep
 * table, since it shows what the round's own trades alone would have done.
 */
export const SWEEP_STOP_LOSS_PCTS: (number | null)[] = [null, 5, 10, 15, 20];

export type GuardrailOverride = Partial<GuardrailConfig>;

export interface ReplayOutcome extends ReplayResult {
  /** True when the round has no usable OHLC bars at all — the numbers below are not meaningful. */
  insufficientHistory: boolean;
}

export interface SweepEntry {
  label: string;
  stopLossPct: number | null;
  /** True for the row that matches the round's real, currently-configured stop-loss. */
  actual: boolean;
  result: ReplayOutcome;
}

interface TradeRow {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price_aud: number;
  gross_cents: number;
  fee_cents: number;
  executed_at: string;
}

function label(stopLossPct: number | null): string {
  return stopLossPct === null ? 'no stop-loss' : `${stopLossPct}% stop-loss`;
}

/**
 * `ALL`-range bars are weekly (spec: `market/history.ts` `RANGES.ALL`), which makes
 * intraday stop detection nearly meaningless for a round that only ran a few weeks.
 * Sanctioned deviation from the plan: pick the range by the round's age instead of
 * always using `ALL`, so short rounds still replay against daily bars.
 */
function pickRange(createdAt: string, now: Date): Range {
  const ageDays = (now.getTime() - Date.parse(createdAt)) / 86_400_000;
  if (ageDays <= RANGES['1M'].lookbackDays) return '1M';
  if (ageDays <= RANGES['3M'].lookbackDays) return '3M';
  return 'ALL';
}

/**
 * Deterministic guardrail what-if calculator over a round's real trades (spec §10
 * phase 2). Strictly read-only: it never touches the money tables, only `replayRound`
 * (a pure function) and read queries here.
 */
export class ReplayService {
  constructor(private db: DB, private rounds: RoundService, private history: MarketHistoryService) {}

  async replay(roundId: number, overrides: GuardrailOverride, now = new Date()): Promise<ReplayOutcome> {
    const round = this.rounds.get(roundId); // throws for an unknown round — routes turn that into a 404
    const config = this.rounds.config(roundId);
    const trades = this.tradeRows(roundId);

    const range = pickRange(round.created_at, now);
    const bars = await this.barsFor(trades, range, now);

    const guardrails: GuardrailConfig = { ...config.guardrails, ...overrides };

    const result = replayRound({
      startingBalanceCents: round.starting_balance_cents,
      guardrails,
      fees: config.fees,
      trades: trades.map((row): ReplayTrade => ({
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        priceAud: row.price_aud,
        grossCents: row.gross_cents,
        feeCents: row.fee_cents,
        executedAt: row.executed_at,
      })),
      bars,
    });

    return { ...result, insufficientHistory: bars.length === 0 };
  }

  async sweep(roundId: number, now = new Date()): Promise<SweepEntry[]> {
    const config = this.rounds.config(roundId); // throws for an unknown round
    const entries: SweepEntry[] = [];
    for (const stopLossPct of SWEEP_STOP_LOSS_PCTS) {
      const result = await this.replay(roundId, { stopLossPct }, now);
      entries.push({
        label: label(stopLossPct),
        stopLossPct,
        actual: stopLossPct === config.guardrails.stopLossPct,
        result,
      });
    }
    return entries;
  }

  private async barsFor(trades: TradeRow[], range: Range, now: Date): Promise<ReplayBar[]> {
    const symbols = [...new Set(trades.map((t) => t.symbol))];
    const bars: ReplayBar[] = [];
    for (const symbol of symbols) {
      try {
        const fetched = await this.history.history(symbol, range, now);
        for (const bar of fetched.bars) {
          bars.push({ symbol, ts: bar.ts, high: bar.high, low: bar.low, close: bar.close });
        }
      } catch {
        // spec §7: a data outage degrades the replay (fewer bars), it does not fail it
      }
    }
    return bars;
  }

  private tradeRows(roundId: number): TradeRow[] {
    return this.db
      .prepare(
        `SELECT symbol, side, quantity, price_aud, gross_cents, fee_cents, executed_at
           FROM trades WHERE round_id = ? ORDER BY executed_at, id`,
      )
      .all(roundId) as TradeRow[];
  }
}
