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

/**
 * Yahoo's predefined screener (`most_actives`/`day_gainers` via `predefined/saved`) is
 * effectively US-only: its `region` param does not change the result set — `region: 'AU'`
 * returns the exact same US symbols as `region: 'US'` (confirmed live, not a guess; see
 * CLAUDE.md's market-scan section). There is no working screener-based discovery path for ASX
 * through this library. Live quotes on individual `.AX` symbols DO work correctly and return
 * real ASX data (verified live), so ASX candidates come from a fixed, curated universe of
 * major, liquid ASX-listed companies polled for live quotes instead — the same "cheap,
 * deterministic grounding" idea as the US screener, just with the discovery step swapped for a
 * static seed list since Yahoo has no working dynamic one for this market.
 */
const ASX_CANDIDATE_UNIVERSE = [
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

async function asxCandidates(): Promise<ScanCandidate[]> {
  const results = await yahooFinance.quote(ASX_CANDIDATE_UNIVERSE);
  const quotes: unknown[] = Array.isArray(results) ? results : [results];
  // Mirrors the shape of the US path (a "most active" pool + a "day gainers" pool, deduped)
  // rather than just returning the whole fixed universe verbatim every time.
  const byVolume = [...quotes].sort((a, b) => numberField(b, 'regularMarketVolume') - numberField(a, 'regularMarketVolume')).slice(0, 15);
  const byGain = [...quotes].sort((a, b) => numberField(b, 'regularMarketChangePercent') - numberField(a, 'regularMarketChangePercent')).slice(0, 15);
  const seen = new Map<string, ScanCandidate>();
  for (const q of [...byVolume, ...byGain]) {
    const c = toCandidate(q);
    if (c && !seen.has(c.symbol)) seen.set(c.symbol, c);
  }
  return [...seen.values()];
}

async function usCandidates(): Promise<ScanCandidate[]> {
  const [actives, gainers] = await Promise.all([
    yahooFinance.screener({ scrIds: 'most_actives', region: 'US', count: 15 }),
    yahooFinance.screener({ scrIds: 'day_gainers', region: 'US', count: 15 }),
  ]);
  const seen = new Map<string, ScanCandidate>();
  for (const q of [...actives.quotes, ...gainers.quotes]) {
    const c = toCandidate(q);
    if (c && !seen.has(c.symbol)) seen.set(c.symbol, c);
  }
  return [...seen.values()];
}

export const yahooCandidateFetcher: CandidateFetcher = async (market) =>
  market === 'ASX' ? asxCandidates() : usCandidates();
