# Phase 1 Frontend (Dashboard + Markets + Docker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the React/Vite dashboard from spec §6 (login, rounds overview, round detail, new-round wizard, settings, markets charts) on top of the existing backend, add the OHLC history API the Markets page needs, clear the four deferred backend debts, and package the whole thing with Docker Compose.

**Architecture:** Three layers. (1) Backend additions — a cached OHLC history service (`src/market/history.ts`) behind an injected `BarFetcher` so tests never hit the network, a tracked-symbols registry, and a `/api/market/*` router; plus the deferred hardening items (cookie `secure`, `trust proxy`, rate-limiter pruning, paused-round stop-loss switch). (2) A new `frontend/` workspace — React 19 + Vite 8, TanStack Query for all server state, React Router 7 for routing, `lightweight-charts` v5 for every chart, plain CSS with custom properties for theming. Server state is *never* mirrored into local state: the SSE stream invalidates query keys and the UI refetches. (3) Docker Compose — a Node backend container and an nginx container that serves the built SPA and proxies `/api` (including SSE) to the backend.

**Tech Stack:** Backend: Node 22, TypeScript strict ESM (NodeNext, `.js` import specifiers), express 5, better-sqlite3, yahoo-finance2 v4 `chart()`, vitest + supertest. Frontend: React 19.2, Vite 8, `@vitejs/plugin-react` 6, `@tanstack/react-query` 5, `react-router-dom` 7, `lightweight-charts` 5, vitest 4 + jsdom 30 + `@testing-library/react` 16 + `@testing-library/user-event` + msw 2. Packaging: Docker Compose, nginx alpine.

---

## Context you need before starting

Read these before Task 1. They are short and they encode rules that have failed reviews before.

- `CLAUDE.md` at the repo root — especially **Hard-won invariants**. The ones that bite in this plan:
  - **Money is integer AUD cents everywhere.** The frontend formats cents for display and sends cents back. Never round-trip through floats. Every form that accepts dollars converts with `Math.round(dollars * 100)` at the edge.
  - **Files considered hardened** — `engine/*`, `broker/paper.ts`, `rounds/service.ts`, `scheduler.ts`, `db/migrations.ts`. Tasks 1 and 3 touch `migrations.ts`, `scheduler.ts` and `engine/types.ts`. Those diffs must be surgical and are called out explicitly in the task text. Do not refactor anything nearby.
  - **Nested config objects deep-merge** — the new `stopLossWhenPaused` guardrail added in Task 3 must have a default and must survive a partial PATCH.
  - **Quote prices are untrusted input** — the same applies to OHLC bars in Task 1: reject non-finite and non-positive values before they reach the database.
- `docs/superpowers/specs/2026-08-02-trading-agent-design.md` §6 (Dashboard), §6.1 (Global settings & auth), §7 (Error handling), §8 (Notifications).
- `backend/test/api-helper.ts` — the pattern every backend test uses (`createTestApp()` + `loginCookie()`). Task 2 changes its signature; every backend test flows through it, so run the whole suite after that task.

**Baseline test count: 193 backend tests, 29 files, all green.** Frontend tests are a separate vitest project with its own count. When you finish a task, report the *observed* totals from both suites — do not try to match a number written in this plan.

**Commands:**

```bash
cd backend && npm test              # 193 baseline; filter with: npm test -- <name>
cd backend && npx tsc --noEmit
cd frontend && npm test             # exists from Task 4 onward
cd frontend && npx tsc --noEmit
cd frontend && npm run build
```

---

## File Structure

**Backend — created:**

| File | Responsibility |
| --- | --- |
| `backend/src/market/history.ts` | Range specs, `BarFetcher` type, `MarketHistoryService` — cache-first OHLC reads, writes validated bars to `ohlc_bars`. |
| `backend/src/market/symbols.ts` | Tracked-symbol registry: upsert on watchlist/position use, archive, list. |
| `backend/src/api/market-routes.ts` | `/api/market/history`, `/api/market/symbols`, `/api/market/quotes`. |
| `backend/test/market-history.test.ts` | History service: cache hit, TTL expiry, bad-bar rejection, fetch failure falls back to cache. |
| `backend/test/market-symbols.test.ts` | Registry upsert/archive/list. |
| `backend/test/api-market.test.ts` | Route auth, validation, payload shape. |
| `backend/test/api-hardening.test.ts` | Cookie `secure` flag, trust-proxy rate limiting, limiter pruning. |

**Backend — modified:**

| File | Change |
| --- | --- |
| `backend/src/db/migrations.ts` | Append migration index 1: `ohlc_bars` table + `symbols` columns. **Append only — never edit index 0.** |
| `backend/src/market/yahoo.ts` | Add `yahooBarFetcher` using `yahooFinance.chart()`. |
| `backend/src/api/app.ts` | `ApiDeps` gains `history` + `symbols`; mount market routes; `trust proxy`. |
| `backend/src/api/auth-routes.ts` | Cookie `secure` flag from config. |
| `backend/src/api/middleware.ts` | Rate-limiter map pruning. |
| `backend/src/engine/types.ts` | `GuardrailConfig.stopLossWhenPaused` + default. |
| `backend/src/scheduler.ts` | Honour `stopLossWhenPaused`; register polled symbols in the registry. |
| `backend/src/index.ts` | Wire `MarketHistoryService`, `SymbolRegistry`, `COOKIE_SECURE`, `TRUST_PROXY`. |
| `backend/test/api-helper.ts` | Build and pass the two new deps. |

**Frontend — created (all under `frontend/`):**

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `index.html`, `.gitignore` | Workspace scaffold, dev proxy, vitest config. |
| `src/main.tsx`, `src/App.tsx`, `src/index.css` | Entry, router table, design tokens + theme. |
| `src/api/types.ts` | TypeScript mirrors of every backend payload used by the UI. |
| `src/api/client.ts` | `ApiError` + typed `fetch` wrapper (`credentials: 'include'`). |
| `src/api/hooks.ts` | Every TanStack Query hook + query-key factory. |
| `src/auth/AuthProvider.tsx`, `src/auth/LoginPage.tsx`, `src/auth/RequireAuth.tsx` | Session context, login form, route guard. |
| `src/shell/AppShell.tsx`, `src/shell/KillSwitch.tsx` | Nav chrome, logout, global kill switch. |
| `src/events/useEventStream.ts`, `src/events/EventFeed.tsx` | SSE subscription → query invalidation; event list UI. |
| `src/lib/format.ts` | `formatCents`, `dollarsToCents`, `formatPct`, `formatTs`. |
| `src/components/{StatusBadge,Money,ErrorBox,Spinner}.tsx` | Shared primitives. |
| `src/components/charts/{chartTheme.ts,EquityChart.tsx,PriceChart.tsx,Sparkline.tsx}` | The only files allowed to import `lightweight-charts`. |
| `src/pages/RoundsPage.tsx` | Overview cards. |
| `src/pages/RoundDetailPage.tsx` | Detail shell + tabs. |
| `src/pages/round/{Controls,PositionsTable,TradesTable,LedgerTable,JournalList,SummariesList,ConfigPanel,OrderForm}.tsx` | Detail panels. |
| `src/pages/NewRoundPage.tsx`, `src/pages/round/warnings.ts` | Wizard + pure foot-gun rules. |
| `src/pages/SettingsPage.tsx` | Four settings sections + password change. |
| `src/pages/MarketsPage.tsx` | Symbol picker, timeframe, overlays, trade markers. |
| `test/setup.ts`, `test/server.ts`, `test/render.tsx`, `test/*.test.tsx` | jsdom setup, msw handlers, render helper, tests. |

**Packaging — created:** `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`, `docker-compose.yml`, `.dockerignore`, `scripts/setup.sh`, `README.md`.

---

## Task 1: OHLC history service with a cached, injectable fetcher

Spec §6 Markets page needs candles + volume over 1D/1W/1M/3M/all. The backend has no historical data at all today — `MarketDataService` only fetches live quotes. This task adds the storage and the service; Task 2 exposes it over HTTP.

**Files:**
- Modify: `backend/src/db/migrations.ts` (append a new element to the `migrations` array — do not touch index 0)
- Create: `backend/src/market/history.ts`
- Modify: `backend/src/market/yahoo.ts`
- Create: `backend/test/market-history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/market-history.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MarketHistoryService, type BarFetcher, type OhlcBar } from '../src/market/history.js';

const T0 = new Date('2026-08-02T00:00:00.000Z');

function bars(n: number, from = T0): OhlcBar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(from.getTime() + i * 86_400_000).toISOString(),
    open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 1000 + i,
  }));
}

describe('MarketHistoryService', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('fetches, caches and returns bars', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    const result = await svc.history('AAPL', '1M', T0);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.interval).toBe('1d');
    expect(result.currency).toBe('USD');
    expect(result.bars).toHaveLength(3);
    expect(result.bars[0]!.close).toBe(10.5);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM ohlc_bars').get() as { c: number };
    expect(rows.c).toBe(3);
  });

  it('serves the cache without refetching inside the TTL', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    await svc.history('AAPL', '1M', T0);
    const second = await svc.history('AAPL', '1M', new Date(T0.getTime() + 60_000));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.bars).toHaveLength(3);
  });

  it('refetches once the TTL has expired', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    await svc.history('AAPL', '1M', T0);
    await svc.history('AAPL', '1M', new Date(T0.getTime() + 13 * 3_600_000));

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('upserts rather than duplicating an overlapping refetch', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    await svc.history('AAPL', '1M', T0);
    await svc.history('AAPL', '1M', new Date(T0.getTime() + 13 * 3_600_000));

    const rows = db.prepare('SELECT COUNT(*) AS c FROM ohlc_bars').get() as { c: number };
    expect(rows.c).toBe(3);
  });

  it('drops bars with non-finite or non-positive prices', async () => {
    const bad: OhlcBar[] = [
      { ts: T0.toISOString(), open: 10, high: 11, low: 9, close: 10.5, volume: 1 },
      { ts: new Date(T0.getTime() + 86_400_000).toISOString(), open: 0, high: 0, low: 0, close: 0, volume: 1 },
      { ts: new Date(T0.getTime() + 2 * 86_400_000).toISOString(), open: 1, high: NaN, low: 1, close: 1, volume: 1 },
    ];
    const svc = new MarketHistoryService(db, async () => ({ currency: 'USD', bars: bad }));

    const result = await svc.history('AAPL', '1M', T0);

    expect(result.bars).toHaveLength(1);
  });

  it('falls back to cached bars when the fetch fails', async () => {
    let fail = false;
    const svc = new MarketHistoryService(db, async () => {
      if (fail) throw new Error('yahoo down');
      return { currency: 'USD', bars: bars(3) };
    });

    await svc.history('AAPL', '1M', T0);
    fail = true;
    const result = await svc.history('AAPL', '1M', new Date(T0.getTime() + 13 * 3_600_000));

    expect(result.bars).toHaveLength(3);
    expect(result.stale).toBe(true);
  });

  it('rethrows when the fetch fails and nothing is cached', async () => {
    const svc = new MarketHistoryService(db, async () => {
      throw new Error('yahoo down');
    });

    await expect(svc.history('AAPL', '1M', T0)).rejects.toThrow('yahoo down');
  });

  it('keys the cache per interval so ranges do not collide', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    await svc.history('AAPL', '1M', T0);
    await svc.history('AAPL', '1D', T0);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const intervals = db.prepare('SELECT DISTINCT interval FROM ohlc_bars ORDER BY interval').all() as { interval: string }[];
    expect(intervals.map((r) => r.interval)).toEqual(['1d', '5m']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- market-history`
Expected: FAIL — `Cannot find module '../src/market/history.js'`.

- [ ] **Step 3: Append the migration**

In `backend/src/db/migrations.ts`, append a **second** element to the `migrations` array. The existing element at index 0 stays byte-identical — `migrate()` applies only entries beyond the recorded count, so editing index 0 would silently skip on existing databases.

```ts
  `
CREATE TABLE ohlc_bars (
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  ts TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL,
  currency TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, interval, ts)
);
CREATE INDEX idx_ohlc_symbol_interval_ts ON ohlc_bars(symbol, interval, ts);
ALTER TABLE symbols ADD COLUMN first_seen_at TEXT;
ALTER TABLE symbols ADD COLUMN last_polled_at TEXT;
`,
```

- [ ] **Step 4: Write the history service**

Create `backend/src/market/history.ts`:

```ts
import type { DB } from '../db/connection.js';

export type Range = '1D' | '1W' | '1M' | '3M' | 'ALL';

export interface OhlcBar {
  /** ISO timestamp of the bar's open. */
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface RangeSpec {
  interval: string;
  lookbackDays: number;
  /** How long a cached fetch stays authoritative. Intraday data moves; weekly data does not. */
  ttlMs: number;
}

export const RANGES: Record<Range, RangeSpec> = {
  '1D': { interval: '5m', lookbackDays: 3, ttlMs: 5 * 60_000 },
  '1W': { interval: '30m', lookbackDays: 8, ttlMs: 15 * 60_000 },
  '1M': { interval: '1d', lookbackDays: 31, ttlMs: 12 * 3_600_000 },
  '3M': { interval: '1d', lookbackDays: 93, ttlMs: 12 * 3_600_000 },
  ALL: { interval: '1wk', lookbackDays: 3650, ttlMs: 24 * 3_600_000 },
};

export function isRange(value: unknown): value is Range {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANGES, value);
}

export type BarFetcher = (
  symbol: string,
  opts: { interval: string; period1: Date },
) => Promise<{ currency: string; bars: OhlcBar[] }>;

export interface HistoryResult {
  symbol: string;
  range: Range;
  interval: string;
  currency: string;
  bars: OhlcBar[];
  /** True when the upstream fetch failed and these bars came from cache. */
  stale: boolean;
}

/** A bar is usable only if every price is finite and positive and the range is coherent. */
function isUsableBar(bar: OhlcBar): boolean {
  const prices = [bar.open, bar.high, bar.low, bar.close];
  if (!prices.every((p) => Number.isFinite(p) && p > 0)) return false;
  if (bar.high < bar.low) return false;
  if (!Number.isFinite(Date.parse(bar.ts))) return false;
  return bar.volume === null || Number.isFinite(bar.volume);
}

/**
 * Cache-first OHLC reads. The fetcher is injected so tests never touch the network
 * (same contract as MarketDataService's QuoteFetcher).
 */
export class MarketHistoryService {
  constructor(private db: DB, private fetcher: BarFetcher) {}

  async history(symbol: string, range: Range, now = new Date()): Promise<HistoryResult> {
    const spec = RANGES[range];
    const since = new Date(now.getTime() - spec.lookbackDays * 86_400_000);
    const cached = this.read(symbol, spec.interval, since);
    const fresh =
      cached.fetchedAt !== null && now.getTime() - Date.parse(cached.fetchedAt) < spec.ttlMs;

    if (fresh && cached.bars.length > 0) {
      return { symbol, range, interval: spec.interval, currency: cached.currency, bars: cached.bars, stale: false };
    }

    try {
      const fetched = await this.fetcher(symbol, { interval: spec.interval, period1: since });
      const usable = fetched.bars.filter(isUsableBar);
      this.write(symbol, spec.interval, fetched.currency, usable, now);
      const stored = this.read(symbol, spec.interval, since);
      return { symbol, range, interval: spec.interval, currency: fetched.currency, bars: stored.bars, stale: false };
    } catch (err) {
      // Spec §7: a data outage degrades the chart to last-known bars; it never 500s the page.
      if (cached.bars.length > 0) {
        return { symbol, range, interval: spec.interval, currency: cached.currency, bars: cached.bars, stale: true };
      }
      throw err;
    }
  }

  private read(symbol: string, interval: string, since: Date): { bars: OhlcBar[]; currency: string; fetchedAt: string | null } {
    const rows = this.db
      .prepare(
        `SELECT ts, open, high, low, close, volume, currency, fetched_at
           FROM ohlc_bars WHERE symbol = ? AND interval = ? AND ts >= ? ORDER BY ts`,
      )
      .all(symbol, interval, since.toISOString()) as {
      ts: string; open: number; high: number; low: number; close: number;
      volume: number | null; currency: string; fetched_at: string;
    }[];
    if (rows.length === 0) return { bars: [], currency: 'USD', fetchedAt: null };
    const fetchedAt = rows.reduce((max, r) => (r.fetched_at > max ? r.fetched_at : max), rows[0]!.fetched_at);
    return {
      bars: rows.map((r) => ({ ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })),
      currency: rows[0]!.currency,
      fetchedAt,
    };
  }

  private write(symbol: string, interval: string, currency: string, bars: OhlcBar[], now: Date): void {
    if (bars.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO ohlc_bars (symbol, interval, ts, open, high, low, close, volume, currency, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, interval, ts) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
         volume = excluded.volume, currency = excluded.currency, fetched_at = excluded.fetched_at`,
    );
    const iso = now.toISOString();
    this.db.transaction(() => {
      for (const b of bars) stmt.run(symbol, interval, b.ts, b.open, b.high, b.low, b.close, b.volume, currency, iso);
    })();
  }
}
```

- [ ] **Step 5: Add the real Yahoo bar fetcher**

Append to `backend/src/market/yahoo.ts` (the `yahooFinance` client already exists at the top of that file — reuse it, do not construct a second one):

```ts
import type { BarFetcher } from './history.js';

export const yahooBarFetcher: BarFetcher = async (symbol, { interval, period1 }) => {
  const result = await yahooFinance.chart(symbol, {
    period1,
    interval: interval as '5m' | '30m' | '1d' | '1wk',
  });
  const bars = result.quotes
    .filter((q) => q.open !== null && q.high !== null && q.low !== null && q.close !== null)
    .map((q) => ({
      ts: q.date.toISOString(),
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume,
    }));
  return { currency: result.meta.currency, bars };
};
```

Add the `import type` line to the existing import block at the top of the file rather than mid-file.

- [ ] **Step 6: Run the tests**

Run: `cd backend && npm test -- market-history && npx tsc --noEmit`
Expected: 8 new tests PASS, typecheck clean.

- [ ] **Step 7: Run the full suite**

Run: `cd backend && npm test`
Expected: 193 + 8 = 201 tests pass. `migrate.test.ts` must still pass — if it asserts a table count, update that assertion to include `ohlc_bars` and report it as a sanctioned deviation.

- [ ] **Step 8: Commit**

```bash
git add backend/src/db/migrations.ts backend/src/market/history.ts backend/src/market/yahoo.ts backend/test/market-history.test.ts
git commit -m "feat: cached OHLC history service behind an injectable bar fetcher"
```

---

## Task 2: Tracked-symbol registry and the /api/market routes

Spec §6: "Symbols remain polled after leaving a watchlist unless archived." That needs a registry, and the Markets page needs a symbol list plus history over HTTP.

**Files:**
- Create: `backend/src/market/symbols.ts`
- Create: `backend/src/api/market-routes.ts`
- Modify: `backend/src/api/app.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/test/api-helper.ts`
- Create: `backend/test/market-symbols.test.ts`
- Create: `backend/test/api-market.test.ts`

- [ ] **Step 1: Write the registry test**

Create `backend/test/market-symbols.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { SymbolRegistry } from '../src/market/symbols.js';

describe('SymbolRegistry', () => {
  let db: DB;
  let registry: SymbolRegistry;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    registry = new SymbolRegistry(db);
  });

  it('tracks a symbol with its derived market', () => {
    registry.track('BHP.AX');
    expect(registry.list()).toEqual([
      expect.objectContaining({ symbol: 'BHP.AX', market: 'ASX', archived: 0 }),
    ]);
  });

  it('upper-cases and de-duplicates', () => {
    registry.track('aapl');
    registry.track('AAPL');
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.symbol).toBe('AAPL');
  });

  it('trackMany records every symbol once', () => {
    registry.trackMany(['AAPL', 'MSFT', 'AAPL']);
    expect(registry.list().map((s) => s.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });

  it('archives and unarchives without losing the row', () => {
    registry.track('AAPL');
    registry.setArchived('AAPL', true);
    expect(registry.list()[0]!.archived).toBe(1);
    expect(registry.activeSymbols()).toEqual([]);
    registry.setArchived('AAPL', false);
    expect(registry.activeSymbols()).toEqual(['AAPL']);
  });

  it('re-tracking an archived symbol does not silently unarchive it', () => {
    registry.track('AAPL');
    registry.setArchived('AAPL', true);
    registry.track('AAPL');
    expect(registry.list()[0]!.archived).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npm test -- market-symbols`
Expected: FAIL — `Cannot find module '../src/market/symbols.js'`.

- [ ] **Step 3: Write the registry**

Create `backend/src/market/symbols.ts`:

```ts
import type { DB } from '../db/connection.js';
import type { Market } from '../engine/types.js';
import { marketForSymbol } from './data.js';

export interface SymbolRow {
  symbol: string;
  market: Market;
  name: string | null;
  archived: number;
  first_seen_at: string | null;
  last_polled_at: string | null;
}

/** Yahoo tickers: letters, digits, dot, dash, caret, equals. Anything else is not a symbol. */
const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,15}$/;

export function normalizeSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

/**
 * The set of symbols the app knows about. Watchlist and position symbols get
 * tracked automatically so they keep being polled after leaving a watchlist
 * (spec §6) until the operator archives them.
 */
export class SymbolRegistry {
  constructor(private db: DB) {}

  track(raw: string): string | null {
    const symbol = normalizeSymbol(raw);
    if (symbol === null) return null;
    // No DO UPDATE on archived: re-tracking must not resurrect an archived symbol.
    this.db
      .prepare(
        `INSERT INTO symbols (symbol, market, archived, first_seen_at)
         VALUES (?, ?, 0, ?) ON CONFLICT(symbol) DO NOTHING`,
      )
      .run(symbol, marketForSymbol(symbol), new Date().toISOString());
    return symbol;
  }

  trackMany(symbols: string[]): void {
    this.db.transaction(() => {
      for (const s of symbols) this.track(s);
    })();
  }

  setArchived(raw: string, archived: boolean): void {
    const symbol = normalizeSymbol(raw);
    if (symbol === null) return;
    this.db.prepare('UPDATE symbols SET archived = ? WHERE symbol = ?').run(archived ? 1 : 0, symbol);
  }

  markPolled(symbols: string[], now = new Date()): void {
    if (symbols.length === 0) return;
    const stmt = this.db.prepare('UPDATE symbols SET last_polled_at = ? WHERE symbol = ?');
    const iso = now.toISOString();
    this.db.transaction(() => {
      for (const s of symbols) stmt.run(iso, s);
    })();
  }

  list(): SymbolRow[] {
    return this.db.prepare('SELECT * FROM symbols ORDER BY symbol').all() as SymbolRow[];
  }

  activeSymbols(): string[] {
    return (this.db.prepare('SELECT symbol FROM symbols WHERE archived = 0 ORDER BY symbol').all() as {
      symbol: string;
    }[]).map((r) => r.symbol);
  }
}
```

- [ ] **Step 4: Write the routes test**

Create `backend/test/api-market.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('market API', () => {
  let ctx: TestCtx;
  let cookie: string;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
  });

  it('requires auth on every market route', async () => {
    expect((await request(ctx.app).get('/api/market/symbols')).status).toBe(401);
    expect((await request(ctx.app).get('/api/market/history?symbol=AAPL&range=1M')).status).toBe(401);
  });

  it('returns history bars for a valid symbol and range', async () => {
    const res = await request(ctx.app).get('/api/market/history?symbol=AAPL&range=1M').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('AAPL');
    expect(res.body.interval).toBe('1d');
    expect(Array.isArray(res.body.bars)).toBe(true);
    expect(res.body.bars.length).toBeGreaterThan(0);
  });

  it('rejects an unknown range', async () => {
    const res = await request(ctx.app).get('/api/market/history?symbol=AAPL&range=17Y').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('rejects a malformed symbol', async () => {
    const res = await request(ctx.app).get('/api/market/history?symbol=DROP%20TABLE&range=1M').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('502s when history is unavailable and nothing is cached', async () => {
    ctx.barFetcher.fail = true;
    const res = await request(ctx.app).get('/api/market/history?symbol=MSFT&range=1M').set('Cookie', cookie);
    expect(res.status).toBe(502);
  });

  it('tracks, lists and archives symbols', async () => {
    expect((await request(ctx.app).post('/api/market/symbols').set('Cookie', cookie).send({ symbol: 'aapl' })).status).toBe(201);
    const list = await request(ctx.app).get('/api/market/symbols').set('Cookie', cookie);
    expect(list.body).toEqual([expect.objectContaining({ symbol: 'AAPL', archived: 0 })]);

    const archived = await request(ctx.app)
      .post('/api/market/symbols/AAPL/archive')
      .set('Cookie', cookie)
      .send({ archived: true });
    expect(archived.status).toBe(200);
    const after = await request(ctx.app).get('/api/market/symbols').set('Cookie', cookie);
    expect(after.body[0].archived).toBe(1);
  });

  it('rejects a malformed symbol on track', async () => {
    const res = await request(ctx.app).post('/api/market/symbols').set('Cookie', cookie).send({ symbol: 'no spaces' });
    expect(res.status).toBe(400);
  });

  it('returns live quotes for the requested symbols', async () => {
    const res = await request(ctx.app).get('/api/market/quotes?symbols=AAPL').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.AAPL).toEqual(expect.objectContaining({ price: 10, currency: 'USD', stale: false }));
  });
});
```

- [ ] **Step 5: Write the routes**

Create `backend/src/api/market-routes.ts`:

```ts
import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { MarketDataService } from '../market/data.js';
import { isRange, type MarketHistoryService } from '../market/history.js';
import { normalizeSymbol, type SymbolRegistry } from '../market/symbols.js';
import { requireSession } from './middleware.js';

export function marketRoutes(
  auth: AuthService,
  history: MarketHistoryService,
  symbols: SymbolRegistry,
  market: MarketDataService,
): Router {
  const router = Router();
  router.use('/api/market', requireSession(auth));

  router.get('/api/market/history', async (req, res) => {
    const symbol = normalizeSymbol(String(req.query.symbol ?? ''));
    const range = req.query.range;
    if (symbol === null) {
      res.status(400).json({ error: 'invalid symbol' });
      return;
    }
    if (!isRange(range)) {
      res.status(400).json({ error: 'range must be one of 1D, 1W, 1M, 3M, ALL' });
      return;
    }
    try {
      res.json(await history.history(symbol, range));
    } catch (err) {
      res.status(502).json({ error: `history unavailable: ${(err as Error).message}` });
    }
  });

  router.get('/api/market/symbols', (_req, res) => {
    res.json(symbols.list());
  });

  router.post('/api/market/symbols', (req, res) => {
    const raw = (req.body as { symbol?: string } | undefined)?.symbol ?? '';
    const symbol = symbols.track(raw);
    if (symbol === null) {
      res.status(400).json({ error: 'invalid symbol' });
      return;
    }
    res.status(201).json({ symbol });
  });

  router.post('/api/market/symbols/:symbol/archive', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (symbol === null) {
      res.status(400).json({ error: 'invalid symbol' });
      return;
    }
    const archived = (req.body as { archived?: boolean } | undefined)?.archived ?? true;
    symbols.setArchived(symbol, archived);
    res.json({ symbol, archived });
  });

  router.get('/api/market/quotes', async (req, res) => {
    const requested = String(req.query.symbols ?? '')
      .split(',')
      .map((s) => normalizeSymbol(s))
      .filter((s): s is string => s !== null);
    if (requested.length === 0) {
      res.json({});
      return;
    }
    const quotes = await market.poll(requested);
    res.json(Object.fromEntries(quotes));
  });

  return router;
}
```

- [ ] **Step 6: Wire the routes into the app**

In `backend/src/api/app.ts`, extend `ApiDeps` and mount the router:

```ts
import type { MarketHistoryService } from '../market/history.js';
import type { SymbolRegistry } from '../market/symbols.js';
import { marketRoutes } from './market-routes.js';

export interface ApiDeps {
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
  decision: DecisionService;
  history: MarketHistoryService;
  symbols: SymbolRegistry;
}
```

and, after the `roundsRoutes` line:

```ts
  app.use(marketRoutes(deps.auth, deps.history, deps.symbols, deps.market));
```

- [ ] **Step 7: Update the shared test helper**

In `backend/test/api-helper.ts`, add a controllable bar fetcher and the two deps. Add to the imports:

```ts
import { MarketHistoryService, type BarFetcher } from '../src/market/history.js';
import { SymbolRegistry } from '../src/market/symbols.js';
```

Extend `TestCtx` with:

```ts
  history: MarketHistoryService;
  symbols: SymbolRegistry;
  barFetcher: { fail: boolean };
```

and inside `createTestApp()`, before `buildApp`:

```ts
  const barFetcher = { fail: false };
  const bars: BarFetcher = async (symbol) => {
    if (barFetcher.fail) throw new Error('bar fetch failed');
    return {
      currency: 'USD',
      bars: [
        { ts: '2026-08-01T00:00:00.000Z', open: 9, high: 11, low: 8, close: 10, volume: 1000 },
        { ts: '2026-08-02T00:00:00.000Z', open: 10, high: 12, low: 9, close: 11, volume: 1200 },
      ],
    };
  };
  const history = new MarketHistoryService(db, bars);
  const symbols = new SymbolRegistry(db);
```

Pass them to `buildApp({ db, auth, settings, rounds, market, decision, history, symbols })` and add them plus `barFetcher` to the returned object.

Note the fixture bars are dated 2026-08-01/02. `MarketHistoryService` filters cached reads by `ts >= now - lookbackDays`, so the `1M` range only returns them while the system clock is within 31 days of those dates. If the suite is ever run far past that, change the fixture to generate bars relative to `new Date()` instead of hard-coded dates.

- [ ] **Step 8: Wire production dependencies**

In `backend/src/index.ts`, add the imports and construct the services next to the existing `market` line:

```ts
import { MarketHistoryService } from './market/history.js';
import { SymbolRegistry } from './market/symbols.js';
import { yahooBarFetcher, yahooFetcher } from './market/yahoo.js';
```

```ts
const history = new MarketHistoryService(db, yahooBarFetcher);
const symbols = new SymbolRegistry(db);
```

and extend the `buildApp` call:

```ts
const app = buildApp({ db, auth, settings, rounds, market, decision, history, symbols });
```

- [ ] **Step 9: Run the tests**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: 201 + 13 = 214 pass, typecheck clean. Every existing API test flows through `api-helper.ts`, so a compile error there breaks the whole suite — fix it before moving on.

- [ ] **Step 10: Commit**

```bash
git add backend/src/market/symbols.ts backend/src/api/market-routes.ts backend/src/api/app.ts backend/src/index.ts backend/test/api-helper.ts backend/test/market-symbols.test.ts backend/test/api-market.test.ts
git commit -m "feat: tracked-symbol registry and market history/quotes API"
```

---

## Task 3: Clear the four deferred backend debts

These are tracked in `CLAUDE.md` under "Plan 4 must include". They are backend-only and unrelated to each other, but they all block a TLS deployment, so they ship together before the frontend work starts.

**Files:**
- Modify: `backend/src/api/auth-routes.ts` (cookie `secure`)
- Modify: `backend/src/api/app.ts` (`trust proxy`)
- Modify: `backend/src/api/middleware.ts` (limiter pruning)
- Modify: `backend/src/engine/types.ts` (`stopLossWhenPaused`)
- Modify: `backend/src/scheduler.ts` (honour it)
- Modify: `backend/src/index.ts` (env wiring)
- Modify: `backend/.env.example`
- Create: `backend/test/api-hardening.test.ts`
- Modify: `backend/test/scheduler.test.ts` (one new case)

- [ ] **Step 1: Write the failing tests**

Create `backend/test/api-hardening.test.ts`:

```ts
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
});
```

Add this case to `backend/test/scheduler.test.ts` (match the existing setup helpers in that file — it already builds a db, rounds service and a fake market):

```ts
  it('skips stop-loss evaluation on a paused round when stopLossWhenPaused is false', async () => {
    // Build the same fixture the neighbouring stop-loss test uses, then:
    //  - set config.guardrails.stopLossWhenPaused = false
    //  - set the round status to 'paused'
    //  - crash the price below the stop
    // Expect: the position is still open after pollOnce().
  });
```

Write that case out in full using the helpers already present in `scheduler.test.ts` — read the file first and mirror its existing stop-loss test exactly, changing only the config flag, the status and the assertion. Also add the mirror-image case with the flag left at its default (`true`), asserting the position *is* sold, so a regression in either direction fails.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test -- api-hardening scheduler`
Expected: FAIL — `createTestApp` takes no options, `limiter.size` is not a function, and the paused round still sells.

- [ ] **Step 3: Cookie secure flag**

In `backend/src/api/auth-routes.ts`, replace the module-level `COOKIE_OPTS` constant with a per-instance one:

```ts
export function authRoutes(auth: AuthService, limiter: LoginRateLimiter, cookieSecure = false): Router {
  const router = Router();
  const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/', secure: cookieSecure } as const;
```

The two existing uses (`res.cookie` and `res.clearCookie`) already reference `COOKIE_OPTS` and need no change.

- [ ] **Step 4: Trust proxy and the app option**

In `backend/src/api/app.ts`, add an options field to `ApiDeps`:

```ts
  /** TLS deployment flags. Behind nginx set both. */
  cookieSecure?: boolean;
  trustProxy?: boolean;
```

and in `buildApp`, immediately after `const app = express();`:

```ts
  // Behind nginx, req.ip must reflect X-Forwarded-For or the login rate limiter
  // buckets every request under the proxy's address (spec §6.1).
  if (deps.trustProxy) app.set('trust proxy', 1);
```

and pass the flag through: `app.use(authRoutes(deps.auth, loginRateLimiter(), deps.cookieSecure ?? false));`

- [ ] **Step 5: Prune the rate-limiter map**

Rewrite `loginRateLimiter` in `backend/src/api/middleware.ts`:

```ts
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
/** Entries idle this long are dropped; without this the map grows unbounded. */
const ENTRY_TTL_MS = 30 * 60 * 1000;

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
```

- [ ] **Step 6: Paused-round stop-loss switch**

In `backend/src/engine/types.ts`, add the field to `GuardrailConfig` and the default (**surgical edit to a hardened file — add only these two lines**):

```ts
export interface GuardrailConfig {
  stopLossPct: number | null;
  maxPositionPct: number | null;
  drawdownPausePct: number | null;
  /** Keep firing protective stop-losses while the round is paused (spec §5.1). */
  stopLossWhenPaused: boolean;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  stopLossPct: 10,
  maxPositionPct: 40,
  drawdownPausePct: 50,
  stopLossWhenPaused: true,
};
```

In `backend/src/scheduler.ts`, inside the per-round loop, guard the stop-loss block. Replace the line `for (const pos of rounds.openPositions(round.id)) {` with:

```ts
    // Spec §5.1: a paused round keeps its protective stops by default, but the
    // operator can opt out per round.
    const stopsEnabled = round.status !== 'paused' || cfg.guardrails.stopLossWhenPaused !== false;
    for (const pos of stopsEnabled ? rounds.openPositions(round.id) : []) {
```

Leave equity snapshotting and the drawdown check outside that guard — they must keep running for paused rounds.

The `!== false` comparison is deliberate: a round created before this migration has no `stopLossWhenPaused` key in its stored `config_json`, and `undefined !== false` keeps stops on. That is the safe default.

Also register polled symbols. In `pollOnce`, after `const quotes = await market.poll(pollable);` the scheduler knows every symbol in play — but `SchedulerDeps` has no registry. Add it as an optional dep so existing tests keep compiling:

```ts
export interface SchedulerDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
  symbols?: SymbolRegistry;
}
```

and after the poll:

```ts
  deps.symbols?.trackMany(pollable);
  deps.symbols?.markPolled(pollable, now);
```

- [ ] **Step 7: Wire the environment**

In `backend/src/index.ts`:

```ts
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
```

```ts
const stopScheduler = startScheduler({ db, rounds, market, symbols }, `*/${pollMinutes} * * * *`);
```

```ts
const app = buildApp({ db, auth, settings, rounds, market, decision, history, symbols, cookieSecure: COOKIE_SECURE, trustProxy: TRUST_PROXY });
```

Append to `backend/.env.example`:

```
# Set both to 1 when serving over TLS behind nginx (docker-compose does this).
COOKIE_SECURE=0
TRUST_PROXY=0
```

- [ ] **Step 8: Update the test helper for the new option**

In `backend/test/api-helper.ts`, give `createTestApp` an options parameter:

```ts
export function createTestApp(opts: { cookieSecure?: boolean } = {}): TestCtx {
```

and pass it into `buildApp({ ..., cookieSecure: opts.cookieSecure ?? false })`. Existing zero-argument callers keep working.

- [ ] **Step 9: Run the tests**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: 214 + 5 = 219 pass. `settings-store.test.ts` may assert the exact default guardrails object — update it to include `stopLossWhenPaused: true` and report that as a sanctioned deviation.

- [ ] **Step 10: Commit**

```bash
git add backend/src backend/test backend/.env.example
git commit -m "feat: TLS cookie/proxy config, limiter pruning, paused-round stop-loss switch"
```
---

## Task 4: Frontend workspace scaffold, API client and formatting

No frontend exists yet. This task creates the workspace, the typed API client every later task uses, and the money-formatting helpers. Nothing renders yet beyond a placeholder — the point is that `npm test`, `npx tsc --noEmit` and `npm run build` all work before any UI is written.

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/tsconfig.node.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/.gitignore`
- Create: `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/index.css`
- Create: `frontend/src/api/types.ts`, `frontend/src/api/client.ts`, `frontend/src/lib/format.ts`
- Create: `frontend/test/setup.ts`, `frontend/test/format.test.ts`, `frontend/test/client.test.ts`

- [ ] **Step 1: Create the workspace files**

`frontend/package.json`:

```json
{
  "name": "stake-portfolio-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.101.4",
    "lightweight-charts": "^5.2.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router-dom": "^7.18.2"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.0.5",
    "jsdom": "^30.0.1",
    "msw": "^2.15.0",
    "typescript": "^7.0.2",
    "vite": "^8.2.0",
    "vitest": "^4.1.10"
  }
}
```

`frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`frontend/tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts"]
}
```

`frontend/vite.config.ts` — note `changeOrigin` plus a disabled buffer for SSE:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
```

`frontend/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>stake_portfolio</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`frontend/.gitignore`:

```
node_modules
dist
```

- [ ] **Step 2: Install and verify the toolchain**

Run: `cd frontend && npm install`
Expected: installs cleanly, `node_modules` present.

- [ ] **Step 3: Write the failing tests**

`frontend/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

`frontend/test/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dollarsToCents, formatCents, formatPct, formatQty, signedCents } from '../src/lib/format';

describe('format', () => {
  it('formats cents as AUD dollars', () => {
    expect(formatCents(5000)).toBe('$50.00');
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-2550)).toBe('-$25.50');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
  });

  it('always shows a sign for deltas', () => {
    expect(signedCents(500)).toBe('+$5.00');
    expect(signedCents(-500)).toBe('-$5.00');
    expect(signedCents(0)).toBe('$0.00');
  });

  it('converts dollar input to integer cents without float drift', () => {
    expect(dollarsToCents('50')).toBe(5000);
    expect(dollarsToCents('50.10')).toBe(5010);
    expect(dollarsToCents('0.07')).toBe(7);
    expect(dollarsToCents('1.005')).toBe(101);
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
  });

  it('formats percentages and quantities', () => {
    expect(formatPct(12.345)).toBe('12.3%');
    expect(formatPct(null)).toBe('off');
    expect(formatQty(3)).toBe('3');
    expect(formatQty(3.5)).toBe('3.5');
    expect(formatQty(0.123456)).toBe('0.1235');
  });
});
```

`frontend/test/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../src/api/client';

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed JSON and sends credentials', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(apiFetch<{ ok: boolean }>('/api/health')).resolves.toEqual({ ok: true });
    expect(vi.mocked(fetch).mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
  });

  it('serializes a JSON body with the right header', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await apiFetch('/api/rounds', { method: 'POST', body: { name: 'x' } });

    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.body).toBe('{"name":"x"}');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('throws ApiError carrying the status and the server message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'quote is stale' }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(apiFetch('/api/rounds/1/orders', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      message: 'quote is stale',
    });
    await expect(apiFetch('/api/rounds/1/orders', { method: 'POST' })).rejects.toBeInstanceOf(ApiError);
  });

  it('falls back to the status text when the error body is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    await expect(apiFetch('/api/rounds')).rejects.toMatchObject({ status: 502 });
  });

  it('marks 401 responses as unauthorized', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(apiFetch('/api/rounds')).rejects.toMatchObject({ status: 401, unauthorized: true });
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd frontend && npm test`
Expected: FAIL — cannot resolve `../src/lib/format` or `../src/api/client`.

- [ ] **Step 5: Write the formatting helpers**

`frontend/src/lib/format.ts`:

```ts
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });

/** Integer AUD cents → display string. Cents are the only money representation in this app. */
export function formatCents(cents: number): string {
  return AUD.format(cents / 100).replace('A$', '$');
}

/** Same, but always signed — for deltas, P/L and ledger amounts. */
export function signedCents(cents: number): string {
  if (cents === 0) return formatCents(0);
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

/**
 * Parse a user-entered dollar amount into integer cents.
 * Returns null for anything that is not a non-negative number, so callers can
 * block submission rather than sending NaN to the money path.
 */
export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function formatPct(pct: number | null): string {
  return pct === null ? 'off' : `${pct.toFixed(1)}%`;
}

/** Share quantities are floats; ASX holdings are whole shares. */
export function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(4)));
}

export function formatTs(iso: string, timezone = 'Australia/Sydney'): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function formatDay(iso: string, timezone = 'Australia/Sydney'): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  );
}
```

- [ ] **Step 6: Write the API types**

`frontend/src/api/types.ts` — these mirror the backend payloads exactly, including its snake_case database columns. Do not rename fields in the client; the backend serves rows verbatim.

```ts
export type Market = 'ASX' | 'US';
export type RiskProfile = 'conservative' | 'balanced' | 'aggressive' | 'custom';
export type TradingStyle = 'day' | 'swing' | 'long';
export type RoundStatus = 'active' | 'paused' | 'takeover' | 'goal_reached' | 'busted' | 'archived';
export type Actor = 'agent' | 'operator' | 'stop_loss';

export interface GuardrailConfig {
  stopLossPct: number | null;
  maxPositionPct: number | null;
  drawdownPausePct: number | null;
  stopLossWhenPaused: boolean;
}

export interface FeeConfig {
  asxFlatCents: number;
  usFxBps: number;
  slippageBps: number;
}

export interface RoundConfig {
  name: string;
  startingBalanceCents: number;
  profitGoalCents: number;
  markets: Market[];
  watchlist: string[];
  riskProfile: RiskProfile;
  tradingStyle: TradingStyle;
  guardrails: GuardrailConfig;
  fees: FeeConfig;
  model: string;
  checkinCron: string[];
  riskPrompt?: string;
  stylePrompt?: string;
}

export interface RoundListItem {
  id: number;
  name: string;
  status: RoundStatus;
  starting_balance_cents: number;
  cash_cents: number;
  profit_goal_cents: number;
  totalSkimsCents: number;
}

export interface RoundRow extends RoundListItem {
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface PositionRow {
  id: number;
  round_id: number;
  symbol: string;
  market: Market;
  quantity: number;
  cost_basis_cents: number;
  stop_loss_price: number | null;
  opened_at: string;
  closed_at: string | null;
}

export interface RoundDetail {
  round: RoundRow;
  config: RoundConfig;
  positions: PositionRow[];
  totalSkimsCents: number;
}

export interface EquityPoint {
  id: number;
  round_id: number;
  ts: string;
  cash_cents: number;
  holdings_cents: number;
  equity_cents: number;
}

export interface TradeRow {
  id: number;
  order_id: number;
  round_id: number;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price_aud: number;
  gross_cents: number;
  fee_cents: number;
  executed_at: string;
}

export interface LedgerRow {
  id: number;
  round_id: number;
  type: 'deposit' | 'buy' | 'sell' | 'fee' | 'skim';
  amount_cents: number;
  balance_after_cents: number;
  ref_order_id: number | null;
  note: string | null;
  created_at: string;
}

export interface CheckinRow {
  id: number;
  ts: string;
  status: string;
  tokens_used: number | null;
  actions_json: string;
}

export interface JournalRow {
  id: number;
  checkin_id: number | null;
  author: string;
  note: string;
  created_at: string;
}

export interface SummaryRow {
  day: string;
  digest_json: string;
  narrative: string | null;
  created_at: string;
}

export interface DailyDigest {
  trades: number;
  skimsCents: number;
  feesCents: number;
  tokensUsed: number;
  events: string[];
  journals: string[];
}

export interface EventRow {
  id: number;
  round_id: number | null;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  created_at: string;
}

export interface Quote {
  symbol: string;
  market: Market;
  price: number;
  currency: 'AUD' | 'USD';
  ts: string;
  stale: boolean;
}

export type ChartRange = '1D' | '1W' | '1M' | '3M' | 'ALL';

export interface OhlcBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface HistoryResult {
  symbol: string;
  range: ChartRange;
  interval: string;
  currency: string;
  bars: OhlcBar[];
  stale: boolean;
}

export interface SymbolRow {
  symbol: string;
  market: Market;
  name: string | null;
  archived: number;
  first_seen_at: string | null;
  last_polled_at: string | null;
}

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

export interface Settings {
  roundDefaults: Omit<RoundConfig, 'name'>;
  integrations: IntegrationSettings;
  lookAndFeel: LookAndFeelSettings;
  notifications: Record<string, boolean>;
}

export interface TradeResult {
  status: 'filled' | 'rejected';
  reason: string | null;
  skimCents: number;
}

export interface CheckinOutcome {
  status: string;
  [key: string]: unknown;
}
```

- [ ] **Step 7: Write the API client**

`frontend/src/api/client.ts`:

```ts
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }

  /** The session is gone or was never established — the shell redirects to login. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export interface ApiInit extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Every backend call goes through here. Cookies are the only auth mechanism
 * (httpOnly session cookie, spec §6.1), so credentials are always included.
 */
export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const hasBody = init.body !== undefined;
  if (hasBody) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });

  if (!response.ok) {
    let message = response.statusText || `request failed with ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // non-JSON error body (nginx 502 pages, for example) — keep the status text
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
```

- [ ] **Step 8: Write the placeholder entry point**

`frontend/src/index.css`:

```css
:root {
  --accent: #6e56cf;
  --bg: #ffffff;
  --panel: #f6f6f8;
  --border: #dcdce3;
  --text: #16161a;
  --muted: #6b6b76;
  --gain: #1a7f4b;
  --loss: #c0392b;
  --radius: 10px;
  color-scheme: light;
}

:root[data-theme='dark'] {
  --bg: #121216;
  --panel: #1b1b21;
  --border: #2c2c35;
  --text: #ececf1;
  --muted: #9a9aa6;
  --gain: #3ecf8e;
  --loss: #ef6a5c;
  color-scheme: dark;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  padding: 0.4rem 0.8rem;
}

button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: 0.5; cursor: not-allowed; }

input, select, textarea {
  font: inherit;
  padding: 0.4rem 0.6rem;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
}

table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 600; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }

.panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; }
.gain { color: var(--gain); }
.loss { color: var(--loss); }
.muted { color: var(--muted); }
.row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
.grid { display: grid; gap: 1rem; }
```

`frontend/src/App.tsx` (replaced in Task 5 — a placeholder so the build works):

```tsx
export default function App() {
  return <main className="panel">stake_portfolio</main>;
}
```

`frontend/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 9: Run tests, typecheck and build**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`
Expected: 10 tests pass, typecheck clean, `dist/` produced.

- [ ] **Step 10: Commit**

```bash
git add frontend/
git commit -m "feat: frontend workspace scaffold, typed API client, money formatting"
```

---

## Task 5: Auth provider, login page and the app shell

Spec §6.1: a login page gates the whole app; every route requires a session. The shell holds nav, the theme, logout and the global kill switch.

**Files:**
- Create: `frontend/src/auth/AuthProvider.tsx`, `frontend/src/auth/LoginPage.tsx`, `frontend/src/auth/RequireAuth.tsx`
- Create: `frontend/src/shell/AppShell.tsx`, `frontend/src/shell/KillSwitch.tsx`
- Create: `frontend/src/api/hooks.ts`
- Create: `frontend/src/components/{ErrorBox,Spinner,StatusBadge,Money}.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/main.tsx`
- Create: `frontend/test/server.ts`, `frontend/test/render.tsx`, `frontend/test/auth.test.tsx`

- [ ] **Step 1: Write the test harness**

`frontend/test/server.ts` — msw handlers shared by every UI test. Later tasks extend `handlers`; keep the fixtures here so they stay consistent.

```ts
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { RoundDetail, RoundListItem, Settings } from '../src/api/types';

export const roundListFixture: RoundListItem[] = [
  {
    id: 1, name: 'first run', status: 'active',
    starting_balance_cents: 5000, cash_cents: 3000, profit_goal_cents: 100000, totalSkimsCents: 2500,
  },
  {
    id: 2, name: 'paused run', status: 'paused',
    starting_balance_cents: 5000, cash_cents: 5000, profit_goal_cents: 100000, totalSkimsCents: 0,
  },
];

export const roundDetailFixture: RoundDetail = {
  round: {
    ...roundListFixture[0]!,
    config_json: '{}',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
  },
  config: {
    name: 'first run',
    startingBalanceCents: 5000,
    profitGoalCents: 100000,
    markets: ['US'],
    watchlist: ['AAPL'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: { stopLossPct: 10, maxPositionPct: 40, drawdownPausePct: 50, stopLossWhenPaused: true },
    fees: { asxFlatCents: 300, usFxBps: 70, slippageBps: 0 },
    model: 'claude-sonnet-5',
    checkinCron: ['30 23 * * 1-5'],
  },
  positions: [
    {
      id: 7, round_id: 1, symbol: 'AAPL', market: 'US', quantity: 2,
      cost_basis_cents: 2000, stop_loss_price: null,
      opened_at: '2026-08-01T02:00:00.000Z', closed_at: null,
    },
  ],
  totalSkimsCents: 2500,
};

export const settingsFixture: Settings = {
  roundDefaults: {
    startingBalanceCents: 5000,
    profitGoalCents: 100000,
    markets: ['US'],
    watchlist: ['AAPL', 'MSFT'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: { stopLossPct: 10, maxPositionPct: 40, drawdownPausePct: 50, stopLossWhenPaused: true },
    fees: { asxFlatCents: 300, usFxBps: 70, slippageBps: 0 },
    model: 'claude-sonnet-5',
    checkinCron: ['30 23 * * 1-5'],
  },
  integrations: { ntfy: { url: 'https://ntfy.sh', topic: 'stake', enabled: false }, pollIntervalMinutes: 5 },
  lookAndFeel: { theme: 'system', accent: '#6E56CF', chartStyle: 'line', timezone: 'Australia/Sydney' },
  notifications: { trade: true, skim: true, goal: true, stop_loss: true, drawdown: true, busted: true, error: true },
};

export const handlers = [
  http.get('/api/auth/me', () => HttpResponse.json({ username: 'chris' })),
  http.post('/api/auth/login', () => HttpResponse.json({ ok: true })),
  http.post('/api/auth/logout', () => HttpResponse.json({ ok: true })),
  http.get('/api/rounds', () => HttpResponse.json(roundListFixture)),
  http.get('/api/rounds/:id', () => HttpResponse.json(roundDetailFixture)),
  http.get('/api/rounds/:id/equity', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/trades', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/ledger', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/journal', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/summaries', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/checkins', () => HttpResponse.json([])),
  http.get('/api/events', () => HttpResponse.json([])),
  http.get('/api/settings', () => HttpResponse.json(settingsFixture)),
  http.get('/api/market/symbols', () => HttpResponse.json([])),
  http.post('/api/kill', () => HttpResponse.json({ paused: 2 })),
];

export const server = setupServer(...handlers);
```

Register it in `frontend/test/setup.ts` (replacing the one-line version from Task 4):

```ts
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// jsdom has no EventSource; the SSE hook is exercised through this stub.
class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
  close(): void {
    this.closed = true;
  }
}
vi.stubGlobal('EventSource', MockEventSource);
export { MockEventSource };
```

`frontend/test/render.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

export function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } },
  });
}

export function renderWithProviders(ui: ReactElement, initialPath = '/'): RenderResult {
  const client = makeClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper });
}
```

- [ ] **Step 2: Write the failing auth test**

`frontend/test/auth.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import App from '../src/App';
import { renderWithProviders } from './render';
import { server } from './server';

function unauthenticated(): void {
  server.use(http.get('/api/auth/me', () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 })));
}

describe('authentication', () => {
  it('shows the login page when there is no session', async () => {
    unauthenticated();
    renderWithProviders(<App />, '/rounds');

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('surfaces a failed login without navigating away', async () => {
    unauthenticated();
    server.use(http.post('/api/auth/login', () => HttpResponse.json({ error: 'invalid credentials' }, { status: 401 })));
    renderWithProviders(<App />, '/rounds');

    await userEvent.type(await screen.findByLabelText(/username/i), 'chris');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('invalid credentials')).toBeInTheDocument();
  });

  it('renders the shell for an authenticated user', async () => {
    renderWithProviders(<App />, '/rounds');

    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(screen.getByText('chris')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /markets/i })).toBeInTheDocument();
  });

  it('returns to the login page after logout', async () => {
    let authed = true;
    server.use(
      http.get('/api/auth/me', () =>
        authed ? HttpResponse.json({ username: 'chris' }) : HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
      http.post('/api/auth/logout', () => {
        authed = false;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<App />, '/rounds');

    await userEvent.click(await screen.findByRole('button', { name: /log out/i }));

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });

  it('asks for confirmation before the kill switch fires', async () => {
    let killed = false;
    server.use(
      http.post('/api/kill', () => {
        killed = true;
        return HttpResponse.json({ paused: 2 });
      }),
    );
    renderWithProviders(<App />, '/rounds');

    await userEvent.click(await screen.findByRole('button', { name: /kill switch/i }));
    expect(killed).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: /pause all rounds/i }));
    await waitFor(() => expect(killed).toBe(true));
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd frontend && npm test -- auth`
Expected: FAIL — no `AuthProvider`, no shell.

- [ ] **Step 4: Write the shared query hooks**

`frontend/src/api/hooks.ts` — the single place query keys are defined. Later tasks add hooks here; never inline a raw key string in a component.

```ts
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from './client';
import type {
  CheckinOutcome, CheckinRow, ChartRange, EquityPoint, EventRow, HistoryResult, JournalRow,
  LedgerRow, RoundConfig, RoundDetail, RoundListItem, Settings, SummaryRow, SymbolRow, TradeResult, TradeRow,
} from './types';

export const qk = {
  me: ['me'] as const,
  rounds: ['rounds'] as const,
  round: (id: number) => ['round', id] as const,
  equity: (id: number) => ['round', id, 'equity'] as const,
  trades: (id: number) => ['round', id, 'trades'] as const,
  ledger: (id: number) => ['round', id, 'ledger'] as const,
  journal: (id: number) => ['round', id, 'journal'] as const,
  summaries: (id: number) => ['round', id, 'summaries'] as const,
  checkins: (id: number) => ['round', id, 'checkins'] as const,
  events: (roundId?: number) => ['events', roundId ?? 'all'] as const,
  settings: ['settings'] as const,
  symbols: ['symbols'] as const,
  history: (symbol: string, range: ChartRange) => ['history', symbol, range] as const,
};

export function useMe(): UseQueryResult<{ username: string }> {
  return useQuery({ queryKey: qk.me, queryFn: () => apiFetch<{ username: string }>('/api/auth/me'), retry: false });
}

export function useLogin(): UseMutationResult<{ ok: true }, Error, { username: string; password: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ ok: true }>('/api/auth/login', { method: 'POST', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useLogout(): UseMutationResult<{ ok: true }, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => client.clear(),
  });
}

export function useChangePassword(): UseMutationResult<{ ok: true }, Error, { current: string; next: string }> {
  return useMutation({ mutationFn: (body) => apiFetch<{ ok: true }>('/api/auth/password', { method: 'POST', body }) });
}

export function useRounds(): UseQueryResult<RoundListItem[]> {
  return useQuery({ queryKey: qk.rounds, queryFn: () => apiFetch<RoundListItem[]>('/api/rounds') });
}

export function useRound(id: number): UseQueryResult<RoundDetail> {
  return useQuery({ queryKey: qk.round(id), queryFn: () => apiFetch<RoundDetail>(`/api/rounds/${id}`) });
}

export function useEquity(id: number): UseQueryResult<EquityPoint[]> {
  return useQuery({ queryKey: qk.equity(id), queryFn: () => apiFetch<EquityPoint[]>(`/api/rounds/${id}/equity`) });
}

export function useTrades(id: number): UseQueryResult<TradeRow[]> {
  return useQuery({ queryKey: qk.trades(id), queryFn: () => apiFetch<TradeRow[]>(`/api/rounds/${id}/trades`) });
}

export function useLedger(id: number): UseQueryResult<LedgerRow[]> {
  return useQuery({ queryKey: qk.ledger(id), queryFn: () => apiFetch<LedgerRow[]>(`/api/rounds/${id}/ledger`) });
}

export function useJournal(id: number): UseQueryResult<JournalRow[]> {
  return useQuery({ queryKey: qk.journal(id), queryFn: () => apiFetch<JournalRow[]>(`/api/rounds/${id}/journal`) });
}

export function useSummaries(id: number): UseQueryResult<SummaryRow[]> {
  return useQuery({ queryKey: qk.summaries(id), queryFn: () => apiFetch<SummaryRow[]>(`/api/rounds/${id}/summaries`) });
}

export function useCheckins(id: number): UseQueryResult<CheckinRow[]> {
  return useQuery({ queryKey: qk.checkins(id), queryFn: () => apiFetch<CheckinRow[]>(`/api/rounds/${id}/checkins`) });
}

export function useEvents(roundId?: number): UseQueryResult<EventRow[]> {
  const query = roundId === undefined ? '' : `?roundId=${roundId}`;
  return useQuery({ queryKey: qk.events(roundId), queryFn: () => apiFetch<EventRow[]>(`/api/events${query}`) });
}

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({ queryKey: qk.settings, queryFn: () => apiFetch<Settings>('/api/settings') });
}

export function useSaveSettings<K extends keyof Settings>(
  namespace: K,
): UseMutationResult<{ ok: true }, Error, Settings[K]> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ ok: true }>(`/api/settings/${namespace}`, { method: 'PUT', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.settings }),
  });
}

export function useSymbols(): UseQueryResult<SymbolRow[]> {
  return useQuery({ queryKey: qk.symbols, queryFn: () => apiFetch<SymbolRow[]>('/api/market/symbols') });
}

export function useHistory(symbol: string, range: ChartRange): UseQueryResult<HistoryResult> {
  return useQuery({
    queryKey: qk.history(symbol, range),
    queryFn: () => apiFetch<HistoryResult>(`/api/market/history?symbol=${encodeURIComponent(symbol)}&range=${range}`),
    enabled: symbol !== '',
  });
}

export function useKillSwitch(): UseMutationResult<{ paused: number }, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ paused: number }>('/api/kill', { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.rounds }),
  });
}

export function useRoundStatus(id: number): UseMutationResult<{ status: string }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action) => apiFetch<{ status: string }>(`/api/rounds/${id}/status`, { method: 'POST', body: { action } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.round(id) });
      void client.invalidateQueries({ queryKey: qk.rounds });
    },
  });
}

export function usePatchConfig(id: number): UseMutationResult<{ changed: number }, Error, Partial<RoundConfig>> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ changed: number }>(`/api/rounds/${id}/config`, { method: 'PATCH', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.round(id) }),
  });
}

export interface OrderInput {
  symbol: string;
  side: 'buy' | 'sell';
  amountCents?: number;
  quantity?: number | 'all';
}

export function usePlaceOrder(id: number): UseMutationResult<TradeResult, Error, OrderInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<TradeResult>(`/api/rounds/${id}/orders`, { method: 'POST', body }),
    onSuccess: () => {
      for (const key of [qk.round(id), qk.trades(id), qk.ledger(id), qk.equity(id), qk.rounds]) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useRunCheckin(id: number): UseMutationResult<CheckinOutcome, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<CheckinOutcome>(`/api/rounds/${id}/checkin`, { method: 'POST' }),
    onSuccess: () => {
      for (const key of [qk.round(id), qk.checkins(id), qk.journal(id), qk.trades(id), qk.ledger(id)]) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useCreateRound(): UseMutationResult<{ id: number }, Error, Partial<RoundConfig> & { name: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ id: number }>('/api/rounds', { method: 'POST', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.rounds }),
  });
}
```

- [ ] **Step 5: Write the shared components**

`frontend/src/components/Spinner.tsx`:

```tsx
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <p className="muted" role="status">
      {label}…
    </p>
  );
}
```

`frontend/src/components/ErrorBox.tsx`:

```tsx
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p className="loss" role="alert">
      {message}
    </p>
  );
}
```

`frontend/src/components/StatusBadge.tsx`:

```tsx
import type { RoundStatus } from '../api/types';

const LABELS: Record<RoundStatus, string> = {
  active: 'active',
  paused: 'paused',
  takeover: 'takeover',
  goal_reached: 'goal reached',
  busted: 'busted',
  archived: 'archived',
};

const COLORS: Record<RoundStatus, string> = {
  active: 'var(--gain)',
  paused: 'var(--muted)',
  takeover: 'var(--accent)',
  goal_reached: 'var(--gain)',
  busted: 'var(--loss)',
  archived: 'var(--muted)',
};

export function StatusBadge({ status }: { status: RoundStatus }) {
  return (
    <span
      style={{
        border: `1px solid ${COLORS[status]}`,
        color: COLORS[status],
        borderRadius: 999,
        padding: '0.1rem 0.55rem',
        fontSize: '0.8em',
      }}
    >
      {LABELS[status]}
    </span>
  );
}
```

`frontend/src/components/Money.tsx`:

```tsx
import { formatCents, signedCents } from '../lib/format';

export function Money({ cents, signed = false }: { cents: number; signed?: boolean }) {
  const className = cents > 0 ? 'gain' : cents < 0 ? 'loss' : undefined;
  return <span className={signed ? className : undefined}>{signed ? signedCents(cents) : formatCents(cents)}</span>;
}
```

- [ ] **Step 6: Write the auth pieces**

`frontend/src/auth/AuthProvider.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react';
import { useMe } from '../api/hooks';

interface AuthState {
  username: string | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ username: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const value: AuthState = {
    username: me.data?.username ?? null,
    loading: me.isPending,
  };
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
```

`frontend/src/auth/LoginPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useLogin } from '../api/hooks';
import { ErrorBox } from '../components/ErrorBox';

export function LoginPage() {
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    login.mutate({ username, password });
  }

  return (
    <main style={{ maxWidth: 340, margin: '12vh auto' }}>
      <form className="panel grid" onSubmit={onSubmit}>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Sign in</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <ErrorBox error={login.error} />
        <button className="primary" type="submit" disabled={login.isPending}>
          Sign in
        </button>
      </form>
    </main>
  );
}
```

Note: `label` wrapping the input gives `getByLabelText` a working association without `htmlFor`/`id` pairs. Keep that pattern in every form in this plan.

`frontend/src/auth/RequireAuth.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Spinner } from '../components/Spinner';
import { LoginPage } from './LoginPage';
import { useAuth } from './AuthProvider';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { username, loading } = useAuth();
  if (loading) return <Spinner label="Checking session" />;
  if (username === null) return <LoginPage />;
  return <>{children}</>;
}
```

- [ ] **Step 7: Write the shell**

`frontend/src/shell/KillSwitch.tsx`:

```tsx
import { useState } from 'react';
import { useKillSwitch } from '../api/hooks';

/** Spec §5: the kill switch pauses every active round. Protective stops keep running. */
export function KillSwitch() {
  const [confirming, setConfirming] = useState(false);
  const kill = useKillSwitch();

  if (!confirming) {
    return (
      <button onClick={() => setConfirming(true)} title="Pause every active round">
        Kill switch
      </button>
    );
  }

  return (
    <span className="row">
      <button
        className="primary"
        onClick={() => {
          kill.mutate(undefined, { onSettled: () => setConfirming(false) });
        }}
        disabled={kill.isPending}
      >
        Pause all rounds
      </button>
      <button onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  );
}
```

`frontend/src/shell/AppShell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useLogout } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { KillSwitch } from './KillSwitch';

const LINKS = [
  { to: '/rounds', label: 'Rounds' },
  { to: '/markets', label: 'Markets' },
  { to: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { username } = useAuth();
  const logout = useLogout();

  return (
    <>
      <nav
        className="row"
        style={{ justifyContent: 'space-between', padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)' }}
      >
        <span className="row">
          <strong style={{ marginRight: '0.5rem' }}>stake_portfolio</strong>
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              style={({ isActive }) => ({
                color: isActive ? 'var(--accent)' : 'var(--text)',
                textDecoration: 'none',
                fontWeight: isActive ? 600 : 400,
              })}
            >
              {link.label}
            </NavLink>
          ))}
        </span>
        <span className="row">
          <KillSwitch />
          <span className="muted">{username}</span>
          <button onClick={() => logout.mutate()}>Log out</button>
        </span>
      </nav>
      <main style={{ padding: '1rem', maxWidth: 1200, margin: '0 auto' }}>{children}</main>
    </>
  );
}
```

- [ ] **Step 8: Wire the router**

Replace `frontend/src/App.tsx`. Pages referenced here arrive in later tasks; create each one as a one-line placeholder now (`export function MarketsPage() { return <p>markets</p>; }`) and fill it in when its task comes up, so the router is complete from the start and the build never breaks.

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { AppShell } from './shell/AppShell';
import { MarketsPage } from './pages/MarketsPage';
import { NewRoundPage } from './pages/NewRoundPage';
import { RoundDetailPage } from './pages/RoundDetailPage';
import { RoundsPage } from './pages/RoundsPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  return (
    <AuthProvider>
      <RequireAuth>
        <AppShell>
          <Routes>
            <Route path="/" element={<Navigate to="/rounds" replace />} />
            <Route path="/rounds" element={<RoundsPage />} />
            <Route path="/rounds/new" element={<NewRoundPage />} />
            <Route path="/rounds/:id" element={<RoundDetailPage />} />
            <Route path="/markets" element={<MarketsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<p>Not found.</p>} />
          </Routes>
        </AppShell>
      </RequireAuth>
    </AuthProvider>
  );
}
```

Update `frontend/src/main.tsx` to install the providers:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 10_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

`retry: false` matters: without it a 401 from `/api/auth/me` retries three times before the login page appears.

- [ ] **Step 9: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: the 5 auth tests plus the 10 from Task 4 pass.

- [ ] **Step 10: Commit**

```bash
git add frontend/
git commit -m "feat: auth provider, login page, app shell with kill switch"
```

---

## Task 6: SSE live updates

Spec §6: "Live updates via SSE." The backend streams `event_log` rows at `/api/events/stream`. The rule here: an event never carries UI state — it only tells the client which query keys are stale.

**Files:**
- Create: `frontend/src/events/useEventStream.ts`, `frontend/src/events/EventFeed.tsx`
- Modify: `frontend/src/App.tsx`
- Create: `frontend/test/events.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/events.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { qk } from '../src/api/hooks';
import { EventFeed } from '../src/events/EventFeed';
import { useEventStream } from '../src/events/useEventStream';
import { makeClient, renderWithProviders } from './render';
import { MockEventSource } from './setup';
import { server } from './server';

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('SSE', () => {
  it('opens the stream once and closes it on unmount', () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    const { unmount } = renderHook(() => useEventStream(), { wrapper: wrapper(client) });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toBe('/api/events/stream');

    unmount();
    expect(MockEventSource.instances[0]!.closed).toBe(true);
  });

  it('scopes the stream to a round when given an id', () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    renderHook(() => useEventStream(7), { wrapper: wrapper(client) });

    expect(MockEventSource.instances[0]!.url).toBe('/api/events/stream?roundId=7');
  });

  it('invalidates the round queries a trade event touches', async () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useEventStream(1), { wrapper: wrapper(client) });

    act(() => {
      MockEventSource.instances[0]!.emit({
        id: 12, round_id: 1, level: 'info', kind: 'trade', message: 'round 1 buy 2 AAPL', created_at: '2026-08-02T01:00:00.000Z',
      });
    });

    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(qk.trades(1)));
    expect(keys).toContain(JSON.stringify(qk.round(1)));
    expect(keys).toContain(JSON.stringify(qk.rounds));
  });

  it('always refreshes the event list itself', async () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useEventStream(), { wrapper: wrapper(client) });

    act(() => {
      MockEventSource.instances[0]!.emit({
        id: 13, round_id: null, level: 'warn', kind: 'poll_failed', message: 'yahoo timeout', created_at: '2026-08-02T01:00:00.000Z',
      });
    });

    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(qk.events(undefined)));
  });

  it('ignores malformed event payloads without throwing', () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    renderHook(() => useEventStream(), { wrapper: wrapper(client) });

    expect(() => {
      act(() => {
        MockEventSource.instances[0]!.onmessage?.(new MessageEvent('message', { data: 'not json' }));
      });
    }).not.toThrow();
  });

  it('renders recent events newest first with their level', async () => {
    server.use(
      http.get('/api/events', () =>
        HttpResponse.json([
          { id: 1, round_id: 1, level: 'info', kind: 'trade', message: 'bought AAPL', created_at: '2026-08-02T01:00:00.000Z' },
          { id: 2, round_id: 1, level: 'warn', kind: 'stop_loss', message: 'stop-loss on AAPL', created_at: '2026-08-02T02:00:00.000Z' },
        ]),
      ),
    );
    renderWithProviders(<EventFeed roundId={1} />);

    const items = await screen.findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('stop-loss on AAPL');
    expect(items[1]).toHaveTextContent('bought AAPL');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- events`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the hook**

`frontend/src/events/useEventStream.ts`:

```ts
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { qk } from '../api/hooks';
import type { EventRow } from '../api/types';

/** Which round-scoped query keys each event kind makes stale. */
function staleKeys(kind: string, roundId: number): readonly (readonly unknown[])[] {
  switch (kind) {
    case 'trade':
    case 'order_rejected':
    case 'stop_loss':
      return [qk.trades(roundId), qk.ledger(roundId), qk.round(roundId), qk.equity(roundId), qk.rounds];
    case 'skim':
      return [qk.ledger(roundId), qk.round(roundId), qk.rounds];
    case 'round_status':
    case 'round_created':
    case 'kill_switch':
      return [qk.round(roundId), qk.rounds];
    case 'config_change':
      return [qk.round(roundId)];
    case 'checkin_complete':
    case 'checkin_failed':
    case 'checkin_interrupted':
      return [qk.checkins(roundId), qk.journal(roundId), qk.round(roundId)];
    case 'daily_summary':
      return [qk.summaries(roundId)];
    default:
      return [];
  }
}

/**
 * Subscribes to the server event stream and invalidates the queries each event
 * touches. Events are notifications, never data — the UI always refetches.
 */
export function useEventStream(roundId?: number): void {
  const client = useQueryClient();

  useEffect(() => {
    const url = roundId === undefined ? '/api/events/stream' : `/api/events/stream?roundId=${roundId}`;
    const source = new EventSource(url);

    source.onmessage = (message: MessageEvent) => {
      let event: EventRow;
      try {
        event = JSON.parse(String(message.data)) as EventRow;
      } catch {
        return; // a truncated frame is not worth tearing the stream down over
      }
      void client.invalidateQueries({ queryKey: qk.events(roundId) });
      if (event.round_id === null) return;
      for (const key of staleKeys(event.kind, event.round_id)) {
        void client.invalidateQueries({ queryKey: key });
      }
    };

    // The browser reconnects automatically (the server sends `retry: 5000`).
    return () => source.close();
  }, [client, roundId]);
}
```

- [ ] **Step 4: Write the feed**

`frontend/src/events/EventFeed.tsx`:

```tsx
import { useEvents } from '../api/hooks';
import { ErrorBox } from '../components/ErrorBox';
import { Spinner } from '../components/Spinner';
import { formatTs } from '../lib/format';

const LEVEL_CLASS: Record<string, string> = { info: 'muted', warn: 'loss', error: 'loss' };

export function EventFeed({ roundId, limit = 40 }: { roundId?: number; limit?: number }) {
  const events = useEvents(roundId);

  if (events.isPending) return <Spinner label="Loading events" />;
  if (events.error) return <ErrorBox error={events.error} />;

  const rows = [...(events.data ?? [])].sort((a, b) => b.id - a.id).slice(0, limit);
  if (rows.length === 0) return <p className="muted">No events yet.</p>;

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map((event) => (
        <li key={event.id} style={{ padding: '0.3rem 0', borderBottom: '1px solid var(--border)' }}>
          <span className="muted" style={{ marginRight: '0.5rem' }}>
            {formatTs(event.created_at)}
          </span>
          <span className={LEVEL_CLASS[event.level]} style={{ marginRight: '0.5rem' }}>
            {event.kind}
          </span>
          {event.message}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Subscribe globally**

In `frontend/src/App.tsx`, call the hook inside a small component rendered under `AppShell` so it only runs when authenticated:

```tsx
function LiveUpdates() {
  useEventStream();
  return null;
}
```

Render `<LiveUpdates />` as the first child inside `<AppShell>`, and add the import. Round-detail subscribes separately with its own id in Task 9 — two `EventSource` connections is fine and keeps the round page responsive to its own filtered stream.

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 6 new tests pass, everything else still green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/events frontend/src/App.tsx frontend/test/events.test.tsx
git commit -m "feat: SSE stream drives query invalidation, event feed"
```

---

## Task 7: Chart primitives

Three chart components, and they are the only files allowed to import `lightweight-charts`. jsdom cannot render canvas, so their tests mock the library and assert on the data handed to it. `Sparkline` is deliberately hand-rolled SVG — a card-sized chart does not justify a chart engine instance per card.

**Files:**
- Create: `frontend/src/components/charts/chartTheme.ts`
- Create: `frontend/src/components/charts/Sparkline.tsx`
- Create: `frontend/src/components/charts/EquityChart.tsx`
- Create: `frontend/src/components/charts/PriceChart.tsx`
- Create: `frontend/test/charts.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/charts.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EquityChart } from '../src/components/charts/EquityChart';
import { PriceChart } from '../src/components/charts/PriceChart';
import { Sparkline } from '../src/components/charts/Sparkline';
import type { EquityPoint, OhlcBar, TradeRow } from '../src/api/types';

const series = {
  setData: vi.fn(),
  setMarkers: vi.fn(),
  priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
};
const chart = {
  addSeries: vi.fn(() => series),
  applyOptions: vi.fn(),
  priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
  timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
  remove: vi.fn(),
};
const createSeriesMarkers = vi.fn();

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => chart),
  createSeriesMarkers: (...args: unknown[]) => createSeriesMarkers(...args),
  AreaSeries: 'AreaSeries',
  CandlestickSeries: 'CandlestickSeries',
  HistogramSeries: 'HistogramSeries',
  LineSeries: 'LineSeries',
  ColorType: { Solid: 'solid' },
}));

const equity: EquityPoint[] = [
  { id: 1, round_id: 1, ts: '2026-08-01T00:00:00.000Z', cash_cents: 5000, holdings_cents: 0, equity_cents: 5000 },
  { id: 2, round_id: 1, ts: '2026-08-02T00:00:00.000Z', cash_cents: 3000, holdings_cents: 2500, equity_cents: 5500 },
];

const trades: TradeRow[] = [
  {
    id: 1, order_id: 1, round_id: 1, symbol: 'AAPL', side: 'buy', quantity: 2,
    price_aud: 10, gross_cents: 2000, fee_cents: 0, executed_at: '2026-08-01T12:00:00.000Z',
  },
];

const bars: OhlcBar[] = [
  { ts: '2026-08-01T00:00:00.000Z', open: 9, high: 11, low: 8, close: 10, volume: 100 },
  { ts: '2026-08-02T00:00:00.000Z', open: 10, high: 12, low: 9, close: 11, volume: 120 },
];

describe('charts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Sparkline draws a polyline through the values', () => {
    const { container } = render(<Sparkline values={[100, 120, 90, 150]} width={80} height={20} />);
    const polyline = container.querySelector('polyline')!;
    const points = polyline.getAttribute('points')!.split(' ');
    expect(points).toHaveLength(4);
    expect(points[0]!.startsWith('0,')).toBe(true);
    expect(points[3]!.startsWith('80,')).toBe(true);
  });

  it('Sparkline renders a flat line when every value is identical', () => {
    const { container } = render(<Sparkline values={[100, 100, 100]} width={60} height={20} />);
    const ys = container
      .querySelector('polyline')!
      .getAttribute('points')!
      .split(' ')
      .map((p) => p.split(',')[1]);
    expect(new Set(ys).size).toBe(1);
  });

  it('Sparkline renders nothing for an empty series', () => {
    const { container } = render(<Sparkline values={[]} />);
    expect(container.querySelector('polyline')).toBeNull();
  });

  it('EquityChart feeds dollar values in chronological order', () => {
    render(<EquityChart points={[...equity].reverse()} trades={[]} />);
    const data = series.setData.mock.calls[0]![0] as { time: number; value: number }[];
    expect(data.map((d) => d.value)).toEqual([50, 55]);
    expect(data[0]!.time).toBeLessThan(data[1]!.time);
  });

  it('EquityChart places a marker per trade', () => {
    render(<EquityChart points={equity} trades={trades} />);
    const markers = createSeriesMarkers.mock.calls[0]![1] as { text: string; position: string }[];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toContain('AAPL');
    expect(markers[0]!.position).toBe('belowBar');
  });

  it('EquityChart shows an empty state instead of a chart with no data', () => {
    render(<EquityChart points={[]} trades={[]} />);
    expect(screen.getByText(/no equity history/i)).toBeInTheDocument();
  });

  it('PriceChart renders candles plus a volume series', () => {
    render(<PriceChart bars={bars} style="candles" trades={[]} />);
    const seriesTypes = chart.addSeries.mock.calls.map((call) => call[0]);
    expect(seriesTypes).toContain('CandlestickSeries');
    expect(seriesTypes).toContain('HistogramSeries');
  });

  it('PriceChart renders a line series in line mode', () => {
    render(<PriceChart bars={bars} style="line" trades={[]} />);
    const seriesTypes = chart.addSeries.mock.calls.map((call) => call[0]);
    expect(seriesTypes).toContain('LineSeries');
    expect(seriesTypes).not.toContain('CandlestickSeries');
  });

  it('PriceChart adds a moving-average series when asked', () => {
    render(<PriceChart bars={bars} style="line" trades={[]} movingAverage={2} />);
    const lineCalls = chart.addSeries.mock.calls.filter((call) => call[0] === 'LineSeries');
    expect(lineCalls.length).toBe(2);
  });

  it('PriceChart tears the chart down on unmount', () => {
    const { unmount } = render(<PriceChart bars={bars} style="line" trades={[]} />);
    unmount();
    expect(chart.remove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- charts`
Expected: FAIL — chart modules do not exist.

- [ ] **Step 3: Write the theme helper**

`frontend/src/components/charts/chartTheme.ts`:

```ts
import { ColorType, type DeepPartial, type ChartOptions, type UTCTimestamp } from 'lightweight-charts';

/** lightweight-charts wants seconds since epoch, not milliseconds or ISO strings. */
export function toChartTime(iso: string): UTCTimestamp {
  return Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

export function baseChartOptions(height: number): DeepPartial<ChartOptions> {
  const text = cssVar('--text', '#16161a');
  const border = cssVar('--border', '#dcdce3');
  return {
    height,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: text,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: border },
      horzLines: { color: border },
    },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
    autoSize: true,
  };
}

export const CHART_COLORS = {
  up: '#1a7f4b',
  down: '#c0392b',
  accent: '#6e56cf',
  volume: 'rgba(110, 86, 207, 0.35)',
};
```

- [ ] **Step 4: Write the Sparkline**

`frontend/src/components/charts/Sparkline.tsx`:

```tsx
/** Pure SVG. Cards render dozens of these; a chart engine per card is not worth it. */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  color = 'var(--accent)',
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length === 0) return <svg width={width} height={height} aria-hidden="true" />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = values.length === 1 ? 0 : width / (values.length - 1);

  const points = values
    .map((value, index) => {
      const x = index * step;
      // A flat series has no span to scale against — draw it down the middle.
      const y = span === 0 ? height / 2 : height - ((value - min) / span) * height;
      return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} role="img" aria-label="equity trend">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
```

- [ ] **Step 5: Write the EquityChart**

`frontend/src/components/charts/EquityChart.tsx`:

```tsx
import { AreaSeries, createChart, createSeriesMarkers, type IChartApi, type SeriesMarker, type Time } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { EquityPoint, TradeRow } from '../../api/types';
import { baseChartOptions, CHART_COLORS, toChartTime } from './chartTheme';

export interface EquityChartProps {
  points: EquityPoint[];
  trades: TradeRow[];
  /** Extra markers: skims, guardrail firings, config changes (spec §6). */
  extraMarkers?: SeriesMarker<Time>[];
  height?: number;
}

export function EquityChart({ points, trades, extraMarkers = [], height = 260 }: EquityChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (container.current === null || points.length === 0) return;

    const chart = createChart(container.current, baseChartOptions(height));
    chartRef.current = chart;
    const series = chart.addSeries(AreaSeries, {
      lineColor: CHART_COLORS.accent,
      topColor: 'rgba(110, 86, 207, 0.35)',
      bottomColor: 'rgba(110, 86, 207, 0.02)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    // The API serves newest-first; charts need oldest-first.
    const data = [...points]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .map((point) => ({ time: toChartTime(point.ts), value: point.equity_cents / 100 }));
    series.setData(data);

    const tradeMarkers: SeriesMarker<Time>[] = trades.map((trade) => ({
      time: toChartTime(trade.executed_at),
      position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: trade.side === 'buy' ? CHART_COLORS.up : CHART_COLORS.down,
      shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: `${trade.side} ${trade.symbol}`,
    }));
    const markers = [...tradeMarkers, ...extraMarkers].sort((a, b) => Number(a.time) - Number(b.time));
    createSeriesMarkers(series, markers);

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [points, trades, extraMarkers, height]);

  if (points.length === 0) return <p className="muted">No equity history yet.</p>;
  return <div ref={container} style={{ width: '100%', height }} />;
}
```

- [ ] **Step 6: Write the PriceChart**

`frontend/src/components/charts/PriceChart.tsx`:

```tsx
import {
  CandlestickSeries, createChart, createSeriesMarkers, HistogramSeries, LineSeries,
  type IChartApi, type SeriesMarker, type Time,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { OhlcBar, TradeRow } from '../../api/types';
import { baseChartOptions, CHART_COLORS, toChartTime } from './chartTheme';

export interface PriceChartProps {
  bars: OhlcBar[];
  style: 'line' | 'candles';
  trades: TradeRow[];
  /** Simple moving-average window in bars. Undefined hides the overlay. */
  movingAverage?: number;
  height?: number;
}

function sma(bars: OhlcBar[], window: number): { time: ReturnType<typeof toChartTime>; value: number }[] {
  if (window <= 1) return [];
  const out: { time: ReturnType<typeof toChartTime>; value: number }[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.close;
    if (i >= window) sum -= bars[i - window]!.close;
    if (i >= window - 1) out.push({ time: toChartTime(bars[i]!.ts), value: sum / window });
  }
  return out;
}

export function PriceChart({ bars, style, trades, movingAverage, height = 340 }: PriceChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (container.current === null || bars.length === 0) return;

    const ordered = [...bars].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const chart = createChart(container.current, baseChartOptions(height));
    chartRef.current = chart;

    const priceSeries =
      style === 'candles'
        ? chart.addSeries(CandlestickSeries, {
            upColor: CHART_COLORS.up,
            downColor: CHART_COLORS.down,
            borderVisible: false,
            wickUpColor: CHART_COLORS.up,
            wickDownColor: CHART_COLORS.down,
          })
        : chart.addSeries(LineSeries, { color: CHART_COLORS.accent, lineWidth: 2 });

    priceSeries.setData(
      style === 'candles'
        ? ordered.map((bar) => ({
            time: toChartTime(bar.ts), open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          }))
        : ordered.map((bar) => ({ time: toChartTime(bar.ts), value: bar.close })),
    );

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: CHART_COLORS.volume,
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    volumeSeries.setData(
      ordered.filter((bar) => bar.volume !== null).map((bar) => ({ time: toChartTime(bar.ts), value: bar.volume! })),
    );
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    if (movingAverage !== undefined && movingAverage > 1) {
      const maSeries = chart.addSeries(LineSeries, { color: '#e0a020', lineWidth: 1 });
      maSeries.setData(sma(ordered, movingAverage));
    }

    const markers: SeriesMarker<Time>[] = trades.map((trade) => ({
      time: toChartTime(trade.executed_at),
      position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: trade.side === 'buy' ? CHART_COLORS.up : CHART_COLORS.down,
      shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: `${trade.side} ${trade.quantity} @ ${trade.price_aud.toFixed(2)}`,
    }));
    createSeriesMarkers(priceSeries, markers.sort((a, b) => Number(a.time) - Number(b.time)));

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, style, trades, movingAverage, height]);

  if (bars.length === 0) return <p className="muted">No price history for this symbol.</p>;
  return <div ref={container} style={{ width: '100%', height }} />;
}
```

- [ ] **Step 7: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 10 new tests pass.

If `createSeriesMarkers` or `chart.addSeries` do not exist at runtime, the installed `lightweight-charts` is v4, not v5 — the v4 API is `chart.addCandlestickSeries()` and `series.setMarkers()`. Check `node_modules/lightweight-charts/package.json`, and if it is v4 either upgrade to `^5` or adapt these three files (and only these three) to the v4 calls. Report which you did.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/charts frontend/test/charts.test.tsx
git commit -m "feat: sparkline, equity and price chart components"
```

---

## Task 8: Rounds overview page

Spec §6: "cards: state, equity sparkline, pocketed total, risk/style badges."

**Files:**
- Create/replace: `frontend/src/pages/RoundsPage.tsx`
- Create: `frontend/test/rounds-page.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/rounds-page.test.tsx`:

```tsx
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { RoundsPage } from '../src/pages/RoundsPage';
import { renderWithProviders } from './render';
import { roundListFixture, server } from './server';

vi.mock('../src/components/charts/Sparkline', () => ({
  Sparkline: ({ values }: { values: number[] }) => <div data-testid="sparkline">{values.join(',')}</div>,
}));

describe('rounds overview', () => {
  it('lists a card per round with money and status', async () => {
    renderWithProviders(<RoundsPage />);

    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(roundListFixture.length);

    const first = within(cards[0]!);
    expect(first.getByRole('heading', { name: 'first run' })).toBeInTheDocument();
    expect(first.getByText('active')).toBeInTheDocument();
    expect(first.getByText('$25.00')).toBeInTheDocument(); // pocketed
    expect(first.getByText('$30.00')).toBeInTheDocument(); // cash
  });

  it('shows progress toward the profit goal', async () => {
    renderWithProviders(<RoundsPage />);

    const cards = await screen.findAllByRole('article');
    const bar = within(cards[0]!).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '2500');
    expect(bar).toHaveAttribute('aria-valuemax', '100000');
  });

  it('renders an equity sparkline per round', async () => {
    server.use(
      http.get('/api/rounds/1/equity', () =>
        HttpResponse.json([
          { id: 2, round_id: 1, ts: '2026-08-02T00:00:00.000Z', cash_cents: 3000, holdings_cents: 2500, equity_cents: 5500 },
          { id: 1, round_id: 1, ts: '2026-08-01T00:00:00.000Z', cash_cents: 5000, holdings_cents: 0, equity_cents: 5000 },
        ]),
      ),
    );
    renderWithProviders(<RoundsPage />);

    const cards = await screen.findAllByRole('article');
    // Oldest-first, in dollars.
    expect(await within(cards[0]!).findByTestId('sparkline')).toHaveTextContent('50,55');
  });

  it('links each card to its detail page and offers a new round', async () => {
    renderWithProviders(<RoundsPage />);

    expect(await screen.findByRole('link', { name: /first run/i })).toHaveAttribute('href', '/rounds/1');
    expect(screen.getByRole('link', { name: /new round/i })).toHaveAttribute('href', '/rounds/new');
  });

  it('shows an empty state when there are no rounds', async () => {
    server.use(http.get('/api/rounds', () => HttpResponse.json([])));
    renderWithProviders(<RoundsPage />);

    expect(await screen.findByText(/no rounds yet/i)).toBeInTheDocument();
  });

  it('surfaces a load failure', async () => {
    server.use(http.get('/api/rounds', () => HttpResponse.json({ error: 'database locked' }, { status: 500 })));
    renderWithProviders(<RoundsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('database locked');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- rounds-page`
Expected: FAIL — `RoundsPage` is still the placeholder.

- [ ] **Step 3: Write the page**

Replace `frontend/src/pages/RoundsPage.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { useEquity, useRound, useRounds } from '../api/hooks';
import type { RoundListItem } from '../api/types';
import { Sparkline } from '../components/charts/Sparkline';
import { ErrorBox } from '../components/ErrorBox';
import { Money } from '../components/Money';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { formatCents } from '../lib/format';

function GoalProgress({ pocketed, goal }: { pocketed: number; goal: number }) {
  const pct = goal <= 0 ? 0 : Math.min(100, (pocketed / goal) * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pocketed}
      aria-valuemin={0}
      aria-valuemax={goal}
      aria-label={`${formatCents(pocketed)} of ${formatCents(goal)} pocketed`}
      style={{ background: 'var(--border)', borderRadius: 999, height: 8, overflow: 'hidden' }}
    >
      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gain)' }} />
    </div>
  );
}

function RoundCard({ round }: { round: RoundListItem }) {
  // Badges live in config, which the list endpoint does not return; the detail
  // query is already cached by the time a user clicks through.
  const detail = useRound(round.id);
  const equity = useEquity(round.id);
  const points = [...(equity.data ?? [])]
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .map((p) => p.equity_cents / 100);

  return (
    <article className="panel grid" style={{ gap: '0.6rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
          <Link to={`/rounds/${round.id}`} style={{ color: 'inherit' }}>
            {round.name}
          </Link>
        </h2>
        <StatusBadge status={round.status} />
      </div>

      <Sparkline values={points} />

      <dl className="row" style={{ justifyContent: 'space-between', margin: 0 }}>
        <div>
          <dt className="muted">Pocketed</dt>
          <dd style={{ margin: 0 }}>
            <Money cents={round.totalSkimsCents} />
          </dd>
        </div>
        <div>
          <dt className="muted">Cash</dt>
          <dd style={{ margin: 0 }}>
            <Money cents={round.cash_cents} />
          </dd>
        </div>
        <div>
          <dt className="muted">Bankroll</dt>
          <dd style={{ margin: 0 }}>
            <Money cents={round.starting_balance_cents} />
          </dd>
        </div>
      </dl>

      <GoalProgress pocketed={round.totalSkimsCents} goal={round.profit_goal_cents} />

      {detail.data && (
        <div className="row muted" style={{ fontSize: '0.85em' }}>
          <span>{detail.data.config.riskProfile}</span>
          <span>{detail.data.config.tradingStyle}</span>
          <span>{detail.data.config.markets.join(' + ')}</span>
          <span>{detail.data.config.model}</span>
        </div>
      )}
    </article>
  );
}

export function RoundsPage() {
  const rounds = useRounds();

  return (
    <section className="grid">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Rounds</h1>
        <Link to="/rounds/new">
          <button className="primary">New round</button>
        </Link>
      </div>

      {rounds.isPending && <Spinner label="Loading rounds" />}
      <ErrorBox error={rounds.error} />

      {rounds.data?.length === 0 && <p className="muted">No rounds yet. Start one to put the bankroll to work.</p>}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {rounds.data?.map((round) => (
          <RoundCard key={round.id} round={round} />
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 6 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/RoundsPage.tsx frontend/test/rounds-page.test.tsx
git commit -m "feat: rounds overview cards with sparkline and goal progress"
```
---

## Task 9: Round detail shell, controls and positions

Spec §6 round detail: equity curve with markers, pocketed-profit staircase, positions, and the pause/takeover/kill controls. Trades, journal, settings panel and the order form arrive in Tasks 10 and 11 — this task builds the page skeleton and its tab strip.

**Files:**
- Create/replace: `frontend/src/pages/RoundDetailPage.tsx`
- Create: `frontend/src/pages/round/Controls.tsx`, `frontend/src/pages/round/PositionsTable.tsx`, `frontend/src/pages/round/SkimStaircase.tsx`
- Create: `frontend/test/round-detail.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/round-detail.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { RoundDetailPage } from '../src/pages/RoundDetailPage';
import { renderWithProviders } from './render';
import { roundDetailFixture, server } from './server';

vi.mock('../src/components/charts/EquityChart', () => ({
  EquityChart: ({ points }: { points: unknown[] }) => <div data-testid="equity-chart">{points.length}</div>,
}));

function renderDetail() {
  return renderWithProviders(<RoundDetailPage roundId={1} />);
}

describe('round detail', () => {
  it('shows the headline numbers', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'first run' })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByTestId('cash')).toHaveTextContent('$30.00');
    expect(screen.getByTestId('pocketed')).toHaveTextContent('$25.00');
    expect(screen.getByTestId('bankroll')).toHaveTextContent('$50.00');
  });

  it('lists open positions with cost basis and live P/L', async () => {
    server.use(
      http.get('/api/market/quotes', () =>
        HttpResponse.json({ AAPL: { symbol: 'AAPL', market: 'US', price: 12, currency: 'USD', ts: '2026-08-02T03:00:00.000Z', stale: false } }),
      ),
    );
    renderDetail();

    const row = await screen.findByRole('row', { name: /AAPL/ });
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(within(row).getByText('$20.00')).toBeInTheDocument();
  });

  it('offers only the transitions the backend allows for an active round', async () => {
    renderDetail();

    expect(await screen.findByRole('button', { name: /^pause$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /take over/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^resume$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /archive/i })).not.toBeInTheDocument();
  });

  it('offers resume and archive for a paused round', async () => {
    server.use(
      http.get('/api/rounds/:id', () =>
        HttpResponse.json({ ...roundDetailFixture, round: { ...roundDetailFixture.round, status: 'paused' } }),
      ),
    );
    renderDetail();

    expect(await screen.findByRole('button', { name: /^resume$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /archive/i })).toBeEnabled();
  });

  it('posts the status action the operator clicked', async () => {
    let action: string | null = null;
    server.use(
      http.post('/api/rounds/:id/status', async ({ request }) => {
        action = ((await request.json()) as { action: string }).action;
        return HttpResponse.json({ status: 'paused' });
      }),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /^pause$/i }));
    await waitFor(() => expect(action).toBe('pause'));
  });

  it('surfaces a rejected transition', async () => {
    server.use(
      http.post('/api/rounds/:id/status', () => HttpResponse.json({ error: 'cannot pause a busted round' }, { status: 409 })),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /^pause$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot pause a busted round');
  });

  it('runs a manual check-in', async () => {
    let ran = false;
    server.use(
      http.post('/api/rounds/:id/checkin', () => {
        ran = true;
        return HttpResponse.json({ status: 'success' });
      }),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /check in now/i }));
    await waitFor(() => expect(ran).toBe(true));
  });

  it('renders the pocketed staircase from skim ledger entries', async () => {
    server.use(
      http.get('/api/rounds/:id/ledger', () =>
        HttpResponse.json([
          { id: 3, round_id: 1, type: 'skim', amount_cents: -1500, balance_after_cents: 5000, ref_order_id: 2, note: 'profit pocketed', created_at: '2026-08-02T04:00:00.000Z' },
          { id: 2, round_id: 1, type: 'skim', amount_cents: -1000, balance_after_cents: 5000, ref_order_id: 1, note: 'profit pocketed', created_at: '2026-08-01T04:00:00.000Z' },
          { id: 1, round_id: 1, type: 'buy', amount_cents: -2000, balance_after_cents: 3000, ref_order_id: 1, note: 'buy AAPL', created_at: '2026-08-01T02:00:00.000Z' },
        ]),
      ),
    );
    renderDetail();

    const staircase = await screen.findByTestId('skim-staircase');
    // Cumulative, oldest first: $10.00 then $25.00.
    expect(within(staircase).getAllByRole('listitem')[0]).toHaveTextContent('$10.00');
    expect(within(staircase).getAllByRole('listitem')[1]).toHaveTextContent('$25.00');
  });

  it('switches tabs', async () => {
    renderDetail();

    await userEvent.click(await screen.findByRole('tab', { name: /journal/i }));
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/journal/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- round-detail`
Expected: FAIL — placeholder page.

- [ ] **Step 3: Write the controls**

`frontend/src/pages/round/Controls.tsx`:

```tsx
import { useRoundStatus, useRunCheckin } from '../../api/hooks';
import type { RoundStatus } from '../../api/types';
import { ErrorBox } from '../../components/ErrorBox';

/** Mirrors TRANSITIONS in backend/src/api/rounds-routes.ts. Keep the two in step. */
const TRANSITIONS: { action: string; label: string; from: RoundStatus[] }[] = [
  { action: 'pause', label: 'Pause', from: ['active', 'takeover'] },
  { action: 'resume', label: 'Resume', from: ['paused', 'takeover'] },
  { action: 'takeover', label: 'Take over', from: ['active', 'paused'] },
  { action: 'release', label: 'Release to agent', from: ['takeover'] },
  { action: 'archive', label: 'Archive', from: ['paused', 'goal_reached', 'busted'] },
];

export function Controls({ roundId, status }: { roundId: number; status: RoundStatus }) {
  const transition = useRoundStatus(roundId);
  const checkin = useRunCheckin(roundId);
  const available = TRANSITIONS.filter((t) => t.from.includes(status));

  return (
    <div className="grid" style={{ gap: '0.5rem' }}>
      <div className="row">
        {available.map((t) => (
          <button key={t.action} onClick={() => transition.mutate(t.action)} disabled={transition.isPending}>
            {t.label}
          </button>
        ))}
        <button className="primary" onClick={() => checkin.mutate()} disabled={checkin.isPending}>
          {checkin.isPending ? 'Checking in…' : 'Check in now'}
        </button>
      </div>
      {status === 'takeover' && (
        <p className="muted" style={{ margin: 0 }}>
          Takeover: the agent is advisory only — it can journal and adjust the watchlist, but it cannot trade.
        </p>
      )}
      <ErrorBox error={transition.error ?? checkin.error} />
    </div>
  );
}
```

- [ ] **Step 4: Write the positions table**

`frontend/src/pages/round/PositionsTable.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';
import type { PositionRow, Quote } from '../../api/types';
import { Money } from '../../components/Money';
import { formatQty } from '../../lib/format';

function useQuotes(symbols: string[]) {
  const key = [...symbols].sort().join(',');
  return useQuery({
    queryKey: ['quotes', key],
    queryFn: () => apiFetch<Record<string, Quote>>(`/api/market/quotes?symbols=${encodeURIComponent(key)}`),
    enabled: key !== '',
    refetchInterval: 60_000,
  });
}

export function PositionsTable({ positions }: { positions: PositionRow[] }) {
  const quotes = useQuotes(positions.map((p) => p.symbol));

  if (positions.length === 0) return <p className="muted">No open positions.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Symbol</th>
          <th className="num">Qty</th>
          <th className="num">Cost basis</th>
          <th className="num">Last</th>
          <th className="num">Unrealised</th>
          <th className="num">Stop</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => {
          const quote = quotes.data?.[position.symbol];
          // Positions are valued in AUD cents; USD quotes are converted server-side
          // for trading, so only show unrealised P/L for AUD-quoted holdings.
          const marketCents =
            quote && quote.currency === 'AUD' ? Math.round(position.quantity * quote.price * 100) : null;
          const unrealised = marketCents === null ? null : marketCents - position.cost_basis_cents;
          return (
            <tr key={position.id}>
              <td>{position.symbol}</td>
              <td className="num">{formatQty(position.quantity)}</td>
              <td className="num">
                <Money cents={position.cost_basis_cents} />
              </td>
              <td className="num">
                {quote ? `${quote.price.toFixed(2)} ${quote.currency}${quote.stale ? ' (stale)' : ''}` : '—'}
              </td>
              <td className="num">{unrealised === null ? '—' : <Money cents={unrealised} signed />}</td>
              <td className="num">{position.stop_loss_price === null ? '—' : position.stop_loss_price.toFixed(2)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 5: Write the skim staircase**

`frontend/src/pages/round/SkimStaircase.tsx`:

```tsx
import type { LedgerRow } from '../../api/types';
import { formatCents, formatTs } from '../../lib/format';

/**
 * Spec §2.53: every skim is money that can no longer be lost. Shown as a
 * cumulative staircase toward the profit goal. Skims are stored as negative
 * ledger amounts (cash leaving the round), so they are negated here.
 */
export function SkimStaircase({ ledger, goalCents }: { ledger: LedgerRow[]; goalCents: number }) {
  const skims = ledger
    .filter((row) => row.type === 'skim')
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  if (skims.length === 0) return <p className="muted">Nothing pocketed yet.</p>;

  let running = 0;
  const steps = skims.map((skim) => {
    running += -skim.amount_cents;
    return { id: skim.id, at: skim.created_at, amount: -skim.amount_cents, cumulative: running };
  });

  return (
    <ol data-testid="skim-staircase" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {steps.map((step) => (
        <li key={step.id} className="row" style={{ justifyContent: 'space-between', padding: '0.25rem 0' }}>
          <span className="muted">{formatTs(step.at)}</span>
          <span className="gain">+{formatCents(step.amount)}</span>
          <strong>{formatCents(step.cumulative)}</strong>
          <span className="muted">of {formatCents(goalCents)}</span>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 6: Write the detail page**

Replace `frontend/src/pages/RoundDetailPage.tsx`. It takes an optional `roundId` prop so tests can render it without a router param, falling back to the route param in the app.

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useEquity, useLedger, useRound, useTrades } from '../api/hooks';
import { EquityChart } from '../components/charts/EquityChart';
import { ErrorBox } from '../components/ErrorBox';
import { Money } from '../components/Money';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { EventFeed } from '../events/EventFeed';
import { useEventStream } from '../events/useEventStream';
import { Controls } from './round/Controls';
import { PositionsTable } from './round/PositionsTable';
import { SkimStaircase } from './round/SkimStaircase';

const TABS = ['positions', 'trades', 'ledger', 'journal', 'summaries', 'settings', 'events'] as const;
type Tab = (typeof TABS)[number];

function Stat({ label, cents, testId }: { label: string; cents: number; testId: string }) {
  return (
    <div>
      <div className="muted">{label}</div>
      <div data-testid={testId} style={{ fontSize: '1.2rem' }}>
        <Money cents={cents} />
      </div>
    </div>
  );
}

export function RoundDetailPage({ roundId: propId }: { roundId?: number } = {}) {
  const params = useParams();
  const roundId = propId ?? Number(params.id);
  const [tab, setTab] = useState<Tab>('positions');

  useEventStream(roundId);
  const detail = useRound(roundId);
  const equity = useEquity(roundId);
  const trades = useTrades(roundId);
  const ledger = useLedger(roundId);

  if (detail.isPending) return <Spinner label="Loading round" />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return null;

  const { round, config, positions, totalSkimsCents } = detail.data;

  return (
    <section className="grid">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>{round.name}</h1>
        <StatusBadge status={round.status} />
      </div>

      <div className="panel row" style={{ justifyContent: 'space-between' }}>
        <Stat label="Cash" cents={round.cash_cents} testId="cash" />
        <Stat label="Pocketed" cents={totalSkimsCents} testId="pocketed" />
        <Stat label="Bankroll" cents={round.starting_balance_cents} testId="bankroll" />
        <Stat label="Goal" cents={round.profit_goal_cents} testId="goal" />
      </div>

      <div className="panel">
        <Controls roundId={roundId} status={round.status} />
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Equity</h2>
        <EquityChart points={equity.data ?? []} trades={trades.data ?? []} />
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Pocketed profit</h2>
        <SkimStaircase ledger={ledger.data ?? []} goalCents={round.profit_goal_cents} />
      </div>

      <div className="row" role="tablist">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            id={`tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`panel-${name}`}
            onClick={() => setTab(name)}
            className={tab === name ? 'primary' : undefined}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'positions' && <PositionsTable positions={positions} />}
        {tab === 'events' && <EventFeed roundId={roundId} />}
        {tab !== 'positions' && tab !== 'events' && <p className="muted">{tab} panel arrives in a later task.</p>}
      </div>

      <p className="muted" style={{ fontSize: '0.85em' }}>
        {config.riskProfile} · {config.tradingStyle} · {config.markets.join(' + ')} · {config.model}
      </p>
    </section>
  );
}
```

The tab placeholders are replaced in Tasks 10 and 11. Leave them in place until then so the page compiles.

- [ ] **Step 7: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 9 new tests pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages frontend/test/round-detail.test.tsx
git commit -m "feat: round detail shell, controls, positions, skim staircase"
```

---

## Task 10: History panels — trades, ledger, journal, daily summaries, check-ins

Spec §6: "trade + skim history; agent journal per check-in; Daily Summaries page (§4.3)."

**Files:**
- Create: `frontend/src/pages/round/TradesTable.tsx`, `LedgerTable.tsx`, `JournalList.tsx`, `SummariesList.tsx`, `CheckinsTable.tsx`
- Modify: `frontend/src/pages/RoundDetailPage.tsx`
- Create: `frontend/test/round-history.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/round-history.test.tsx`:

```tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { RoundDetailPage } from '../src/pages/RoundDetailPage';
import { renderWithProviders } from './render';
import { server } from './server';

vi.mock('../src/components/charts/EquityChart', () => ({ EquityChart: () => <div /> }));

const trades = [
  { id: 2, order_id: 2, round_id: 1, symbol: 'AAPL', side: 'sell', quantity: 2, price_aud: 20, gross_cents: 4000, fee_cents: 30, executed_at: '2026-08-02T02:00:00.000Z' },
  { id: 1, order_id: 1, round_id: 1, symbol: 'AAPL', side: 'buy', quantity: 2, price_aud: 10, gross_cents: 2000, fee_cents: 30, executed_at: '2026-08-01T02:00:00.000Z' },
];

describe('round history panels', () => {
  it('shows trades newest first with fees', async () => {
    server.use(http.get('/api/rounds/:id/trades', () => HttpResponse.json(trades)));
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /trades/i }));
    const rows = within(screen.getByRole('tabpanel')).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('sell');
    expect(rows[0]).toHaveTextContent('$40.00');
    expect(rows[0]).toHaveTextContent('$0.30');
  });

  it('shows an empty trades state', async () => {
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /trades/i }));
    expect(screen.getByText(/no trades yet/i)).toBeInTheDocument();
  });

  it('colour-codes ledger entries and labels skims', async () => {
    server.use(
      http.get('/api/rounds/:id/ledger', () =>
        HttpResponse.json([
          { id: 2, round_id: 1, type: 'skim', amount_cents: -2500, balance_after_cents: 5000, ref_order_id: 2, note: 'profit pocketed', created_at: '2026-08-02T02:00:00.000Z' },
          { id: 1, round_id: 1, type: 'deposit', amount_cents: 5000, balance_after_cents: 5000, ref_order_id: null, note: 'starting balance', created_at: '2026-08-01T00:00:00.000Z' },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /ledger/i }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('skim')).toBeInTheDocument();
    expect(within(panel).getByText('-$25.00')).toBeInTheDocument();
    expect(within(panel).getByText('+$50.00')).toBeInTheDocument();
  });

  it('shows journal entries with their author', async () => {
    server.use(
      http.get('/api/rounds/:id/journal', () =>
        HttpResponse.json([
          { id: 2, checkin_id: 4, author: 'agent', note: 'Held AAPL; momentum intact.', created_at: '2026-08-02T02:00:00.000Z' },
          { id: 1, checkin_id: null, author: 'operator', note: 'Manual buy to seed the round.', created_at: '2026-08-01T02:00:00.000Z' },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /journal/i }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(/momentum intact/)).toBeInTheDocument();
    expect(within(panel).getByText('agent')).toBeInTheDocument();
    expect(within(panel).getByText('operator')).toBeInTheDocument();
  });

  it('renders the daily summary narrative and digest', async () => {
    server.use(
      http.get('/api/rounds/:id/summaries', () =>
        HttpResponse.json([
          {
            day: '2026-08-01',
            digest_json: JSON.stringify({ trades: 2, skimsCents: 2500, feesCents: 60, tokensUsed: 1800, events: [], journals: [] }),
            narrative: 'I sold AAPL into strength and pocketed the difference.',
            created_at: '2026-08-02T08:10:00.000Z',
          },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /summaries/i }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(/sold AAPL into strength/)).toBeInTheDocument();
    expect(within(panel).getByText(/2 trades/)).toBeInTheDocument();
    expect(within(panel).getByText(/\$25\.00 pocketed/)).toBeInTheDocument();
    expect(within(panel).getByText(/1,800 tokens/)).toBeInTheDocument();
  });

  it('separates the lifetime abstract from dated summaries', async () => {
    server.use(
      http.get('/api/rounds/:id/summaries', () =>
        HttpResponse.json([
          { day: 'abstract', digest_json: '{}', narrative: 'Lifetime: patient swing trading.', created_at: '2026-08-02T08:10:00.000Z' },
          {
            day: '2026-08-01',
            digest_json: JSON.stringify({ trades: 1, skimsCents: 0, feesCents: 30, tokensUsed: 900, events: [], journals: [] }),
            narrative: 'Quiet day.',
            created_at: '2026-08-02T08:10:00.000Z',
          },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /summaries/i }));
    expect(screen.getByRole('heading', { name: /lifetime abstract/i })).toBeInTheDocument();
    expect(screen.getByText(/patient swing trading/)).toBeInTheDocument();
  });

  it('lists check-ins with token spend and parsed actions', async () => {
    server.use(
      http.get('/api/rounds/:id/checkins', () =>
        HttpResponse.json([
          { id: 4, ts: '2026-08-02T02:00:00.000Z', status: 'success', tokens_used: 1800, actions_json: '[{"tool":"place_order"},{"tool":"write_journal"}]' },
          { id: 3, ts: '2026-08-01T02:00:00.000Z', status: 'error', tokens_used: null, actions_json: '[]' },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /check-ins/i }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('place_order, write_journal')).toBeInTheDocument();
    expect(within(panel).getByText('1,800')).toBeInTheDocument();
    expect(within(panel).getByText('error')).toBeInTheDocument();
  });

  it('survives an unparseable actions payload', async () => {
    server.use(
      http.get('/api/rounds/:id/checkins', () =>
        HttpResponse.json([{ id: 5, ts: '2026-08-02T02:00:00.000Z', status: 'success', tokens_used: 10, actions_json: 'not json' }]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /check-ins/i }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('—');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- round-history`
Expected: FAIL — the tabs still render placeholders and there is no check-ins tab.

- [ ] **Step 3: Write the tables**

`frontend/src/pages/round/TradesTable.tsx`:

```tsx
import type { TradeRow } from '../../api/types';
import { Money } from '../../components/Money';
import { formatQty, formatTs } from '../../lib/format';

export function TradesTable({ trades }: { trades: TradeRow[] }) {
  if (trades.length === 0) return <p className="muted">No trades yet.</p>;
  const rows = [...trades].sort((a, b) => b.id - a.id);

  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Side</th>
          <th>Symbol</th>
          <th className="num">Qty</th>
          <th className="num">Price (AUD)</th>
          <th className="num">Gross</th>
          <th className="num">Fee</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((trade) => (
          <tr key={trade.id}>
            <td>{formatTs(trade.executed_at)}</td>
            <td className={trade.side === 'buy' ? 'gain' : 'loss'}>{trade.side}</td>
            <td>{trade.symbol}</td>
            <td className="num">{formatQty(trade.quantity)}</td>
            <td className="num">{trade.price_aud.toFixed(4)}</td>
            <td className="num">
              <Money cents={trade.gross_cents} />
            </td>
            <td className="num">
              <Money cents={trade.fee_cents} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`frontend/src/pages/round/LedgerTable.tsx`:

```tsx
import type { LedgerRow } from '../../api/types';
import { Money } from '../../components/Money';
import { formatTs } from '../../lib/format';

export function LedgerTable({ ledger }: { ledger: LedgerRow[] }) {
  if (ledger.length === 0) return <p className="muted">No ledger entries yet.</p>;
  const rows = [...ledger].sort((a, b) => b.id - a.id);

  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Type</th>
          <th className="num">Amount</th>
          <th className="num">Balance after</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{formatTs(row.created_at)}</td>
            <td>{row.type}</td>
            <td className="num">
              <Money cents={row.amount_cents} signed />
            </td>
            <td className="num">
              <Money cents={row.balance_after_cents} />
            </td>
            <td className="muted">{row.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`frontend/src/pages/round/JournalList.tsx`:

```tsx
import type { JournalRow } from '../../api/types';
import { formatTs } from '../../lib/format';

export function JournalList({ entries }: { entries: JournalRow[] }) {
  if (entries.length === 0) return <p className="muted">No journal entries yet.</p>;
  const rows = [...entries].sort((a, b) => b.id - a.id);

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map((entry) => (
        <li key={entry.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
          <div className="row muted" style={{ fontSize: '0.85em' }}>
            <span>{formatTs(entry.created_at)}</span>
            <span>{entry.author}</span>
            {entry.checkin_id !== null && <span>check-in #{entry.checkin_id}</span>}
          </div>
          <p style={{ margin: '0.2rem 0 0' }}>{entry.note}</p>
        </li>
      ))}
    </ul>
  );
}
```

`frontend/src/pages/round/SummariesList.tsx`:

```tsx
import type { DailyDigest, SummaryRow } from '../../api/types';
import { formatCents, formatDay } from '../../lib/format';

function parseDigest(json: string): DailyDigest | null {
  try {
    return JSON.parse(json) as DailyDigest;
  } catch {
    return null;
  }
}

export function SummariesList({ summaries }: { summaries: SummaryRow[] }) {
  if (summaries.length === 0) return <p className="muted">No daily summaries yet.</p>;

  // 'abstract' is the reserved lifetime slot (spec §4.3), not a calendar day.
  const abstract = summaries.find((s) => s.day === 'abstract');
  const days = summaries.filter((s) => s.day !== 'abstract').sort((a, b) => (a.day < b.day ? 1 : -1));

  return (
    <div className="grid">
      {abstract && (
        <section>
          <h3 style={{ margin: '0 0 0.3rem', fontSize: '0.95rem' }}>Lifetime abstract</h3>
          <p style={{ margin: 0 }}>{abstract.narrative}</p>
        </section>
      )}
      {days.map((summary) => {
        const digest = parseDigest(summary.digest_json);
        return (
          <section key={summary.day} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
            <h3 style={{ margin: '0 0 0.2rem', fontSize: '0.95rem' }}>{formatDay(`${summary.day}T00:00:00.000Z`)}</h3>
            <p style={{ margin: '0 0 0.3rem' }}>{summary.narrative ?? 'No narrative recorded.'}</p>
            {digest && (
              <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
                {digest.trades} trades · {formatCents(digest.skimsCents)} pocketed · {formatCents(digest.feesCents)} fees ·{' '}
                {digest.tokensUsed.toLocaleString('en-AU')} tokens
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
```

`frontend/src/pages/round/CheckinsTable.tsx`:

```tsx
import type { CheckinRow } from '../../api/types';
import { formatTs } from '../../lib/format';

function actionSummary(json: string): string {
  try {
    const actions = JSON.parse(json) as { tool?: string }[];
    const tools = actions.map((a) => a.tool).filter((t): t is string => typeof t === 'string');
    return tools.length === 0 ? '—' : tools.join(', ');
  } catch {
    return '—';
  }
}

export function CheckinsTable({ checkins }: { checkins: CheckinRow[] }) {
  if (checkins.length === 0) return <p className="muted">No check-ins yet.</p>;
  const rows = [...checkins].sort((a, b) => b.id - a.id);

  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Status</th>
          <th>Actions</th>
          <th className="num">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((checkin) => (
          <tr key={checkin.id}>
            <td>{formatTs(checkin.ts)}</td>
            <td className={checkin.status === 'success' ? undefined : 'loss'}>{checkin.status}</td>
            <td>{actionSummary(checkin.actions_json)}</td>
            <td className="num">{checkin.tokens_used?.toLocaleString('en-AU') ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Wire the tabs**

In `frontend/src/pages/RoundDetailPage.tsx`: add `'checkins'` to `TABS` (between `'journal'` and `'summaries'`), label it `check-ins` in the button text (`{name === 'checkins' ? 'check-ins' : name}`), add the hooks `useJournal`, `useSummaries`, `useCheckins`, and replace the placeholder line with:

```tsx
        {tab === 'positions' && <PositionsTable positions={positions} />}
        {tab === 'trades' && <TradesTable trades={trades.data ?? []} />}
        {tab === 'ledger' && <LedgerTable ledger={ledger.data ?? []} />}
        {tab === 'journal' && <JournalList entries={journal.data ?? []} />}
        {tab === 'checkins' && <CheckinsTable checkins={checkins.data ?? []} />}
        {tab === 'summaries' && <SummariesList summaries={summaries.data ?? []} />}
        {tab === 'settings' && <p className="muted">Settings panel arrives in the next task.</p>}
        {tab === 'events' && <EventFeed roundId={roundId} />}
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 8 new tests pass; the `round-detail` tab test still passes.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages frontend/test/round-history.test.tsx
git commit -m "feat: trades, ledger, journal, summaries and check-in panels"
```

---

## Task 11: Live config panel and manual order form

Spec §2.6 (live config changes) and §5 (manual control). Two rules the UI must not break: `startingBalanceCents` is immutable mid-round, and nested config objects must be sent whole enough that the backend's deep-merge does the right thing.

**Files:**
- Create: `frontend/src/pages/round/ConfigPanel.tsx`, `frontend/src/pages/round/OrderForm.tsx`
- Modify: `frontend/src/pages/RoundDetailPage.tsx`
- Create: `frontend/test/round-config.test.tsx`, `frontend/test/order-form.test.tsx`

- [ ] **Step 1: Write the failing tests**

`frontend/test/round-config.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ConfigPanel } from '../src/pages/round/ConfigPanel';
import { roundDetailFixture, server } from './server';
import { renderWithProviders } from './render';

function renderPanel() {
  return renderWithProviders(<ConfigPanel roundId={1} config={roundDetailFixture.config} />);
}

describe('config panel', () => {
  it('pre-fills from the current config', () => {
    renderPanel();

    expect(screen.getByLabelText(/profit goal/i)).toHaveValue('1000.00');
    expect(screen.getByLabelText(/watchlist/i)).toHaveValue('AAPL');
    expect(screen.getByLabelText(/stop-loss %/i)).toHaveValue('10');
    expect(screen.getByLabelText(/risk profile/i)).toHaveValue('balanced');
  });

  it('never offers the starting balance', () => {
    renderPanel();
    expect(screen.queryByLabelText(/starting balance/i)).not.toBeInTheDocument();
  });

  it('patches only the fields that changed, in cents', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch('/api/rounds/:id/config', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ changed: 1 });
      }),
    );
    renderPanel();

    const goal = screen.getByLabelText(/profit goal/i);
    await userEvent.clear(goal);
    await userEvent.type(goal, '20');
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ profitGoalCents: 2000 });
  });

  it('sends the whole guardrail object so the deep-merge cannot strip a key', async () => {
    let body: { guardrails?: Record<string, unknown> } | null = null;
    server.use(
      http.patch('/api/rounds/:id/config', async ({ request }) => {
        body = (await request.json()) as { guardrails?: Record<string, unknown> };
        return HttpResponse.json({ changed: 1 });
      }),
    );
    renderPanel();

    const stop = screen.getByLabelText(/stop-loss %/i);
    await userEvent.clear(stop);
    await userEvent.type(stop, '5');
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() => expect(body?.guardrails).toBeDefined());
    expect(body!.guardrails).toEqual({
      stopLossPct: 5, maxPositionPct: 40, drawdownPausePct: 50, stopLossWhenPaused: true,
    });
  });

  it('treats a blank guardrail as disabled (null), not zero', async () => {
    let body: { guardrails?: Record<string, unknown> } | null = null;
    server.use(
      http.patch('/api/rounds/:id/config', async ({ request }) => {
        body = (await request.json()) as { guardrails?: Record<string, unknown> };
        return HttpResponse.json({ changed: 1 });
      }),
    );
    renderPanel();

    await userEvent.clear(screen.getByLabelText(/stop-loss %/i));
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() => expect(body?.guardrails).toBeDefined());
    expect(body!.guardrails!.stopLossPct).toBeNull();
  });

  it('splits the watchlist on commas and upper-cases it', async () => {
    let body: { watchlist?: string[] } | null = null;
    server.use(
      http.patch('/api/rounds/:id/config', async ({ request }) => {
        body = (await request.json()) as { watchlist?: string[] };
        return HttpResponse.json({ changed: 1 });
      }),
    );
    renderPanel();

    const watchlist = screen.getByLabelText(/watchlist/i);
    await userEvent.clear(watchlist);
    await userEvent.type(watchlist, 'aapl, bhp.ax , ');
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() => expect(body?.watchlist).toBeDefined());
    expect(body!.watchlist).toEqual(['AAPL', 'BHP.AX']);
  });

  it('blocks a save with no changes', async () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /save config/i })).toBeDisabled();
  });

  it('reports a rejected patch', async () => {
    server.use(
      http.patch('/api/rounds/:id/config', () =>
        HttpResponse.json({ error: 'startingBalanceCents cannot change mid-round' }, { status: 400 }),
      ),
    );
    renderPanel();

    const goal = screen.getByLabelText(/profit goal/i);
    await userEvent.clear(goal);
    await userEvent.type(goal, '20');
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('cannot change mid-round');
  });
});
```

`frontend/test/order-form.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { OrderForm } from '../src/pages/round/OrderForm';
import { roundDetailFixture, server } from './server';
import { renderWithProviders } from './render';

function renderForm(status: 'active' | 'paused' | 'goal_reached' = 'active') {
  return renderWithProviders(
    <OrderForm roundId={1} status={status} positions={roundDetailFixture.positions} watchlist={['AAPL', 'MSFT']} />,
  );
}

describe('manual order form', () => {
  it('sends a buy in integer cents', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/rounds/:id/orders', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ status: 'filled', reason: null, skimCents: 0 }, { status: 201 });
      }),
    );
    renderForm();

    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.type(screen.getByLabelText(/amount/i), '12.34');
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ symbol: 'AAPL', side: 'buy', amountCents: 1234 });
  });

  it('sends a sell quantity, including "all"', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/rounds/:id/orders', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ status: 'filled', reason: null, skimCents: 1000 }, { status: 201 });
      }),
    );
    renderForm();

    await userEvent.selectOptions(screen.getByLabelText(/side/i), 'sell');
    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.click(screen.getByLabelText(/sell everything/i));
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ symbol: 'AAPL', side: 'sell', quantity: 'all' });
  });

  it('reports the skim after a profitable sell', async () => {
    server.use(
      http.post('/api/rounds/:id/orders', () =>
        HttpResponse.json({ status: 'filled', reason: null, skimCents: 2000 }, { status: 201 }),
      ),
    );
    renderForm();

    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.type(screen.getByLabelText(/amount/i), '5');
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    expect(await screen.findByText(/pocketed \$20\.00/i)).toBeInTheDocument();
  });

  it('surfaces a rejection reason from the backend', async () => {
    server.use(http.post('/api/rounds/:id/orders', () => HttpResponse.json({ error: 'quote is stale' }, { status: 409 })));
    renderForm();

    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.type(screen.getByLabelText(/amount/i), '5');
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('quote is stale');
  });

  it('blocks a zero or unparseable amount before it reaches the money path', async () => {
    renderForm();

    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.type(screen.getByLabelText(/amount/i), '0');
    expect(screen.getByRole('button', { name: /place order/i })).toBeDisabled();
  });

  it('disables the whole form on a terminal round', () => {
    renderForm('goal_reached');
    expect(screen.getByRole('button', { name: /place order/i })).toBeDisabled();
    expect(screen.getByText(/goal_reached round cannot trade/i)).toBeInTheDocument();
  });

  it('stays enabled for a paused round because the operator may still trade', () => {
    renderForm('paused');
    expect(screen.getByLabelText(/symbol/i)).toBeEnabled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- round-config order-form`
Expected: FAIL — neither component exists.

- [ ] **Step 3: Write the config panel**

`frontend/src/pages/round/ConfigPanel.tsx`:

```tsx
import { useState } from 'react';
import { usePatchConfig } from '../../api/hooks';
import type { RoundConfig } from '../../api/types';
import { ErrorBox } from '../../components/ErrorBox';
import { dollarsToCents } from '../../lib/format';

interface FormState {
  name: string;
  profitGoal: string;
  watchlist: string;
  riskProfile: RoundConfig['riskProfile'];
  tradingStyle: RoundConfig['tradingStyle'];
  model: string;
  checkinCron: string;
  stopLossPct: string;
  maxPositionPct: string;
  drawdownPausePct: string;
  stopLossWhenPaused: boolean;
}

function toForm(config: RoundConfig): FormState {
  const pct = (value: number | null): string => (value === null ? '' : String(value));
  return {
    name: config.name,
    profitGoal: (config.profitGoalCents / 100).toFixed(2),
    watchlist: config.watchlist.join(', '),
    riskProfile: config.riskProfile,
    tradingStyle: config.tradingStyle,
    model: config.model,
    checkinCron: config.checkinCron.join('\n'),
    stopLossPct: pct(config.guardrails.stopLossPct),
    maxPositionPct: pct(config.guardrails.maxPositionPct),
    drawdownPausePct: pct(config.guardrails.drawdownPausePct),
    stopLossWhenPaused: config.guardrails.stopLossWhenPaused,
  };
}

/** Blank means "disabled" (null), never 0 — a 0% stop-loss would sell instantly. */
function toPct(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function parseWatchlist(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '');
}

export function ConfigPanel({ roundId, config }: { roundId: number; config: RoundConfig }) {
  const [form, setForm] = useState<FormState>(() => toForm(config));
  const patch = usePatchConfig(roundId);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  /**
   * Only changed top-level fields are sent. Guardrails go as a complete object:
   * the backend deep-merges, and a partial object would leave stale keys behind
   * while looking like a full edit to the operator.
   */
  function buildPatch(): Partial<RoundConfig> {
    const body: Partial<RoundConfig> = {};
    if (form.name !== config.name) body.name = form.name;

    const goalCents = dollarsToCents(form.profitGoal);
    if (goalCents !== null && goalCents !== config.profitGoalCents) body.profitGoalCents = goalCents;

    const watchlist = parseWatchlist(form.watchlist);
    if (JSON.stringify(watchlist) !== JSON.stringify(config.watchlist)) body.watchlist = watchlist;

    if (form.riskProfile !== config.riskProfile) body.riskProfile = form.riskProfile;
    if (form.tradingStyle !== config.tradingStyle) body.tradingStyle = form.tradingStyle;
    if (form.model !== config.model) body.model = form.model;

    const cron = form.checkinCron.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (JSON.stringify(cron) !== JSON.stringify(config.checkinCron)) body.checkinCron = cron;

    const guardrails = {
      stopLossPct: toPct(form.stopLossPct),
      maxPositionPct: toPct(form.maxPositionPct),
      drawdownPausePct: toPct(form.drawdownPausePct),
      stopLossWhenPaused: form.stopLossWhenPaused,
    };
    if (JSON.stringify(guardrails) !== JSON.stringify(config.guardrails)) body.guardrails = guardrails;

    return body;
  }

  const pending = buildPatch();
  const dirty = Object.keys(pending).length > 0;

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        patch.mutate(pending, { onSuccess: () => setSaved(true) });
      }}
    >
      <p className="muted" style={{ margin: 0 }}>
        Starting balance is fixed for the life of a round — it is the skim baseline. Chain a new round to change it.
      </p>

      <label>
        Name
        <input value={form.name} onChange={(e) => set('name', e.target.value)} />
      </label>
      <label>
        Profit goal ($)
        <input value={form.profitGoal} onChange={(e) => set('profitGoal', e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Watchlist (comma separated)
        <input value={form.watchlist} onChange={(e) => set('watchlist', e.target.value)} />
      </label>
      <label>
        Risk profile
        <select value={form.riskProfile} onChange={(e) => set('riskProfile', e.target.value as RoundConfig['riskProfile'])}>
          {['conservative', 'balanced', 'aggressive', 'custom'].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Trading style
        <select value={form.tradingStyle} onChange={(e) => set('tradingStyle', e.target.value as RoundConfig['tradingStyle'])}>
          {['day', 'swing', 'long'].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model
        <input value={form.model} onChange={(e) => set('model', e.target.value)} />
      </label>
      <label>
        Check-in schedule (one cron expression per line)
        <textarea rows={3} value={form.checkinCron} onChange={(e) => set('checkinCron', e.target.value)} />
      </label>

      <fieldset className="grid" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <legend>Guardrails — blank disables</legend>
        <label>
          Stop-loss %
          <input value={form.stopLossPct} onChange={(e) => set('stopLossPct', e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Max position %
          <input value={form.maxPositionPct} onChange={(e) => set('maxPositionPct', e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Drawdown pause %
          <input value={form.drawdownPausePct} onChange={(e) => set('drawdownPausePct', e.target.value)} inputMode="decimal" />
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={form.stopLossWhenPaused}
            onChange={(e) => set('stopLossWhenPaused', e.target.checked)}
          />
          Keep firing stop-losses while paused
        </label>
      </fieldset>

      <ErrorBox error={patch.error} />
      {saved && !dirty && <p className="gain" style={{ margin: 0 }}>Saved.</p>}
      <button className="primary" type="submit" disabled={!dirty || patch.isPending}>
        Save config
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Write the order form**

`frontend/src/pages/round/OrderForm.tsx`:

```tsx
import { useState } from 'react';
import { usePlaceOrder } from '../../api/hooks';
import type { PositionRow, RoundStatus, TradeResult } from '../../api/types';
import { ErrorBox } from '../../components/ErrorBox';
import { dollarsToCents, formatCents } from '../../lib/format';

const TERMINAL: RoundStatus[] = ['goal_reached', 'busted', 'archived'];

export function OrderForm({
  roundId,
  status,
  positions,
  watchlist,
}: {
  roundId: number;
  status: RoundStatus;
  positions: PositionRow[];
  watchlist: string[];
}) {
  const place = usePlaceOrder(roundId);
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('');
  const [sellAll, setSellAll] = useState(false);
  const [result, setResult] = useState<TradeResult | null>(null);

  const frozen = TERMINAL.includes(status);
  const amountCents = dollarsToCents(amount);
  const qty = Number(quantity);
  const valid =
    !frozen &&
    symbol.trim() !== '' &&
    (side === 'buy' ? amountCents !== null && amountCents > 0 : sellAll || (Number.isFinite(qty) && qty > 0));

  const suggestions = [...new Set([...watchlist, ...positions.map((p) => p.symbol)])];

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        setResult(null);
        const body =
          side === 'buy'
            ? { symbol: symbol.trim().toUpperCase(), side, amountCents: amountCents! }
            : { symbol: symbol.trim().toUpperCase(), side, quantity: sellAll ? ('all' as const) : qty };
        place.mutate(body, { onSuccess: setResult });
      }}
    >
      {frozen && <p className="muted">A {status} round cannot trade.</p>}

      <label>
        Side
        <select value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')} disabled={frozen}>
          <option value="buy">buy</option>
          <option value="sell">sell</option>
        </select>
      </label>

      <label>
        Symbol
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          list="order-symbols"
          disabled={frozen}
          placeholder="AAPL"
        />
      </label>
      <datalist id="order-symbols">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      {side === 'buy' ? (
        <label>
          Amount to spend ($)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" disabled={frozen} />
        </label>
      ) : (
        <>
          <label className="row">
            <input type="checkbox" checked={sellAll} onChange={(e) => setSellAll(e.target.checked)} disabled={frozen} />
            Sell everything
          </label>
          {!sellAll && (
            <label>
              Quantity
              <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" disabled={frozen} />
            </label>
          )}
        </>
      )}

      <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
        Orders are rejected on stale quotes. Buys are clipped to available cash and the max-position guardrail.
      </p>

      <ErrorBox error={place.error} />
      {result?.status === 'filled' && (
        <p className="gain" style={{ margin: 0 }}>
          Filled{result.reason ? ` (${result.reason})` : ''}
          {result.skimCents > 0 ? ` — pocketed ${formatCents(result.skimCents)}` : ''}.
        </p>
      )}

      <button className="primary" type="submit" disabled={!valid || place.isPending}>
        Place order
      </button>
    </form>
  );
}
```

- [ ] **Step 5: Wire them into the detail page**

In `frontend/src/pages/RoundDetailPage.tsx`, replace the settings placeholder and add the order form above the tab strip:

```tsx
        {tab === 'settings' && <ConfigPanel roundId={roundId} config={config} />}
```

```tsx
      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Manual order</h2>
        <OrderForm roundId={roundId} status={round.status} positions={positions} watchlist={config.watchlist} />
      </div>
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 15 new tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages frontend/test/round-config.test.tsx frontend/test/order-form.test.tsx
git commit -m "feat: live config panel and manual order form"
```

---

## Task 12: New round wizard with foot-gun warnings

Spec §6: "config, presets, optional carry-over from a finished round; warns on foot-gun combos (e.g. day + ASX + small bankroll)." The warning rules are pure functions and get their own tests.

**Files:**
- Create: `frontend/src/pages/round/warnings.ts`
- Create/replace: `frontend/src/pages/NewRoundPage.tsx`
- Create: `frontend/test/warnings.test.ts`, `frontend/test/new-round.test.tsx`

- [ ] **Step 1: Write the failing tests**

`frontend/test/warnings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { roundWarnings } from '../src/pages/round/warnings';

const base = {
  startingBalanceCents: 5000,
  profitGoalCents: 100000,
  markets: ['US'] as ('ASX' | 'US')[],
  tradingStyle: 'swing' as const,
  guardrails: { stopLossPct: 10, maxPositionPct: 40, drawdownPausePct: 50, stopLossWhenPaused: true },
  fees: { asxFlatCents: 300, usFxBps: 70, slippageBps: 0 },
  watchlist: ['AAPL'],
  checkinCron: ['30 23 * * 1-5'],
};

describe('roundWarnings', () => {
  it('is quiet for a sensible config', () => {
    expect(roundWarnings(base)).toEqual([]);
  });

  it('warns when ASX brokerage eats a large share of the bankroll', () => {
    const warnings = roundWarnings({ ...base, markets: ['ASX'], startingBalanceCents: 5000 });
    expect(warnings.join(' ')).toMatch(/brokerage/i);
  });

  it('warns hardest about day trading ASX on a tiny bankroll', () => {
    const warnings = roundWarnings({ ...base, markets: ['ASX'], tradingStyle: 'day', startingBalanceCents: 5000 });
    expect(warnings.join(' ')).toMatch(/day trading/i);
    expect(warnings.length).toBeGreaterThan(1);
  });

  it('warns when the profit goal dwarfs the bankroll', () => {
    const warnings = roundWarnings({ ...base, startingBalanceCents: 5000, profitGoalCents: 100000 });
    expect(warnings.join(' ')).toMatch(/20×|goal/i);
  });

  it('warns when every guardrail is disabled', () => {
    const warnings = roundWarnings({
      ...base,
      guardrails: { stopLossPct: null, maxPositionPct: null, drawdownPausePct: null, stopLossWhenPaused: true },
    });
    expect(warnings.join(' ')).toMatch(/no guardrails/i);
  });

  it('warns on an empty watchlist', () => {
    expect(roundWarnings({ ...base, watchlist: [] }).join(' ')).toMatch(/watchlist/i);
  });

  it('warns when no check-in is scheduled', () => {
    expect(roundWarnings({ ...base, checkinCron: [] }).join(' ')).toMatch(/check-in/i);
  });

  it('warns when max position allows the whole bankroll in one symbol', () => {
    const warnings = roundWarnings({
      ...base,
      guardrails: { ...base.guardrails, maxPositionPct: 100 },
    });
    expect(warnings.join(' ')).toMatch(/single symbol/i);
  });
});
```

`frontend/test/new-round.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { NewRoundPage } from '../src/pages/NewRoundPage';
import { renderWithProviders } from './render';
import { server } from './server';

describe('new round wizard', () => {
  it('pre-fills from the global round defaults', async () => {
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    expect(screen.getByLabelText(/profit goal/i)).toHaveValue('1000.00');
    expect(screen.getByLabelText(/watchlist/i)).toHaveValue('AAPL, MSFT');
  });

  it('requires a name', async () => {
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    expect(screen.getByRole('button', { name: /create round/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/round name/i), 'second run');
    expect(screen.getByRole('button', { name: /create round/i })).toBeEnabled();
  });

  it('shows a live foot-gun warning', async () => {
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    await userEvent.selectOptions(screen.getByLabelText(/trading style/i), 'day');
    await userEvent.click(screen.getByLabelText(/ASX/));

    expect(await screen.findByText(/day trading/i)).toBeInTheDocument();
  });

  it('creates the round in cents and navigates to it', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/rounds', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 42 }, { status: 201 });
      }),
    );
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    await userEvent.type(screen.getByLabelText(/round name/i), 'second run');
    const balance = screen.getByLabelText(/starting balance/i);
    await userEvent.clear(balance);
    await userEvent.type(balance, '75.50');
    await userEvent.click(screen.getByRole('button', { name: /create round/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ name: 'second run', startingBalanceCents: 7550, profitGoalCents: 100000 });
    expect(await screen.findByText(/round created/i)).toBeInTheDocument();
  });

  it('offers carry-over from a finished round', async () => {
    server.use(
      http.get('/api/rounds', () =>
        HttpResponse.json([
          { id: 3, name: 'finished run', status: 'goal_reached', starting_balance_cents: 5000, cash_cents: 5000, profit_goal_cents: 100000, totalSkimsCents: 100000 },
        ]),
      ),
    );
    renderWithProviders(<NewRoundPage />);

    await userEvent.selectOptions(await screen.findByLabelText(/carry over/i), '3');
    await waitFor(() => expect(screen.getByLabelText(/round name/i)).toHaveValue('finished run #2'));
  });

  it('reports a create failure', async () => {
    server.use(http.post('/api/rounds', () => HttpResponse.json({ error: 'name is required' }, { status: 400 })));
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    await userEvent.type(screen.getByLabelText(/round name/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: /create round/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('name is required');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- warnings new-round`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the warning rules**

`frontend/src/pages/round/warnings.ts`:

```ts
import type { FeeConfig, GuardrailConfig, Market, TradingStyle } from '../../api/types';

export interface WarningInput {
  startingBalanceCents: number;
  profitGoalCents: number;
  markets: Market[];
  tradingStyle: TradingStyle;
  guardrails: GuardrailConfig;
  fees: FeeConfig;
  watchlist: string[];
  checkinCron: string[];
}

/**
 * Pure foot-gun rules for the new-round wizard (spec §6). Warnings never block
 * creation — the operator is allowed to run a doomed experiment on purpose.
 */
export function roundWarnings(input: WarningInput): string[] {
  const warnings: string[] = [];
  const { startingBalanceCents: bankroll, fees, markets, tradingStyle, guardrails } = input;
  const tradesAsx = markets.includes('ASX');

  // A round-trip on ASX costs two flat brokerage hits.
  const roundTripCents = fees.asxFlatCents * 2;
  if (tradesAsx && bankroll > 0 && roundTripCents / bankroll >= 0.05) {
    const pct = ((roundTripCents / bankroll) * 100).toFixed(0);
    warnings.push(
      `ASX brokerage costs ${pct}% of the bankroll per round trip ($${(roundTripCents / 100).toFixed(2)} on $${(bankroll / 100).toFixed(2)}). The position has to move that far just to break even.`,
    );
  }

  if (tradesAsx && tradingStyle === 'day' && bankroll < 100_000) {
    warnings.push(
      'Day trading ASX on a small bankroll is the worst fee combination available: flat brokerage on both sides of every trade, several times a day.',
    );
  }

  if (bankroll > 0 && input.profitGoalCents / bankroll >= 5) {
    const multiple = (input.profitGoalCents / bankroll).toFixed(0);
    warnings.push(`The profit goal is ${multiple}× the bankroll. That is a long round — expect it to run for months, if it finishes.`);
  }

  if (guardrails.stopLossPct === null && guardrails.maxPositionPct === null && guardrails.drawdownPausePct === null) {
    warnings.push('No guardrails are enabled. Nothing will stop this round losing the whole bankroll.');
  }

  if (guardrails.maxPositionPct !== null && guardrails.maxPositionPct >= 100) {
    warnings.push('Max position size allows the entire bankroll in a single symbol.');
  }

  if (input.watchlist.length === 0) {
    warnings.push('The watchlist is empty, so the agent has nothing to research or trade.');
  }

  if (input.checkinCron.length === 0) {
    warnings.push('No check-in schedule: the agent will never run unless you trigger check-ins manually.');
  }

  return warnings;
}
```

- [ ] **Step 4: Write the wizard**

Replace `frontend/src/pages/NewRoundPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCreateRound, useRound, useRounds, useSettings } from '../api/hooks';
import type { Market, RoundConfig } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { Spinner } from '../components/Spinner';
import { dollarsToCents } from '../lib/format';
import { roundWarnings } from './round/warnings';

interface WizardState {
  name: string;
  startingBalance: string;
  profitGoal: string;
  markets: Market[];
  watchlist: string;
  riskProfile: RoundConfig['riskProfile'];
  tradingStyle: RoundConfig['tradingStyle'];
  model: string;
  checkinCron: string;
  stopLossPct: string;
  maxPositionPct: string;
  drawdownPausePct: string;
}

function pctOrNull(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function NewRoundPage() {
  const settings = useSettings();
  const rounds = useRounds();
  const create = useCreateRound();
  const [carryFrom, setCarryFrom] = useState<number | null>(null);
  const carried = useRound(carryFrom ?? 0);
  const [form, setForm] = useState<WizardState | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);

  // Seed from global defaults once they load (spec §6.1: defaults pre-fill, per-round overrides win).
  useEffect(() => {
    if (form !== null || !settings.data) return;
    const defaults = settings.data.roundDefaults;
    setForm({
      name: '',
      startingBalance: (defaults.startingBalanceCents / 100).toFixed(2),
      profitGoal: (defaults.profitGoalCents / 100).toFixed(2),
      markets: defaults.markets,
      watchlist: defaults.watchlist.join(', '),
      riskProfile: defaults.riskProfile,
      tradingStyle: defaults.tradingStyle,
      model: defaults.model,
      checkinCron: defaults.checkinCron.join('\n'),
      stopLossPct: defaults.guardrails.stopLossPct === null ? '' : String(defaults.guardrails.stopLossPct),
      maxPositionPct: defaults.guardrails.maxPositionPct === null ? '' : String(defaults.guardrails.maxPositionPct),
      drawdownPausePct: defaults.guardrails.drawdownPausePct === null ? '' : String(defaults.guardrails.drawdownPausePct),
    });
  }, [settings.data, form]);

  // Carry-over copies the finished round's config and names the sequel.
  useEffect(() => {
    if (carryFrom === null || !carried.data) return;
    const config = carried.data.config;
    setForm({
      name: `${config.name} #2`,
      startingBalance: (config.startingBalanceCents / 100).toFixed(2),
      profitGoal: (config.profitGoalCents / 100).toFixed(2),
      markets: config.markets,
      watchlist: config.watchlist.join(', '),
      riskProfile: config.riskProfile,
      tradingStyle: config.tradingStyle,
      model: config.model,
      checkinCron: config.checkinCron.join('\n'),
      stopLossPct: config.guardrails.stopLossPct === null ? '' : String(config.guardrails.stopLossPct),
      maxPositionPct: config.guardrails.maxPositionPct === null ? '' : String(config.guardrails.maxPositionPct),
      drawdownPausePct: config.guardrails.drawdownPausePct === null ? '' : String(config.guardrails.drawdownPausePct),
    });
  }, [carryFrom, carried.data]);

  if (settings.isPending || form === null) return <Spinner label="Loading defaults" />;

  function set<K extends keyof WizardState>(key: K, value: WizardState[K]): void {
    setForm((current) => (current === null ? current : { ...current, [key]: value }));
  }

  const startingBalanceCents = dollarsToCents(form.startingBalance);
  const profitGoalCents = dollarsToCents(form.profitGoal);
  const watchlist = form.watchlist.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s !== '');
  const checkinCron = form.checkinCron.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  const guardrails = {
    stopLossPct: pctOrNull(form.stopLossPct),
    maxPositionPct: pctOrNull(form.maxPositionPct),
    drawdownPausePct: pctOrNull(form.drawdownPausePct),
    stopLossWhenPaused: settings.data!.roundDefaults.guardrails.stopLossWhenPaused,
  };
  const fees = settings.data!.roundDefaults.fees;

  const warnings =
    startingBalanceCents === null || profitGoalCents === null
      ? []
      : roundWarnings({
          startingBalanceCents, profitGoalCents, markets: form.markets,
          tradingStyle: form.tradingStyle, guardrails, fees, watchlist, checkinCron,
        });

  const valid =
    form.name.trim() !== '' &&
    startingBalanceCents !== null && startingBalanceCents > 0 &&
    profitGoalCents !== null && profitGoalCents > 0 &&
    form.markets.length > 0;

  const finished = (rounds.data ?? []).filter((r) => ['goal_reached', 'busted', 'archived'].includes(r.status));

  return (
    <section className="grid" style={{ maxWidth: 560 }}>
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>New round</h1>

      {createdId !== null && (
        <p className="gain">
          Round created. <Link to={`/rounds/${createdId}`}>Open it</Link>.
        </p>
      )}

      <label>
        Carry over from a finished round
        <select
          value={carryFrom ?? ''}
          onChange={(e) => setCarryFrom(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">Start fresh</option>
          {finished.map((round) => (
            <option key={round.id} value={round.id}>
              {round.name}
            </option>
          ))}
        </select>
      </label>

      <form
        className="grid"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              name: form.name.trim(),
              startingBalanceCents: startingBalanceCents!,
              profitGoalCents: profitGoalCents!,
              markets: form.markets,
              watchlist,
              riskProfile: form.riskProfile,
              tradingStyle: form.tradingStyle,
              model: form.model,
              checkinCron,
              guardrails,
            },
            { onSuccess: (created) => setCreatedId(created.id) },
          );
        }}
      >
        <label>
          Round name
          <input value={form.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label>
          Starting balance ($)
          <input value={form.startingBalance} onChange={(e) => set('startingBalance', e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Profit goal ($)
          <input value={form.profitGoal} onChange={(e) => set('profitGoal', e.target.value)} inputMode="decimal" />
        </label>

        <fieldset style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <legend>Markets</legend>
          {(['ASX', 'US'] as Market[]).map((market) => (
            <label key={market} className="row">
              <input
                type="checkbox"
                checked={form.markets.includes(market)}
                onChange={(e) =>
                  set('markets', e.target.checked ? [...form.markets, market] : form.markets.filter((m) => m !== market))
                }
              />
              {market}
            </label>
          ))}
        </fieldset>

        <label>
          Watchlist (comma separated)
          <input value={form.watchlist} onChange={(e) => set('watchlist', e.target.value)} />
        </label>
        <label>
          Risk profile
          <select value={form.riskProfile} onChange={(e) => set('riskProfile', e.target.value as RoundConfig['riskProfile'])}>
            {['conservative', 'balanced', 'aggressive', 'custom'].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Trading style
          <select value={form.tradingStyle} onChange={(e) => set('tradingStyle', e.target.value as RoundConfig['tradingStyle'])}>
            {['day', 'swing', 'long'].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Model
          <input value={form.model} onChange={(e) => set('model', e.target.value)} />
        </label>
        <label>
          Check-in schedule (one cron expression per line)
          <textarea rows={3} value={form.checkinCron} onChange={(e) => set('checkinCron', e.target.value)} />
        </label>

        <fieldset className="grid" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <legend>Guardrails — blank disables</legend>
          <label>
            Stop-loss %
            <input value={form.stopLossPct} onChange={(e) => set('stopLossPct', e.target.value)} inputMode="decimal" />
          </label>
          <label>
            Max position %
            <input value={form.maxPositionPct} onChange={(e) => set('maxPositionPct', e.target.value)} inputMode="decimal" />
          </label>
          <label>
            Drawdown pause %
            <input value={form.drawdownPausePct} onChange={(e) => set('drawdownPausePct', e.target.value)} inputMode="decimal" />
          </label>
        </fieldset>

        {warnings.length > 0 && (
          <div className="panel" style={{ borderColor: 'var(--loss)' }}>
            <strong>Before you start:</strong>
            <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        <ErrorBox error={create.error} />
        <button className="primary" type="submit" disabled={!valid || create.isPending}>
          Create round
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 14 new tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages frontend/test/warnings.test.ts frontend/test/new-round.test.tsx
git commit -m "feat: new round wizard with carry-over and foot-gun warnings"
```

---

## Task 13: Settings page

Spec §6.1: round defaults, integrations, look & feel, notification toggles, password change. Each section saves to its own namespace via `PUT /api/settings/:namespace`.

**Files:**
- Create/replace: `frontend/src/pages/SettingsPage.tsx`
- Create: `frontend/src/shell/useTheme.ts`
- Modify: `frontend/src/App.tsx`
- Create: `frontend/test/settings-page.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/settings-page.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from '../src/pages/SettingsPage';
import { renderWithProviders } from './render';
import { server } from './server';

describe('settings page', () => {
  it('loads each section from the server', async () => {
    renderWithProviders(<SettingsPage />);

    await waitFor(() => expect(screen.getByLabelText(/default starting balance/i)).toHaveValue('50.00'));
    expect(screen.getByLabelText(/ntfy topic/i)).toHaveValue('stake');
    expect(screen.getByLabelText(/^theme/i)).toHaveValue('system');
    expect(screen.getByLabelText(/poll interval/i)).toHaveValue('5');
  });

  it('saves round defaults as cents to the right namespace', async () => {
    let url = '';
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/settings/:namespace', async ({ request }) => {
        url = new URL(request.url).pathname;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<SettingsPage />);

    const balance = await screen.findByLabelText(/default starting balance/i);
    await userEvent.clear(balance);
    await userEvent.type(balance, '100');
    await userEvent.click(screen.getByRole('button', { name: /save round defaults/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(url).toBe('/api/settings/roundDefaults');
    expect(body).toMatchObject({ startingBalanceCents: 10000, profitGoalCents: 100000 });
  });

  it('saves integrations including the ntfy toggle', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/settings/integrations', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<SettingsPage />);

    await userEvent.click(await screen.findByLabelText(/enable ntfy/i));
    await userEvent.click(screen.getByRole('button', { name: /save integrations/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ ntfy: { enabled: true, topic: 'stake' }, pollIntervalMinutes: 5 });
  });

  it('applies the theme to the document immediately', async () => {
    renderWithProviders(<SettingsPage />);

    await userEvent.selectOptions(await screen.findByLabelText(/^theme/i), 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('saves notification toggles per event kind', async () => {
    let body: Record<string, boolean> | null = null;
    server.use(
      http.put('/api/settings/notifications', async ({ request }) => {
        body = (await request.json()) as Record<string, boolean>;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<SettingsPage />);

    await userEvent.click(await screen.findByLabelText(/notify on trade/i));
    await userEvent.click(screen.getByRole('button', { name: /save notifications/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.trade).toBe(false);
    expect(body!.skim).toBe(true);
  });

  it('changes the password and reports success', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/auth/password', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<SettingsPage />);

    await userEvent.type(await screen.findByLabelText(/current password/i), 'hunter22');
    await userEvent.type(screen.getByLabelText(/new password/i), 'hunter33');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => expect(body).toEqual({ current: 'hunter22', next: 'hunter33' }));
    expect(await screen.findByText(/password changed/i)).toBeInTheDocument();
  });

  it('reports a rejected password change', async () => {
    server.use(http.post('/api/auth/password', () => HttpResponse.json({ error: 'current password is wrong' }, { status: 403 })));
    renderWithProviders(<SettingsPage />);

    await userEvent.type(await screen.findByLabelText(/current password/i), 'nope');
    await userEvent.type(screen.getByLabelText(/new password/i), 'hunter33');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('current password is wrong');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- settings-page`
Expected: FAIL — placeholder page.

- [ ] **Step 3: Write the theme hook**

`frontend/src/shell/useTheme.ts`:

```ts
import { useEffect } from 'react';
import type { LookAndFeelSettings } from '../api/types';

/** Applies the stored look & feel to the document root (spec §6.1). */
export function applyTheme(look: Pick<LookAndFeelSettings, 'theme' | 'accent'>): void {
  const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const resolved = look.theme === 'system' ? (prefersDark ? 'dark' : 'light') : look.theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.setProperty('--accent', look.accent);
}

export function useTheme(look: LookAndFeelSettings | undefined): void {
  useEffect(() => {
    if (look) applyTheme(look);
  }, [look]);
}
```

Call it in `App.tsx` from a small component so the saved theme applies app-wide:

```tsx
function ThemeSync() {
  const settings = useSettings();
  useTheme(settings.data?.lookAndFeel);
  return null;
}
```

Render `<ThemeSync />` next to `<LiveUpdates />`.

- [ ] **Step 4: Write the settings page**

`frontend/src/pages/SettingsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useChangePassword, useSaveSettings, useSettings } from '../api/hooks';
import type { IntegrationSettings, LookAndFeelSettings, Market, RoundConfig, Settings } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { Spinner } from '../components/Spinner';
import { dollarsToCents } from '../lib/format';
import { applyTheme } from '../shell/useTheme';

type Defaults = Omit<RoundConfig, 'name'>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel grid">
      <h2 style={{ margin: 0, fontSize: '1rem' }}>{title}</h2>
      {children}
    </section>
  );
}

function RoundDefaultsForm({ initial }: { initial: Defaults }) {
  const save = useSaveSettings('roundDefaults');
  const [balance, setBalance] = useState((initial.startingBalanceCents / 100).toFixed(2));
  const [goal, setGoal] = useState((initial.profitGoalCents / 100).toFixed(2));
  const [markets, setMarkets] = useState<Market[]>(initial.markets);
  const [watchlist, setWatchlist] = useState(initial.watchlist.join(', '));
  const [model, setModel] = useState(initial.model);
  const [cron, setCron] = useState(initial.checkinCron.join('\n'));

  const balanceCents = dollarsToCents(balance);
  const goalCents = dollarsToCents(goal);

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        if (balanceCents === null || goalCents === null) return;
        save.mutate({
          ...initial,
          startingBalanceCents: balanceCents,
          profitGoalCents: goalCents,
          markets,
          watchlist: watchlist.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s !== ''),
          model,
          checkinCron: cron.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
        });
      }}
    >
      <p className="muted" style={{ margin: 0 }}>
        These pre-fill the new-round wizard. Editing them never changes an existing round.
      </p>
      <label>
        Default starting balance ($)
        <input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Default profit goal ($)
        <input value={goal} onChange={(e) => setGoal(e.target.value)} inputMode="decimal" />
      </label>
      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <legend>Default markets</legend>
        {(['ASX', 'US'] as Market[]).map((market) => (
          <label key={market} className="row">
            <input
              type="checkbox"
              checked={markets.includes(market)}
              onChange={(e) => setMarkets(e.target.checked ? [...markets, market] : markets.filter((m) => m !== market))}
            />
            {market}
          </label>
        ))}
      </fieldset>
      <label>
        Default watchlist
        <input value={watchlist} onChange={(e) => setWatchlist(e.target.value)} />
      </label>
      <label>
        Default model
        <input value={model} onChange={(e) => setModel(e.target.value)} />
      </label>
      <label>
        Default check-in schedule
        <textarea rows={3} value={cron} onChange={(e) => setCron(e.target.value)} />
      </label>
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save round defaults
      </button>
    </form>
  );
}

function IntegrationsForm({ initial }: { initial: IntegrationSettings }) {
  const save = useSaveSettings('integrations');
  const [url, setUrl] = useState(initial.ntfy.url);
  const [topic, setTopic] = useState(initial.ntfy.topic);
  const [enabled, setEnabled] = useState(initial.ntfy.enabled);
  const [poll, setPoll] = useState(String(initial.pollIntervalMinutes));

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        const minutes = Number(poll);
        save.mutate({
          ntfy: { url, topic, enabled },
          pollIntervalMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : initial.pollIntervalMinutes,
        });
      }}
    >
      <label>
        ntfy server URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        ntfy topic
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </label>
      <label className="row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable ntfy notifications
      </label>
      <label>
        Poll interval (minutes)
        <input value={poll} onChange={(e) => setPoll(e.target.value)} inputMode="numeric" />
      </label>
      <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
        The poll interval takes effect when the backend restarts.
      </p>
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save integrations
      </button>
    </form>
  );
}

function LookAndFeelForm({ initial }: { initial: LookAndFeelSettings }) {
  const save = useSaveSettings('lookAndFeel');
  const [look, setLook] = useState(initial);

  // Preview immediately; the save button persists it.
  useEffect(() => {
    applyTheme(look);
  }, [look]);

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(look);
      }}
    >
      <label>
        Theme
        <select value={look.theme} onChange={(e) => setLook({ ...look, theme: e.target.value as LookAndFeelSettings['theme'] })}>
          {['light', 'dark', 'system'].map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        Accent colour
        <input type="color" value={look.accent} onChange={(e) => setLook({ ...look, accent: e.target.value })} />
      </label>
      <label>
        Default chart style
        <select
          value={look.chartStyle}
          onChange={(e) => setLook({ ...look, chartStyle: e.target.value as LookAndFeelSettings['chartStyle'] })}
        >
          <option value="line">line</option>
          <option value="candles">candles</option>
        </select>
      </label>
      <label>
        Display timezone
        <input value={look.timezone} onChange={(e) => setLook({ ...look, timezone: e.target.value })} />
      </label>
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save look &amp; feel
      </button>
    </form>
  );
}

function NotificationsForm({ initial }: { initial: Settings['notifications'] }) {
  const save = useSaveSettings('notifications');
  const [toggles, setToggles] = useState(initial);

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(toggles);
      }}
    >
      {Object.entries(toggles).map(([kind, on]) => (
        <label key={kind} className="row">
          <input type="checkbox" checked={on} onChange={(e) => setToggles({ ...toggles, [kind]: e.target.checked })} />
          Notify on {kind}
        </label>
      ))}
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save notifications
      </button>
    </form>
  );
}

function PasswordForm() {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        setDone(false);
        change.mutate(
          { current, next },
          {
            onSuccess: () => {
              setDone(true);
              setCurrent('');
              setNext('');
            },
          },
        );
      }}
    >
      <label>
        Current password
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label>
        New password
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </label>
      <ErrorBox error={change.error} />
      {done && <p className="gain" style={{ margin: 0 }}>Password changed.</p>}
      <button className="primary" type="submit" disabled={current === '' || next === '' || change.isPending}>
        Change password
      </button>
    </form>
  );
}

export function SettingsPage() {
  const settings = useSettings();

  if (settings.isPending) return <Spinner label="Loading settings" />;
  if (settings.error) return <ErrorBox error={settings.error} />;
  if (!settings.data) return null;

  return (
    <div className="grid" style={{ maxWidth: 620 }}>
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Settings</h1>
      <Section title="Round defaults">
        <RoundDefaultsForm initial={settings.data.roundDefaults} />
      </Section>
      <Section title="Integrations">
        <IntegrationsForm initial={settings.data.integrations} />
      </Section>
      <Section title="Look &amp; feel">
        <LookAndFeelForm initial={settings.data.lookAndFeel} />
      </Section>
      <Section title="Notifications">
        <NotificationsForm initial={settings.data.notifications} />
      </Section>
      <Section title="Password">
        <PasswordForm />
      </Section>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit`
Expected: 7 new tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src frontend/test/settings-page.test.tsx
git commit -m "feat: settings page with defaults, integrations, theme, notifications, password"
```

---

## Task 14: Markets page

Spec §6: "chart any tracked symbol (held or not): candles/line + volume, 1D/1W/1M/3M/all, moving-average and %-change overlays, markers for every round's trades on that symbol."

**Files:**
- Create/replace: `frontend/src/pages/MarketsPage.tsx`
- Modify: `frontend/src/api/hooks.ts` (all-rounds trade lookup)
- Create: `frontend/test/markets-page.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/test/markets-page.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { MarketsPage } from '../src/pages/MarketsPage';
import { renderWithProviders } from './render';
import { server } from './server';

const priceChartProps = vi.fn();
vi.mock('../src/components/charts/PriceChart', () => ({
  PriceChart: (props: Record<string, unknown>) => {
    priceChartProps(props);
    return <div data-testid="price-chart" />;
  },
}));

const symbols = [
  { symbol: 'AAPL', market: 'US', name: null, archived: 0, first_seen_at: null, last_polled_at: null },
  { symbol: 'BHP.AX', market: 'ASX', name: null, archived: 1, first_seen_at: null, last_polled_at: null },
];

const history = {
  symbol: 'AAPL', range: '1M', interval: '1d', currency: 'USD', stale: false,
  bars: [
    { ts: '2026-08-01T00:00:00.000Z', open: 9, high: 11, low: 8, close: 10, volume: 100 },
    { ts: '2026-08-02T00:00:00.000Z', open: 10, high: 12, low: 9, close: 11, volume: 120 },
  ],
};

describe('markets page', () => {
  it('lists tracked symbols and separates archived ones', async () => {
    server.use(http.get('/api/market/symbols', () => HttpResponse.json(symbols)));
    renderWithProviders(<MarketsPage />);

    expect(await screen.findByRole('button', { name: 'AAPL' })).toBeInTheDocument();
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
  });

  it('charts the selected symbol over the chosen range', async () => {
    let requestedRange = '';
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', ({ request }) => {
        requestedRange = new URL(request.url).searchParams.get('range') ?? '';
        return HttpResponse.json(history);
      }),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '3M' }));
    await waitFor(() => expect(requestedRange).toBe('3M'));
  });

  it('toggles between candles and line', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json(history)),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    await waitFor(() => expect(priceChartProps).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /candles/i }));
    await waitFor(() => {
      const last = priceChartProps.mock.calls.at(-1)![0] as { style: string };
      expect(last.style).toBe('candles');
    });
  });

  it('passes a moving-average window through when enabled', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json(history)),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    await userEvent.selectOptions(screen.getByLabelText(/moving average/i), '20');

    await waitFor(() => {
      const last = priceChartProps.mock.calls.at(-1)![0] as { movingAverage?: number };
      expect(last.movingAverage).toBe(20);
    });
  });

  it('shows the % change over the loaded range', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json(history)),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    // close 10 → 11
    expect(await screen.findByText('+10.0%')).toBeInTheDocument();
  });

  it('marks the chart with trades on that symbol from every round', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json(history)),
      http.get('/api/rounds/1/trades', () =>
        HttpResponse.json([
          { id: 1, order_id: 1, round_id: 1, symbol: 'AAPL', side: 'buy', quantity: 2, price_aud: 10, gross_cents: 2000, fee_cents: 0, executed_at: '2026-08-01T02:00:00.000Z' },
          { id: 2, order_id: 2, round_id: 1, symbol: 'MSFT', side: 'buy', quantity: 1, price_aud: 30, gross_cents: 3000, fee_cents: 0, executed_at: '2026-08-01T02:00:00.000Z' },
        ]),
      ),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    await waitFor(() => {
      const last = priceChartProps.mock.calls.at(-1)![0] as { trades: { symbol: string }[] };
      expect(last.trades).toHaveLength(1);
      expect(last.trades[0]!.symbol).toBe('AAPL');
    });
  });

  it('tracks a new symbol', async () => {
    let tracked: string | null = null;
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.post('/api/market/symbols', async ({ request }) => {
        tracked = ((await request.json()) as { symbol: string }).symbol;
        return HttpResponse.json({ symbol: 'TSLA' }, { status: 201 });
      }),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.type(await screen.findByLabelText(/track a symbol/i), 'tsla');
    await userEvent.click(screen.getByRole('button', { name: /^track$/i }));

    await waitFor(() => expect(tracked).toBe('tsla'));
  });

  it('flags stale history', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json({ ...history, stale: true })),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    expect(await screen.findByText(/last known prices/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- markets-page`
Expected: FAIL — placeholder page.

- [ ] **Step 3: Add the cross-round trade hook**

Append to `frontend/src/api/hooks.ts`:

```ts
import { useQueries } from '@tanstack/react-query';

/**
 * Trades on one symbol across every round — the Markets page marks them all
 * (spec §6). One query per round keeps the per-round caches shared.
 */
export function useTradesForSymbol(symbol: string): { trades: TradeRow[]; isPending: boolean } {
  const rounds = useRounds();
  const results = useQueries({
    queries: (rounds.data ?? []).map((round) => ({
      queryKey: qk.trades(round.id),
      queryFn: () => apiFetch<TradeRow[]>(`/api/rounds/${round.id}/trades`),
    })),
  });
  const trades = results
    .flatMap((result) => result.data ?? [])
    .filter((trade) => trade.symbol === symbol);
  return { trades, isPending: rounds.isPending || results.some((r) => r.isPending) };
}

export function useTrackSymbol(): UseMutationResult<{ symbol: string }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (symbol) => apiFetch<{ symbol: string }>('/api/market/symbols', { method: 'POST', body: { symbol } }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.symbols }),
  });
}

export function useArchiveSymbol(): UseMutationResult<
  { symbol: string; archived: boolean }, Error, { symbol: string; archived: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, archived }) =>
      apiFetch<{ symbol: string; archived: boolean }>(`/api/market/symbols/${encodeURIComponent(symbol)}/archive`, {
        method: 'POST',
        body: { archived },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.symbols }),
  });
}
```

- [ ] **Step 4: Write the page**

`frontend/src/pages/MarketsPage.tsx`:

```tsx
import { useState } from 'react';
import {
  useArchiveSymbol, useHistory, useSettings, useSymbols, useTrackSymbol, useTradesForSymbol,
} from '../api/hooks';
import type { ChartRange } from '../api/types';
import { PriceChart } from '../components/charts/PriceChart';
import { ErrorBox } from '../components/ErrorBox';
import { Spinner } from '../components/Spinner';

const RANGES: ChartRange[] = ['1D', '1W', '1M', '3M', 'ALL'];
const MA_WINDOWS = [0, 5, 10, 20, 50];

export function MarketsPage() {
  const symbols = useSymbols();
  const settings = useSettings();
  const track = useTrackSymbol();
  const archive = useArchiveSymbol();

  const [selected, setSelected] = useState('');
  const [range, setRange] = useState<ChartRange>('1M');
  const [style, setStyle] = useState<'line' | 'candles'>(settings.data?.lookAndFeel.chartStyle ?? 'line');
  const [ma, setMa] = useState(0);
  const [newSymbol, setNewSymbol] = useState('');

  const history = useHistory(selected, range);
  const { trades } = useTradesForSymbol(selected);

  const bars = history.data?.bars ?? [];
  const changePct =
    bars.length >= 2 ? ((bars[bars.length - 1]!.close - bars[0]!.close) / bars[0]!.close) * 100 : null;

  const active = (symbols.data ?? []).filter((s) => s.archived === 0);
  const archived = (symbols.data ?? []).filter((s) => s.archived === 1);

  return (
    <section className="grid">
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Markets</h1>

      <div className="panel grid">
        <div className="row">
          {symbols.isPending && <Spinner label="Loading symbols" />}
          {active.map((row) => (
            <button
              key={row.symbol}
              onClick={() => setSelected(row.symbol)}
              className={selected === row.symbol ? 'primary' : undefined}
            >
              {row.symbol}
            </button>
          ))}
          {active.length === 0 && !symbols.isPending && <span className="muted">No tracked symbols yet.</span>}
        </div>

        {archived.length > 0 && (
          <div className="row muted" style={{ fontSize: '0.85em' }}>
            <span>Archived:</span>
            {archived.map((row) => (
              <button key={row.symbol} onClick={() => archive.mutate({ symbol: row.symbol, archived: false })}>
                {row.symbol} — restore
              </button>
            ))}
          </div>
        )}

        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            if (newSymbol.trim() === '') return;
            track.mutate(newSymbol, { onSuccess: () => setNewSymbol('') });
          }}
        >
          <label>
            Track a symbol
            <input value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} placeholder="TSLA" />
          </label>
          <button type="submit" disabled={track.isPending}>
            Track
          </button>
        </form>
        <ErrorBox error={track.error} />
      </div>

      {selected === '' ? (
        <p className="muted">Pick a symbol to chart it.</p>
      ) : (
        <div className="panel grid">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{selected}</strong>
            {changePct !== null && (
              <span className={changePct >= 0 ? 'gain' : 'loss'}>
                {changePct >= 0 ? '+' : ''}
                {changePct.toFixed(1)}%
              </span>
            )}
          </div>

          <div className="row">
            {RANGES.map((option) => (
              <button key={option} onClick={() => setRange(option)} className={range === option ? 'primary' : undefined}>
                {option}
              </button>
            ))}
            <button onClick={() => setStyle(style === 'line' ? 'candles' : 'line')}>
              {style === 'line' ? 'Candles' : 'Line'}
            </button>
            <label>
              Moving average
              <select value={ma} onChange={(e) => setMa(Number(e.target.value))}>
                {MA_WINDOWS.map((window) => (
                  <option key={window} value={window}>
                    {window === 0 ? 'off' : `${window} bars`}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => archive.mutate({ symbol: selected, archived: true })}>Archive</button>
          </div>

          {history.isPending && <Spinner label="Loading history" />}
          <ErrorBox error={history.error} />
          {history.data?.stale && (
            <p className="loss" style={{ margin: 0 }}>
              Showing last known prices — the market data fetch failed.
            </p>
          )}
          {history.data && (
            <PriceChart bars={bars} style={style} trades={trades} movingAverage={ma === 0 ? undefined : ma} />
          )}
          <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
            {history.data ? `${history.data.interval} bars · ${history.data.currency}` : ''} · {trades.length} trade
            {trades.length === 1 ? '' : 's'} marked
          </p>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`
Expected: 8 new tests pass; the production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src frontend/test/markets-page.test.tsx
git commit -m "feat: markets page with candles, volume, overlays and trade markers"
```

---

## Task 15: Docker Compose packaging and setup script

Two containers: the Node backend, and nginx serving the built SPA and proxying `/api`. SSE needs proxy buffering off or events arrive in clumps.

**Files:**
- Create: `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`, `docker-compose.yml`, `.dockerignore`, `scripts/setup.sh`, `README.md`

- [ ] **Step 1: Write the backend Dockerfile**

`backend/Dockerfile`:

```dockerfile
# better-sqlite3 and argon2 are native modules — build them on the same base image we run on.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data
ENV DB_PATH=/data/stake.db
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

`npm ci` installs devDependencies (typescript is needed for the build); the runtime stage copies the same `node_modules` so the compiled native bindings match. That trades image size for correctness — a `npm ci --omit=dev` in the runtime stage would rebuild the native modules and can drift.

- [ ] **Step 2: Write the frontend image and nginx config**

`frontend/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

`frontend/nginx.conf`:

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;

  # SPA routes: everything that is not a real file falls through to index.html.
  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://backend:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Server-sent events: no buffering, no timeout, or the stream stalls.
  location /api/events/stream {
    proxy_pass http://backend:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
    chunked_transfer_encoding off;
  }
}
```

- [ ] **Step 3: Write the compose file**

`docker-compose.yml` at the repo root:

```yaml
services:
  backend:
    build: ./backend
    restart: unless-stopped
    environment:
      PORT: 3000
      DB_PATH: /data/stake.db
      TRUST_PROXY: "1"
      # Set to 1 once you terminate TLS in front of nginx.
      COOKIE_SECURE: "${COOKIE_SECURE:-0}"
      # Point at the OneCLI gateway; the real token never lands in this file.
      ANTHROPIC_BASE_URL: "${ANTHROPIC_BASE_URL:-http://host.docker.internal:8080}"
      ANTHROPIC_AUTH_TOKEN: "${ANTHROPIC_AUTH_TOKEN:-placeholder}"
      TZ: Australia/Sydney
    volumes:
      - stake-data:/data
    extra_hosts:
      - "host.docker.internal:host-gateway"

  web:
    build: ./frontend
    restart: unless-stopped
    depends_on:
      - backend
    ports:
      - "8088:80"

volumes:
  stake-data:
```

`.dockerignore` at the repo root:

```
**/node_modules
**/dist
**/data
.git
docs
```

- [ ] **Step 4: Write the setup script**

`scripts/setup.sh` (make it executable with `chmod +x`):

```bash
#!/usr/bin/env bash
# First-run setup: Claude auth, the initial user, then bring the stack up.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> 1/3  Claude subscription auth (OneCLI gateway)"
if [ -x scripts/setup-claude-auth.sh ]; then
  ./scripts/setup-claude-auth.sh
else
  echo "scripts/setup-claude-auth.sh missing — skipping"
fi

echo
echo "==> 2/3  Build and start the stack"
docker compose up -d --build

echo
echo "==> 3/3  Create the dashboard login"
if docker compose exec -T backend node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH);
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  process.exit(row.c > 0 ? 0 : 1);
" 2>/dev/null; then
  echo "A user already exists — skipping."
else
  read -r -p "Username: " USERNAME
  read -r -s -p "Password: " PASSWORD
  echo
  docker compose exec -T -e SETUP_USER="$USERNAME" -e SETUP_PASS="$PASSWORD" backend \
    node dist/cli.js create-user "$USERNAME" <<< "$PASSWORD"
fi

echo
echo "Dashboard: http://localhost:8088"
```

Before writing this, read `backend/src/cli.ts` and match how `create-user` actually takes its password (argument, prompt or stdin). If the CLI prompts interactively, drop the heredoc and run the command attached to a TTY (`docker compose exec backend node dist/cli.js create-user "$USERNAME"`). Adjust the script to what the CLI really does and note the adjustment in your report.

- [ ] **Step 5: Verify the stack builds and serves**

```bash
docker compose build
docker compose up -d
curl -fsS http://localhost:8088/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:8088/
docker compose down
```

Expected: `{"ok":true}` from the health check and `200` for the SPA index. If Docker is unavailable in your environment, report BLOCKED with the exact error rather than marking this step done — the Dockerfiles are still committed for the operator to run.

- [ ] **Step 6: Write the README**

`README.md` at the repo root:

```markdown
# stake_portfolio

Paper-trading agent. Claude-powered rounds trade ASX and US shares against a fixed bankroll,
and every sell that lifts cash above the starting balance skims the excess into a profit
ledger. Rounds pause at their goal and can be chained.

## Quick start (Docker)

```bash
./scripts/setup.sh          # Claude auth, build, start, create the login
open http://localhost:8088
```

## Development

```bash
cd backend  && npm install && npm run dev    # API on :3000
cd frontend && npm install && npm run dev    # dashboard on :5173, proxies /api
```

```bash
cd backend  && npm test && npx tsc --noEmit
cd frontend && npm test && npx tsc --noEmit
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `DB_PATH` | `./data/stake.db` | SQLite database (WAL) |
| `COOKIE_SECURE` | `0` | Set to `1` when serving over TLS |
| `TRUST_PROXY` | `0` | Set to `1` behind nginx so rate limiting sees real client IPs |
| `ANTHROPIC_BASE_URL` | — | OneCLI gateway URL |
| `ANTHROPIC_AUTH_TOKEN` | — | Gateway placeholder token; the real subscription token lives in the OneCLI vault |

There is no `ANTHROPIC_API_KEY` anywhere, by design — the agent subprocess strips it.

## Layout

- `backend/` — engine, market data, broker, rounds service, scheduler, API, Claude agent
- `frontend/` — React + Vite dashboard
- `docs/superpowers/` — the spec and the implementation plans
```

- [ ] **Step 7: Commit**

```bash
chmod +x scripts/setup.sh
git add backend/Dockerfile frontend/Dockerfile frontend/nginx.conf docker-compose.yml .dockerignore scripts/setup.sh README.md
git commit -m "feat: docker compose packaging, nginx SSE proxy, setup script, README"
```

---

## Task 16: Whole-branch review and documentation

Per the established process, a whole-branch review runs before merging — it has caught cross-file bugs that per-task reviews missed.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run everything**

```bash
cd backend  && npm test && npx tsc --noEmit && npm run build
cd ../frontend && npm test && npx tsc --noEmit && npm run build
```

Record the exact observed test totals for both suites.

- [ ] **Step 2: Dispatch the whole-branch review**

Review the full diff of this branch against `master` in two stages, spec-compliance then code-quality, with instructions to read the code rather than trust task reports. Focus areas, in priority order:

1. **Money path.** Every place the frontend produces or consumes cents. Look for `parseFloat` on money, dollar values sent where cents are expected, and any arithmetic on money outside `format.ts`.
2. **`migrations.ts`.** Confirm index 0 is byte-identical to `master` and only index 1 was added.
3. **`scheduler.ts`.** Confirm the `stopLossWhenPaused` guard wraps only the stop-loss loop, that equity snapshots and the drawdown check still run for paused rounds, and that a round created before the migration (no such key in `config_json`) keeps its stops.
4. **Guardrail deep-merge.** The config panel and wizard must both send complete `guardrails` objects.
5. **Permission matrix drift.** `Controls.tsx`'s `TRANSITIONS` against `rounds-routes.ts`'s, and `OrderForm`'s terminal-status list against `canTrade` in `rounds/service.ts`.
6. **Query invalidation.** Any mutation that changes cash, positions or status must invalidate `qk.round`, `qk.rounds` and the affected lists.

- [ ] **Step 3: Apply review fixes**

Send fixes to the implementer that owns each file, then re-review. Money-path findings get the full two-reviewer treatment.

- [ ] **Step 4: Update CLAUDE.md**

Rewrite the **CURRENT STATE** section for the merged frontend, and:
- record the new backend and frontend test totals;
- move the four deferred items (cookie `secure`, `trust proxy`, paused-round stop-loss, limiter pruning) out of "Deferred / tracked for later" — they are done;
- add the frontend to **Repo layout / stack**: React 19 + Vite 8, TanStack Query, React Router 7, lightweight-charts 5, vitest + jsdom + Testing Library + msw, tests in `frontend/test/`;
- add the frontend commands to **Commands**;
- add these frontend invariants to the hard-won list:
  - the frontend sends and receives integer cents; `dollarsToCents` is the only conversion point;
  - `lightweight-charts` is imported in exactly three files under `src/components/charts/`, mirroring the SDK-in-one-file rule;
  - SSE events invalidate query keys and never carry UI state;
  - `Controls.tsx` mirrors the backend transition table — change both together;
- note that Plan 5 (analytics) is next and point at its file.

- [ ] **Step 5: Commit and merge**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for the merged frontend"
git checkout master
git merge --no-ff feature/frontend -m "Merge Plan 4: React dashboard, markets charts, Docker packaging (reviewed)"
cd backend && npm test
cd ../frontend && npm test
```

Both suites must be green on `master` before Plan 5 starts.

---

## Self-review notes

Checked against spec §6, §6.1 and §7:

- Rounds overview (cards, state, sparkline, pocketed, badges) — Task 8.
- Round detail (equity curve with trade markers, pocketed staircase, positions, trade/skim history, journal, daily summaries, live settings panel, pause/takeover/kill, manual order form) — Tasks 9–11.
- New round wizard (config, defaults pre-fill, carry-over, foot-gun warnings) — Task 12.
- Settings page (round defaults, integrations, look & feel, notifications, password) and the login gate — Tasks 5 and 13.
- Markets page (any tracked symbol, candles/line + volume, 1D–ALL, MA and %-change overlays, cross-round trade markers, archive semantics) — Tasks 1, 2 and 14.
- Live updates via SSE — Task 6.
- Error handling: stale quotes surfaced in positions and the order form; a market-data outage degrades history to cached bars rather than failing the page.
- **Analytics (§6 bullet 6) is deliberately not here** — it is Plan 5, executed immediately after this one.

Known constraints carried forward:

- Unrealised P/L in `PositionsTable` is shown only for AUD-quoted holdings. Cost bases are AUD cents while quotes for US symbols are USD, and the AUD/USD rate is not exposed over the API. Plan 5 adds a converted valuation endpoint; until then a US position shows `—` rather than a wrong number.
- Two `EventSource` connections are open on the round detail page (one global, one round-scoped). That is intentional and cheap; if it ever matters, promote the stream to a context.
