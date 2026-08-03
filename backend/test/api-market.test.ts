import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('market API', () => {
  let ctx: TestCtx;
  let cookie: string;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
  });

  it('requires auth on every market route', async () => {
    expect((await request(ctx.app).get('/api/market/symbols')).status).toBe(401);
    expect((await request(ctx.app).get('/api/market/history?symbol=AAPL&range=1M')).status).toBe(401);
  });

  it('returns history bars for a valid symbol and range', async () => {
    const res = await request(ctx.app).get('/api/market/history?symbol=AAPL&range=1M').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('AAPL');
    expect(res.body.interval).toBe('1d');
    expect(Array.isArray(res.body.bars)).toBe(true);
    expect(res.body.bars.length).toBeGreaterThan(0);
  });

  it('rejects an unknown range', async () => {
    const res = await request(ctx.app).get('/api/market/history?symbol=AAPL&range=17Y').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('rejects a malformed symbol', async () => {
    const res = await request(ctx.app).get('/api/market/history?symbol=DROP%20TABLE&range=1M').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('502s when history is unavailable and nothing is cached', async () => {
    ctx.barFetcher.fail = true;
    const res = await request(ctx.app).get('/api/market/history?symbol=MSFT&range=1M').set('Cookie', cookie);
    expect(res.status).toBe(502);
  });

  it('tracks, lists and archives symbols', async () => {
    expect(
      (await request(ctx.app).post('/api/market/symbols').set('Cookie', cookie).send({ symbol: 'aapl' })).status,
    ).toBe(201);
    const list = await request(ctx.app).get('/api/market/symbols').set('Cookie', cookie);
    expect(list.body).toEqual([expect.objectContaining({ symbol: 'AAPL', archived: 0 })]);

    const archived = await request(ctx.app)
      .post('/api/market/symbols/AAPL/archive')
      .set('Cookie', cookie)
      .send({ archived: true });
    expect(archived.status).toBe(200);
    const after = await request(ctx.app).get('/api/market/symbols').set('Cookie', cookie);
    expect(after.body[0].archived).toBe(1);
  });

  it('rejects a malformed symbol on track', async () => {
    const res = await request(ctx.app).post('/api/market/symbols').set('Cookie', cookie).send({ symbol: 'no spaces' });
    expect(res.status).toBe(400);
  });

  it('returns live quotes for the requested symbols', async () => {
    const res = await request(ctx.app).get('/api/market/quotes?symbols=AAPL').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.AAPL).toEqual(expect.objectContaining({ price: 10, currency: 'USD', stale: false }));
  });
});

describe('market FX', () => {
  let ctx: TestCtx;
  let cookie: string;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get('/api/market/fx')).status).toBe(401);
  });

  it('returns the AUD/USD rate so the UI can value USD holdings', async () => {
    const res = await request(ctx.app).get('/api/market/fx').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ audUsd: 1 });
  });

  it('502s rather than guessing when the rate is unavailable', async () => {
    delete ctx.prices['AUDUSD=X'];
    const res = await request(ctx.app).get('/api/market/fx').set('Cookie', cookie);
    expect(res.status).toBe(502);
  });
});
