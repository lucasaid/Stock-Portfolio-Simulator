import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('round controls API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let id: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const res = await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r1' });
    id = res.body.id as number;
  });

  const act = (action: string, roundId = id) =>
    request(ctx.app).post(`/api/rounds/${roundId}/status`).set('Cookie', cookie).send({ action });

  it('pause → resume round-trips', async () => {
    expect((await act('pause')).status).toBe(200);
    expect(ctx.rounds.get(id).status).toBe('paused');
    expect((await act('resume')).status).toBe(200);
    expect(ctx.rounds.get(id).status).toBe('active');
  });

  it('takeover → release round-trips', async () => {
    expect((await act('takeover')).status).toBe(200);
    expect(ctx.rounds.get(id).status).toBe('takeover');
    expect((await act('release')).status).toBe(200);
    expect(ctx.rounds.get(id).status).toBe('active');
  });

  it('rejects invalid transitions with 409', async () => {
    expect((await act('release')).status).toBe(409); // not in takeover
    expect((await act('archive')).status).toBe(409); // active can't archive
  });

  it('rejects unknown actions with 400', async () => {
    expect((await act('explode')).status).toBe(400);
  });

  it('kill switch pauses every non-terminal round', async () => {
    const r2 = (await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r2' })).body.id as number;
    const res = await request(ctx.app).post('/api/kill').set('Cookie', cookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(2);
    expect(ctx.rounds.get(id).status).toBe('paused');
    expect(ctx.rounds.get(r2).status).toBe('paused');
  });

  it('PATCHes config live, records config events, and blocks startingBalanceCents', async () => {
    const res = await request(ctx.app)
      .patch(`/api/rounds/${id}/config`)
      .set('Cookie', cookie)
      .send({ tradingStyle: 'day', riskProfile: 'aggressive' });
    expect(res.status).toBe(200);
    const cfg = ctx.rounds.config(id);
    expect(cfg.tradingStyle).toBe('day');
    expect(cfg.riskProfile).toBe('aggressive');
    const events = ctx.db
      .prepare('SELECT field, old_value, new_value FROM config_events WHERE round_id = ? ORDER BY id')
      .all(id) as { field: string; old_value: string; new_value: string }[];
    expect(events.map((e) => e.field).sort()).toEqual(['riskProfile', 'tradingStyle']);
    expect(events.find((e) => e.field === 'tradingStyle')).toMatchObject({
      old_value: '"swing"',
      new_value: '"day"',
    });

    const blocked = await request(ctx.app)
      .patch(`/api/rounds/${id}/config`)
      .set('Cookie', cookie)
      .send({ startingBalanceCents: cents(500) });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/startingBalanceCents/);
  });

  it('PATCHing profitGoalCents also updates the denormalized column', async () => {
    await request(ctx.app).patch(`/api/rounds/${id}/config`).set('Cookie', cookie).send({ profitGoalCents: cents(20) });
    expect(ctx.rounds.get(id).profit_goal_cents).toBe(cents(20));
  });

  it('deep-merges partial guardrail edits over current config', async () => {
    const res = await request(ctx.app)
      .patch(`/api/rounds/${id}/config`)
      .set('Cookie', cookie)
      .send({ guardrails: { stopLossPct: 5 } });
    expect(res.status).toBe(200);
    const g = ctx.rounds.config(id).guardrails;
    expect(g.stopLossPct).toBe(5);
    expect(g.maxPositionPct).not.toBeUndefined();
    expect(g.drawdownPausePct).not.toBeUndefined();
  });
});
