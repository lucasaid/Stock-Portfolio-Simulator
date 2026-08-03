import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('market-scan API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let roundId: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const created = await request(ctx.app).post('/api/rounds').set('Cookie', cookie)
      .send({ name: 'market-scan', startingBalanceCents: cents(50), profitGoalCents: cents(100) });
    roundId = created.body.id as number;
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get(`/api/rounds/${roundId}/scans`)).status).toBe(401);
    expect((await request(ctx.app).post(`/api/rounds/${roundId}/scan`)).status).toBe(401);
  });

  it('lists scans, empty before any scan', async () => {
    const res = await request(ctx.app).get(`/api/rounds/${roundId}/scans`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('runs a scan on demand', async () => {
    const res = await request(ctx.app).post(`/api/rounds/${roundId}/scan`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
  });

  it('404s for an unknown round', async () => {
    expect((await request(ctx.app).get('/api/rounds/9999/scans').set('Cookie', cookie)).status).toBe(404);
    expect((await request(ctx.app).post('/api/rounds/9999/scan').set('Cookie', cookie)).status).toBe(404);
  });
});
