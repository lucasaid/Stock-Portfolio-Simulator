import type { NextFunction, Request, Response } from 'express';
import type { AuthService } from '../auth/service.js';

/** Session guard. Attaches userId to res.locals. */
export function requireSession(auth: AuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = (req.cookies as Record<string, string> | undefined)?.session;
    const session = token ? auth.validateSession(token) : null;
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.locals.userId = session.userId;
    next();
  };
}

const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
/** Entries idle this long are dropped; without this the map grows unbounded. */
const ENTRY_TTL_MS = 30 * 60 * 1000;

/** In-memory per-IP login rate limiter (spec §6.1). */
export function loginRateLimiter() {
  const fails = new Map<string, { count: number; lockedUntil: number; touchedAt: number }>();

  function prune(now: number): void {
    for (const [ip, entry] of fails) {
      if (now - entry.touchedAt > ENTRY_TTL_MS) fails.delete(ip);
    }
  }

  return {
    check(ip: string): boolean {
      const now = Date.now();
      prune(now);
      const entry = fails.get(ip);
      return !entry || entry.lockedUntil <= now;
    },
    recordFailure(ip: string): void {
      const now = Date.now();
      const entry = fails.get(ip) ?? { count: 0, lockedUntil: 0, touchedAt: now };
      entry.count += 1;
      entry.touchedAt = now;
      if (entry.count >= MAX_FAILS) entry.lockedUntil = now + LOCKOUT_MS;
      fails.set(ip, entry);
    },
    reset(ip: string): void {
      fails.delete(ip);
    },
    size(): number {
      return fails.size;
    },
  };
}

export type LoginRateLimiter = ReturnType<typeof loginRateLimiter>;

/** JSON 404 + error handler, mounted last. */
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not found' });
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  res.status(500).json({ error: err.message });
}
