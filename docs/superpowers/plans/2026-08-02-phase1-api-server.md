# Phase 1 / Plan 2 — API Server Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the Plan-1 engine in an authenticated Express API: login/sessions, global settings, round CRUD + live config edits + manual controls/orders, event feed + SSE, ntfy notifications, and the runnable server entrypoint.

**Architecture:** `buildApp(deps)` returns a fully-wired Express app (no `listen`) so every route is testable with supertest against an in-memory SQLite DB. Services stay constructor-injected like Plan 1. The SSE stream and the ntfy dispatcher both tail the existing `event_log` table (id cursor) rather than hooking engine internals — Plan-1 code is only modified once (trade events). `src/index.ts` is the only file that touches the network/filesystem environment.

**Tech Stack:** express 5, cookie-parser, argon2, supertest (dev). Everything else is already installed.

**Spec:** `docs/superpowers/specs/2026-08-02-trading-agent-design.md` §5 (manual control), §6 (dashboard API needs), §6.1 (settings & auth), §7 (errors), §8 (ntfy). Plan 1 (engine) is merged on `master`; 81 tests green.

---

## File Structure

```
backend/src/
  settings/store.ts        # SettingsStore: typed namespaced settings over the settings table, defaults + shallow merge
  auth/service.ts          # AuthService: single-user creation, argon2 verify, session lifecycle, password change
  api/
    middleware.ts          # requireSession, login rate limiter, JSON error handler
    auth-routes.ts         # POST /api/auth/login|logout, GET /api/auth/me, POST /api/auth/password
    settings-routes.ts     # GET/PUT /api/settings
    rounds-routes.ts       # GET/POST /api/rounds, GET /api/rounds/:id(+/ledger|trades|equity), PATCH config, status actions, kill, orders
    events-routes.ts       # GET /api/events (cursor), GET /api/events/stream (SSE tail)
    app.ts                 # buildApp(deps): mounts everything
  notify/ntfy.ts           # NtfyNotifier (injected fetch) + NotificationDispatcher (event_log tail → ntfy)
  cli.ts                   # create-user / status commands
  index.ts                 # env, wiring, graceful shutdown (not unit tested)
backend/src/rounds/service.ts   # MODIFY: log 'trade' events on fills
backend/test/
  api-helper.ts            # createTestApp(): app + services on :memory: db; loginAgent()
  settings-store.test.ts  auth-service.test.ts  api-auth.test.ts  api-settings.test.ts
  trade-events.test.ts  api-rounds.test.ts  api-controls.test.ts  api-orders.test.ts
  api-events.test.ts  ntfy.test.ts
```

Run all commands from `backend/` unless noted. All work on a new branch: from repo root, `git checkout -b feature/api-server` before Task 1.

---

### Task 1: Dependencies + SettingsStore

**Files:**
- Create: `backend/src/settings/store.ts`
- Test: `backend/test/settings-store.test.ts`

- [ ] **Step 1: Install dependencies**

```bash
npm install express cookie-parser argon2
npm install -D supertest @types/express @types/cookie-parser @types/supertest
```
Expected: exit 0. (argon2 compiles a native module; takes ~30s.)

- [ ] **Step 2: Write the failing test** — `backend/test/settings-store.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings/store.js';

describe('SettingsStore', () => {
  let db: DB;
  let store: SettingsStore;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    store = new SettingsStore(db);
  });

  it('returns defaults when nothing is stored', () => {
    expect(store.get('roundDefaults')).toEqual(DEFAULT_SETTINGS.roundDefaults);
    expect(store.get('lookAndFeel').theme).toBe('system');
  });

  it('persists and merges stored values over defaults', () => {
    store.set('lookAndFeel', { ...store.get('lookAndFeel'), theme: 'dark' });
    const laf = store.get('lookAndFeel');
    expect(laf.theme).toBe('dark');
    expect(laf.timezone).toBe(DEFAULT_SETTINGS.lookAndFeel.timezone); // untouched keys keep defaults
  });

  it('round defaults are usable to build a RoundConfig', () => {
    const d = store.get('roundDefaults');
    expect(d.startingBalanceCents).toBeGreaterThan(0);
    expect(d.guardrails).toHaveProperty('stopLossPct');
  });

  it('returns all settings namespaces', () => {
    const all = store.all();
    expect(Object.keys(all).sort()).toEqual(['integrations', 'lookAndFeel', 'notifications', 'roundDefaults']);
  });

  it('does not let mutation of a returned object corrupt defaults', () => {
    const d = store.get('roundDefaults');
    d.watchlist.push('HACK');
    expect(store.get('roundDefaults').watchlist).not.toContain('HACK');
  });
});
```

- [ ] **Step 3: Run to verify FAIL:** `npm test -- settings-store` → cannot find module.

- [ ] **Step 4: Create `backend/src/settings/store.ts`**

```ts
import type { DB } from '../db/connection.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, type RoundConfig } from '../engine/types.js';

export interface NtfySettings {
  url: string;
  topic: string;
  enabled: boolean;
}

export interface IntegrationSettings {
  ntfy: NtfySettings;
  pollIntervalMinutes: number;
}

export interface LookAndFeelSettings {
  theme: 'light' | 'dark' | 'system';
  accent: string;
  chartStyle: 'line' | 'candles';
  timezone: string;
}

/** Per-event-kind on/off switches for ntfy (spec §8). */
export type NotificationToggles = Record<string, boolean>;

export interface Settings {
  roundDefaults: Omit<RoundConfig, 'name'>;
  integrations: IntegrationSettings;
  lookAndFeel: LookAndFeelSettings;
  notifications: NotificationToggles;
}

export const DEFAULT_SETTINGS: Settings = {
  roundDefaults: {
    startingBalanceCents: 5_000,
    profitGoalCents: 100_000,
    markets: ['US'],
    watchlist: ['AAPL', 'MSFT'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS,
    fees: DEFAULT_FEES,
    model: 'claude-sonnet-5',
    checkinCron: ['30 23 * * 1-5'], // ~US open, AEST evening
  },
  integrations: {
    ntfy: { url: 'https://ntfy.sh', topic: '', enabled: false },
    pollIntervalMinutes: 5,
  },
  lookAndFeel: {
    theme: 'system',
    accent: '#6E56CF',
    chartStyle: 'line',
    timezone: 'Australia/Sydney',
  },
  notifications: {
    trade: true,
    skim: true,
    goal: true,
    stop_loss: true,
    drawdown: true,
    busted: true,
    error: true,
  },
};

export class SettingsStore {
  constructor(private db: DB) {}

  get<K extends keyof Settings>(key: K): Settings[K] {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    const defaults = structuredClone(DEFAULT_SETTINGS[key]);
    if (!row) return defaults;
    return { ...defaults, ...(JSON.parse(row.value_json) as Partial<Settings[K]>) };
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  all(): Settings {
    return {
      roundDefaults: this.get('roundDefaults'),
      integrations: this.get('integrations'),
      lookAndFeel: this.get('lookAndFeel'),
      notifications: this.get('notifications'),
    };
  }
}
```

- [ ] **Step 5: Verify PASS:** `npm test -- settings-store` → 5 tests. Full suite → 86.

- [ ] **Step 6: Commit** (repo root)

```bash
git add backend/package.json backend/package-lock.json backend/src/settings backend/test/settings-store.test.ts
git commit -m "feat: settings store with typed namespaces and defaults"
```

---

### Task 2: AuthService

**Files:**
- Create: `backend/src/auth/service.ts`
- Test: `backend/test/auth-service.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/auth-service.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';

describe('AuthService', () => {
  let db: DB;
  let auth: AuthService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    auth = new AuthService(db);
  });

  it('creates a user with an argon2 hash and reports hasUsers', async () => {
    expect(auth.hasUsers()).toBe(false);
    await auth.createUser('chris', 'hunter22');
    expect(auth.hasUsers()).toBe(true);
    const row = db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(row.password_hash).toMatch(/^\$argon2/);
  });

  it('enforces single-user (spec §6.1)', async () => {
    await auth.createUser('chris', 'hunter22');
    await expect(auth.createUser('mallory', 'x')).rejects.toThrow(/single user/);
  });

  it('verifies logins', async () => {
    await auth.createUser('chris', 'hunter22');
    expect(await auth.verifyLogin('chris', 'hunter22')).toEqual(expect.any(Number));
    expect(await auth.verifyLogin('chris', 'wrong')).toBeNull();
    expect(await auth.verifyLogin('nobody', 'hunter22')).toBeNull();
  });

  it('creates, validates, and deletes sessions', async () => {
    const userId = (await auth.createUser('chris', 'hunter22'))!;
    const { token } = auth.createSession(userId);
    expect(auth.validateSession(token)).toEqual({ userId });
    auth.deleteSession(token);
    expect(auth.validateSession(token)).toBeNull();
  });

  it('rejects expired sessions and cleans them up', async () => {
    const userId = (await auth.createUser('chris', 'hunter22'))!;
    const { token } = auth.createSession(userId, -1000); // already expired
    expect(auth.validateSession(token)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
  });

  it('changes password only with the correct current password', async () => {
    const userId = (await auth.createUser('chris', 'hunter22'))!;
    await expect(auth.changePassword(userId, 'wrong', 'newpass')).rejects.toThrow(/current password/);
    await auth.changePassword(userId, 'hunter22', 'newpass');
    expect(await auth.verifyLogin('chris', 'newpass')).toBe(userId);
    expect(await auth.verifyLogin('chris', 'hunter22')).toBeNull();
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- auth-service`.

- [ ] **Step 3: Create `backend/src/auth/service.ts`**

```ts
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { DB } from '../db/connection.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class AuthService {
  constructor(private db: DB) {}

  hasUsers(): boolean {
    const { c } = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return c > 0;
  }

  async createUser(username: string, password: string): Promise<number> {
    if (this.hasUsers()) throw new Error('single user only: a user already exists');
    const hash = await argon2.hash(password);
    const r = this.db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, hash, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  async verifyLogin(username: string, password: string): Promise<number | null> {
    const row = this.db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username) as
      | { id: number; password_hash: string }
      | undefined;
    if (!row) return null;
    return (await argon2.verify(row.password_hash, password)) ? row.id : null;
  }

  createSession(userId: number, ttlMs: number = SESSION_TTL_MS): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db
      .prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, expiresAt, new Date().toISOString());
    return { token, expiresAt };
  }

  validateSession(token: string): { userId: number } | null {
    const row = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token) as
      | { user_id: number; expires_at: string }
      | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.deleteSession(token);
      return null;
    }
    return { userId: row.user_id };
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  async changePassword(userId: number, current: string, next: string): Promise<void> {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
      | { password_hash: string }
      | undefined;
    if (!row || !(await argon2.verify(row.password_hash, current))) {
      throw new Error('current password is incorrect');
    }
    const hash = await argon2.hash(next);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // force re-login everywhere
  }
}
```

- [ ] **Step 4: Verify PASS:** `npm test -- auth-service` → 6 tests. Full suite → 92.

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth backend/test/auth-service.test.ts
git commit -m "feat: auth service - argon2 single user, sessions, password change"
```

---

### Task 3: App skeleton, middleware, auth routes

**Files:**
- Create: `backend/src/api/middleware.ts`, `backend/src/api/auth-routes.ts`, `backend/src/api/app.ts`
- Create: `backend/test/api-helper.ts`
- Test: `backend/test/api-auth.test.ts`

- [ ] **Step 1: Create the shared test helper** — `backend/test/api-helper.ts`

```ts
import type { Express } from 'express';
import request from 'supertest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/api/app.js';
import { AuthService } from '../src/auth/service.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { RoundService } from '../src/rounds/service.js';
import { SettingsStore } from '../src/settings/store.js';

export interface TestCtx {
  app: Express;
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
  prices: Record<string, { price: number; currency: string }>;
}

export function createTestApp(): TestCtx {
  const db = openDb(':memory:');
  migrate(db);
  const prices: Record<string, { price: number; currency: string }> = {
    'AAPL': { price: 10, currency: 'USD' },
    'AUDUSD=X': { price: 1, currency: 'USD' },
  };
  const fetcher: QuoteFetcher = async (symbols) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };
  const auth = new AuthService(db);
  const settings = new SettingsStore(db);
  const rounds = new RoundService(db, new PaperBroker(db));
  const market = new MarketDataService(db, fetcher);
  const app = buildApp({ db, auth, settings, rounds, market });
  return { app, db, auth, settings, rounds, market, prices };
}

/** Registers the single user and returns a session cookie for authed requests. */
export async function loginCookie(ctx: TestCtx, username = 'chris', password = 'hunter22'): Promise<string> {
  await ctx.auth.createUser(username, password);
  const res = await request(ctx.app).post('/api/auth/login').send({ username, password });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}
```

- [ ] **Step 2: Write the failing test** — `backend/test/api-auth.test.ts`

```ts
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
```

- [ ] **Step 3: Verify FAIL:** `npm test -- api-auth` → cannot find module app.js.

- [ ] **Step 4: Create `backend/src/api/middleware.ts`**

```ts
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
```

- [ ] **Step 5: Create `backend/src/api/auth-routes.ts`**

```ts
import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import { requireSession, type LoginRateLimiter } from './middleware.js';

const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/' } as const;

export function authRoutes(auth: AuthService, limiter: LoginRateLimiter): Router {
  const router = Router();

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
    res.json({ username: 'chris' }); // placeholder replaced in Step 6 below — see note
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
```

NOTE on `/api/auth/me`: do NOT ship the placeholder. Implement it properly by adding this method to `AuthService` (in `backend/src/auth/service.ts`) as part of this task:

```ts
  username(userId: number): string | null {
    const row = this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as
      | { username: string }
      | undefined;
    return row?.username ?? null;
  }
```

and the route becomes:

```ts
  router.get('/api/auth/me', requireSession(auth), (_req, res) => {
    res.json({ username: auth.username(res.locals.userId as number) });
  });
```

- [ ] **Step 6: Create `backend/src/api/app.ts`**

```ts
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import type { MarketDataService } from '../market/data.js';
import type { RoundService } from '../rounds/service.js';
import type { SettingsStore } from '../settings/store.js';
import { authRoutes } from './auth-routes.js';
import { errorHandler, loginRateLimiter, notFound } from './middleware.js';

export interface ApiDeps {
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
}

export function buildApp(deps: ApiDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(authRoutes(deps.auth, loginRateLimiter()));
  // settings/rounds/events routes mounted here in later tasks

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 7: Verify PASS:** `npm test -- api-auth` → 8 tests. Full suite → 100. `npx tsc --noEmit` clean.

- [ ] **Step 8: Commit**

```bash
git add backend/src/api backend/src/auth backend/test/api-helper.ts backend/test/api-auth.test.ts
git commit -m "feat: express app skeleton with session auth and rate limiting"
```

---

### Task 4: Settings routes

**Files:**
- Create: `backend/src/api/settings-routes.ts`
- Modify: `backend/src/api/app.ts` (mount)
- Test: `backend/test/api-settings.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/api-settings.test.ts`

```ts
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
```

- [ ] **Step 2: Verify FAIL:** `npm test -- api-settings` → 404s where 200 expected.

- [ ] **Step 3: Create `backend/src/api/settings-routes.ts`**

```ts
import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { Settings, SettingsStore } from '../settings/store.js';
import { requireSession } from './middleware.js';

const NAMESPACES: (keyof Settings)[] = ['roundDefaults', 'integrations', 'lookAndFeel', 'notifications'];

export function settingsRoutes(settings: SettingsStore, auth: AuthService): Router {
  const router = Router();
  router.use('/api/settings', requireSession(auth));

  router.get('/api/settings', (_req, res) => {
    res.json(settings.all());
  });

  router.put('/api/settings/:namespace', (req, res) => {
    const ns = req.params.namespace as keyof Settings;
    if (!NAMESPACES.includes(ns)) {
      res.status(400).json({ error: `unknown namespace: ${String(ns)}` });
      return;
    }
    settings.set(ns, req.body as Settings[typeof ns]);
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Mount in `backend/src/api/app.ts`** — add import and, after the authRoutes line:

```ts
import { settingsRoutes } from './settings-routes.js';
// ...
  app.use(settingsRoutes(deps.settings, deps.auth));
```

- [ ] **Step 5: Verify PASS:** `npm test -- api-settings` → 4 tests. Full suite → 104.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api backend/test/api-settings.test.ts
git commit -m "feat: settings API routes"
```

---

### Task 5: Trade events in RoundService

**Files:**
- Modify: `backend/src/rounds/service.ts` (buy/sell fill paths)
- Test: `backend/test/trade-events.test.ts`

The notifier (Task 9) and SSE feed tail `event_log`; fills currently log nothing. Add one info event per fill.

- [ ] **Step 1: Write the failing test** — `backend/test/trade-events.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/broker/types.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { RoundService } from '../src/rounds/service.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function q(price: number): Quote {
  return { symbol: 'AAPL', market: 'US', price, currency: 'USD', ts: new Date().toISOString(), stale: false };
}

describe('trade events', () => {
  let db: DB;
  let rounds: RoundService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
  });

  it('logs one trade event per fill with side, symbol, and quantity', () => {
    const config: RoundConfig = {
      name: 't', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
      watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
      guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
      model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'],
    };
    const id = rounds.create(config);
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    rounds.sell(id, 'AAPL', 'all', q(20), 1, 'agent');
    const events = db
      .prepare("SELECT message FROM event_log WHERE kind = 'trade' AND round_id = ? ORDER BY id")
      .all(id) as { message: string }[];
    expect(events).toHaveLength(2);
    expect(events[0]!.message).toMatch(/buy 2.* AAPL/);
    expect(events[1]!.message).toMatch(/sell 2.* AAPL/);
  });

  it('does not log trade events for rejected orders', () => {
    const config: RoundConfig = {
      name: 't', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
      watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
      guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
      model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'],
    };
    const id = rounds.create(config);
    rounds.setStatus(id, 'paused', 'test');
    rounds.buy(id, 'AAPL', 'US', cents(10), q(10), 1, 'agent');
    expect(db.prepare("SELECT COUNT(*) AS c FROM event_log WHERE kind = 'trade'").get()).toEqual({ c: 0 });
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- trade-events` → 0 events found.

- [ ] **Step 3: Modify `backend/src/rounds/service.ts`** — inside the buy() transaction after the ledger/fee writes (before returning the filled result), add:

```ts
      logEvent(this.db, 'info', 'trade', `round ${roundId} buy ${fill.quantity} ${symbol} @ ${fill.priceAud.toFixed(4)} AUD`, roundId);
```

and inside the sell() transaction after its ledger/skim writes:

```ts
      logEvent(this.db, 'info', 'trade', `round ${roundId} sell ${fill.quantity} ${symbol} @ ${fill.priceAud.toFixed(4)} AUD`, roundId);
```

(`logEvent` is already imported in this file. Placement inside the transaction keeps the event atomic with the fill.)

- [ ] **Step 4: Verify PASS:** `npm test -- trade-events` → 2 tests. Full suite → 106 (no existing test asserts event counts that would break; if one does, STOP and report).

- [ ] **Step 5: Commit**

```bash
git add backend/src/rounds/service.ts backend/test/trade-events.test.ts
git commit -m "feat: log trade events on fills for SSE and notifications"
```

---

### Task 6: Rounds routes — list, create, detail, data

**Files:**
- Create: `backend/src/api/rounds-routes.ts`
- Modify: `backend/src/api/app.ts` (mount)
- Test: `backend/test/api-rounds.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/api-rounds.test.ts`

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('rounds API', () => {
  let ctx: TestCtx;
  let cookie: string;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get('/api/rounds')).status).toBe(401);
  });

  it('creates a round from defaults with overrides', async () => {
    const res = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'first run', startingBalanceCents: cents(50), profitGoalCents: cents(1000) });
    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(Number));
    const round = ctx.rounds.get(res.body.id);
    expect(round.starting_balance_cents).toBe(cents(50));
    expect(round.status).toBe('active');
    // unspecified fields came from settings defaults
    expect(ctx.rounds.config(res.body.id).tradingStyle).toBe('swing');
  });

  it('rejects invalid create payloads', async () => {
    expect((await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({})).status).toBe(400);
    expect(
      (await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'x', startingBalanceCents: -5 }))
        .status,
    ).toBe(400);
  });

  it('lists rounds with pocketed totals', async () => {
    await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r1' });
    const res = await request(ctx.app).get('/api/rounds').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ name: 'r1', status: 'active', totalSkimsCents: 0 });
  });

  it('returns round detail with config, positions and totals', async () => {
    const create = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'r1', startingBalanceCents: cents(50) });
    const id = create.body.id as number;
    const quotes = await ctx.market.poll(['AAPL']);
    ctx.rounds.buy(id, 'AAPL', 'US', cents(20), quotes.get('AAPL')!, 1, 'operator');
    const res = await request(ctx.app).get(`/api/rounds/${id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.round.cash_cents).toBe(cents(30));
    expect(res.body.config.name).toBe('r1');
    expect(res.body.positions).toHaveLength(1);
    expect(res.body.totalSkimsCents).toBe(0);
  });

  it('serves ledger, trades and equity history', async () => {
    const create = await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r1' });
    const id = create.body.id as number;
    ctx.rounds.recordEquity(id, new Map());
    const ledger = await request(ctx.app).get(`/api/rounds/${id}/ledger`).set('Cookie', cookie);
    expect(ledger.body[0].type).toBe('deposit');
    const equity = await request(ctx.app).get(`/api/rounds/${id}/equity`).set('Cookie', cookie);
    expect(equity.body).toHaveLength(1);
    const trades = await request(ctx.app).get(`/api/rounds/${id}/trades`).set('Cookie', cookie);
    expect(trades.body).toEqual([]);
  });

  it('404s for unknown rounds', async () => {
    expect((await request(ctx.app).get('/api/rounds/999').set('Cookie', cookie)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- api-rounds`.

- [ ] **Step 3: Create `backend/src/api/rounds-routes.ts`** (this task implements list/create/detail/data; Task 7 appends controls to this same file)

```ts
import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import type { RoundConfig } from '../engine/types.js';
import type { MarketDataService } from '../market/data.js';
import type { RoundService } from '../rounds/service.js';
import type { SettingsStore } from '../settings/store.js';
import { requireSession } from './middleware.js';

export interface RoundsDeps {
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
}

/** Fields callers may set at create time (everything except computed state). */
const CREATE_KEYS: (keyof RoundConfig)[] = [
  'name', 'startingBalanceCents', 'profitGoalCents', 'markets', 'watchlist',
  'riskProfile', 'tradingStyle', 'guardrails', 'fees', 'model', 'checkinCron',
];

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export function roundsRoutes(deps: RoundsDeps): Router {
  const { db, auth, settings, rounds } = deps;
  const router = Router();
  router.use('/api/rounds', requireSession(auth));

  router.get('/api/rounds', (_req, res) => {
    const rows = db.prepare('SELECT id, name, status, starting_balance_cents, cash_cents, profit_goal_cents FROM rounds ORDER BY id DESC').all() as {
      id: number;
    }[];
    res.json(rows.map((r) => ({ ...r, totalSkimsCents: rounds.totalSkimsCents(r.id) })));
  });

  router.post('/api/rounds', (req, res) => {
    const body = (req.body ?? {}) as Partial<RoundConfig>;
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const overrides: Partial<RoundConfig> = {};
    for (const key of CREATE_KEYS) {
      if (body[key] !== undefined) (overrides as Record<string, unknown>)[key] = body[key];
    }
    const config: RoundConfig = { ...settings.get('roundDefaults'), ...overrides, name: body.name.trim() };
    if (!isPositiveInt(config.startingBalanceCents) || !isPositiveInt(config.profitGoalCents)) {
      res.status(400).json({ error: 'startingBalanceCents and profitGoalCents must be positive integers' });
      return;
    }
    if (!Array.isArray(config.markets) || config.markets.some((m) => m !== 'ASX' && m !== 'US')) {
      res.status(400).json({ error: 'markets must be ASX and/or US' });
      return;
    }
    const id = rounds.create(config);
    res.status(201).json({ id });
  });

  /** Loads the round or 404s. Returns null after responding. */
  function loadRound(idParam: string, res: import('express').Response): number | null {
    const id = Number(idParam);
    const exists = db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id);
    if (!exists) {
      res.status(404).json({ error: 'round not found' });
      return null;
    }
    return id;
  }

  router.get('/api/rounds/:id', (req, res) => {
    const id = loadRound(req.params.id, res);
    if (id === null) return;
    res.json({
      round: rounds.get(id),
      config: rounds.config(id),
      positions: rounds.openPositions(id),
      totalSkimsCents: rounds.totalSkimsCents(id),
    });
  });

  const DATA_QUERIES: Record<string, string> = {
    ledger: 'SELECT * FROM ledger_entries WHERE round_id = ? ORDER BY id DESC LIMIT 500',
    trades: 'SELECT * FROM trades WHERE round_id = ? ORDER BY id DESC LIMIT 500',
    equity: 'SELECT * FROM equity_snapshots WHERE round_id = ? ORDER BY id DESC LIMIT 2000',
  };

  for (const [name, sql] of Object.entries(DATA_QUERIES)) {
    router.get(`/api/rounds/:id/${name}`, (req, res) => {
      const id = loadRound(req.params.id, res);
      if (id === null) return;
      res.json(db.prepare(sql).all(id));
    });
  }

  return router;
}
```

- [ ] **Step 4: Mount in `backend/src/api/app.ts`**:

```ts
import { roundsRoutes } from './rounds-routes.js';
// after settingsRoutes:
  app.use(roundsRoutes(deps));
```

- [ ] **Step 5: Verify PASS:** `npm test -- api-rounds` → 7 tests. Full suite → 113. `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api backend/test/api-rounds.test.ts
git commit -m "feat: rounds API - create from defaults, list, detail, history data"
```

---

### Task 7: Controls — status actions, kill switch, live config PATCH

**Files:**
- Modify: `backend/src/api/rounds-routes.ts` (append routes before `return router;`)
- Test: `backend/test/api-controls.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/api-controls.test.ts`

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('round controls API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let id: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const res = await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r1' });
    id = res.body.id as number;
  });

  const act = (action: string, roundId = id) =>
    request(ctx.app).post(`/api/rounds/${roundId}/status`).set('Cookie', cookie).send({ action });

  it('pause → resume round-trips', async () => {
    expect((await act('pause')).status).toBe(200);
    expect(ctx.rounds.get(id).status).toBe('paused');
    expect((await act('resume')).status).toBe(200);
    expect(ctx.rounds.get(id).status).toBe('active');
  });

  it('takeover → release round-trips', async () => {
    expect((await act('takeover')).status).toBe(200);
    expect(ctx.rounds.get(id).status).toBe('takeover');
    expect((await act('release')).status).toBe(200);
    expect(ctx.rounds.get(id).status).toBe('active');
  });

  it('rejects invalid transitions with 409', async () => {
    expect((await act('release')).status).toBe(409); // not in takeover
    expect((await act('archive')).status).toBe(409); // active can't archive
  });

  it('rejects unknown actions with 400', async () => {
    expect((await act('explode')).status).toBe(400);
  });

  it('kill switch pauses every non-terminal round', async () => {
    const r2 = (await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r2' })).body.id as number;
    const res = await request(ctx.app).post('/api/kill').set('Cookie', cookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(2);
    expect(ctx.rounds.get(id).status).toBe('paused');
    expect(ctx.rounds.get(r2).status).toBe('paused');
  });

  it('PATCHes config live, records config events, and blocks startingBalanceCents', async () => {
    const res = await request(ctx.app)
      .patch(`/api/rounds/${id}/config`)
      .set('Cookie', cookie)
      .send({ tradingStyle: 'day', riskProfile: 'aggressive' });
    expect(res.status).toBe(200);
    const cfg = ctx.rounds.config(id);
    expect(cfg.tradingStyle).toBe('day');
    expect(cfg.riskProfile).toBe('aggressive');
    const events = ctx.db
      .prepare('SELECT field, old_value, new_value FROM config_events WHERE round_id = ? ORDER BY id')
      .all(id) as { field: string; old_value: string; new_value: string }[];
    expect(events.map((e) => e.field).sort()).toEqual(['riskProfile', 'tradingStyle']);
    expect(events.find((e) => e.field === 'tradingStyle')).toMatchObject({
      old_value: '"swing"',
      new_value: '"day"',
    });

    const blocked = await request(ctx.app)
      .patch(`/api/rounds/${id}/config`)
      .set('Cookie', cookie)
      .send({ startingBalanceCents: cents(500) });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/startingBalanceCents/);
  });

  it('PATCHing profitGoalCents also updates the denormalized column', async () => {
    await request(ctx.app).patch(`/api/rounds/${id}/config`).set('Cookie', cookie).send({ profitGoalCents: cents(20) });
    expect(ctx.rounds.get(id).profit_goal_cents).toBe(cents(20));
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- api-controls`.

- [ ] **Step 3: Append to `backend/src/api/rounds-routes.ts`** (before `return router;`; add `logEvent` import from `../db/events.js` and `RoundStatus` type import from `../rounds/service.js`)

```ts
  const TRANSITIONS: Record<string, { from: RoundStatus[]; to: RoundStatus }> = {
    pause: { from: ['active', 'takeover'], to: 'paused' },
    resume: { from: ['paused', 'takeover'], to: 'active' },
    takeover: { from: ['active', 'paused'], to: 'takeover' },
    release: { from: ['takeover'], to: 'active' },
    archive: { from: ['paused', 'goal_reached', 'busted'], to: 'archived' },
  };

  router.post('/api/rounds/:id/status', (req, res) => {
    const id = loadRound(req.params.id, res);
    if (id === null) return;
    const action = (req.body as { action?: string } | undefined)?.action ?? '';
    const transition = TRANSITIONS[action];
    if (!transition) {
      res.status(400).json({ error: `unknown action: ${action}` });
      return;
    }
    const current = rounds.get(id).status;
    if (!transition.from.includes(current)) {
      res.status(409).json({ error: `cannot ${action} a ${current} round` });
      return;
    }
    rounds.setStatus(id, transition.to, `operator ${action}`);
    res.json({ status: transition.to });
  });

  router.post('/api/kill', requireSession(auth), (_req, res) => {
    const ids = db.prepare(`SELECT id FROM rounds WHERE status IN ('active', 'takeover')`).all() as { id: number }[];
    for (const { id } of ids) rounds.setStatus(id, 'paused', 'kill switch');
    logEvent(db, 'warn', 'kill_switch', `kill switch: paused ${ids.length} rounds`);
    res.json({ paused: ids.length });
  });

  /** Live config edit (spec §2.6). startingBalanceCents is immutable mid-round: it is the skim baseline. */
  const PATCHABLE: (keyof RoundConfig)[] = [
    'name', 'profitGoalCents', 'markets', 'watchlist', 'riskProfile',
    'tradingStyle', 'guardrails', 'fees', 'model', 'checkinCron',
  ];

  router.patch('/api/rounds/:id/config', (req, res) => {
    const id = loadRound(req.params.id, res);
    if (id === null) return;
    const body = (req.body ?? {}) as Partial<RoundConfig>;
    if (body.startingBalanceCents !== undefined) {
      res.status(400).json({ error: 'startingBalanceCents cannot change mid-round (skim baseline); chain a new round instead' });
      return;
    }
    const current = rounds.config(id);
    const next = { ...current };
    const now = new Date().toISOString();
    const insertEvent = db.prepare(
      'INSERT INTO config_events (round_id, changed_by, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    let changed = 0;
    for (const key of PATCHABLE) {
      if (body[key] === undefined) continue;
      const oldJson = JSON.stringify(current[key]);
      const newJson = JSON.stringify(body[key]);
      if (oldJson === newJson) continue;
      (next as Record<string, unknown>)[key] = body[key];
      insertEvent.run(id, 'operator', key, oldJson, newJson, now);
      changed += 1;
    }
    if (changed === 0) {
      res.json({ changed: 0 });
      return;
    }
    db.prepare('UPDATE rounds SET config_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), now, id);
    if (body.profitGoalCents !== undefined) {
      db.prepare('UPDATE rounds SET profit_goal_cents = ? WHERE id = ?').run(body.profitGoalCents, id);
    }
    logEvent(db, 'info', 'config_change', `round ${id}: operator changed ${changed} config field(s)`, id);
    res.json({ changed });
  });
```

- [ ] **Step 4: Verify PASS:** `npm test -- api-controls` → 7 tests. Full suite → 120. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/rounds-routes.ts backend/test/api-controls.test.ts
git commit -m "feat: round controls - status actions, kill switch, live config patch"
```

---

### Task 8: Manual orders route

**Files:**
- Modify: `backend/src/api/rounds-routes.ts` (append before `return router;`)
- Test: `backend/test/api-orders.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/api-orders.test.ts`

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('manual orders API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let id: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const res = await request(ctx.app)
      .post('/api/rounds')
      .set('Cookie', cookie)
      .send({ name: 'r1', startingBalanceCents: cents(50) });
    id = res.body.id as number;
  });

  const order = (body: object) =>
    request(ctx.app).post(`/api/rounds/${id}/orders`).set('Cookie', cookie).send(body);

  it('places an operator buy at a fresh quote', async () => {
    const res = await order({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('filled');
    expect(ctx.rounds.get(id).cash_cents).toBe(cents(30));
  });

  it('sells all and reports the skim', async () => {
    await order({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    ctx.prices['AAPL'] = { price: 20, currency: 'USD' };
    const res = await order({ symbol: 'AAPL', side: 'sell', quantity: 'all' });
    expect(res.status).toBe(201);
    expect(res.body.skimCents).toBe(cents(20));
  });

  it('operator can trade while paused (takeover semantics)', async () => {
    await request(ctx.app).post(`/api/rounds/${id}/status`).set('Cookie', cookie).send({ action: 'pause' });
    const res = await order({ symbol: 'AAPL', side: 'buy', amountCents: cents(10) });
    expect(res.status).toBe(201);
  });

  it('409s with the rejection reason when the engine rejects', async () => {
    const res = await order({ symbol: 'AAPL', side: 'sell', quantity: 'all' }); // nothing held
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no open position/);
  });

  it('422s when no quote is available', async () => {
    const res = await order({ symbol: 'GHOST', side: 'buy', amountCents: cents(10) });
    expect(res.status).toBe(422);
  });

  it('400s on malformed bodies', async () => {
    expect((await order({ side: 'buy' })).status).toBe(400);
    expect((await order({ symbol: 'AAPL', side: 'hold' })).status).toBe(400);
    expect((await order({ symbol: 'AAPL', side: 'buy' })).status).toBe(400); // no amount
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- api-orders`.

- [ ] **Step 3: Append to `backend/src/api/rounds-routes.ts`** (uses `deps.market`; add `marketForSymbol` import from `../market/data.js`)

```ts
  router.post('/api/rounds/:id/orders', async (req, res) => {
    const id = loadRound(req.params.id, res);
    if (id === null) return;
    const body = (req.body ?? {}) as { symbol?: string; side?: string; amountCents?: number; quantity?: number | 'all' };
    const { symbol, side } = body;
    if (typeof symbol !== 'string' || symbol.trim() === '' || (side !== 'buy' && side !== 'sell')) {
      res.status(400).json({ error: 'symbol and side (buy|sell) required' });
      return;
    }
    if (side === 'buy' && !isPositiveInt(body.amountCents)) {
      res.status(400).json({ error: 'buys require amountCents (positive integer)' });
      return;
    }
    if (side === 'sell' && body.quantity !== 'all' && !(typeof body.quantity === 'number' && body.quantity > 0)) {
      res.status(400).json({ error: "sells require quantity (positive number or 'all')" });
      return;
    }

    const quotes = await deps.market.poll([symbol]);
    const quote = quotes.get(symbol);
    if (!quote) {
      res.status(422).json({ error: `no quote available for ${symbol}` });
      return;
    }
    const audUsd = quote.currency === 'USD' ? await deps.market.audUsdRate() : 1;

    const result =
      side === 'buy'
        ? rounds.buy(id, symbol, marketForSymbol(symbol), body.amountCents!, quote, audUsd, 'operator')
        : rounds.sell(id, symbol, body.quantity!, quote, audUsd, 'operator');

    if (result.status === 'rejected') {
      res.status(409).json({ error: result.reason });
      return;
    }
    res.status(201).json(result);
  });
```

- [ ] **Step 4: Verify PASS:** `npm test -- api-orders` → 6 tests. Full suite → 126. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/rounds-routes.ts backend/test/api-orders.test.ts
git commit -m "feat: manual order placement through the operator API"
```

---

### Task 9: Events API + SSE stream

**Files:**
- Create: `backend/src/api/events-routes.ts`
- Modify: `backend/src/api/app.ts` (mount)
- Test: `backend/test/api-events.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/api-events.test.ts`

```ts
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
```

- [ ] **Step 2: Verify FAIL:** `npm test -- api-events`.

- [ ] **Step 3: Create `backend/src/api/events-routes.ts`**

```ts
import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import { requireSession } from './middleware.js';

export interface EventRow {
  id: number;
  round_id: number | null;
  level: string;
  kind: string;
  message: string;
  created_at: string;
}

export function recentEvents(db: DB, afterId: number, roundId?: number, limit = 200): EventRow[] {
  if (roundId !== undefined) {
    return db
      .prepare('SELECT * FROM event_log WHERE id > ? AND round_id = ? ORDER BY id LIMIT ?')
      .all(afterId, roundId, limit) as EventRow[];
  }
  return db.prepare('SELECT * FROM event_log WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit) as EventRow[];
}

export function latestEventId(db: DB): number {
  const { m } = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM event_log').get() as { m: number };
  return m;
}

const SSE_POLL_MS = 1000;
const SSE_HEARTBEAT_MS = 25_000;

export function eventsRoutes(db: DB, auth: AuthService): Router {
  const router = Router();
  router.use('/api/events', requireSession(auth));

  router.get('/api/events', (req, res) => {
    const after = Number(req.query.after ?? 0);
    const roundId = req.query.roundId !== undefined ? Number(req.query.roundId) : undefined;
    res.json(recentEvents(db, Number.isFinite(after) ? after : 0, roundId));
  });

  router.get('/api/events/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 5000\n\n');

    let cursor = latestEventId(db); // only NEW events; the REST endpoint serves history
    const roundId = req.query.roundId !== undefined ? Number(req.query.roundId) : undefined;

    const poll = setInterval(() => {
      const rows = recentEvents(db, cursor, roundId);
      for (const row of rows) {
        cursor = row.id;
        res.write(`id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`);
      }
    }, SSE_POLL_MS);
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      res.end();
    });
  });

  return router;
}
```

- [ ] **Step 4: Mount in `backend/src/api/app.ts`**:

```ts
import { eventsRoutes } from './events-routes.js';
// after roundsRoutes:
  app.use(eventsRoutes(deps.db, deps.auth));
```

- [ ] **Step 5: Verify PASS:** `npm test -- api-events` → 5 tests. Full suite → 131. `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api backend/test/api-events.test.ts
git commit -m "feat: event feed API with SSE stream tailing event_log"
```

---

### Task 10: Ntfy notifier + dispatcher

**Files:**
- Create: `backend/src/notify/ntfy.ts`
- Test: `backend/test/ntfy.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/ntfy.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { logEvent } from '../src/db/events.js';
import { migrate } from '../src/db/migrate.js';
import { NotificationDispatcher, NtfyNotifier } from '../src/notify/ntfy.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings/store.js';

describe('NtfyNotifier', () => {
  it('POSTs to url/topic with title, priority and tags', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const notifier = new NtfyNotifier(
      () => ({ url: 'https://ntfy.example', topic: 'trades', enabled: true }),
      fetchFn as unknown as typeof fetch,
    );
    await notifier.send('Trade executed', 'bought AAPL', 3, ['chart_with_upwards_trend']);
    expect(fetchFn).toHaveBeenCalledWith('https://ntfy.example/trades', {
      method: 'POST',
      body: 'bought AAPL',
      headers: { Title: 'Trade executed', Priority: '3', Tags: 'chart_with_upwards_trend' },
    });
  });

  it('does nothing when disabled or unconfigured', async () => {
    const fetchFn = vi.fn();
    const notifier = new NtfyNotifier(
      () => ({ url: 'https://ntfy.example', topic: '', enabled: false }),
      fetchFn as unknown as typeof fetch,
    );
    await notifier.send('x', 'y', 3);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never throws on network failure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('net down'));
    const notifier = new NtfyNotifier(
      () => ({ url: 'https://ntfy.example', topic: 't', enabled: true }),
      fetchFn as unknown as typeof fetch,
    );
    await expect(notifier.send('x', 'y', 3)).resolves.toBeUndefined();
  });
});

describe('NotificationDispatcher', () => {
  let db: DB;
  let settings: SettingsStore;
  let sent: { title: string; message: string; priority: number }[];
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    settings = new SettingsStore(db);
    settings.set('integrations', {
      ...DEFAULT_SETTINGS.integrations,
      ntfy: { url: 'https://ntfy.example', topic: 't', enabled: true },
    });
    sent = [];
    const fetchFn = (async (url: unknown, init: { body: string; headers: Record<string, string> }) => {
      sent.push({ title: init.headers.Title!, message: init.body, priority: Number(init.headers.Priority) });
      return { ok: true };
    }) as unknown as typeof fetch;
    dispatcher = new NotificationDispatcher(db, settings, new NtfyNotifier(() => settings.get('integrations').ntfy, fetchFn));
  });

  it('sends mapped notifications for new events only', async () => {
    logEvent(db, 'info', 'trade', 'round 1 buy 2 AAPL @ 10.0000 AUD', 1); // pre-start: skipped
    dispatcher.resetCursor();
    logEvent(db, 'info', 'skim', 'round 1 pocketed 2000 cents', 1);
    logEvent(db, 'warn', 'stop_loss', 'round 1 stop-loss on AAPL', 1);
    logEvent(db, 'info', 'irrelevant_kind', 'ignored');
    const count = await dispatcher.dispatchNew();
    expect(count).toBe(2);
    expect(sent.map((s) => s.title)).toEqual(['Profit pocketed', 'Stop-loss fired']);
    expect(sent[0]!.priority).toBe(4);
  });

  it('maps round_status messages to goal/busted/drawdown rules', async () => {
    dispatcher.resetCursor();
    logEvent(db, 'info', 'round_status', 'round 1 → goal_reached: profit goal reached', 1);
    logEvent(db, 'info', 'round_status', 'round 2 → busted: cash and holdings exhausted', 2);
    logEvent(db, 'info', 'round_status', 'round 3 → paused: drawdown pause breached', 3);
    logEvent(db, 'info', 'round_status', 'round 4 → paused: operator pause', 4); // no rule → skipped
    const count = await dispatcher.dispatchNew();
    expect(count).toBe(3);
    expect(sent.map((s) => s.priority)).toEqual([5, 5, 4]);
  });

  it('respects per-kind toggles', async () => {
    settings.set('notifications', { ...settings.get('notifications'), skim: false });
    dispatcher.resetCursor();
    logEvent(db, 'info', 'skim', 'round 1 pocketed 100 cents', 1);
    expect(await dispatcher.dispatchNew()).toBe(0);
  });

  it('is idempotent across calls (cursor advances)', async () => {
    dispatcher.resetCursor();
    logEvent(db, 'info', 'skim', 'x', 1);
    expect(await dispatcher.dispatchNew()).toBe(1);
    expect(await dispatcher.dispatchNew()).toBe(0);
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- ntfy`.

- [ ] **Step 3: Create `backend/src/notify/ntfy.ts`**

```ts
import type { DB } from '../db/connection.js';
import { recentEvents, latestEventId, type EventRow } from '../api/events-routes.js';
import type { NtfySettings, SettingsStore } from '../settings/store.js';

export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

/** Fire-and-forget ntfy publisher (spec §8). Never throws. */
export class NtfyNotifier {
  constructor(
    private config: () => NtfySettings,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(title: string, message: string, priority: NtfyPriority, tags: string[] = []): Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.url || !cfg.topic) return;
    const headers: Record<string, string> = { Title: title, Priority: String(priority) };
    if (tags.length > 0) headers.Tags = tags.join(',');
    try {
      await this.fetchFn(`${cfg.url.replace(/\/$/, '')}/${cfg.topic}`, { method: 'POST', body: message, headers });
    } catch {
      // Notifications are best-effort; a down ntfy server must never break trading.
    }
  }
}

interface NotifyRule {
  toggle: string;
  priority: NtfyPriority;
  title: string;
  tags: string[];
}

/** Map an event_log row to a notification, or null to skip (spec §8 priority mapping). */
export function ruleFor(event: EventRow): NotifyRule | null {
  switch (event.kind) {
    case 'trade':
      return { toggle: 'trade', priority: 3, title: 'Trade executed', tags: ['chart_with_upwards_trend'] };
    case 'skim':
      return { toggle: 'skim', priority: 4, title: 'Profit pocketed', tags: ['moneybag'] };
    case 'stop_loss':
      return { toggle: 'stop_loss', priority: 4, title: 'Stop-loss fired', tags: ['warning'] };
    case 'poll_failed':
      return { toggle: 'error', priority: 5, title: 'Market poll failed', tags: ['rotating_light'] };
    case 'kill_switch':
      return { toggle: 'error', priority: 5, title: 'Kill switch engaged', tags: ['octagonal_sign'] };
    case 'round_status':
      if (event.message.includes('goal_reached')) return { toggle: 'goal', priority: 5, title: 'Profit goal reached', tags: ['tada'] };
      if (event.message.includes('busted')) return { toggle: 'busted', priority: 5, title: 'Round busted', tags: ['skull'] };
      if (event.message.includes('drawdown')) return { toggle: 'drawdown', priority: 4, title: 'Drawdown pause', tags: ['warning'] };
      return null;
    default:
      return null;
  }
}

/** Tails event_log and forwards notifiable events to ntfy. */
export class NotificationDispatcher {
  private cursor: number;
  constructor(
    private db: DB,
    private settings: SettingsStore,
    private notifier: NtfyNotifier,
  ) {
    this.cursor = latestEventId(db);
  }

  /** Test hook / restart semantics: start tailing from the current end of the log. */
  resetCursor(): void {
    this.cursor = latestEventId(this.db);
  }

  async dispatchNew(): Promise<number> {
    const rows = recentEvents(this.db, this.cursor);
    const toggles = this.settings.get('notifications');
    let sentCount = 0;
    for (const row of rows) {
      this.cursor = row.id;
      const rule = ruleFor(row);
      if (!rule || toggles[rule.toggle] === false) continue;
      await this.notifier.send(rule.title, row.message, rule.priority, rule.tags);
      sentCount += 1;
    }
    return sentCount;
  }

  start(intervalMs = 5000): () => void {
    const timer = setInterval(() => {
      void this.dispatchNew();
    }, intervalMs);
    return () => clearInterval(timer);
  }
}
```

- [ ] **Step 4: Verify PASS:** `npm test -- ntfy` → 7 tests. Full suite → 138. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/notify backend/test/ntfy.test.ts
git commit -m "feat: ntfy notifier and event-log dispatcher with priority mapping"
```

---

### Task 11: CLI + server entrypoint + final verification

**Files:**
- Create: `backend/src/cli.ts`, `backend/src/index.ts`
- Modify: `backend/package.json` (scripts)

`index.ts` and `cli.ts` are thin wiring over tested components — no unit tests; verified by tsc, a boot smoke check, and the full suite.

- [ ] **Step 1: Create `backend/src/cli.ts`**

```ts
/**
 * Thin operator CLI:
 *   npm run cli -- create-user <username>   (prompts for password)
 *   npm run cli -- status                   (lists rounds)
 * DB path via DB_PATH env (default ./data/portfolio.db), matching index.ts.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AuthService } from './auth/service.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';

const DB_PATH = process.env.DB_PATH ?? './data/portfolio.db';

async function main(): Promise<void> {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = openDb(DB_PATH);
  migrate(db);
  const [command, ...args] = process.argv.slice(2);

  if (command === 'create-user') {
    const username = args[0];
    if (!username) {
      console.error('usage: npm run cli -- create-user <username>');
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.warn('note: password input is visible in this terminal');
    const password = await rl.question('password: ');
    rl.close();
    if (password.length < 8) {
      console.error('password must be at least 8 characters');
      process.exit(1);
    }
    const auth = new AuthService(db);
    await auth.createUser(username, password);
    console.log(`user '${username}' created`);
    return;
  }

  if (command === 'status') {
    const rows = db
      .prepare('SELECT id, name, status, cash_cents, profit_goal_cents FROM rounds ORDER BY id')
      .all() as { id: number; name: string; status: string; cash_cents: number; profit_goal_cents: number }[];
    if (rows.length === 0) {
      console.log('no rounds');
      return;
    }
    for (const r of rows) {
      console.log(`#${r.id} ${r.name} [${r.status}] cash $${(r.cash_cents / 100).toFixed(2)} goal $${(r.profit_goal_cents / 100).toFixed(2)}`);
    }
    return;
  }

  console.error('usage: npm run cli -- <create-user <username> | status>');
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 2: Create `backend/src/index.ts`**

```ts
/** Server entrypoint: wiring only — every component here is tested elsewhere. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './api/app.js';
import { AuthService } from './auth/service.js';
import { PaperBroker } from './broker/paper.js';
import { openDb } from './db/connection.js';
import { logEvent } from './db/events.js';
import { migrate } from './db/migrate.js';
import { MarketDataService } from './market/data.js';
import { yahooFetcher } from './market/yahoo.js';
import { NotificationDispatcher, NtfyNotifier } from './notify/ntfy.js';
import { RoundService } from './rounds/service.js';
import { start as startScheduler } from './scheduler.js';
import { SettingsStore } from './settings/store.js';

const DB_PATH = process.env.DB_PATH ?? './data/portfolio.db';
const PORT = Number(process.env.PORT ?? 3000);

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
migrate(db);

const auth = new AuthService(db);
const settings = new SettingsStore(db);
const rounds = new RoundService(db, new PaperBroker(db));
const market = new MarketDataService(db, yahooFetcher);
const notifier = new NtfyNotifier(() => settings.get('integrations').ntfy);
const dispatcher = new NotificationDispatcher(db, settings, notifier);

if (!auth.hasUsers()) {
  console.warn('no user exists yet — create one with: npm run cli -- create-user <username>');
}

const pollMinutes = settings.get('integrations').pollIntervalMinutes;
const stopScheduler = startScheduler({ db, rounds, market }, `*/${pollMinutes} * * * *`);
const stopDispatcher = dispatcher.start();

const app = buildApp({ db, auth, settings, rounds, market });
const server = app.listen(PORT, () => {
  logEvent(db, 'info', 'server_started', `API listening on :${PORT}`);
  console.log(`stock_portfolio_simulator backend on http://localhost:${PORT}`);
});

function shutdown(): void {
  console.log('shutting down…');
  stopScheduler();
  stopDispatcher();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 3: Add scripts to `backend/package.json`** — merge into the existing `scripts` block:

```json
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "cli": "tsx src/cli.ts"
```

- [ ] **Step 4: Verify build + full suite**

Run: `npx tsc --noEmit && npm run build && npm test`
Expected: clean compile, `dist/` builds, 138 tests pass.

- [ ] **Step 5: Boot smoke check**

```bash
DB_PATH=/tmp/portfolio-smoke.db PORT=3999 npx tsx src/index.ts & SERVER_PID=$!
sleep 3
curl -s http://localhost:3999/api/health
kill $SERVER_PID
rm -f /tmp/portfolio-smoke.db*
```
Expected: `{"ok":true}` printed; server exits cleanly.

- [ ] **Step 6: Commit**

```bash
git add backend/src/cli.ts backend/src/index.ts backend/package.json
git commit -m "feat: server entrypoint, operator CLI, npm scripts"
```

---

## Done Criteria

- Full suite green (~138 tests) and `npm run build` compiles.
- `npx tsx src/index.ts` boots: health endpoint responds, scheduler + dispatcher running, graceful SIGINT shutdown.
- Every API surface auth-gated except `/api/health` and login; login rate-limited.
- Spec coverage this plan: §5 manual control (pause/resume/takeover/release/kill/manual orders), §2.6 live config edits with config_events, §6.1 settings + auth, §8 ntfy with priorities/toggles, SSE feed for §6 live updates.
- Deferred to Plan 3: OneCLI + DecisionService + check-in scheduling + daily summaries; Plan 4: frontend + Docker (the `paused stop-loss configurability` minor from Plan 1's final review also lands with the config UI work).
