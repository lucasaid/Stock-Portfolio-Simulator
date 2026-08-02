import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/broker/types.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, cents } from '../src/engine/types.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function quote(symbol: string, market: 'ASX' | 'US', price: number, currency: 'AUD' | 'USD'): Quote {
  return { symbol, market, price, currency, ts: new Date().toISOString(), stale: false };
}

function seedRound(db: DB): number {
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO rounds (name, status, starting_balance_cents, cash_cents, profit_goal_cents, config_json, created_at, updated_at)
       VALUES ('t', 'active', ?, ?, ?, '{}', ?, ?)`,
    )
    .run(cents(50), cents(50), cents(1000), now, now);
  return Number(r.lastInsertRowid);
}

describe('PaperBroker', () => {
  let db: DB;
  let broker: PaperBroker;
  let roundId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    broker = new PaperBroker(db);
    roundId = seedRound(db);
  });

  it('fills a fee-free US buy: $20 at USD$10, AUDUSD=1 → 2 shares', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o1', symbol: 'AAPL', market: 'US', side: 'buy', amountCents: cents(20), placedBy: 'agent' },
      quote('AAPL', 'US', 10, 'USD'), 1, NO_FEES,
    );
    expect(fill.quantity).toBeCloseTo(2);
    expect(fill.grossCents).toBe(cents(20));
    expect(fill.feeCents).toBe(0);
    expect(fill.netCashDeltaCents).toBe(-cents(20));
  });

  it('converts USD prices to AUD (USD$6.50 at 0.65 = AUD$10)', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o2', symbol: 'AAPL', market: 'US', side: 'buy', amountCents: cents(20), placedBy: 'agent' },
      quote('AAPL', 'US', 6.5, 'USD'), 0.65, NO_FEES,
    );
    expect(fill.priceAud).toBeCloseTo(10);
    expect(fill.quantity).toBeCloseTo(2);
  });

  it('deducts fees from the spend on buys (US 70bps)', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o3', symbol: 'AAPL', market: 'US', side: 'buy', amountCents: cents(100), placedBy: 'agent' },
      quote('AAPL', 'US', 10, 'USD'), 1, DEFAULT_FEES,
    );
    expect(fill.feeCents).toBe(70); // 70bps of $100
    expect(fill.grossCents + fill.feeCents).toBeLessThanOrEqual(cents(100));
    expect(fill.netCashDeltaCents).toBe(-(fill.grossCents + fill.feeCents));
  });

  it('floors ASX buys to whole shares', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o4', symbol: 'BHP.AX', market: 'ASX', side: 'buy', amountCents: cents(45), placedBy: 'agent' },
      quote('BHP.AX', 'ASX', 20, 'AUD'), 1, NO_FEES,
    );
    expect(fill.quantity).toBe(2); // $45 buys 2 whole $20 shares
    expect(fill.grossCents).toBe(cents(40));
  });

  it('rejects an ASX buy too small for one share after the flat fee', () => {
    expect(() =>
      broker.execute(
        { roundId, clientOrderId: 'o5', symbol: 'BHP.AX', market: 'ASX', side: 'buy', amountCents: cents(20), placedBy: 'agent' },
        quote('BHP.AX', 'ASX', 20, 'AUD'), 1, DEFAULT_FEES,
      ),
    ).toThrow(/too small/);
  });

  it('fills sells and credits net of fees', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o6', symbol: 'AAPL', market: 'US', side: 'sell', quantity: 2, placedBy: 'agent' },
      quote('AAPL', 'US', 20, 'USD'), 1, NO_FEES,
    );
    expect(fill.grossCents).toBe(cents(40));
    expect(fill.netCashDeltaCents).toBe(cents(40));
  });

  it('applies slippage against the trader', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o7', symbol: 'AAPL', market: 'US', side: 'sell', quantity: 1, placedBy: 'agent' },
      quote('AAPL', 'US', 100, 'USD'), 1, { ...NO_FEES, slippageBps: 100 },
    );
    expect(fill.priceAud).toBeCloseTo(99);
  });

  it('persists order and trade rows', () => {
    broker.execute(
      { roundId, clientOrderId: 'o8', symbol: 'AAPL', market: 'US', side: 'buy', amountCents: cents(20), placedBy: 'operator' },
      quote('AAPL', 'US', 10, 'USD'), 1, NO_FEES,
    );
    const order = db.prepare("SELECT status, placed_by FROM orders WHERE client_order_id = 'o8'").get() as { status: string; placed_by: string };
    expect(order).toEqual({ status: 'filled', placed_by: 'operator' });
    expect(db.prepare('SELECT COUNT(*) AS c FROM trades').get()).toEqual({ c: 1 });
  });

  it('enforces client_order_id idempotency', () => {
    const req = { roundId, clientOrderId: 'dup', symbol: 'AAPL', market: 'US' as const, side: 'buy' as const, amountCents: cents(10), placedBy: 'agent' as const };
    broker.execute(req, quote('AAPL', 'US', 10, 'USD'), 1, NO_FEES);
    expect(() => broker.execute(req, quote('AAPL', 'US', 10, 'USD'), 1, NO_FEES)).toThrow(/duplicate order/);
  });

  it('fills exact whole-share ASX boundaries without dropping a share', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o10', symbol: 'BHP.AX', market: 'ASX', side: 'buy', amountCents: 3_278_255, placedBy: 'agent' },
      quote('BHP.AX', 'ASX', 327.82553944112493, 'AUD'), 1, NO_FEES,
    );
    expect(fill.quantity).toBe(100);
  });

  it('rejects a dust ASX sell instead of charging the flat fee for nothing', () => {
    expect(() =>
      broker.execute(
        { roundId, clientOrderId: 'o11', symbol: 'BHP.AX', market: 'ASX', side: 'sell', quantity: 0.001, placedBy: 'agent' },
        quote('BHP.AX', 'ASX', 20, 'AUD'), 1, DEFAULT_FEES,
      ),
    ).toThrow(/too small/);
  });

  it('charges flat brokerage on ASX sells', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o12', symbol: 'BHP.AX', market: 'ASX', side: 'sell', quantity: 2, placedBy: 'agent' },
      quote('BHP.AX', 'ASX', 20, 'AUD'), 1, DEFAULT_FEES,
    );
    expect(fill.grossCents).toBe(cents(40));
    expect(fill.feeCents).toBe(300);
    expect(fill.netCashDeltaCents).toBe(cents(40) - 300);
  });

  it('converts USD sells to AUD', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o13', symbol: 'AAPL', market: 'US', side: 'sell', quantity: 2, placedBy: 'agent' },
      quote('AAPL', 'US', 20, 'USD'), 0.65, NO_FEES,
    );
    expect(fill.grossCents).toBe(6154); // 2 × (20/0.65) × 100 rounded
  });

  it('applies slippage against the trader on buys', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o14', symbol: 'AAPL', market: 'US', side: 'buy', amountCents: cents(100), placedBy: 'agent' },
      quote('AAPL', 'US', 100, 'USD'), 1, { ...NO_FEES, slippageBps: 100 },
    );
    expect(fill.priceAud).toBeCloseTo(101);
  });

  it('never spends more than amountCents on ASX buys, even at epsilon boundaries', () => {
    for (const price of [327.82553944112493, 19.999999999, 3.3333333333, 101.00000001]) {
      for (const dollars of [50, 45.5, 3278.255, 20]) {
        try {
          const fill = broker.execute(
            { roundId, clientOrderId: `inv-${price}-${dollars}`, symbol: 'BHP.AX', market: 'ASX', side: 'buy', amountCents: Math.round(dollars * 100), placedBy: 'agent' },
            quote('BHP.AX', 'ASX', price, 'AUD'), 1, NO_FEES,
          );
          expect(fill.grossCents + fill.feeCents).toBeLessThanOrEqual(Math.round(dollars * 100));
        } catch (err) {
          if (!(err instanceof Error) || !/too small/.test(err.message)) throw err;
        }
      }
    }
  });

  it('handles penny-stock scale without overspend (reviewer repro)', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o16', symbol: 'PNY.AX', market: 'ASX', side: 'buy', amountCents: 5_000_000, placedBy: 'agent' },
      quote('PNY.AX', 'ASX', 0.01, 'AUD'), 1, NO_FEES,
    );
    expect(fill.quantity).toBe(5_000_000);
    expect(fill.grossCents + fill.feeCents).toBeLessThanOrEqual(5_000_000);
  });

  it('never sells more shares than requested (phantom-share repro)', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o17', symbol: 'PNY.AX', market: 'ASX', side: 'sell', quantity: 5_000_000, placedBy: 'agent' },
      quote('PNY.AX', 'ASX', 0.01, 'AUD'), 1, NO_FEES,
    );
    expect(fill.quantity).toBe(5_000_000);
  });

  it('holds both invariants across a wide fuzz sweep', () => {
    let checked = 0;
    for (const price of [0.005, 0.01, 0.1, 1, 19.999999999, 327.82553944112493, 1000]) {
      for (const dollars of [1, 45.5, 500, 32782.55, 50000]) {
        const amountCents = Math.round(dollars * 100);
        try {
          const buy = broker.execute(
            { roundId, clientOrderId: `fz-b-${price}-${dollars}`, symbol: 'FZ.AX', market: 'ASX', side: 'buy', amountCents, placedBy: 'agent' },
            quote('FZ.AX', 'ASX', price, 'AUD'), 1, NO_FEES,
          );
          expect(buy.grossCents + buy.feeCents).toBeLessThanOrEqual(amountCents);
          const sell = broker.execute(
            { roundId, clientOrderId: `fz-s-${price}-${dollars}`, symbol: 'FZ.AX', market: 'ASX', side: 'sell', quantity: buy.quantity, placedBy: 'agent' },
            quote('FZ.AX', 'ASX', price, 'AUD'), 1, NO_FEES,
          );
          expect(sell.quantity).toBeLessThanOrEqual(buy.quantity);
        } catch (err) {
          if (!/too small/.test((err as Error).message)) throw err;
        }
        checked++;
      }
    }
    expect(checked).toBe(35);
  });
});
