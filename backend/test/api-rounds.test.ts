import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('rounds API', () => {
  let ctx: TestCtx;
  let cookie: string;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get('/api/rounds')).status).toBe(401);
  });

  it('creates a round from defaults with overrides', async () => {
    const res = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'first run', startingBalanceCents: cents(50), profitGoalCents: cents(1000) });
    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(Number));
    const round = ctx.rounds.get(res.body.id);
    expect(round.starting_balance_cents).toBe(cents(50));
    expect(round.status).toBe('active');
    // unspecified fields came from settings defaults
    expect(ctx.rounds.config(res.body.id).tradingStyle).toBe('swing');
  });

  it('rejects invalid create payloads', async () => {
    expect((await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({})).status).toBe(400);
    expect(
      (await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'x', startingBalanceCents: -5 }))
        .status,
    ).toBe(400);
  });

  it('accepts a CRYPTO-only markets list', async () => {
    const res = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'crypto round', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['CRYPTO'] });
    expect(res.status).toBe(201);
  });

  it('accepts a markets list combining ASX, US and CRYPTO', async () => {
    const res = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({
        name: 'all markets round',
        startingBalanceCents: cents(50),
        profitGoalCents: cents(1000),
        markets: ['ASX', 'US', 'CRYPTO'],
      });
    expect(res.status).toBe(201);
  });

  it('still rejects an unknown market string', async () => {
    const res = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({
        name: 'bad round',
        startingBalanceCents: cents(50),
        profitGoalCents: cents(1000),
        markets: ['NOTAMARKET'],
      });
    expect(res.status).toBe(400);
  });

  it('lists rounds with pocketed totals', async () => {
    await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r1' });
    const res = await request(ctx.app).get('/api/rounds').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ name: 'r1', status: 'active', totalSkimsCents: 0 });
  });

  it('returns round detail with config, positions and totals', async () => {
    const create = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'r1', startingBalanceCents: cents(50) });
    const id = create.body.id as number;
    const quotes = await ctx.market.poll(['AAPL']);
    ctx.rounds.buy(id, 'AAPL', 'US', cents(20), quotes.get('AAPL')!, 1, 'operator');
    const res = await request(ctx.app).get(`/api/rounds/${id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.round.cash_cents).toBe(cents(30));
    expect(res.body.config.name).toBe('r1');
    expect(res.body.positions).toHaveLength(1);
    expect(res.body.totalSkimsCents).toBe(0);
  });

  it('serves ledger, trades and equity history', async () => {
    const create = await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r1' });
    const id = create.body.id as number;
    ctx.rounds.recordEquity(id, new Map());
    const ledger = await request(ctx.app).get(`/api/rounds/${id}/ledger`).set('Cookie', cookie);
    expect(ledger.body[0].type).toBe('deposit');
    const equity = await request(ctx.app).get(`/api/rounds/${id}/equity`).set('Cookie', cookie);
    expect(equity.body).toHaveLength(1);
    const trades = await request(ctx.app).get(`/api/rounds/${id}/trades`).set('Cookie', cookie);
    expect(trades.body).toEqual([]);
  });

  it('serves equity as one point per Sydney day, or raw points for a recent window', async () => {
    const create = await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r1' });
    const id = create.body.id as number;
    const insert = ctx.db.prepare(
      'INSERT INTO equity_snapshots (round_id, ts, cash_cents, holdings_cents, equity_cents) VALUES (?, ?, 0, 0, ?)',
    );
    // 13:00Z and 13:55Z are both 3 Aug in Sydney (UTC+10); 14:05Z is already 4 Aug there.
    insert.run(id, '2026-08-03T13:00:00.000Z', 100);
    insert.run(id, '2026-08-03T13:55:00.000Z', 200);
    insert.run(id, '2026-08-03T14:05:00.000Z', 300);
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    insert.run(id, recent, 400);

    const get = (view: string) => request(ctx.app).get(`/api/rounds/${id}/equity?view=${view}`).set('Cookie', cookie);
    const daily = await get('daily');
    expect(daily.body.map((p: { equity_cents: number }) => p.equity_cents)).toEqual([200, 300, 400]);
    const week = await get('1W');
    expect(week.body.map((p: { ts: string }) => p.ts)).toEqual([recent]);
    expect((await get('toString')).status).toBe(400);
  });

  it('404s for unknown rounds', async () => {
    expect((await request(ctx.app).get('/api/rounds/999').set('Cookie', cookie)).status).toBe(404);
  });

  it('deep-merges partial guardrails over defaults instead of replacing them', async () => {
    const res = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'partial', guardrails: { stopLossPct: 5 } });
    expect(res.status).toBe(201);
    const g = ctx.rounds.config(res.body.id).guardrails;
    expect(g.stopLossPct).toBe(5);
    expect(g.maxPositionPct).not.toBeUndefined();
    expect(g.drawdownPausePct).not.toBeUndefined();
  });

  it('deep-merges partial fees over defaults', async () => {
    const res = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'fees', fees: { slippageBps: 25 } });
    expect(res.status).toBe(201);
    const f = ctx.rounds.config(res.body.id).fees;
    expect(f.slippageBps).toBe(25);
    expect(f.asxFlatCents).not.toBeUndefined();
    expect(f.usFxBps).not.toBeUndefined();
  });
});
