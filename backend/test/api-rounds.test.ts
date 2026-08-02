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
