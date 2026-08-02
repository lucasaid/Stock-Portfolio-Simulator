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
  /** FX cost is charged inside the fill fee, so fees are split by market, not by fee type. */
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
      eras: this.eras(roundId, trips),
    };
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

  private tokenTotals(roundId: number): { checkinTokens: number; checkins: number } {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(tokens_used), 0) AS tokens, COUNT(*) AS n FROM checkins WHERE round_id = ?')
      .get(roundId) as { tokens: number; n: number };
    return { checkinTokens: row.tokens, checkins: row.n };
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
