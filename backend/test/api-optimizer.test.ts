import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp, loginCookie } from './api-helper.js';

describe('optimizer routes', () => {
  it('requires auth', async () => {
    const { app } = createTestApp();
    await request(app).get('/api/optimizer').expect(401);
    await request(app).post('/api/optimizer/run').send({ webSearch: false }).expect(401);
  });

  it('lists runs and triggers a new one', async () => {
    const ctx = createTestApp();
    const cookie = await loginCookie(ctx);

    const empty = await request(ctx.app).get('/api/optimizer').set('Cookie', cookie);
    expect(empty.body).toEqual([]);

    const run = await request(ctx.app).post('/api/optimizer/run').set('Cookie', cookie).send({ webSearch: false });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('success');

    const list = await request(ctx.app).get('/api/optimizer').set('Cookie', cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].web_search_enabled).toBe(false);
  });
});
