import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loginRateLimiter } from '../src/api/middleware.js';
import { createTestApp, type TestCtx } from './api-helper.js';

describe('deployment hardening', () => {
  let ctx: TestCtx;

  beforeEach(async () => {
    ctx = createTestApp();
    await ctx.auth.createUser('chris', 'hunter22');
  });

  it('omits the secure cookie flag by default', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'chris', password: 'hunter22' });
    expect(res.headers['set-cookie']![0]).not.toContain('Secure');
  });

  it('sets the secure cookie flag when configured for TLS', async () => {
    const tls = createTestApp({ cookieSecure: true });
    await tls.auth.createUser('chris', 'hunter22');
    const res = await request(tls.app).post('/api/auth/login').send({ username: 'chris', password: 'hunter22' });
    expect(res.headers['set-cookie']![0]).toContain('Secure');
  });

  it('prunes expired rate-limiter entries instead of growing forever', () => {
    vi.useFakeTimers();
    try {
      const limiter = loginRateLimiter();
      for (let i = 0; i < 10; i++) limiter.recordFailure(`10.0.0.${i}`);
      expect(limiter.size()).toBe(10);
      vi.advanceTimersByTime(31 * 60 * 1000);
      limiter.check('10.0.0.1');
      expect(limiter.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still locks out a bucket that is being actively hammered', () => {
    const limiter = loginRateLimiter();
    for (let i = 0; i < 5; i++) limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1')).toBe(false);
    expect(limiter.check('10.0.0.2')).toBe(true);
  });
});
