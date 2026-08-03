import YahooFinance from 'yahoo-finance2';
import type { Market } from '../engine/types.js';

export interface ScanCandidate {
  symbol: string;
  name?: string;
  changePct?: number;
}

/** Cheap, deterministic grounding for the scan prompt — never a blank-page "what's good?" ask. */
export type CandidateFetcher = (market: Market) => Promise<ScanCandidate[]>;

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export const yahooCandidateFetcher: CandidateFetcher = async (market) => {
  const region = market === 'ASX' ? 'AU' : 'US';
  const [actives, gainers] = await Promise.all([
    yahooFinance.screener({ scrIds: 'most_actives', region, count: 15 }),
    yahooFinance.screener({ scrIds: 'day_gainers', region, count: 15 }),
  ]);
  const seen = new Map<string, ScanCandidate>();
  for (const q of [...actives.quotes, ...gainers.quotes]) {
    if (q.symbol && !seen.has(q.symbol)) {
      seen.set(q.symbol, {
        symbol: q.symbol,
        name: q.longName ?? q.shortName,
        changePct: q.regularMarketChangePercent,
      });
    }
  }
  return [...seen.values()];
};
