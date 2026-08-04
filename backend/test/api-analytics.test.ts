import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('analytics API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let roundId: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const created = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'analytics', startingBalanceCents: cents(50), profitGoalCents: cents(100) });
    roundId = created.body.id as number;
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get(`/api/analytics/rounds/${roundId}`)).status).toBe(401);
    expect((await request(ctx.app).get('/api/analytics/summary')).status).toBe(401);
  });

  it('returns the per-round analytics payload', async () => {
    const res = await request(ctx.app).get(`/api/analytics/rounds/${roundId}`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      roundId,
      stats: expect.objectContaining({ closed: 0, wins: 0 }),
      histogram: [],
      scatter: [],
      costs: expect.objectContaining({ totalFeesCents: 0 }),
    });
    expect(Array.isArray(res.body.eras)).toBe(true);
  });

  it('404s for an unknown round', async () => {
    expect((await request(ctx.app).get('/api/analytics/rounds/9999').set('Cookie', cookie)).status).toBe(404);
  });

  it('404s for a non-numeric round id rather than 500ing', async () => {
    expect((await request(ctx.app).get('/api/analytics/rounds/abc').set('Cookie', cookie)).status).toBe(404);
  });

  it('serves the benchmark with the configured default symbol', async () => {
    const res = await request(ctx.app).get(`/api/analytics/rounds/${roundId}/benchmark`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('IVV');
    expect(Array.isArray(res.body.points)).toBe(true);
  });

  it('accepts a benchmark symbol override', async () => {
    const res = await request(ctx.app)
      .get(`/api/analytics/rounds/${roundId}/benchmark?symbol=vas.ax`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('VAS.AX');
  });

  it('rejects a malformed benchmark symbol', async () => {
    const res = await request(ctx.app)
      .get(`/api/analytics/rounds/${roundId}/benchmark?symbol=drop table`)
      .set('Cookie', cookie);

    expect(res.status).toBe(400);
  });

  it('serves decision outcomes', async () => {
    const res = await request(ctx.app).get(`/api/analytics/rounds/${roundId}/decisions`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('summarises every round for cross-round comparison', async () => {
    const res = await request(ctx.app).get('/api/analytics/summary').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.rounds).toEqual([
      expect.objectContaining({ id: roundId, name: 'analytics', stats: expect.any(Object) }),
    ]);
    expect(res.body.totals).toMatchObject({ closed: 0, totalNetCents: 0 });
  });

  it('summary includes per-round and total ai usage', async () => {
    ctx.db
      .prepare(
        `INSERT INTO checkins (round_id, ts, snapshot_json, actions_json, tokens_used, cost_usd, status)
         VALUES (?, ?, '{}', '[]', ?, ?, 'success')`,
      )
      .run(roundId, '2026-08-01T00:00:00.000Z', 100, 0.01);
    ctx.db
      .prepare(
        `INSERT INTO research_briefings (round_id, created_at, symbols_json, briefing, tokens_used, cost_usd, status)
         VALUES (?, ?, '[]', '', ?, ?, 'success')`,
      )
      .run(roundId, '2026-08-02T00:00:00.000Z', 500, 0.05);

    const res = await request(ctx.app).get('/api/analytics/summary').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.rounds[0].aiUsage).toEqual({ totalTokens: 600, totalCostUsd: expect.closeTo(0.06) });
    expect(res.body.aiUsageTotals.totalTokens).toBe(600);
    expect(res.body.aiUsageTotals.totalCostUsd).toBeCloseTo(0.06);
    expect(res.body.aiUsageTotals.byDay).toEqual(
      expect.arrayContaining([
        { day: '2026-08-01', tokens: 100, costUsd: expect.closeTo(0.01) },
        { day: '2026-08-02', tokens: 500, costUsd: expect.closeTo(0.05) },
      ]),
    );
  });

  it('never returns dollars — money fields stay integer cents', async () => {
    const res = await request(ctx.app).get(`/api/analytics/rounds/${roundId}`).set('Cookie', cookie);

    const moneyFields = [
      res.body.stats.avgWinCents, res.body.stats.avgLossCents, res.body.stats.totalNetCents,
      res.body.stats.totalFeesCents, res.body.costs.totalFeesCents,
    ];
    for (const value of moneyFields) expect(Number.isInteger(value)).toBe(true);
  });
});
