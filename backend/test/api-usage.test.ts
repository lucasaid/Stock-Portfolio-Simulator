import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('usage API', () => {
  it('requires auth', async () => {
    const ctx = createTestApp();
    expect((await request(ctx.app).get('/api/usage')).status).toBe(401);
  });

  it('returns the cached snapshot, thresholds, and gated booleans', async () => {
    const ctx: TestCtx = createTestApp();
    const cookie = await loginCookie(ctx);

    const res = await request(ctx.app).get('/api/usage').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      sessionThresholdPct: 80,
      weeklyThresholdPct: 90,
      sessionGated: false,
      weeklyGated: false,
    });
    expect(res.body.snapshot).toEqual({
      sessionPct: null, sessionResetsAt: null, weeklyPct: null, weeklyResetsAt: null,
    });
  });
});
