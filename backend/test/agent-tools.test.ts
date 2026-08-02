import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { RoundService } from '../src/rounds/service.js';
import { buildDecisionTools } from '../src/agent/tools.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'tools', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
    model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'], ...overrides,
  };
}

describe('decision tools', () => {
  let db: DB;
  let rounds: RoundService;
  let market: MarketDataService;
  let prices: Record<string, { price: number; currency: string }>;
  let id: number;
  let checkinId: number;

  const fetcher: QuoteFetcher = async (symbols) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    market = new MarketDataService(db, fetcher);
    prices = { 'AAPL': { price: 10, currency: 'USD' }, 'AUDUSD=X': { price: 1, currency: 'USD' } };
    id = rounds.create(config());
    checkinId = Number(
      db.prepare("INSERT INTO checkins (round_id, ts, snapshot_json, actions_json, status) VALUES (?, ?, '{}', '[]', 'running')")
        .run(id, new Date().toISOString()).lastInsertRowid,
    );
  });

  function tools() {
    return buildDecisionTools({ db, rounds, market }, id, checkinId);
  }

  it('place_order buys at a fresh quote and records the action', async () => {
    const { tools: t, actions } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    const result = await place.handler({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/filled/i);
    expect(rounds.get(id).cash_cents).toBe(cents(30));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ tool: 'place_order', ok: true });
  });

  it('place_order sells all and reports the skim', async () => {
    const { tools: t } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    await place.handler({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    prices['AAPL'] = { price: 20, currency: 'USD' };
    const result = await place.handler({ symbol: 'AAPL', side: 'sell', quantity: 'all' });
    expect(result.text).toMatch(/pocketed \$20\.00/i);
  });

  it('place_order surfaces engine rejections as tool errors, not throws', async () => {
    rounds.setStatus(id, 'paused', 'test');
    const { tools: t, actions } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    const result = await place.handler({ symbol: 'AAPL', side: 'buy', amountCents: cents(10) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/paused/);
    expect(actions[0]).toMatchObject({ ok: false });
  });

  it('place_order errors cleanly when no quote is available', async () => {
    const { tools: t } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    const result = await place.handler({ symbol: 'GHOST', side: 'buy', amountCents: cents(10) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no quote/i);
  });

  it('rejects malformed orders before they reach the engine (no NaN amounts)', async () => {
    const { tools: t, actions } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    const noAmount = await place.handler({ symbol: 'AAPL', side: 'buy' });
    expect(noAmount.isError).toBe(true);
    expect(noAmount.text).toMatch(/amountCents/);
    const noQty = await place.handler({ symbol: 'AAPL', side: 'sell' });
    expect(noQty.isError).toBe(true);
    expect(noQty.text).toMatch(/quantity/);
    expect(actions.every((a) => a.ok === false)).toBe(true);
    // nothing reached the ledger
    expect(db.prepare('SELECT COUNT(*) AS c FROM trades').get()).toEqual({ c: 0 });
    expect(rounds.get(id).cash_cents).toBe(cents(50));
  });

  it('set_stop_loss updates the open position and clears with null', async () => {
    const { tools: t } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    await place.handler({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    const stop = t.find((x) => x.name === 'set_stop_loss')!;
    const result = await stop.handler({ symbol: 'AAPL', stopPrice: 9 });
    expect(result.isError).toBeUndefined();
    expect((db.prepare('SELECT stop_loss_price FROM positions WHERE round_id = ? AND closed_at IS NULL').get(id) as { stop_loss_price: number }).stop_loss_price).toBe(9);
    await stop.handler({ symbol: 'AAPL', stopPrice: null });
    expect((db.prepare('SELECT stop_loss_price FROM positions WHERE round_id = ? AND closed_at IS NULL').get(id) as { stop_loss_price: number | null }).stop_loss_price).toBeNull();
  });

  it('set_stop_loss errors when there is no open position', async () => {
    const { tools: t } = tools();
    const stop = t.find((x) => x.name === 'set_stop_loss')!;
    const result = await stop.handler({ symbol: 'AAPL', stopPrice: 9 });
    expect(result.isError).toBe(true);
  });

  it('update_watchlist adds and removes symbols and writes config_events', async () => {
    const { tools: t } = tools();
    const watch = t.find((x) => x.name === 'update_watchlist')!;
    const result = await watch.handler({ add: ['MSFT'], remove: ['AAPL'] });
    expect(result.isError).toBeUndefined();
    expect(rounds.config(id).watchlist).toEqual(['MSFT']);
    const event = db.prepare("SELECT changed_by, field FROM config_events WHERE round_id = ?").get(id) as { changed_by: string; field: string };
    expect(event).toEqual({ changed_by: 'agent', field: 'watchlist' });
  });

  it('update_watchlist dedupes added symbols', async () => {
    const { tools: t } = tools();
    const watch = t.find((x) => x.name === 'update_watchlist')!;
    await watch.handler({ add: ['MSFT', 'MSFT'], remove: [] });
    expect(rounds.config(id).watchlist.filter((s) => s === 'MSFT')).toHaveLength(1);
  });

  it('write_journal inserts an agent journal entry linked to the check-in', async () => {
    const { tools: t } = tools();
    const journal = t.find((x) => x.name === 'write_journal')!;
    await journal.handler({ note: 'Holding steady.' });
    const row = db.prepare('SELECT author, note, checkin_id FROM journal_entries WHERE round_id = ?').get(id) as {
      author: string; note: string; checkin_id: number;
    };
    expect(row).toEqual({ author: 'agent', note: 'Holding steady.', checkin_id: checkinId });
  });
});
