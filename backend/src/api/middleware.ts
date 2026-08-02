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

/** In-memory per-IP login rate limiter (spec §6.1). */
export function loginRateLimiter() {
  const fails = new Map<string, { count: number; lockedUntil: number }>();
  return {
    check(ip: string): boolean {
      const entry = fails.get(ip);
      return !entry || entry.lockedUntil <= Date.now();
    },
    recordFailure(ip: string): void {
      const entry = fails.get(ip) ?? { count: 0, lockedUntil: 0 };
      entry.count += 1;
      if (entry.count >= MAX_FAILS) entry.lockedUntil = Date.now() + LOCKOUT_MS;
      fails.set(ip, entry);
    },
    reset(ip: string): void {
      fails.delete(ip);
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
