import type { Quote } from '../broker/types.js';
import type { DB } from '../db/connection.js';
import type { Market } from '../engine/types.js';
import { MARKET_ADAPTERS } from './adapters.js';

export type QuoteFetcher = (
  symbols: string[],
) => Promise<Map<string, { price: number; currency: string; name?: string }>>;

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

export function marketForSymbol(symbol: string): Market {
  // US is the registry's catch-all adapter, so `.find` always matches something.
  return MARKET_ADAPTERS.find((a) => a.matchesSymbol(symbol))!.id;
}

export class MarketDataService {
  private cache = new Map<string, Quote>();

  constructor(
    private db: DB,
    private fetcher: QuoteFetcher,
    private staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
    // Additive, optional: per-market fetcher override, keyed by market id. Any market absent
    // from this map falls back to `fetcher` — so every pre-existing caller (which never passes
    // this) keeps its exact current behavior of one fetcher used for every market. Only used
    // today by market-data.test.ts to prove poll() dedups by fetcher *reference* through the
    // per-market lookup, not merely because there's a single fetcher parameter.
    private fetcherOverrides: Partial<Record<Market, QuoteFetcher>> = {},
  ) {}

  private fetcherFor(market: Market): QuoteFetcher {
    return this.fetcherOverrides[market] ?? this.fetcher;
  }

  /** Fetch fresh quotes, persist a price bar per symbol, refresh the cache. */
  async poll(symbols: string[]): Promise<Map<string, Quote>> {
    if (symbols.length === 0) return new Map();
    const ts = new Date().toISOString();

    // Group symbols by fetcher *reference* (not by market) so that today's real all-Yahoo
    // config — every adapter/override resolving to the same fetcher — still issues exactly one
    // network call per poll, while a future market with a distinct fetcher gets its own call.
    const byFetcher = new Map<QuoteFetcher, string[]>();
    for (const symbol of symbols) {
      const fetcher = this.fetcherFor(marketForSymbol(symbol));
      const bucket = byFetcher.get(fetcher);
      if (bucket) bucket.push(symbol);
      else byFetcher.set(fetcher, [symbol]);
    }
    const partials = await Promise.all([...byFetcher].map(([fetcher, syms]) => fetcher(syms)));
    const results = new Map<string, { price: number; currency: string; name?: string }>();
    for (const partial of partials) for (const [symbol, quote] of partial) results.set(symbol, quote);

    const insert = this.db.prepare('INSERT INTO price_bars (symbol, ts, price, currency, stale) VALUES (?, ?, ?, ?, 0)');
    // Never overwrites a name that is already set, and never inserts a new symbols row
    // (that stays SymbolRegistry.track's job) — this only backfills a tracked symbol
    // that has no display name yet.
    const backfillName = this.db.prepare('UPDATE symbols SET name = ? WHERE symbol = ? AND name IS NULL');
    for (const [symbol, { price, currency, name }] of results) {
      this.cache.set(symbol, {
        symbol,
        market: marketForSymbol(symbol),
        price,
        currency: currency as 'AUD' | 'USD',
        ts,
        stale: false,
      });
      insert.run(symbol, ts, price, currency);
      if (name) backfillName.run(name, symbol);
    }
    return this.latest(symbols);
  }

  /** Last known quotes with staleness recomputed against the clock. */
  latest(symbols: string[]): Map<string, Quote> {
    const out = new Map<string, Quote>();
    const now = Date.now();
    for (const symbol of symbols) {
      const cached = this.cache.get(symbol);
      if (cached) out.set(symbol, { ...cached, stale: now - Date.parse(cached.ts) > this.staleAfterMs });
    }
    return out;
  }

  async audUsdRate(): Promise<number> {
    const result = await this.fetcher(['AUDUSD=X']);
    const rate = result.get('AUDUSD=X')?.price;
    if (!rate) throw new Error('AUDUSD rate unavailable');
    return rate;
  }
}
