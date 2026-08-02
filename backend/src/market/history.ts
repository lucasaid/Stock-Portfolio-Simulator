import type { DB } from '../db/connection.js';

export type Range = '1D' | '1W' | '1M' | '3M' | 'ALL';

export interface OhlcBar {
  /** ISO timestamp of the bar's open. */
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface RangeSpec {
  interval: string;
  lookbackDays: number;
  /** How long a cached fetch stays authoritative. Intraday data moves; weekly data does not. */
  ttlMs: number;
}

export const RANGES: Record<Range, RangeSpec> = {
  '1D': { interval: '5m', lookbackDays: 3, ttlMs: 5 * 60_000 },
  '1W': { interval: '30m', lookbackDays: 8, ttlMs: 15 * 60_000 },
  '1M': { interval: '1d', lookbackDays: 31, ttlMs: 12 * 3_600_000 },
  '3M': { interval: '1d', lookbackDays: 93, ttlMs: 12 * 3_600_000 },
  ALL: { interval: '1wk', lookbackDays: 3650, ttlMs: 24 * 3_600_000 },
};

export function isRange(value: unknown): value is Range {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANGES, value);
}

export type BarFetcher = (
  symbol: string,
  opts: { interval: string; period1: Date },
) => Promise<{ currency: string; bars: OhlcBar[] }>;

export interface HistoryResult {
  symbol: string;
  range: Range;
  interval: string;
  currency: string;
  bars: OhlcBar[];
  /** True when the upstream fetch failed and these bars came from cache. */
  stale: boolean;
}

/** A bar is usable only if every price is finite and positive and the range is coherent. */
function isUsableBar(bar: OhlcBar): boolean {
  const prices = [bar.open, bar.high, bar.low, bar.close];
  if (!prices.every((p) => Number.isFinite(p) && p > 0)) return false;
  if (bar.high < bar.low) return false;
  if (!Number.isFinite(Date.parse(bar.ts))) return false;
  return bar.volume === null || Number.isFinite(bar.volume);
}

/**
 * Cache-first OHLC reads. The fetcher is injected so tests never touch the network
 * (same contract as MarketDataService's QuoteFetcher).
 */
export class MarketHistoryService {
  constructor(private db: DB, private fetcher: BarFetcher) {}

  async history(symbol: string, range: Range, now = new Date()): Promise<HistoryResult> {
    const spec = RANGES[range];
    const since = new Date(now.getTime() - spec.lookbackDays * 86_400_000);
    const cached = this.read(symbol, spec.interval, since);
    const fresh = cached.fetchedAt !== null && now.getTime() - Date.parse(cached.fetchedAt) < spec.ttlMs;

    if (fresh && cached.bars.length > 0) {
      return { symbol, range, interval: spec.interval, currency: cached.currency, bars: cached.bars, stale: false };
    }

    try {
      const fetched = await this.fetcher(symbol, { interval: spec.interval, period1: since });
      const usable = fetched.bars.filter(isUsableBar);
      this.write(symbol, spec.interval, fetched.currency, usable, now);
      const stored = this.read(symbol, spec.interval, since);
      return { symbol, range, interval: spec.interval, currency: fetched.currency, bars: stored.bars, stale: false };
    } catch (err) {
      // Spec §7: a data outage degrades the chart to last-known bars; it never 500s the page.
      if (cached.bars.length > 0) {
        return { symbol, range, interval: spec.interval, currency: cached.currency, bars: cached.bars, stale: true };
      }
      throw err;
    }
  }

  private read(
    symbol: string,
    interval: string,
    since: Date,
  ): { bars: OhlcBar[]; currency: string; fetchedAt: string | null } {
    const rows = this.db
      .prepare(
        `SELECT ts, open, high, low, close, volume, currency, fetched_at
           FROM ohlc_bars WHERE symbol = ? AND interval = ? AND ts >= ? ORDER BY ts`,
      )
      .all(symbol, interval, since.toISOString()) as {
      ts: string; open: number; high: number; low: number; close: number;
      volume: number | null; currency: string; fetched_at: string;
    }[];
    if (rows.length === 0) return { bars: [], currency: 'USD', fetchedAt: null };
    const fetchedAt = rows.reduce((max, r) => (r.fetched_at > max ? r.fetched_at : max), rows[0]!.fetched_at);
    return {
      bars: rows.map((r) => ({ ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })),
      currency: rows[0]!.currency,
      fetchedAt,
    };
  }

  private write(symbol: string, interval: string, currency: string, bars: OhlcBar[], now: Date): void {
    if (bars.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO ohlc_bars (symbol, interval, ts, open, high, low, close, volume, currency, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, interval, ts) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
         volume = excluded.volume, currency = excluded.currency, fetched_at = excluded.fetched_at`,
    );
    const iso = now.toISOString();
    this.db.transaction(() => {
      for (const b of bars) stmt.run(symbol, interval, b.ts, b.open, b.high, b.low, b.close, b.volume, currency, iso);
    })();
  }
}
