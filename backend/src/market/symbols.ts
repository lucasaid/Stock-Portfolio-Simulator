import type { DB } from '../db/connection.js';
import type { Market } from '../engine/types.js';
import { marketForSymbol } from './data.js';

export interface SymbolRow {
  symbol: string;
  market: Market;
  name: string | null;
  archived: number;
  first_seen_at: string | null;
  last_polled_at: string | null;
}

/** Yahoo tickers: letters, digits, dot, dash, caret, equals. Anything else is not a symbol. */
const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,15}$/;

export function normalizeSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

/**
 * The set of symbols the app knows about. Watchlist and position symbols get
 * tracked automatically so they keep being polled after leaving a watchlist
 * (spec §6) until the operator archives them.
 */
export class SymbolRegistry {
  constructor(private db: DB) {}

  track(raw: string): string | null {
    const symbol = normalizeSymbol(raw);
    if (symbol === null) return null;
    // No DO UPDATE on archived: re-tracking must not resurrect an archived symbol.
    this.db
      .prepare(
        `INSERT INTO symbols (symbol, market, archived, first_seen_at)
         VALUES (?, ?, 0, ?) ON CONFLICT(symbol) DO NOTHING`,
      )
      .run(symbol, marketForSymbol(symbol), new Date().toISOString());
    return symbol;
  }

  trackMany(symbols: string[]): void {
    this.db.transaction(() => {
      for (const s of symbols) this.track(s);
    })();
  }

  setArchived(raw: string, archived: boolean): void {
    const symbol = normalizeSymbol(raw);
    if (symbol === null) return;
    this.db.prepare('UPDATE symbols SET archived = ? WHERE symbol = ?').run(archived ? 1 : 0, symbol);
  }

  markPolled(symbols: string[], now = new Date()): void {
    if (symbols.length === 0) return;
    const stmt = this.db.prepare('UPDATE symbols SET last_polled_at = ? WHERE symbol = ?');
    const iso = now.toISOString();
    this.db.transaction(() => {
      for (const s of symbols) stmt.run(iso, s);
    })();
  }

  list(): SymbolRow[] {
    return this.db.prepare('SELECT * FROM symbols ORDER BY symbol').all() as SymbolRow[];
  }

  activeSymbols(): string[] {
    return (this.db.prepare('SELECT symbol FROM symbols WHERE archived = 0 ORDER BY symbol').all() as {
      symbol: string;
    }[]).map((r) => r.symbol);
  }
}
