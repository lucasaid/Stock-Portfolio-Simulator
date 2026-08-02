import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('settings API', () => {
  let ctx: TestCtx;
  let cookie: string;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get('/api/settings')).status).toBe(401);
  });

  it('returns all namespaces with defaults', async () => {
    const res = await request(ctx.app).get('/api/settings').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.lookAndFeel).toEqual(DEFAULT_SETTINGS.lookAndFeel);
  });

  it('updates a namespace and persists it', async () => {
    const res = await request(ctx.app)
      .put('/api/settings/lookAndFeel')
      .set('Cookie', cookie)
      .send({ ...DEFAULT_SETTINGS.lookAndFeel, theme: 'dark' });
    expect(res.status).toBe(200);
    expect(ctx.settings.get('lookAndFeel').theme).toBe('dark');
  });

  it('rejects unknown namespaces', async () => {
    const res = await request(ctx.app).put('/api/settings/hacks').set('Cookie', cookie).send({});
    expect(res.status).toBe(400);
  });
});
