import { z } from 'zod';
import type { DB } from '../db/connection.js';
import { marketForSymbol, type MarketDataService } from '../market/data.js';
import type { RoundService } from '../rounds/service.js';
import type { AgentToolDescriptor, AgentToolResult } from './types.js';

export interface ToolDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
}

export interface CheckinAction {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  detail: string;
}

function dollars(centsValue: number): string {
  return `$${(centsValue / 100).toFixed(2)}`;
}

/** The four spec §4.2 tools, bound to one round and one check-in. Handlers never throw. */
export function buildDecisionTools(
  deps: ToolDeps,
  roundId: number,
  checkinId: number,
): { tools: AgentToolDescriptor[]; actions: CheckinAction[] } {
  const { db, rounds, market } = deps;
  const actions: CheckinAction[] = [];

  function record(tool: string, args: Record<string, unknown>, ok: boolean, detail: string): AgentToolResult {
    actions.push({ tool, args, ok, detail });
    return ok ? { text: detail } : { text: detail, isError: true };
  }

  const placeOrder: AgentToolDescriptor = {
    name: 'place_order',
    description:
      "Place a market order. Buys take amountCents (AUD cents to spend, fees included). Sells take quantity (number of shares, or 'all'). Fills at the live quote; may be clipped or rejected by guardrails.",
    schema: {
      symbol: z.string().describe('Ticker, e.g. AAPL or BHP.AX'),
      side: z.enum(['buy', 'sell']),
      amountCents: z.number().int().positive().optional().describe('Buys only: AUD cents to spend'),
      quantity: z.union([z.number().positive(), z.literal('all')]).optional().describe("Sells only: shares or 'all'"),
    },
    handler: async (args) => {
      const symbol = String(args.symbol);
      const side = args.side as 'buy' | 'sell';
      try {
        const quotes = await market.poll([symbol]);
        const quote = quotes.get(symbol);
        if (!quote) return record('place_order', args, false, `no quote available for ${symbol}`);
        const audUsd = quote.currency === 'USD' ? await market.audUsdRate() : 1;
        const result =
          side === 'buy'
            ? rounds.buy(roundId, symbol, marketForSymbol(symbol), Number(args.amountCents), quote, audUsd, 'agent')
            : rounds.sell(roundId, symbol, (args.quantity === 'all' ? 'all' : Number(args.quantity)), quote, audUsd, 'agent');
        if (result.status === 'rejected') return record('place_order', args, false, `rejected: ${result.reason}`);
        const skimNote = result.skimCents > 0 ? ` — pocketed ${dollars(result.skimCents)} to the profit ledger` : '';
        return record('place_order', args, true, `filled ${side} ${symbol}${result.reason ? ` (${result.reason})` : ''}${skimNote}`);
      } catch (err) {
        return record('place_order', args, false, `error: ${(err as Error).message}`);
      }
    },
  };

  const setStopLoss: AgentToolDescriptor = {
    name: 'set_stop_loss',
    description: 'Set an explicit stop price on an open position (checked every poll, fires without you). Pass stopPrice null to clear.',
    schema: {
      symbol: z.string(),
      stopPrice: z.number().positive().nullable().describe('AUD price; null clears the explicit stop'),
    },
    handler: (args) => {
      const symbol = String(args.symbol);
      const position = rounds.openPosition(roundId, symbol);
      if (!position) return record('set_stop_loss', args, false, `no open position in ${symbol}`);
      const stopPrice = args.stopPrice === null ? null : Number(args.stopPrice);
      db.prepare('UPDATE positions SET stop_loss_price = ? WHERE id = ?').run(stopPrice, position.id);
      return record('set_stop_loss', args, true, stopPrice === null ? `cleared stop on ${symbol}` : `stop set at $${stopPrice} on ${symbol}`);
    },
  };

  const updateWatchlist: AgentToolDescriptor = {
    name: 'update_watchlist',
    description: 'Add or remove symbols from the round watchlist (they will be polled and appear in future snapshots).',
    schema: {
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    },
    handler: (args) => {
      const add = (args.add as string[] | undefined) ?? [];
      const remove = (args.remove as string[] | undefined) ?? [];
      const config = rounds.config(roundId);
      const before = JSON.stringify(config.watchlist);
      const next = [...config.watchlist.filter((s) => !remove.includes(s)), ...add.filter((s) => !config.watchlist.includes(s))];
      const now = new Date().toISOString();
      db.prepare('UPDATE rounds SET config_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...config, watchlist: next }), now, roundId);
      db.prepare('INSERT INTO config_events (round_id, changed_by, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(roundId, 'agent', 'watchlist', before, JSON.stringify(next), now);
      return record('update_watchlist', args, true, `watchlist is now: ${next.join(', ') || '(empty)'}`);
    },
  };

  const writeJournal: AgentToolDescriptor = {
    name: 'write_journal',
    description: 'Record your reasoning: what you did this check-in, why, and what you are watching next. Call exactly once, last.',
    schema: { note: z.string().min(1) },
    handler: (args) => {
      db.prepare('INSERT INTO journal_entries (round_id, checkin_id, author, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(roundId, checkinId, 'agent', String(args.note), new Date().toISOString());
      return record('write_journal', args, true, 'journal recorded');
    },
  };

  return { tools: [placeOrder, setStopLoss, updateWatchlist, writeJournal], actions };
}
