import type { DB } from '../db/connection.js';
import { applySlippage, tradeFeeCents, usdToAud } from '../engine/fees.js';
import type { FeeConfig } from '../engine/types.js';
import type { Broker, Fill, OrderRequest, Quote } from './types.js';

/** Simulated broker: fills instantly at the quoted price (spec §3.1). */
export class PaperBroker implements Broker {
  constructor(private db: DB) {}

  execute(req: OrderRequest, quote: Quote, audUsdRate: number, fees: FeeConfig): Fill {
    const now = new Date().toISOString();
    const priceRaw = quote.currency === 'USD' ? usdToAud(quote.price, audUsdRate) : quote.price;
    const priceAud = applySlippage(priceRaw, req.side, fees.slippageBps);

    let quantity: number;
    let grossCents: number;
    let feeCents: number;

    if (req.side === 'buy') {
      if (!req.amountCents || req.amountCents <= 0) throw new Error('buy requires amountCents > 0');
      feeCents = tradeFeeCents(req.market, req.amountCents, fees);
      const investableCents = req.amountCents - feeCents;
      if (investableCents <= 0) throw new Error('amount too small to cover fees');
      quantity = investableCents / (priceAud * 100);
      if (req.market === 'ASX') {
        quantity = Math.floor(quantity);
        // A truncated fractional share may still be affordable as a whole share once
        // cost is rounded to cents — top up only while the rounded cost actually fits.
        while (Math.round((quantity + 1) * priceAud * 100) <= investableCents) quantity += 1;
        if (quantity < 1) throw new Error('amount too small for one ASX share');
      }
      grossCents = Math.round(quantity * priceAud * 100);
      if (req.market === 'ASX' && grossCents > investableCents) {
        throw new Error('internal: ASX buy overspend');
      }
    } else {
      if (!req.quantity || req.quantity <= 0) throw new Error('sell requires quantity > 0');
      quantity = req.quantity;
      if (req.market === 'ASX') {
        quantity = Math.floor(req.quantity + 1e-6); // absolute epsilon only absorbs FP dust
        if (quantity > req.quantity) quantity = Math.floor(req.quantity); // hard cap: no phantom shares
        if (quantity < 1) throw new Error('sell quantity too small for one ASX share');
      }
      grossCents = Math.round(quantity * priceAud * 100);
      if (grossCents <= 0) throw new Error('sell too small: zero proceeds');
      feeCents = tradeFeeCents(req.market, grossCents, fees);
    }

    const netCashDeltaCents = req.side === 'buy' ? -(grossCents + feeCents) : grossCents - feeCents;

    let fill: Fill;
    try {
      fill = this.db.transaction((): Fill => {
        const order = this.db
          .prepare(
            `INSERT INTO orders (round_id, client_order_id, symbol, side, requested_cents, quantity, status, placed_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'filled', ?, ?)`,
          )
          .run(req.roundId, req.clientOrderId, req.symbol, req.side, req.amountCents ?? null, req.quantity ?? null, req.placedBy, now);
        const orderId = Number(order.lastInsertRowid);
        this.db
          .prepare(
            `INSERT INTO trades (order_id, round_id, symbol, side, quantity, price_aud, gross_cents, fee_cents, executed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(orderId, req.roundId, req.symbol, req.side, quantity, priceAud, grossCents, feeCents, now);
        return { orderId, quantity, priceAud, grossCents, feeCents, netCashDeltaCents };
      })();
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed.*client_order_id/.test(err.message)) {
        throw new Error('duplicate order');
      }
      throw err;
    }

    return fill;
  }
}
