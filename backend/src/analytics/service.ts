import type { DB } from '../db/connection.js';
import {
  bucketReturns, matchRoundTrips, summarizeRoundTrips,
  type AnalyticsTrade, type ReturnBucket, type RoundTrip, type RoundTripStats,
} from '../engine/analytics.js';
import type { Market } from '../engine/types.js';
import { marketForSymbol } from '../market/data.js';
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
  /** FX cost is charged inside the fill fee, so fees are split by market, not by fee type. */
  feesByMarket: Partial<Record<Market, number>>;
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

export interface AiUsageByType {
  type: 'checkin' | 'research' | 'scan';
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface AiUsagePattern {
  /** Ordered tool-name sequence, e.g. ['place_order', 'write_journal']. Empty = no tool calls. */
  sequence: string[];
  count: number;
}

export interface AiUsageBreakdown {
  byType: AiUsageByType[];
  totalTokens: number;
  totalCostUsd: number;
  byDay: { day: string; tokens: number; costUsd: number }[];
  patterns: AiUsagePattern[];
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
  aiUsage: AiUsageBreakdown;
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

/** Index of the last bar at or before `at`, or -1 when the series starts later. */
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
function verdictFor(decision: Decision, forward: ForwardReturn[]): string {
  const medium = forward.find((f) => f.bars === 5) ?? forward[forward.length - 1];
  const move = medium?.pricePct ?? null;
  if (move === null) return 'too recent to judge';
  const rounded = move.toFixed(1);
  if (decision === 'buy') return move >= 0 ? `up ${rounded}% since` : `down ${rounded}% since`;
  if (decision === 'sell') return move > 2 ? 'sold early' : move < -2 ? 'sold well' : 'sold about right';
  return move > 2 ? `passing cost ${rounded}%` : move < -2 ? `passing avoided ${rounded}%` : 'passing was neutral';
}

export function parseActions(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as { tool?: string }[];
    return Array.isArray(parsed)
      ? parsed.map((a) => a.tool).filter((t): t is string => typeof t === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Read-only analytics over the append-only ledger. This service must never
 * INSERT, UPDATE or DELETE — every number here is derived on request.
 */
export class AnalyticsService {
  constructor(private db: DB, private rounds: RoundService, private history: MarketHistoryService) {}

  async roundAnalytics(roundId: number): Promise<RoundAnalytics> {
    // Throws for an unknown round — the routes turn that into a 404.
    this.rounds.get(roundId);

    const trades = this.tradeRows(roundId);
    const trips = matchRoundTrips(trades.map(toAnalyticsTrade));
    const aiUsage = this.aiUsage(roundId);

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
      tokenTotals: this.tokenTotals(aiUsage),
      eras: this.eras(roundId, trips),
      aiUsage,
    };
  }

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
    const firstTs = snapshots[0]?.ts;
    // Anchor on the close at (or before) the round's first snapshot; if the series
    // starts later than the round did, fall back to its earliest bar.
    const firstClose = (firstTs === undefined ? undefined : priceAt(bars, firstTs)) ?? bars[0]?.close;

    const points: BenchmarkPoint[] = snapshots.map((snapshot) => ({
      ts: snapshot.ts,
      equityCents: snapshot.equity_cents,
      benchmarkCents: firstClose === undefined ? null : this.benchmarkValue(bars, snapshot.ts, firstClose, base),
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
  private benchmarkValue(
    bars: { ts: string; close: number }[],
    ts: string,
    firstClose: number,
    baseCents: number,
  ): number | null {
    const close = priceAt(bars, ts);
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
        barsBySymbol.set(
          symbol,
          (await this.history.history(symbol, 'ALL')).bars.map((b) => ({ ts: b.ts, close: b.close })),
        );
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

  private forwardReturns(
    bars: { ts: string; close: number }[],
    at: string,
    horizons: number[],
  ): ForwardReturn[] {
    const index = lastIndexAtOrBefore(bars, at);
    if (index === -1) return horizons.map((h) => ({ bars: h, pricePct: null }));
    const basePrice = bars[index]!.close;
    return horizons.map((h) => {
      const target = bars[index + h];
      if (target === undefined || basePrice === 0) return { bars: h, pricePct: null };
      return { bars: h, pricePct: ((target.close - basePrice) / basePrice) * 100 };
    });
  }

  private tradeRows(roundId: number): TradeRow[] {
    return this.db
      .prepare(
        `SELECT id, symbol, side, quantity, gross_cents, fee_cents, executed_at
           FROM trades WHERE round_id = ? ORDER BY executed_at, id`,
      )
      .all(roundId) as TradeRow[];
  }

  private costs(roundId: number): CostBreakdown {
    const rows = this.db
      .prepare("SELECT amount_cents, note, created_at FROM ledger_entries WHERE round_id = ? AND type = 'fee' ORDER BY id")
      .all(roundId) as { amount_cents: number; note: string | null; created_at: string }[];

    const byDay = new Map<string, number>();
    const byMarket = new Map<Market, number>();
    let total = 0;
    const SYMBOL_RE = /^fee for (?:buy|sell) (.+)$/;
    for (const row of rows) {
      const cents = -row.amount_cents; // fees are stored as negative cash movements
      total += cents;
      const day = row.created_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + cents);
      const symbol = row.note === null ? null : SYMBOL_RE.exec(row.note)?.[1] ?? null;
      if (symbol !== null) {
        const market = marketForSymbol(symbol);
        byMarket.set(market, (byMarket.get(market) ?? 0) + cents);
      }
    }

    return {
      totalFeesCents: total,
      feesByMarket: Object.fromEntries(byMarket),
      byDay: [...byDay.entries()]
        .map(([day, feesCents]) => ({ day, feesCents }))
        .sort((a, b) => (a.day < b.day ? -1 : 1)),
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

  /** Derived from `aiUsage()`'s checkin row rather than a second SUM query. */
  private tokenTotals(usage: AiUsageBreakdown): { checkinTokens: number; checkins: number } {
    const checkinRow = usage.byType.find((t) => t.type === 'checkin');
    return { checkinTokens: checkinRow?.tokens ?? 0, checkins: checkinRow?.runs ?? 0 };
  }

  /**
   * Token/cost aggregation across the three AI-run sources (spec
   * docs/superpowers/specs/2026-08-04-ai-usage-monitor-design.md §2). Strictly
   * read-only, same as the rest of this file.
   */
  private aiUsage(roundId: number): AiUsageBreakdown {
    const sources: { type: AiUsageByType['type']; table: string; tsCol: string }[] = [
      { type: 'checkin', table: 'checkins', tsCol: 'ts' },
      { type: 'research', table: 'research_briefings', tsCol: 'created_at' },
      { type: 'scan', table: 'market_scans', tsCol: 'created_at' },
    ];

    const byType: AiUsageByType[] = [];
    const dayTotals = new Map<string, { tokens: number; costUsd: number }>();

    for (const source of sources) {
      const totals = this.db
        .prepare(
          `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_used),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
             FROM ${source.table} WHERE round_id = ?`,
        )
        .get(roundId) as { runs: number; tokens: number; cost: number };
      byType.push({ type: source.type, runs: totals.runs, tokens: totals.tokens, costUsd: totals.cost });

      const rows = this.db
        .prepare(`SELECT ${source.tsCol} AS ts, tokens_used AS tokens, cost_usd AS cost FROM ${source.table} WHERE round_id = ?`)
        .all(roundId) as { ts: string; tokens: number; cost: number }[];
      for (const row of rows) {
        const day = row.ts.slice(0, 10);
        const existing = dayTotals.get(day) ?? { tokens: 0, costUsd: 0 };
        existing.tokens += row.tokens ?? 0;
        existing.costUsd += row.cost ?? 0;
        dayTotals.set(day, existing);
      }
    }

    const byDay = [...dayTotals.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));

    return {
      byType,
      totalTokens: byType.reduce((sum, t) => sum + t.tokens, 0),
      totalCostUsd: byType.reduce((sum, t) => sum + t.costUsd, 0),
      byDay,
      patterns: this.patternCounts(roundId),
    };
  }

  /** Groups check-ins' already-recorded tool-call sequences (spec §2) — top 10 by count desc. */
  private patternCounts(roundId: number, limit = 10): AiUsagePattern[] {
    const rows = this.db
      .prepare('SELECT actions_json FROM checkins WHERE round_id = ? ORDER BY id DESC')
      .all(roundId) as { actions_json: string }[];

    const counts = new Map<string, { sequence: string[]; count: number }>();
    for (const row of rows) {
      const sequence = parseActions(row.actions_json);
      const key = JSON.stringify(sequence);
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { sequence, count: 1 });
    }

    return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  }

  /**
   * Config-era segmentation (spec §6): a round's history is split at every config
   * change, so "the aggressive era lost money" becomes answerable. A trip belongs
   * to the era containing its close.
   */
  private eras(roundId: number, trips: RoundTrip[]): ConfigEra[] {
    const { created_at: createdAt } = this.db
      .prepare('SELECT created_at FROM rounds WHERE id = ?')
      .get(roundId) as { created_at: string };

    const changes = this.db
      .prepare('SELECT field, new_value, created_at FROM config_events WHERE round_id = ? ORDER BY created_at, id')
      .all(roundId) as { field: string; new_value: string | null; created_at: string }[];

    const boundaries = [{ label: 'initial config', at: createdAt }].concat(
      changes.map((change) => ({ label: `${change.field} → ${change.new_value ?? 'null'}`, at: change.created_at })),
    );

    return boundaries.map((boundary, index) => {
      const next = boundaries[index + 1]?.at ?? null;
      // The first era is open-ended at the start: the eras must partition EVERY
      // trip, so their stats sum to the round's. Anchoring it at created_at would
      // silently drop trips timestamped before the round row (backfills, clock
      // skew, imported history).
      const lowerBound = index === 0 ? Number.NEGATIVE_INFINITY : Date.parse(boundary.at);
      const inEra = trips.filter((trip) => {
        const closed = Date.parse(trip.closedAt);
        return closed >= lowerBound && (next === null || closed < Date.parse(next));
      });
      return { label: boundary.label, from: boundary.at, to: next, stats: summarizeRoundTrips(inEra) };
    });
  }
}

export type { RoundTrip, RoundTripStats };
