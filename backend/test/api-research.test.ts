import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('research API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let roundId: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const created = await request(ctx.app).post('/api/rounds').set('Cookie', cookie)
      .send({ name: 'research', startingBalanceCents: cents(50), profitGoalCents: cents(100) });
    roundId = created.body.id as number;
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get(`/api/rounds/${roundId}/briefings`)).status).toBe(401);
    expect((await request(ctx.app).post(`/api/rounds/${roundId}/research`)).status).toBe(401);
  });

  it('lists briefings, newest first', async () => {
    await request(ctx.app).post(`/api/rounds/${roundId}/research`).set('Cookie', cookie);
    const res = await request(ctx.app).get(`/api/rounds/${roundId}/briefings`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ status: 'success', briefing: expect.any(String) });
  });

  it('runs a briefing on demand', async () => {
    const res = await request(ctx.app).post(`/api/rounds/${roundId}/research`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('404s for an unknown round', async () => {
    expect((await request(ctx.app).get('/api/rounds/9999/briefings').set('Cookie', cookie)).status).toBe(404);
    expect((await request(ctx.app).post('/api/rounds/9999/research').set('Cookie', cookie)).status).toBe(404);
  });
});
