import YahooFinance from 'yahoo-finance2';
import type { QuoteFetcher } from './data.js';
import type { BarFetcher } from './history.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export const yahooFetcher: QuoteFetcher = async (symbols) => {
  const out = new Map<string, { price: number; currency: string; name?: string }>();
  const results = await yahooFinance.quote(symbols);
  for (const r of Array.isArray(results) ? results : [results]) {
    if (r.regularMarketPrice != null) {
      const name = r.longName ?? r.shortName ?? undefined;
      out.set(r.symbol, { price: r.regularMarketPrice, currency: r.currency ?? 'USD', ...(name ? { name } : {}) });
    }
  }
  return out;
};

export const yahooBarFetcher: BarFetcher = async (symbol, { interval, period1 }) => {
  const result = await yahooFinance.chart(symbol, {
    period1,
    interval: interval as '5m' | '30m' | '1d' | '1wk',
  });
  const bars = result.quotes
    .filter((q) => q.open !== null && q.high !== null && q.low !== null && q.close !== null)
    .map((q) => ({
      ts: q.date.toISOString(),
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume,
    }));
  return { currency: result.meta.currency, bars };
};
