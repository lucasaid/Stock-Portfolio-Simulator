import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('agent API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let id: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const res = await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r1', startingBalanceCents: cents(50) });
    id = res.body.id as number;
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get(`/api/rounds/${id}/checkins`)).status).toBe(401);
  });

  it('triggers a manual check-in and records it', async () => {
    const res = await request(ctx.app).post(`/api/rounds/${id}/checkin`).set('Cookie', cookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    const checkins = await request(ctx.app).get(`/api/rounds/${id}/checkins`).set('Cookie', cookie);
    expect(checkins.body).toHaveLength(1);
    expect(checkins.body[0].status).toBe('success');
  });

  it('serves journal entries and daily summaries', async () => {
    ctx.db.prepare("INSERT INTO journal_entries (round_id, author, note, created_at) VALUES (?, 'agent', 'note', ?)")
      .run(id, new Date().toISOString());
    ctx.db.prepare("INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, '2026-08-01', '{}', 'n', ?)")
      .run(id, new Date().toISOString());
    expect((await request(ctx.app).get(`/api/rounds/${id}/journal`).set('Cookie', cookie)).body).toHaveLength(1);
    expect((await request(ctx.app).get(`/api/rounds/${id}/summaries`).set('Cookie', cookie)).body).toHaveLength(1);
  });

  it('404s on unknown rounds', async () => {
    expect((await request(ctx.app).post('/api/rounds/999/checkin').set('Cookie', cookie).send({})).status).toBe(404);
  });
});
