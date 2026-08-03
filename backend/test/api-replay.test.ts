import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('replay API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let roundId: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const created = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'replay', startingBalanceCents: cents(50), profitGoalCents: cents(100) });
    roundId = created.body.id as number;
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get(`/api/replay/rounds/${roundId}/sweep`)).status).toBe(401);
    expect((await request(ctx.app).post(`/api/replay/rounds/${roundId}`).send({})).status).toBe(401);
  });

  it('serves the sweep', async () => {
    const res = await request(ctx.app).get(`/api/replay/rounds/${roundId}/sweep`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('accepts a guardrail override body', async () => {
    const res = await request(ctx.app)
      .post(`/api/replay/rounds/${roundId}`)
      .set('Cookie', cookie)
      .send({ stopLossPct: 5 });
    expect(res.status).toBe(200);
    expect(typeof res.body.finalCashCents).toBe('number');
  });

  it('rejects a malformed override body', async () => {
    const res = await request(ctx.app)
      .post(`/api/replay/rounds/${roundId}`)
      .set('Cookie', cookie)
      .send({ stopLossPct: 'a lot' });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown round on both routes', async () => {
    expect((await request(ctx.app).get('/api/replay/rounds/9999/sweep').set('Cookie', cookie)).status).toBe(404);
    expect((await request(ctx.app).post('/api/replay/rounds/9999').set('Cookie', cookie).send({})).status).toBe(404);
  });

  it('every money field in the response is an integer', async () => {
    const res = await request(ctx.app).post(`/api/replay/rounds/${roundId}`).set('Cookie', cookie).send({});
    for (const value of [res.body.finalCashCents, res.body.skimmedCents, res.body.feesCents]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
