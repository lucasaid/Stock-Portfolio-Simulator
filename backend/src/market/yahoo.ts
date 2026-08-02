import YahooFinance from 'yahoo-finance2';
import type { QuoteFetcher } from './data.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export const yahooFetcher: QuoteFetcher = async (symbols) => {
  const out = new Map<string, { price: number; currency: string }>();
  const results = await yahooFinance.quote(symbols);
  for (const r of Array.isArray(results) ? results : [results]) {
    if (r.regularMarketPrice != null) {
      out.set(r.symbol, { price: r.regularMarketPrice, currency: r.currency ?? 'USD' });
    }
  }
  return out;
};
