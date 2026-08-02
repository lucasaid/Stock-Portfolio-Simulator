import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('manual orders API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let id: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const res = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'r1', startingBalanceCents: cents(50) });
    id = res.body.id as number;
  });

  const order = (body: object) =>
    request(ctx.app).post(`/api/rounds/${id}/orders`).set('Cookie', cookie).send(body);

  it('places an operator buy at a fresh quote', async () => {
    const res = await order({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('filled');
    expect(ctx.rounds.get(id).cash_cents).toBe(cents(30));
  });

  it('sells all and reports the skim', async () => {
    await order({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    ctx.prices['AAPL'] = { price: 20, currency: 'USD' };
    const res = await order({ symbol: 'AAPL', side: 'sell', quantity: 'all' });
    expect(res.status).toBe(201);
    // Skim is price-doubled profit minus FX fees (70 bps on buy and sell)
    expect(res.body.skimCents).toBe(1944);
  });

  it('operator can trade while paused (takeover semantics)', async () => {
    await request(ctx.app).post(`/api/rounds/${id}/status`).set('Cookie', cookie).send({ action: 'pause' });
    const res = await order({ symbol: 'AAPL', side: 'buy', amountCents: cents(10) });
    expect(res.status).toBe(201);
  });

  it('409s with the rejection reason when the engine rejects', async () => {
    const res = await order({ symbol: 'AAPL', side: 'sell', quantity: 'all' }); // nothing held
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no open position/);
  });

  it('422s when no quote is available', async () => {
    const res = await order({ symbol: 'GHOST', side: 'buy', amountCents: cents(10) });
    expect(res.status).toBe(422);
  });

  it('400s on malformed bodies', async () => {
    expect((await order({ side: 'buy' })).status).toBe(400);
    expect((await order({ symbol: 'AAPL', side: 'hold' })).status).toBe(400);
    expect((await order({ symbol: 'AAPL', side: 'buy' })).status).toBe(400); // no amount
  });
});
