import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import { requireSession, type LoginRateLimiter } from './middleware.js';

export function authRoutes(auth: AuthService, limiter: LoginRateLimiter, cookieSecure = false): Router {
  const router = Router();
  // `secure` is opt-in: setting it unconditionally would break plain-HTTP local dev,
  // where the browser silently drops the cookie.
  const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/', secure: cookieSecure } as const;

  router.post('/api/auth/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (!limiter.check(ip)) {
      res.status(429).json({ error: 'too many failed logins; try again later' });
      return;
    }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: 'username and password required' });
      return;
    }
    const userId = await auth.verifyLogin(username, password);
    if (userId === null) {
      limiter.recordFailure(ip);
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    limiter.reset(ip);
    const { token, expiresAt } = auth.createSession(userId);
    res.cookie('session', token, { ...COOKIE_OPTS, expires: new Date(expiresAt) });
    res.json({ ok: true });
  });

  router.post('/api/auth/logout', requireSession(auth), (req, res) => {
    auth.deleteSession((req.cookies as Record<string, string>).session);
    res.clearCookie('session', COOKIE_OPTS);
    res.json({ ok: true });
  });

  router.get('/api/auth/me', requireSession(auth), (_req, res) => {
    res.json({ username: auth.username(res.locals.userId as number) });
  });

  router.post('/api/auth/password', requireSession(auth), async (req, res) => {
    const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
    if (!current || !next) {
      res.status(400).json({ error: 'current and next required' });
      return;
    }
    try {
      await auth.changePassword(res.locals.userId as number, current, next);
      res.json({ ok: true });
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
    }
  });

  return router;
}
