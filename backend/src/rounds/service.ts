import { randomUUID } from 'node:crypto';
import type { Broker, Quote } from '../broker/types.js';
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import { clipBuy } from '../engine/guardrails.js';
import { computeSkimCents } from '../engine/skim.js';
import type { Market, RoundConfig } from '../engine/types.js';

export type RoundStatus = 'active' | 'paused' | 'takeover' | 'goal_reached' | 'busted' | 'archived';
export type Actor = 'agent' | 'operator' | 'stop_loss';

export interface RoundRow {
  id: number;
  name: string;
  status: RoundStatus;
  starting_balance_cents: number;
  cash_cents: number;
  profit_goal_cents: number;
  config_json: string;
}

export interface PositionRow {
  id: number;
  round_id: number;
  symbol: string;
  market: Market;
  quantity: number;
  cost_basis_cents: number;
  stop_loss_price: number | null;
}

export interface TradeResult {
  status: 'filled' | 'rejected';
  reason: string | null;
  skimCents: number;
}

/** Cash floor below which a positionless round is busted (can't buy anything with < $1). */
const BUST_CENTS = 100;

const TERMINAL: RoundStatus[] = ['goal_reached', 'busted', 'archived'];

function canTrade(status: RoundStatus, actor: Actor, side: 'buy' | 'sell'): boolean {
  if (TERMINAL.includes(status)) return false;
  if (actor === 'operator') return true;
  if (actor === 'stop_loss') return side === 'sell';
  return status === 'active';
}

export class RoundService {
  constructor(private db: DB, private broker: Broker) {}

  create(config: RoundConfig): number {
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO rounds (name, status, starting_balance_cents, cash_cents, profit_goal_cents, config_json, created_at, updated_at)
         VALUES (?, 'active', ?, ?, ?, ?, ?, ?)`,
      )
      .run(config.name, config.startingBalanceCents, config.startingBalanceCents, config.profitGoalCents, JSON.stringify(config), now, now);
    const id = Number(r.lastInsertRowid);
    this.ledger(id, 'deposit', config.startingBalanceCents, config.startingBalanceCents, null, 'starting balance');
    logEvent(this.db, 'info', 'round_created', `round ${id} created`, id);
    return id;
  }

  get(id: number): RoundRow {
    const row = this.db.prepare('SELECT * FROM rounds WHERE id = ?').get(id) as RoundRow | undefined;
    if (!row) throw new Error(`round ${id} not found`);
    return row;
  }

  config(id: number): RoundConfig {
    return JSON.parse(this.get(id).config_json) as RoundConfig;
  }

  setStatus(id: number, status: RoundStatus, note: string): void {
    this.db.prepare('UPDATE rounds SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    logEvent(this.db, 'info', 'round_status', `round ${id} → ${status}: ${note}`, id);
  }

  openPositions(roundId: number): PositionRow[] {
    return this.db.prepare('SELECT * FROM positions WHERE round_id = ? AND closed_at IS NULL').all(roundId) as PositionRow[];
  }

  openPosition(roundId: number, symbol: string): PositionRow | undefined {
    return this.db
      .prepare('SELECT * FROM positions WHERE round_id = ? AND symbol = ? AND closed_at IS NULL')
      .get(roundId, symbol) as PositionRow | undefined;
  }

  totalSkimsCents(roundId: number): number {
    const { total } = this.db
      .prepare("SELECT COALESCE(SUM(-amount_cents), 0) AS total FROM ledger_entries WHERE round_id = ? AND type = 'skim'")
      .get(roundId) as { total: number };
    return total;
  }

  buy(roundId: number, symbol: string, market: Market, requestedCents: number, quote: Quote, audUsdRate: number, actor: Actor): TradeResult {
    const round = this.get(roundId);
    if (!canTrade(round.status, actor, 'buy')) {
      return this.reject(roundId, symbol, 'buy', actor, `round is ${round.status}`);
    }
    const cfg = this.config(roundId);
    const held = this.openPosition(roundId, symbol);
    const clip = clipBuy({
      requestedCents,
      cashCents: round.cash_cents,
      heldCostCents: held?.cost_basis_cents ?? 0,
      startingBalanceCents: round.starting_balance_cents,
      maxPositionPct: cfg.guardrails.maxPositionPct,
    });
    if (clip.rejected) return this.reject(roundId, symbol, 'buy', actor, clip.reason ?? 'rejected by guardrails');

    try {
      return this.db.transaction((): TradeResult => {
        const fill = this.broker.execute(
          { roundId, clientOrderId: randomUUID(), symbol, market, side: 'buy', amountCents: clip.allowedCents, placedBy: actor },
          quote, audUsdRate, cfg.fees,
        );

        const now = new Date().toISOString();
        if (held) {
          this.db
            .prepare('UPDATE positions SET quantity = quantity + ?, cost_basis_cents = cost_basis_cents + ? WHERE id = ?')
            .run(fill.quantity, fill.grossCents, held.id);
        } else {
          this.db
            .prepare('INSERT INTO positions (round_id, symbol, market, quantity, cost_basis_cents, opened_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(roundId, symbol, market, fill.quantity, fill.grossCents, now);
        }

        let cash = round.cash_cents - fill.grossCents;
        this.ledger(roundId, 'buy', -fill.grossCents, cash, fill.orderId, `buy ${symbol}${clip.reason ? ` (${clip.reason})` : ''}`);
        if (fill.feeCents > 0) {
          cash -= fill.feeCents;
          this.ledger(roundId, 'fee', -fill.feeCents, cash, fill.orderId, `fee for buy ${symbol}`);
        }
        this.setCash(roundId, cash);
        return { status: 'filled', reason: clip.reason, skimCents: 0 };
      })();
    } catch (err) {
      return this.reject(roundId, symbol, 'buy', actor, (err as Error).message);
    }
  }

  sell(roundId: number, symbol: string, quantity: number | 'all', quote: Quote, audUsdRate: number, actor: Actor): TradeResult {
    const round = this.get(roundId);
    if (!canTrade(round.status, actor, 'sell')) {
      return this.reject(roundId, symbol, 'sell', actor, `round is ${round.status}`);
    }
    const position = this.openPosition(roundId, symbol);
    if (!position) return this.reject(roundId, symbol, 'sell', actor, 'no open position');

    const qty = quantity === 'all' ? position.quantity : Math.min(quantity, position.quantity);
    const cfg = this.config(roundId);

    try {
      return this.db.transaction((): TradeResult => {
        const fill = this.broker.execute(
          { roundId, clientOrderId: randomUUID(), symbol, market: position.market, side: 'sell', quantity: qty, placedBy: actor },
          quote, audUsdRate, cfg.fees,
        );

        const now = new Date().toISOString();
        // APPROVED DEVIATION: PaperBroker may floor ASX sell quantities below the requested
        // qty, so use the actual fill quantity (not qty) to keep positions consistent with fills.
        const fullSell = fill.quantity >= position.quantity - 1e-9;
        const costRemoved = fullSell ? position.cost_basis_cents : Math.round(position.cost_basis_cents * (fill.quantity / position.quantity));
        this.db
          .prepare('UPDATE positions SET quantity = quantity - ?, cost_basis_cents = cost_basis_cents - ?, closed_at = ? WHERE id = ?')
          .run(fill.quantity, costRemoved, fullSell ? now : null, position.id);

        let cash = round.cash_cents + fill.grossCents;
        this.ledger(roundId, 'sell', fill.grossCents, cash, fill.orderId, `sell ${symbol} (${actor})`);
        if (fill.feeCents > 0) {
          cash -= fill.feeCents;
          this.ledger(roundId, 'fee', -fill.feeCents, cash, fill.orderId, `fee for sell ${symbol}`);
        }

        const skim = computeSkimCents(cash, round.starting_balance_cents);
        if (skim > 0) {
          cash -= skim;
          this.ledger(roundId, 'skim', -skim, cash, fill.orderId, 'profit pocketed');
          logEvent(this.db, 'info', 'skim', `round ${roundId} pocketed ${skim} cents`, roundId);
        }
        this.setCash(roundId, cash);

        if (skim > 0 && this.totalSkimsCents(roundId) >= round.profit_goal_cents) {
          this.setStatus(roundId, 'goal_reached', 'profit goal reached');
        } else if (cash < BUST_CENTS && this.openPositions(roundId).length === 0) {
          this.setStatus(roundId, 'busted', 'cash and holdings exhausted');
        }
        return { status: 'filled', reason: null, skimCents: skim };
      })();
    } catch (err) {
      return this.reject(roundId, symbol, 'sell', actor, (err as Error).message);
    }
  }

  equityCents(roundId: number, priceAudBySymbol: Map<string, number>): number {
    const round = this.get(roundId);
    let holdings = 0;
    const fallbackSymbols: string[] = [];
    for (const pos of this.openPositions(roundId)) {
      const price = priceAudBySymbol.get(pos.symbol);
      // Fall back to cost basis when no live price is available (never value a holding at zero).
      if (price !== undefined) {
        holdings += Math.round(pos.quantity * price * 100);
      } else {
        holdings += pos.cost_basis_cents;
        fallbackSymbols.push(pos.symbol);
      }
    }
    if (fallbackSymbols.length > 0) {
      logEvent(
        this.db,
        'warn',
        'equity_fallback',
        `round ${roundId} valued at cost basis (no live price) for: ${fallbackSymbols.join(', ')}`,
        roundId,
      );
    }
    return round.cash_cents + holdings;
  }

  recordEquity(roundId: number, priceAudBySymbol: Map<string, number>): void {
    const round = this.get(roundId);
    const equity = this.equityCents(roundId, priceAudBySymbol);
    this.db
      .prepare('INSERT INTO equity_snapshots (round_id, ts, cash_cents, holdings_cents, equity_cents) VALUES (?, ?, ?, ?, ?)')
      .run(roundId, new Date().toISOString(), round.cash_cents, equity - round.cash_cents, equity);
  }

  private reject(roundId: number, symbol: string, side: 'buy' | 'sell', actor: Actor, reason: string): TradeResult {
    this.db
      .prepare(
        `INSERT INTO orders (round_id, client_order_id, symbol, side, status, placed_by, reason, created_at)
         VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?)`,
      )
      .run(roundId, randomUUID(), symbol, side, actor, reason, new Date().toISOString());
    logEvent(this.db, 'warn', 'order_rejected', `${side} ${symbol}: ${reason}`, roundId);
    return { status: 'rejected', reason, skimCents: 0 };
  }

  private setCash(roundId: number, cashCents: number): void {
    this.db.prepare('UPDATE rounds SET cash_cents = ?, updated_at = ? WHERE id = ?').run(cashCents, new Date().toISOString(), roundId);
  }

  private ledger(roundId: number, type: string, amountCents: number, balanceAfterCents: number, refOrderId: number | null, note: string): void {
    this.db
      .prepare(
        `INSERT INTO ledger_entries (round_id, type, amount_cents, balance_after_cents, ref_order_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(roundId, type, amountCents, balanceAfterCents, refOrderId, note, new Date().toISOString());
  }
}
