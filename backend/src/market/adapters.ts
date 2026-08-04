import type { Market } from '../engine/types.js';
import type { CandidateFetcher } from './candidates.js';
import { yahooCandidateFetcher } from './candidates.js';
import type { QuoteFetcher } from './data.js';
import { yahooFetcher } from './yahoo.js';

export interface MarketAdapter {
  id: Market;
  label: string;
  /** Registry tries adapters in array order; first match wins. */
  matchesSymbol(symbol: string): boolean;
  isOpen(now: Date): boolean;
  quoteFetcher: QuoteFetcher;
  candidateFetcher: CandidateFetcher;
}

/** Weekday/session check in the given IANA timezone. Session bounds are [open, close)
 * in minutes-since-midnight local time. Public holidays are intentionally ignored (spec §11:
 * acceptable paper-mode simplification). */
function isWithinSession(zone: string, session: [number, number], now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const [open, close] = session;
  return minutes >= open && minutes < close;
}

const asxAdapter: MarketAdapter = {
  id: 'ASX',
  label: 'ASX',
  matchesSymbol: (s) => s.endsWith('.AX'),
  isOpen: (now) => isWithinSession('Australia/Sydney', [600, 960], now),
  quoteFetcher: yahooFetcher,
  candidateFetcher: yahooCandidateFetcher,
};

const cryptoAdapter: MarketAdapter = {
  id: 'CRYPTO',
  label: 'Crypto',
  matchesSymbol: (s) => s.endsWith('-USD'),
  isOpen: () => true, // trades 24/7, no weekend/holiday closure
  quoteFetcher: yahooFetcher,
  candidateFetcher: yahooCandidateFetcher,
};

const usAdapter: MarketAdapter = {
  id: 'US',
  label: 'US',
  matchesSymbol: () => true, // catch-all — MUST stay last in MARKET_ADAPTERS
  isOpen: (now) => isWithinSession('America/New_York', [570, 960], now),
  quoteFetcher: yahooFetcher,
  candidateFetcher: yahooCandidateFetcher,
};

// Order matters: specific suffixes are tried before the US catch-all.
export const MARKET_ADAPTERS: MarketAdapter[] = [asxAdapter, cryptoAdapter, usAdapter];
export const ALL_MARKETS: Market[] = MARKET_ADAPTERS.map((a) => a.id);

export function adapterFor(market: Market): MarketAdapter {
  const adapter = MARKET_ADAPTERS.find((a) => a.id === market);
  if (!adapter) throw new Error(`no adapter registered for market ${market}`); // internal invariant
  return adapter;
}
