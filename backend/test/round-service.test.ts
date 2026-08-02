import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/broker/types.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { RoundService } from '../src/rounds/service.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'test round',
    startingBalanceCents: cents(50),
    profitGoalCents: cents(1000),
    markets: ['US'],
    watchlist: ['AAPL'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null },
    fees: NO_FEES,
    model: 'claude-sonnet-5',
    checkinCron: ['0 8 * * 1-5'],
    ...overrides,
  };
}

function q(price: number): Quote {
  return { symbol: 'AAPL', market: 'US', price, currency: 'USD', ts: new Date().toISOString(), stale: false };
}

describe('RoundService', () => {
  let db: DB;
  let rounds: RoundService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
  });

  it('creates a round with a deposit ledger entry', () => {
    const id = rounds.create(config());
    const round = rounds.get(id);
    expect(round.cash_cents).toBe(cents(50));
    expect(round.status).toBe('active');
    const ledger = db.prepare('SELECT type, amount_cents, balance_after_cents FROM ledger_entries WHERE round_id = ?').all(id);
    expect(ledger).toEqual([{ type: 'deposit', amount_cents: cents(50), balance_after_cents: cents(50) }]);
  });

  it('runs the spec §2.2 worked example: buy $20, sell at 2x, skim $20', () => {
    const id = rounds.create(config());
    const buy = rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    expect(buy.status).toBe('filled');
    expect(rounds.get(id).cash_cents).toBe(cents(30));

    const sell = rounds.sell(id, 'AAPL', 'all', q(20), 1, 'agent');
    expect(sell.status).toBe('filled');
    expect(sell.skimCents).toBe(cents(20));
    expect(rounds.get(id).cash_cents).toBe(cents(50));
    expect(rounds.totalSkimsCents(id)).toBe(cents(20));

    const position = db.prepare('SELECT quantity, closed_at FROM positions WHERE round_id = ?').get(id) as { quantity: number; closed_at: string | null };
    expect(position.quantity).toBe(0);
    expect(position.closed_at).not.toBeNull();
  });

  it('does not skim when cash stays below starting balance', () => {
    const id = rounds.create(config());
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const sell = rounds.sell(id, 'AAPL', 'all', q(9), 1, 'agent'); // sell at a loss
    expect(sell.skimCents).toBe(0);
    expect(rounds.get(id).cash_cents).toBe(cents(48)); // 30 + 18
  });

  it('reaches goal_reached when skims hit the profit goal', () => {
    const id = rounds.create(config({ profitGoalCents: cents(20) }));
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    rounds.sell(id, 'AAPL', 'all', q(20), 1, 'agent');
    expect(rounds.get(id).status).toBe('goal_reached');
  });

  it('clips buys to the max position guardrail', () => {
    const id = rounds.create(config({ guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: 40 } }));
    const buy = rounds.buy(id, 'AAPL', 'US', cents(30), q(10), 1, 'agent'); // cap = $20
    expect(buy.status).toBe('filled');
    const pos = db.prepare('SELECT cost_basis_cents FROM positions WHERE round_id = ?').get(id) as { cost_basis_cents: number };
    expect(pos.cost_basis_cents).toBe(cents(20));
  });

  it('rejects agent trades when the round is paused, but allows the operator', () => {
    const id = rounds.create(config());
    rounds.setStatus(id, 'paused', 'manual pause');
    expect(rounds.buy(id, 'AAPL', 'US', cents(10), q(10), 1, 'agent').status).toBe('rejected');
    expect(rounds.buy(id, 'AAPL', 'US', cents(10), q(10), 1, 'operator').status).toBe('filled');
  });

  it('marks the round busted when cash is exhausted and no positions remain', () => {
    const id = rounds.create(config());
    rounds.buy(id, 'AAPL', 'US', cents(50), q(10), 1, 'agent'); // all-in
    rounds.sell(id, 'AAPL', 'all', q(0.1), 1, 'stop_loss'); // near-total loss → cash $0.50
    expect(rounds.get(id).status).toBe('busted');
  });

  it('sells partially and reduces cost basis proportionally', () => {
    const id = rounds.create(config());
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent'); // 2 shares
    rounds.sell(id, 'AAPL', 1, q(10), 1, 'agent');
    const pos = db.prepare('SELECT quantity, cost_basis_cents, closed_at FROM positions WHERE round_id = ?').get(id) as {
      quantity: number; cost_basis_cents: number; closed_at: string | null;
    };
    expect(pos.quantity).toBe(1);
    expect(pos.cost_basis_cents).toBe(cents(10));
    expect(pos.closed_at).toBeNull();
  });

  it('computes equity from cash plus holdings at given prices', () => {
    const id = rounds.create(config());
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent'); // 2 shares, cash $30
    const equity = rounds.equityCents(id, new Map([['AAPL', 15]])); // 2 × $15 = $30
    expect(equity).toBe(cents(60));
  });

  it('records equity snapshots', () => {
    const id = rounds.create(config());
    rounds.recordEquity(id, new Map());
    const snap = db.prepare('SELECT cash_cents, holdings_cents, equity_cents FROM equity_snapshots WHERE round_id = ?').get(id);
    expect(snap).toEqual({ cash_cents: cents(50), holdings_cents: 0, equity_cents: cents(50) });
  });

  it('ledgers fees on buys and sells (US FX bps)', () => {
    const id = rounds.create(config({ fees: { asxFlatCents: 0, usFxBps: 70, slippageBps: 0 } }));
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    rounds.sell(id, 'AAPL', 'all', q(10), 1, 'agent');
    const types = (db.prepare('SELECT type, amount_cents, balance_after_cents FROM ledger_entries WHERE round_id = ? ORDER BY id').all(id)) as { type: string; amount_cents: number; balance_after_cents: number }[];
    expect(types.map((t) => t.type)).toEqual(['deposit', 'buy', 'fee', 'sell', 'fee']);
    // final ledger balance must equal the round's cash
    expect(types[types.length - 1].balance_after_cents).toBe(rounds.get(id).cash_cents);
  });

  it('handles the ASX path end-to-end (whole shares + flat fee)', () => {
    const id = rounds.create(config({ markets: ['ASX'], watchlist: ['BHP.AX'], fees: { asxFlatCents: 300, usFxBps: 0, slippageBps: 0 }, startingBalanceCents: cents(100), profitGoalCents: cents(1000) }));
    const bq = (price: number): Quote => ({ symbol: 'BHP.AX', market: 'ASX', price, currency: 'AUD', ts: new Date().toISOString(), stale: false });
    const buy = rounds.buy(id, 'BHP.AX', 'ASX', cents(50), bq(20), 1, 'agent'); // $50 − $3 fee → 2 whole shares ($40), leftover stays cash
    expect(buy.status).toBe('filled');
    const pos = db.prepare('SELECT quantity FROM positions WHERE round_id = ?').get(id) as { quantity: number };
    expect(pos.quantity).toBe(2);
    expect(rounds.get(id).cash_cents).toBe(cents(100) - cents(40) - 300);
    const sell = rounds.sell(id, 'BHP.AX', 'all', bq(30), 1, 'agent'); // gross $60, fee $3
    expect(sell.status).toBe('filled');
    expect(rounds.get(id).cash_cents + rounds.totalSkimsCents(id)).toBe(cents(100) - 300 - 300 + cents(20)); // start − 2 fees + $20 gain
  });

  it('writes an audit row for rejected orders', () => {
    const id = rounds.create(config());
    rounds.setStatus(id, 'paused', 'test');
    rounds.buy(id, 'AAPL', 'US', cents(10), q(10), 1, 'agent');
    const row = db.prepare("SELECT status, reason FROM orders WHERE round_id = ? AND status = 'rejected'").get(id) as { status: string; reason: string };
    expect(row.status).toBe('rejected');
    expect(row.reason).toMatch(/paused/);
  });

  it('still records a rejected order when the broker throws inside the transaction', () => {
    const id = rounds.create(config());
    const bad: Quote = { symbol: 'AAPL', market: 'US', price: 0, currency: 'USD', ts: new Date().toISOString(), stale: false };
    const res = rounds.buy(id, 'AAPL', 'US', cents(10), bad, 1, 'agent');
    expect(res.status).toBe('rejected');
    expect(res.reason).toMatch(/invalid quote price/);
    const c = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE round_id = ? AND status = 'rejected'").get(id) as { c: number };
    expect(c.c).toBe(1);
    // and nothing else leaked: no trades, cash unchanged
    expect((db.prepare('SELECT COUNT(*) AS c FROM trades WHERE round_id = ?').get(id) as { c: number }).c).toBe(0);
    expect(rounds.get(id).cash_cents).toBe(cents(50));
  });

  it('rejects agent and operator orders on stale quotes', () => {
    const id = rounds.create(config());
    const staleQ: Quote = { ...q(10), stale: true };
    expect(rounds.buy(id, 'AAPL', 'US', cents(10), staleQ, 1, 'agent').status).toBe('rejected');
    expect(rounds.buy(id, 'AAPL', 'US', cents(10), staleQ, 1, 'operator').status).toBe('rejected');
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    expect(rounds.sell(id, 'AAPL', 'all', staleQ, 1, 'agent').status).toBe('rejected');
    expect(rounds.sell(id, 'AAPL', 'all', staleQ, 1, 'stop_loss').status).toBe('filled'); // protective sells proceed
  });

  it('config() returns the parsed RoundConfig', () => {
    const cfg = config({ name: 'my round', profitGoalCents: cents(123) });
    const id = rounds.create(cfg);
    expect(rounds.config(id)).toEqual(cfg);
  });
});
