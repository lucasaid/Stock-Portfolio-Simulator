import cron from 'node-cron';
import type { DB } from './db/connection.js';
import { logEvent } from './db/events.js';
import { drawdownBreached, stopLossTriggered } from './engine/guardrails.js';
import type { Market, RoundConfig } from './engine/types.js';
import { isMarketOpen } from './market/hours.js';
import { marketForSymbol, type MarketDataService } from './market/data.js';
import type { RoundRow, RoundService } from './rounds/service.js';

export interface SchedulerDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
}

const SWEEPABLE = ['active', 'paused', 'takeover'];

/** One protective sweep: poll open-market prices, fire stop-losses, check drawdown, snapshot equity. */
export async function pollOnce(deps: SchedulerDeps, now = new Date()): Promise<void> {
  const { db, rounds, market } = deps;
  const openMarkets = (['ASX', 'US'] as Market[]).filter((m) => isMarketOpen(m, now));
  if (openMarkets.length === 0) return;

  const roundRows = db
    .prepare(`SELECT * FROM rounds WHERE status IN ('active', 'paused', 'takeover')`)
    .all() as RoundRow[];
  if (roundRows.length === 0) return;

  // Union of watchlists and open-position symbols, restricted to open markets.
  const symbols = new Set<string>();
  for (const round of roundRows) {
    const cfg = JSON.parse(round.config_json) as RoundConfig;
    for (const s of cfg.watchlist) symbols.add(s);
    for (const p of rounds.openPositions(round.id)) symbols.add(p.symbol);
  }
  const pollable = [...symbols].filter((s) => openMarkets.includes(marketForSymbol(s)));
  const quotes = await market.poll(pollable);

  const needsUs = [...quotes.values()].some((q) => q.currency === 'USD');
  const audUsd = needsUs ? await market.audUsdRate() : 1;

  const priceAudBySymbol = new Map<string, number>();
  for (const [symbol, q] of quotes) {
    priceAudBySymbol.set(symbol, q.currency === 'USD' ? q.price / audUsd : q.price);
  }

  for (const round of roundRows) {
    if (!SWEEPABLE.includes(round.status)) continue;
    const cfg = JSON.parse(round.config_json) as RoundConfig;

    for (const pos of rounds.openPositions(round.id)) {
      const q = quotes.get(pos.symbol);
      // Spec §7: stop-losses are protective and evaluate on last-known price even if
      // stale — only a missing quote is skipped. New orders are suppressed for staleness
      // at the RoundService level instead (buy()/sell() reject stale quotes for non-stop-loss actors).
      if (!q) continue;
      const priceAud = priceAudBySymbol.get(pos.symbol)!;
      const avgCostPrice = pos.cost_basis_cents / 100 / pos.quantity;
      if (
        stopLossTriggered({
          avgCostPrice,
          currentPrice: priceAud,
          stopLossPct: cfg.guardrails.stopLossPct,
          stopPrice: pos.stop_loss_price,
        })
      ) {
        logEvent(db, 'warn', 'stop_loss', `round ${round.id} stop-loss on ${pos.symbol} at ${priceAud.toFixed(4)}`, round.id);
        rounds.sell(round.id, pos.symbol, 'all', q, audUsd, 'stop_loss');
      }
    }

    rounds.recordEquity(round.id, priceAudBySymbol);

    const fresh = rounds.get(round.id); // status/cash may have changed above
    // Drawdown pause intentionally applies to 'active' only — during takeover the
    // operator is in control (product decision, final review 2026-08-02).
    if (fresh.status === 'active') {
      const equity = rounds.equityCents(round.id, priceAudBySymbol);
      if (drawdownBreached(equity, fresh.starting_balance_cents, cfg.guardrails.drawdownPausePct)) {
        rounds.setStatus(round.id, 'paused', 'drawdown pause breached');
      }
    }
  }
}

/** Wire pollOnce to a cron cadence. Returns a stop function. */
export function start(deps: SchedulerDeps, cadence = '*/5 * * * *'): () => void {
  const task = cron.schedule(cadence, () => {
    pollOnce(deps).catch((err: unknown) => {
      logEvent(deps.db, 'error', 'poll_failed', (err as Error).message);
    });
  });
  return () => {
    void task.stop();
  };
}
