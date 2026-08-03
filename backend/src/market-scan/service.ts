import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { AgentRunner } from '../agent/types.js';
import { marketForSymbol, type MarketDataService } from '../market/data.js';
import type { CandidateFetcher } from '../market/candidates.js';
import type { RoundService } from '../rounds/service.js';
import { buildScanPrompt, parseScanResponse, SCAN_SYSTEM_PROMPT } from './prompt.js';

export interface MarketScanDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
}

export interface ScanOutcome {
  status: 'success' | 'error' | 'skipped';
  detail: string;
}

export interface ScanRow {
  id: number;
  created_at: string;
  status: string;
  watchlist_json: string | null;
  added_json: string;
  removed_json: string;
  detail: string;
  tokens_used: number;
  cost_usd: number;
}

/** Scanning is a shorter, more constrained task than research — fewer turns needed. */
const SCAN_MAX_TURNS = 8;
const CANDIDATES_PER_MARKET = 15;
const MAX_WATCHLIST = 15;
const TERMINAL = ['goal_reached', 'busted', 'archived'];

/**
 * TODO.md item 3 / spec's market-scan feature: a budgeted agent run, sibling to
 * ResearchService, that proposes a round's watchlist from a deterministic candidate
 * pool. Three independent defences stop a hallucinated or out-of-market ticker from
 * ever landing: the candidate-list allowlist, the configured-markets filter, and a
 * live-quote check. Never throws — a failed or unparsable run leaves the watchlist
 * untouched and is recorded as an 'error' row, exactly like ResearchService.
 */
export class MarketScanService {
  constructor(
    private deps: MarketScanDeps,
    private runner: AgentRunner,
    private candidates: CandidateFetcher,
  ) {}

  async runScan(roundId: number): Promise<ScanOutcome> {
    const { db, rounds, market } = this.deps;
    const round = rounds.get(roundId);
    if (TERMINAL.includes(round.status)) {
      return { status: 'skipped', detail: `round is ${round.status}` };
    }

    const config = rounds.config(roundId);
    const positions = rounds.openPositions(roundId);
    const heldSymbols = positions.map((p) => p.symbol);

    let pool: Awaited<ReturnType<CandidateFetcher>>;
    try {
      pool = (
        await Promise.all(config.markets.map((m) => this.candidates(m)))
      ).flatMap((list) => list.slice(0, CANDIDATES_PER_MARKET));
    } catch (err) {
      return this.record(roundId, [], null, [], [], 'error', `candidate fetch failed: ${(err as Error).message}`, 0, 0);
    }
    const poolSymbols = pool.map((c) => c.symbol);

    if (pool.length === 0) {
      return this.record(roundId, [], null, [], [], 'error', 'no candidates available for the configured markets', 0, 0);
    }

    const prompt = buildScanPrompt({
      roundName: config.name,
      markets: config.markets,
      tradingStyle: config.tradingStyle,
      mode: config.autoWatchlist === true ? 'manage' : 'bootstrap',
      held: heldSymbols,
      currentWatchlist: config.watchlist,
      candidates: pool,
    });

    let text: string;
    let tokens = 0;
    let costUsd = 0;
    try {
      const result = await this.runner.run({
        model: config.model,
        systemPrompt: SCAN_SYSTEM_PROMPT,
        prompt,
        tools: [], // no trading tools — a scan can only propose, never act
        webTools: true,
        maxTurns: SCAN_MAX_TURNS,
      });
      tokens = result.inputTokens + result.outputTokens;
      costUsd = result.costUsd;
      if (result.status !== 'success') {
        return this.record(roundId, poolSymbols, null, [], [], 'error', `scan run failed (${result.subtype})`, tokens, costUsd);
      }
      text = result.text;
    } catch (err) {
      return this.record(roundId, poolSymbols, null, [], [], 'error', (err as Error).message, 0, 0);
    }

    const parsed = parseScanResponse(text);
    if (!parsed) {
      return this.record(roundId, poolSymbols, null, [], [], 'error', 'could not parse a watchlist from the scan response', tokens, costUsd);
    }

    // Defence 1: only symbols actually offered as candidates, or already held — never an invented ticker.
    const candidateSet = new Set(poolSymbols);
    const onList = parsed.watchlist.filter((s) => candidateSet.has(s) || heldSymbols.includes(s));
    // Defence 2: must belong to a market this round actually trades.
    const inMarket = onList.filter((s) => config.markets.includes(marketForSymbol(s)));
    // Held positions always stay trackable, regardless of what the scan chose.
    const withHeld = [...new Set([...heldSymbols, ...inMarket])].slice(0, MAX_WATCHLIST);

    // Defence 3: a live quote must exist — a hallucinated, delisted, or misfiltered ticker never lands.
    let finalList: string[];
    try {
      const quotes = await market.poll(withHeld);
      finalList = withHeld.filter((s) => quotes.has(s));
    } catch (err) {
      return this.record(roundId, poolSymbols, null, [], [], 'error', `quote validation failed: ${(err as Error).message}`, tokens, costUsd);
    }

    if (finalList.length === 0) {
      return this.record(roundId, poolSymbols, null, [], [], 'error', 'no proposed symbol survived validation', tokens, costUsd);
    }

    const before = new Set(config.watchlist);
    const after = new Set(finalList);
    const added = finalList.filter((s) => !before.has(s));
    const removed = config.watchlist.filter((s) => !after.has(s));

    db.prepare('UPDATE rounds SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...config, watchlist: finalList }), new Date().toISOString(), roundId);

    return this.record(
      roundId, poolSymbols, finalList, added, removed, 'success',
      `watchlist now: ${finalList.join(', ')}`, tokens, costUsd,
    );
  }

  list(roundId: number, limit = 20): ScanRow[] {
    return this.deps.db
      .prepare(
        `SELECT id, created_at, status, watchlist_json, added_json, removed_json, detail, tokens_used, cost_usd
           FROM market_scans WHERE round_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(roundId, limit) as ScanRow[];
  }

  private record(
    roundId: number, candidateSymbols: string[],
    watchlist: string[] | null, added: string[], removed: string[],
    status: 'success' | 'error', detail: string, tokens: number, costUsd: number,
  ): ScanOutcome {
    this.deps.db
      .prepare(
        `INSERT INTO market_scans (round_id, created_at, status, candidates_json, watchlist_json, added_json, removed_json, detail, tokens_used, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        roundId, new Date().toISOString(), status, JSON.stringify(candidateSymbols),
        watchlist ? JSON.stringify(watchlist) : null, JSON.stringify(added), JSON.stringify(removed),
        detail, tokens, costUsd,
      );

    if (status === 'error') {
      logEvent(this.deps.db, 'warn', 'market_scan_failed', `round ${roundId} market scan failed: ${detail}`, roundId);
    } else {
      logEvent(this.deps.db, 'info', 'market_scan', `round ${roundId} market scan: ${detail}`, roundId);
    }
    return { status, detail };
  }
}
