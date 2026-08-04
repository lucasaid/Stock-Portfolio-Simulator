import YahooFinance from 'yahoo-finance2';
// Deliberately-exported internal helpers (see yahoo-finance2's package.json "exports" map,
// entries "./lib/getCrumb" and "./lib/cookieJar") — not a deep/undocumented import. Needed
// because yahoo-finance2's public `screener()` method only ever calls Yahoo's PREDEFINED
// screener endpoint (`.../v1/finance/screener/predefined/saved`), which is confirmed US-only
// (see the comment on `customScreener` below). Yahoo's CUSTOM screener endpoint
// (`.../v1/finance/screener`, POST with a JSON criteria body) does support real region
// filtering, but the library has no public method that reaches it — `_fetch` only ever issues
// GETs with query-string params, never a POST body. `getCrumb`/`ExtendedCookieJar` are the
// same crumb/cookie machinery `screener()`/`quote()` already use internally, reused here
// instead of duplicated.
import getCrumb from 'yahoo-finance2/lib/getCrumb';
import type { Market } from '../engine/types.js';

export interface ScanCandidate {
  symbol: string;
  name?: string;
  changePct?: number;
}

/** Cheap, deterministic grounding for the scan prompt — never a blank-page "what's good?" ask. */
export type CandidateFetcher = (market: Market) => Promise<ScanCandidate[]>;

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const SCREENER_URL = 'https://query1.finance.yahoo.com/v1/finance/screener';

interface ScreenerCriterion {
  operator: string;
  operands: (string | number)[];
}

/**
 * Yahoo's PREDEFINED screener (`most_actives`/`day_gainers` via `.../predefined/saved`, what
 * `yahoo-finance2`'s public `screener()` method calls) is confirmed US-only: its `region` param
 * does not change the result set at all — `region: 'AU'` (even combined with `lang: 'en-AU'`)
 * returns the exact same US symbols as `region: 'US'`, verified live.
 *
 * Yahoo's CUSTOM screener endpoint — the same one the finance.yahoo.com screener UI itself
 * submits to when you build a filter and save it — DOES support real region filtering via a
 * `{ operator: 'eq', operands: ['region', 'au'] }` criterion, verified live: it returns real
 * `.AX`-suffixed ASX-listed symbols (`exchange: 'ASX'`, `market: 'au_market'`), thousands of
 * them. It requires a crumb + POST body, which the library's fetch layer doesn't support for
 * any public method, hence this hand-rolled call reusing the library's own crumb/cookie
 * machinery. Undocumented/private Yahoo API — no stability guarantee, so every caller of this
 * function must handle it throwing (existing convention: `MarketScanService`/the
 * `/api/market/candidates` route both already wrap candidate-fetch calls in try/catch).
 */
async function customScreener(sortField: string, criteria: ScreenerCriterion[], count: number): Promise<unknown[]> {
  const cookieJar = yahooFinance._opts.cookieJar;
  const logger = yahooFinance._opts.logger;
  if (!cookieJar || !logger) throw new Error('yahoo-finance2 instance is missing cookieJar/logger');
  const crumb = await getCrumb(cookieJar, fetch, {}, logger, yahooFinance._notices);
  const cookie = await cookieJar.getCookieString(SCREENER_URL, { allPaths: true });
  const body = {
    size: count,
    offset: 0,
    sortField,
    sortType: 'DESC',
    quoteType: 'EQUITY',
    query: { operator: 'and', operands: criteria },
  };
  const url = `${SCREENER_URL}?crumb=${encodeURIComponent(crumb ?? '')}&lang=en-AU&region=AU`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Yahoo custom screener request failed: ${res.status}`);
  const json = (await res.json()) as { finance?: { result?: { quotes?: unknown[] }[] } };
  return json.finance?.result?.[0]?.quotes ?? [];
}

const REGION_AU: ScreenerCriterion = { operator: 'eq', operands: ['region', 'au'] };
/** $200M+ market cap — filters out illiquid micro-caps, same intent as Yahoo's own predefined screens. */
const MIN_CAP_AU: ScreenerCriterion = { operator: 'gt', operands: ['intradaymarketcap', 200_000_000] };
const MIN_VOLUME_AU: ScreenerCriterion = { operator: 'gt', operands: ['dayvolume', 100_000] };

/**
 * Fallback ASX pool used only if the undocumented custom-screener call above throws (crumb
 * fetch failure, rate limit, Yahoo changing the private endpoint's shape). Live per-symbol
 * quotes on `.AX` tickers are a separate, stable, documented API and were verified live to
 * return real ASX data — so this still returns real, correctly-suffixed candidates, just from
 * a fixed universe rather than a live top-movers ranking.
 */
const ASX_FALLBACK_UNIVERSE = [
  'BHP.AX', 'CBA.AX', 'CSL.AX', 'NAB.AX', 'WBC.AX', 'ANZ.AX', 'WES.AX', 'WOW.AX', 'TLS.AX', 'RIO.AX',
  'FMG.AX', 'MQG.AX', 'GMG.AX', 'TCL.AX', 'STO.AX', 'WDS.AX', 'QBE.AX', 'WTC.AX', 'REA.AX', 'COL.AX',
  'ALL.AX', 'SUN.AX', 'IAG.AX', 'ASX.AX', 'JHX.AX', 'AMC.AX', 'SHL.AX', 'RMD.AX', 'COH.AX', 'AGL.AX',
  'S32.AX', 'ORG.AX', 'APA.AX', 'SCG.AX', 'GPT.AX', 'MGR.AX', 'VCX.AX', 'XRO.AX', 'CPU.AX', 'TWE.AX',
];

/** Quote/screener response items are typed as broad unions upstream; read fields defensively. */
function toCandidate(q: unknown): ScanCandidate | null {
  const r = q as Record<string, unknown>;
  const symbol = typeof r.symbol === 'string' ? r.symbol : null;
  if (!symbol) return null;
  const name = (typeof r.longName === 'string' && r.longName) || (typeof r.shortName === 'string' && r.shortName) || undefined;
  const changePct = typeof r.regularMarketChangePercent === 'number' ? r.regularMarketChangePercent : undefined;
  return { symbol, name, changePct };
}

function numberField(q: unknown, field: string): number {
  const value = (q as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : 0;
}

function dedupe(groups: unknown[][]): ScanCandidate[] {
  const seen = new Map<string, ScanCandidate>();
  for (const group of groups) {
    for (const q of group) {
      const c = toCandidate(q);
      if (c && !seen.has(c.symbol)) seen.set(c.symbol, c);
    }
  }
  return [...seen.values()];
}

async function asxFallbackCandidates(): Promise<ScanCandidate[]> {
  const results = await yahooFinance.quote(ASX_FALLBACK_UNIVERSE);
  const quotes: unknown[] = Array.isArray(results) ? results : [results];
  const byVolume = [...quotes].sort((a, b) => numberField(b, 'regularMarketVolume') - numberField(a, 'regularMarketVolume')).slice(0, 15);
  const byGain = [...quotes].sort((a, b) => numberField(b, 'regularMarketChangePercent') - numberField(a, 'regularMarketChangePercent')).slice(0, 15);
  return dedupe([byVolume, byGain]);
}

async function asxCandidates(): Promise<ScanCandidate[]> {
  try {
    const [actives, gainers] = await Promise.all([
      customScreener('dayvolume', [REGION_AU, MIN_CAP_AU], 15),
      customScreener('percentchange', [REGION_AU, MIN_CAP_AU, MIN_VOLUME_AU], 15),
    ]);
    const candidates = dedupe([actives, gainers]);
    if (candidates.length > 0) return candidates;
  } catch {
    // Undocumented endpoint — fall through to the fallback below rather than propagate.
  }
  return asxFallbackCandidates();
}

async function usCandidates(): Promise<ScanCandidate[]> {
  const [actives, gainers] = await Promise.all([
    yahooFinance.screener({ scrIds: 'most_actives', region: 'US', count: 15 }),
    yahooFinance.screener({ scrIds: 'day_gainers', region: 'US', count: 15 }),
  ]);
  return dedupe([actives.quotes, gainers.quotes]);
}

export const yahooCandidateFetcher: CandidateFetcher = async (market) =>
  market === 'ASX' ? asxCandidates() : usCandidates();
