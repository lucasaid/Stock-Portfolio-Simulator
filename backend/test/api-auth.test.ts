import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('auth API', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = createTestApp();
  });

  it('health endpoint is public', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('logs in with valid credentials and sets an httpOnly cookie', async () => {
    await ctx.auth.createUser('chris', 'hunter22');
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'chris', password: 'hunter22' });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it('rejects bad credentials with 401', async () => {
    await ctx.auth.createUser('chris', 'hunter22');
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'chris', password: 'nope' });
    expect(res.status).toBe(401);
  });

  it('rate limits after 5 failed logins', async () => {
    await ctx.auth.createUser('chris', 'hunter22');
    for (let i = 0; i < 5; i++) {
      await request(ctx.app).post('/api/auth/login').send({ username: 'chris', password: 'nope' });
    }
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'chris', password: 'hunter22' });
    expect(res.status).toBe(429);
  });

  it('guards protected routes: 401 without session, 200 with', async () => {
    expect((await request(ctx.app).get('/api/auth/me')).status).toBe(401);
    const cookie = await loginCookie(ctx);
    const res = await request(ctx.app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: 'chris' });
  });

  it('logout invalidates the session', async () => {
    const cookie = await loginCookie(ctx);
    await request(ctx.app).post('/api/auth/logout').set('Cookie', cookie);
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('changes password via the API and old password stops working', async () => {
    const cookie = await loginCookie(ctx);
    const res = await request(ctx.app)
      .post('/api/auth/password')
      .set('Cookie', cookie)
      .send({ current: 'hunter22', next: 'newpass' });
    expect(res.status).toBe(200);
    expect(await ctx.auth.verifyLogin('chris', 'newpass')).not.toBeNull();
    expect(await ctx.auth.verifyLogin('chris', 'hunter22')).toBeNull();
  });

  it('returns JSON errors, not HTML, for unknown routes', async () => {
    const cookie = await loginCookie(ctx);
    const res = await request(ctx.app).get('/api/nope').set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});
