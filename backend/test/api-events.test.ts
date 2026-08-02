import { createServer } from 'node:http';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { logEvent } from '../src/db/events.js';
import { recentEvents } from '../src/api/events-routes.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('events API', () => {
  let ctx: TestCtx;
  let cookie: string;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get('/api/events')).status).toBe(401);
  });

  it('returns events after a cursor', () => {
    logEvent(ctx.db, 'info', 'a', 'first');
    logEvent(ctx.db, 'info', 'b', 'second');
    const all = recentEvents(ctx.db, 0);
    expect(all).toHaveLength(2);
    const afterFirst = recentEvents(ctx.db, all[0]!.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.kind).toBe('b');
  });

  it('filters by round', () => {
    logEvent(ctx.db, 'info', 'a', 'global');
    logEvent(ctx.db, 'info', 'b', 'round-scoped', 42);
    expect(recentEvents(ctx.db, 0, 42)).toHaveLength(1);
  });

  it('serves events over HTTP with cursor param', async () => {
    logEvent(ctx.db, 'info', 'a', 'first');
    const res = await request(ctx.app).get('/api/events?after=0').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].message).toBe('first');
  });

  it('streams SSE: correct headers and delivers a new event', async () => {
    logEvent(ctx.db, 'info', 'pre', 'existing'); // should NOT be replayed
    const server = createServer(ctx.app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const controller = new AbortController();
      const resPromise = fetch(`http://127.0.0.1:${port}/api/events/stream`, {
        headers: { cookie },
        signal: controller.signal,
      });
      const res = await resPromise;
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      // trigger an event after the stream is open
      logEvent(ctx.db, 'warn', 'stop_loss', 'sse test event', 7);
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 5000;
      while (!buffer.includes('sse test event') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      controller.abort();
      expect(buffer).toContain('data: ');
      expect(buffer).toContain('sse test event');
      expect(buffer).not.toContain('existing'); // no replay of pre-connection events
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
