# Phase 1 / Plan 1 — Backend Trading Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic paper-trading engine: SQLite persistence, skim/guardrail rules, fee/FX model, PaperBroker, market data polling, and the scheduler — fully covered by vitest, no HTTP layer yet.

**Architecture:** A Node 22 / TypeScript (ESM, NodeNext) package in `backend/`. Pure-function rules engine (`src/engine/`), side-effectful services around it (`src/broker/`, `src/market/`, `src/rounds/`, `src/scheduler.ts`), all state in SQLite via better-sqlite3. Money is always **integer AUD cents**; share quantities are floats (fractional US shares, whole ASX shares). Everything injectable for tests: the Yahoo quote fetcher, the clock, and the DB (`:memory:`).

**Tech Stack:** TypeScript 5, vitest, better-sqlite3, yahoo-finance2, node-cron.

**Spec:** `docs/superpowers/specs/2026-08-02-trading-agent-design.md` (§2 concepts, §3 architecture). Plan 2 adds Claude/DecisionService, API, auth, settings, ntfy; Plan 3 adds frontend + Docker.

---

## File Structure

```
backend/
  package.json  tsconfig.json  vitest.config.ts  .gitignore
  src/
    db/
      connection.ts     # open SQLite, pragmas
      migrations.ts     # ordered SQL migration strings (schema v1 = full spec §3.3)
      migrate.ts        # idempotent migration runner
      events.ts         # logEvent() → event_log table
    engine/             # PURE FUNCTIONS ONLY — no I/O, no Date.now()
      types.ts          # Market, RoundConfig, GuardrailConfig, FeeConfig, defaults, cents()
      skim.ts           # computeSkimCents()
      guardrails.ts     # clipBuy(), stopLossTriggered(), drawdownBreached()
      fees.ts           # tradeFeeCents(), applySlippage(), usdToAud()
    market/
      hours.ts          # isMarketOpen(market, date) — timezone-aware
      data.ts           # MarketDataService: poll/cache/persist quotes, staleness, AUDUSD
      yahoo.ts          # yahooFetcher (QuoteFetcher impl) — the only file touching yahoo-finance2
    broker/
      types.ts          # Quote, OrderRequest, Fill, Broker interface
      paper.ts          # PaperBroker — fills at quote, fees/slippage, writes orders+trades
    rounds/
      service.ts        # RoundService — create/buy/sell/skim/goal/bust/status/equity
    scheduler.ts        # pollOnce() + start() cron wiring
  test/
    smoke.test.ts  migrate.test.ts  skim.test.ts  guardrails.test.ts  fees.test.ts
    hours.test.ts  paper-broker.test.ts  round-service.test.ts  market-data.test.ts
    scheduler.test.ts  round-lifecycle.test.ts
```

Run all commands from `backend/` unless stated otherwise.

---

### Task 1: Scaffold backend package

**Files:**
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`, `backend/.gitignore`
- Test: `backend/test/smoke.test.ts`

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "stock-portfolio-simulator-backend",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "tsc"
  }
}
```

- [ ] **Step 2: Create `backend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `backend/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 4: Create `backend/.gitignore`**

```
node_modules/
dist/
*.db
*.db-wal
*.db-shm
```

- [ ] **Step 5: Install dependencies**

Run:
```bash
npm install better-sqlite3 yahoo-finance2 node-cron
npm install -D typescript tsx vitest @types/node @types/better-sqlite3 @types/node-cron
```
Expected: both commands exit 0; `package.json` gains dependencies/devDependencies.

- [ ] **Step 6: Write toolchain smoke test** — `backend/test/smoke.test.ts`

```ts
import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests', () => {
    const sum: number = 1 + 1;
    expect(sum).toBe(2);
  });
});
```

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS — 1 test.

- [ ] **Step 8: Commit**

```bash
git add backend
git commit -m "chore: scaffold backend package (TS, vitest, better-sqlite3)"
```

---

### Task 2: DB connection, schema migration, event log

**Files:**
- Create: `backend/src/db/connection.ts`, `backend/src/db/migrations.ts`, `backend/src/db/migrate.ts`, `backend/src/db/events.ts`
- Test: `backend/test/migrate.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/migrate.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { logEvent } from '../src/db/events.js';

const EXPECTED_TABLES = [
  'rounds', 'config_events', 'symbols', 'price_bars', 'positions', 'orders',
  'trades', 'ledger_entries', 'equity_snapshots', 'checkins', 'journal_entries',
  'daily_summaries', 'event_log', 'settings', 'users', 'sessions',
];

describe('migrate', () => {
  it('creates the full schema on an empty database', () => {
    const db = openDb(':memory:');
    migrate(db);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_%' ESCAPE '\\'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const table of EXPECTED_TABLES) expect(names).toContain(table);
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it('logs events', () => {
    const db = openDb(':memory:');
    migrate(db);
    logEvent(db, 'info', 'test', 'hello', null);
    const row = db.prepare('SELECT level, kind, message, round_id FROM event_log').get() as {
      level: string; kind: string; message: string; round_id: number | null;
    };
    expect(row).toMatchObject({ level: 'info', kind: 'test', message: 'hello', round_id: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- migrate`
Expected: FAIL — cannot find module `../src/db/connection.js`.

- [ ] **Step 3: Create `backend/src/db/connection.ts`**

```ts
import Database from 'better-sqlite3';

export type DB = Database.Database;

export function openDb(path = ':memory:'): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 4: Create `backend/src/db/migrations.ts`** (schema v1 — spec §3.3)

```ts
export const migrations: string[] = [
  `
CREATE TABLE rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  starting_balance_cents INTEGER NOT NULL,
  cash_cents INTEGER NOT NULL,
  profit_goal_cents INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE config_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  changed_by TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE symbols (
  symbol TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  name TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE price_bars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  ts TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_price_bars_symbol_ts ON price_bars(symbol, ts);
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  quantity REAL NOT NULL,
  cost_basis_cents INTEGER NOT NULL,
  stop_loss_price REAL,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  client_order_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  requested_cents INTEGER,
  quantity REAL,
  status TEXT NOT NULL,
  placed_by TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  price_aud REAL NOT NULL,
  gross_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  executed_at TEXT NOT NULL
);
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  ref_order_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  ts TEXT NOT NULL,
  cash_cents INTEGER NOT NULL,
  holdings_cents INTEGER NOT NULL,
  equity_cents INTEGER NOT NULL
);
CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  ts TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  tokens_used INTEGER,
  status TEXT NOT NULL
);
CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  checkin_id INTEGER REFERENCES checkins(id),
  author TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  day TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  narrative TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(round_id, day)
);
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
];
```

- [ ] **Step 5: Create `backend/src/db/migrate.ts`**

```ts
import type { DB } from './connection.js';
import { migrations } from './migrations.js';

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number };
  for (let i = c; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]);
      db.prepare('INSERT INTO _migrations (idx, applied_at) VALUES (?, ?)').run(i, new Date().toISOString());
    })();
  }
}
```

- [ ] **Step 6: Create `backend/src/db/events.ts`**

```ts
import type { DB } from './connection.js';

export type EventLevel = 'info' | 'warn' | 'error';

export function logEvent(db: DB, level: EventLevel, kind: string, message: string, roundId: number | null = null): void {
  db.prepare('INSERT INTO event_log (round_id, level, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(roundId, level, kind, message, new Date().toISOString());
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- migrate`
Expected: PASS — 3 tests.

- [ ] **Step 8: Commit**

```bash
git add backend/src/db backend/test/migrate.test.ts
git commit -m "feat: sqlite schema v1, migration runner, event log"
```

---

### Task 3: Engine types + skim rule

**Files:**
- Create: `backend/src/engine/types.ts`, `backend/src/engine/skim.ts`
- Test: `backend/test/skim.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/skim.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { computeSkimCents } from '../src/engine/skim.js';
import { cents } from '../src/engine/types.js';

describe('computeSkimCents', () => {
  it("skims the excess over starting balance (spec §2.2 worked example: $70 cash on $50 start → $20 skim)", () => {
    expect(computeSkimCents(cents(70), cents(50))).toBe(cents(20));
  });

  it('skims nothing at exactly the starting balance', () => {
    expect(computeSkimCents(cents(50), cents(50))).toBe(0);
  });

  it('skims nothing below the starting balance', () => {
    expect(computeSkimCents(cents(35), cents(50))).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- skim`
Expected: FAIL — cannot find module `../src/engine/skim.js`.

- [ ] **Step 3: Create `backend/src/engine/types.ts`**

```ts
export type Market = 'ASX' | 'US';
export type RiskProfile = 'conservative' | 'balanced' | 'aggressive' | 'custom';
export type TradingStyle = 'day' | 'swing' | 'long';

/** Convert whole dollars to integer cents. All money in this codebase is integer AUD cents. */
export function cents(dollars: number): number {
  return Math.round(dollars * 100);
}

export interface GuardrailConfig {
  /** Sell a position when price falls this % below avg cost. null = disabled. */
  stopLossPct: number | null;
  /** Max % of starting balance held in one symbol (at cost). null = disabled. */
  maxPositionPct: number | null;
  /** Pause the round when equity has lost this % of starting balance. null = disabled. */
  drawdownPausePct: number | null;
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
}

export const DEFAULT_FEES: FeeConfig = { asxFlatCents: 300, usFxBps: 70, slippageBps: 0 };

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  stopLossPct: 10,
  maxPositionPct: 40,
  drawdownPausePct: 50,
};
```

- [ ] **Step 4: Create `backend/src/engine/skim.ts`**

```ts
/** Spec §2.2: after a sell, pocket whatever cash exceeds the starting balance. */
export function computeSkimCents(cashCents: number, startingBalanceCents: number): number {
  return Math.max(0, cashCents - startingBalanceCents);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- skim`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/engine backend/test/skim.test.ts
git commit -m "feat: engine types and skim rule"
```

---

### Task 4: Guardrails

**Files:**
- Create: `backend/src/engine/guardrails.ts`
- Test: `backend/test/guardrails.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/guardrails.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { clipBuy, drawdownBreached, stopLossTriggered } from '../src/engine/guardrails.js';
import { cents } from '../src/engine/types.js';

describe('clipBuy', () => {
  const base = { cashCents: cents(50), heldCostCents: 0, startingBalanceCents: cents(50), maxPositionPct: 40 as number | null };

  it('allows a buy inside all limits', () => {
    expect(clipBuy({ ...base, requestedCents: cents(15) }))
      .toEqual({ allowedCents: cents(15), clipped: false, rejected: false, reason: null });
  });

  it('clips to max position size (40% of $50 = $20)', () => {
    const r = clipBuy({ ...base, requestedCents: cents(30) });
    expect(r.allowedCents).toBe(cents(20));
    expect(r.clipped).toBe(true);
    expect(r.rejected).toBe(false);
  });

  it('counts existing holdings toward the cap', () => {
    const r = clipBuy({ ...base, heldCostCents: cents(15), requestedCents: cents(10) });
    expect(r.allowedCents).toBe(cents(5));
    expect(r.clipped).toBe(true);
  });

  it('rejects when the cap is already reached', () => {
    const r = clipBuy({ ...base, heldCostCents: cents(20), requestedCents: cents(5) });
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe('max position size reached');
  });

  it('clips to available cash', () => {
    const r = clipBuy({ ...base, maxPositionPct: null, cashCents: cents(8), requestedCents: cents(10) });
    expect(r.allowedCents).toBe(cents(8));
    expect(r.clipped).toBe(true);
  });

  it('rejects when there is no cash', () => {
    const r = clipBuy({ ...base, cashCents: 0, requestedCents: cents(10) });
    expect(r.rejected).toBe(true);
  });

  it('ignores the cap when maxPositionPct is null', () => {
    const r = clipBuy({ ...base, maxPositionPct: null, requestedCents: cents(50) });
    expect(r.allowedCents).toBe(cents(50));
    expect(r.rejected).toBe(false);
  });
});

describe('stopLossTriggered', () => {
  it('triggers on pct drop from avg cost', () => {
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 8.9, stopLossPct: 10, stopPrice: null })).toBe(true);
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 9.1, stopLossPct: 10, stopPrice: null })).toBe(false);
  });

  it('triggers on an explicit stop price', () => {
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 9.5, stopLossPct: null, stopPrice: 9.5 })).toBe(true);
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 9.6, stopLossPct: null, stopPrice: 9.5 })).toBe(false);
  });

  it('never triggers when both are disabled', () => {
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 0.01, stopLossPct: null, stopPrice: null })).toBe(false);
  });
});

describe('drawdownBreached', () => {
  it('breaches when equity has lost more than the threshold (50% of $50 → below $25)', () => {
    expect(drawdownBreached(cents(24), cents(50), 50)).toBe(true);
    expect(drawdownBreached(cents(25), cents(50), 50)).toBe(false);
  });

  it('is disabled when null', () => {
    expect(drawdownBreached(0, cents(50), null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- guardrails`
Expected: FAIL — cannot find module `../src/engine/guardrails.js`.

- [ ] **Step 3: Create `backend/src/engine/guardrails.ts`**

```ts
export interface BuyClipResult {
  allowedCents: number;
  clipped: boolean;
  rejected: boolean;
  reason: string | null;
}

export function clipBuy(params: {
  requestedCents: number;
  cashCents: number;
  heldCostCents: number;
  startingBalanceCents: number;
  maxPositionPct: number | null;
}): BuyClipResult {
  const { requestedCents, cashCents, heldCostCents, startingBalanceCents, maxPositionPct } = params;
  let allowed = Math.min(requestedCents, cashCents);
  let reason: string | null = allowed < requestedCents ? 'clipped to available cash' : null;

  if (maxPositionPct !== null) {
    const capRoom = Math.floor((startingBalanceCents * maxPositionPct) / 100) - heldCostCents;
    if (capRoom <= 0) {
      return { allowedCents: 0, clipped: false, rejected: true, reason: 'max position size reached' };
    }
    if (allowed > capRoom) {
      allowed = capRoom;
      reason = 'clipped to max position size';
    }
  }

  if (allowed <= 0) {
    return { allowedCents: 0, clipped: false, rejected: true, reason: reason ?? 'insufficient cash' };
  }
  return { allowedCents: allowed, clipped: allowed < requestedCents, rejected: false, reason };
}

export function stopLossTriggered(params: {
  avgCostPrice: number;
  currentPrice: number;
  stopLossPct: number | null;
  stopPrice: number | null;
}): boolean {
  const { avgCostPrice, currentPrice, stopLossPct, stopPrice } = params;
  if (stopPrice !== null && currentPrice <= stopPrice) return true;
  if (stopLossPct !== null && currentPrice <= avgCostPrice * (1 - stopLossPct / 100)) return true;
  return false;
}

export function drawdownBreached(
  equityCents: number,
  startingBalanceCents: number,
  drawdownPausePct: number | null,
): boolean {
  if (drawdownPausePct === null) return false;
  return equityCents < Math.floor((startingBalanceCents * (100 - drawdownPausePct)) / 100);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- guardrails`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/engine/guardrails.ts backend/test/guardrails.test.ts
git commit -m "feat: guardrails - position clip, stop-loss, drawdown"
```

---

### Task 5: Fees, slippage, FX

**Files:**
- Create: `backend/src/engine/fees.ts`
- Test: `backend/test/fees.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/fees.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { applySlippage, tradeFeeCents, usdToAud } from '../src/engine/fees.js';
import { DEFAULT_FEES, cents } from '../src/engine/types.js';

describe('tradeFeeCents', () => {
  it('charges the flat ASX brokerage', () => {
    expect(tradeFeeCents('ASX', cents(20), DEFAULT_FEES)).toBe(300);
  });

  it('charges FX bps on US notional (70bps of $100 = $0.70)', () => {
    expect(tradeFeeCents('US', cents(100), DEFAULT_FEES)).toBe(70);
  });

  it('rounds US fees up so fees are never understated', () => {
    expect(tradeFeeCents('US', 1, DEFAULT_FEES)).toBe(1);
  });
});

describe('applySlippage', () => {
  it('worsens the price against the trader on both sides (50bps)', () => {
    expect(applySlippage(100, 'buy', 50)).toBeCloseTo(100.5);
    expect(applySlippage(100, 'sell', 50)).toBeCloseTo(99.5);
  });

  it('is a no-op at 0 bps', () => {
    expect(applySlippage(100, 'buy', 0)).toBe(100);
  });
});

describe('usdToAud', () => {
  it('converts using USD-per-AUD rate (USD$65 at 0.65 = AUD$100)', () => {
    expect(usdToAud(65, 0.65)).toBeCloseTo(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fees`
Expected: FAIL — cannot find module `../src/engine/fees.js`.

- [ ] **Step 3: Create `backend/src/engine/fees.ts`**

```ts
import type { FeeConfig, Market } from './types.js';

/**
 * Paper fee model (spec §3.2): ASX = flat brokerage per trade; US = $0 brokerage
 * but FX bps charged on the AUD notional each way, approximating a typical retail broker's FX fee.
 */
export function tradeFeeCents(market: Market, notionalCents: number, fees: FeeConfig): number {
  if (market === 'ASX') return fees.asxFlatCents;
  return Math.ceil((notionalCents * fees.usFxBps) / 10_000);
}

/** Slippage always moves the fill price against the trader. */
export function applySlippage(price: number, side: 'buy' | 'sell', slippageBps: number): number {
  const factor = slippageBps / 10_000;
  return side === 'buy' ? price * (1 + factor) : price * (1 - factor);
}

/** audUsdRate is USD per 1 AUD (Yahoo symbol AUDUSD=X). */
export function usdToAud(usd: number, audUsdRate: number): number {
  return usd / audUsdRate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fees`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/engine/fees.ts backend/test/fees.test.ts
git commit -m "feat: fee, slippage and FX model"
```

---

### Task 6: Market hours

**Files:**
- Create: `backend/src/market/hours.ts`
- Test: `backend/test/hours.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/hours.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { isMarketOpen } from '../src/market/hours.js';

// 2026-08-03 is a Monday. All instants below are expressed in UTC.
describe('isMarketOpen', () => {
  it('ASX open Monday 11:00 Sydney (AEST = UTC+10 in August)', () => {
    expect(isMarketOpen('ASX', new Date('2026-08-03T01:00:00Z'))).toBe(true);
  });

  it('ASX closed Monday 09:59 Sydney (pre-open)', () => {
    expect(isMarketOpen('ASX', new Date('2026-08-02T23:59:00Z'))).toBe(false);
  });

  it('ASX closed Monday 16:00 Sydney (close)', () => {
    expect(isMarketOpen('ASX', new Date('2026-08-03T06:00:00Z'))).toBe(false);
  });

  it('ASX closed on Saturday Sydney time', () => {
    expect(isMarketOpen('ASX', new Date('2026-08-01T01:00:00Z'))).toBe(false);
  });

  it('US open Monday 10:00 New York (EDT = UTC-4 in August)', () => {
    expect(isMarketOpen('US', new Date('2026-08-03T14:00:00Z'))).toBe(true);
  });

  it('US closed Monday 09:29 New York (pre-open)', () => {
    expect(isMarketOpen('US', new Date('2026-08-03T13:29:00Z'))).toBe(false);
  });

  it('US closed Monday 16:00 New York (close)', () => {
    expect(isMarketOpen('US', new Date('2026-08-03T20:00:00Z'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- hours`
Expected: FAIL — cannot find module `../src/market/hours.js`.

- [ ] **Step 3: Create `backend/src/market/hours.ts`**

```ts
import type { Market } from '../engine/types.js';

const ZONES: Record<Market, string> = { ASX: 'Australia/Sydney', US: 'America/New_York' };
// Session bounds in minutes-since-midnight local time. [open, close)
const SESSIONS: Record<Market, [number, number]> = { ASX: [600, 960], US: [570, 960] };

/**
 * Weekday/session check in the exchange's own timezone. Public holidays are
 * intentionally ignored (spec §11: acceptable paper-mode simplification —
 * polls on a holiday just return unchanged prices).
 */
export function isMarketOpen(market: Market, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONES[market],
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const [open, close] = SESSIONS[market];
  return minutes >= open && minutes < close;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- hours`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/market/hours.ts backend/test/hours.test.ts
git commit -m "feat: timezone-aware market hours"
```

---

### Task 7: PaperBroker

**Files:**
- Create: `backend/src/broker/types.ts`, `backend/src/broker/paper.ts`
- Test: `backend/test/paper-broker.test.ts`

- [ ] **Step 1: Create `backend/src/broker/types.ts`** (interface first — both test and impl need it)

```ts
import type { FeeConfig, Market } from '../engine/types.js';

export interface Quote {
  symbol: string;
  market: Market;
  price: number;
  currency: 'AUD' | 'USD';
  ts: string;
  stale: boolean;
}

export interface OrderRequest {
  roundId: number;
  clientOrderId: string;
  symbol: string;
  market: Market;
  side: 'buy' | 'sell';
  /** Buys: AUD cents to spend (fees come out of this). */
  amountCents?: number;
  /** Sells: share quantity to sell. */
  quantity?: number;
  placedBy: 'agent' | 'operator' | 'stop_loss';
}

export interface Fill {
  orderId: number;
  quantity: number;
  priceAud: number;
  grossCents: number;
  feeCents: number;
  /** Signed cash movement: negative for buys, positive for sells. */
  netCashDeltaCents: number;
}

export interface Broker {
  execute(req: OrderRequest, quote: Quote, audUsdRate: number, fees: FeeConfig): Fill;
}
```

- [ ] **Step 2: Write the failing test** — `backend/test/paper-broker.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/broker/types.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, cents } from '../src/engine/types.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function quote(symbol: string, market: 'ASX' | 'US', price: number, currency: 'AUD' | 'USD'): Quote {
  return { symbol, market, price, currency, ts: new Date().toISOString(), stale: false };
}

function seedRound(db: DB): number {
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO rounds (name, status, starting_balance_cents, cash_cents, profit_goal_cents, config_json, created_at, updated_at)
       VALUES ('t', 'active', ?, ?, ?, '{}', ?, ?)`,
    )
    .run(cents(50), cents(50), cents(1000), now, now);
  return Number(r.lastInsertRowid);
}

describe('PaperBroker', () => {
  let db: DB;
  let broker: PaperBroker;
  let roundId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    broker = new PaperBroker(db);
    roundId = seedRound(db);
  });

  it('fills a fee-free US buy: $20 at USD$10, AUDUSD=1 → 2 shares', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o1', symbol: 'AAPL', market: 'US', side: 'buy', amountCents: cents(20), placedBy: 'agent' },
      quote('AAPL', 'US', 10, 'USD'), 1, NO_FEES,
    );
    expect(fill.quantity).toBeCloseTo(2);
    expect(fill.grossCents).toBe(cents(20));
    expect(fill.feeCents).toBe(0);
    expect(fill.netCashDeltaCents).toBe(-cents(20));
  });

  it('converts USD prices to AUD (USD$6.50 at 0.65 = AUD$10)', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o2', symbol: 'AAPL', market: 'US', side: 'buy', amountCents: cents(20), placedBy: 'agent' },
      quote('AAPL', 'US', 6.5, 'USD'), 0.65, NO_FEES,
    );
    expect(fill.priceAud).toBeCloseTo(10);
    expect(fill.quantity).toBeCloseTo(2);
  });

  it('deducts fees from the spend on buys (US 70bps)', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o3', symbol: 'AAPL', market: 'US', side: 'buy', amountCents: cents(100), placedBy: 'agent' },
      quote('AAPL', 'US', 10, 'USD'), 1, DEFAULT_FEES,
    );
    expect(fill.feeCents).toBe(70); // 70bps of $100
    expect(fill.grossCents + fill.feeCents).toBeLessThanOrEqual(cents(100));
    expect(fill.netCashDeltaCents).toBe(-(fill.grossCents + fill.feeCents));
  });

  it('floors ASX buys to whole shares', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o4', symbol: 'BHP.AX', market: 'ASX', side: 'buy', amountCents: cents(45), placedBy: 'agent' },
      quote('BHP.AX', 'ASX', 20, 'AUD'), 1, NO_FEES,
    );
    expect(fill.quantity).toBe(2); // $45 buys 2 whole $20 shares
    expect(fill.grossCents).toBe(cents(40));
  });

  it('rejects an ASX buy too small for one share after the flat fee', () => {
    expect(() =>
      broker.execute(
        { roundId, clientOrderId: 'o5', symbol: 'BHP.AX', market: 'ASX', side: 'buy', amountCents: cents(20), placedBy: 'agent' },
        quote('BHP.AX', 'ASX', 20, 'AUD'), 1, DEFAULT_FEES,
      ),
    ).toThrow(/too small/);
  });

  it('fills sells and credits net of fees', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o6', symbol: 'AAPL', market: 'US', side: 'sell', quantity: 2, placedBy: 'agent' },
      quote('AAPL', 'US', 20, 'USD'), 1, NO_FEES,
    );
    expect(fill.grossCents).toBe(cents(40));
    expect(fill.netCashDeltaCents).toBe(cents(40));
  });

  it('applies slippage against the trader', () => {
    const fill = broker.execute(
      { roundId, clientOrderId: 'o7', symbol: 'AAPL', market: 'US', side: 'sell', quantity: 1, placedBy: 'agent' },
      quote('AAPL', 'US', 100, 'USD'), 1, { ...NO_FEES, slippageBps: 100 },
    );
    expect(fill.priceAud).toBeCloseTo(99);
  });

  it('persists order and trade rows', () => {
    broker.execute(
      { roundId, clientOrderId: 'o8', symbol: 'AAPL', market: 'US', side: 'buy', amountCents: cents(20), placedBy: 'operator' },
      quote('AAPL', 'US', 10, 'USD'), 1, NO_FEES,
    );
    const order = db.prepare("SELECT status, placed_by FROM orders WHERE client_order_id = 'o8'").get() as { status: string; placed_by: string };
    expect(order).toEqual({ status: 'filled', placed_by: 'operator' });
    expect(db.prepare('SELECT COUNT(*) AS c FROM trades').get()).toEqual({ c: 1 });
  });

  it('enforces client_order_id idempotency', () => {
    const req = { roundId, clientOrderId: 'dup', symbol: 'AAPL', market: 'US' as const, side: 'buy' as const, amountCents: cents(10), placedBy: 'agent' as const };
    broker.execute(req, quote('AAPL', 'US', 10, 'USD'), 1, NO_FEES);
    expect(() => broker.execute(req, quote('AAPL', 'US', 10, 'USD'), 1, NO_FEES)).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- paper-broker`
Expected: FAIL — cannot find module `../src/broker/paper.js`.

- [ ] **Step 4: Create `backend/src/broker/paper.ts`**

```ts
import type { DB } from '../db/connection.js';
import { applySlippage, tradeFeeCents, usdToAud } from '../engine/fees.js';
import type { FeeConfig } from '../engine/types.js';
import type { Broker, Fill, OrderRequest, Quote } from './types.js';

/** Simulated broker: fills instantly at the quoted price (spec §3.1). */
export class PaperBroker implements Broker {
  constructor(private db: DB) {}

  execute(req: OrderRequest, quote: Quote, audUsdRate: number, fees: FeeConfig): Fill {
    const now = new Date().toISOString();
    const priceRaw = quote.currency === 'USD' ? usdToAud(quote.price, audUsdRate) : quote.price;
    const priceAud = applySlippage(priceRaw, req.side, fees.slippageBps);

    let quantity: number;
    let grossCents: number;
    let feeCents: number;

    if (req.side === 'buy') {
      if (!req.amountCents || req.amountCents <= 0) throw new Error('buy requires amountCents > 0');
      feeCents = tradeFeeCents(req.market, req.amountCents, fees);
      const investableCents = req.amountCents - feeCents;
      if (investableCents <= 0) throw new Error('amount too small to cover fees');
      quantity = investableCents / (priceAud * 100);
      if (req.market === 'ASX') {
        quantity = Math.floor(quantity);
        if (quantity < 1) throw new Error('amount too small for one ASX share');
      }
      grossCents = Math.round(quantity * priceAud * 100);
    } else {
      if (!req.quantity || req.quantity <= 0) throw new Error('sell requires quantity > 0');
      quantity = req.quantity;
      grossCents = Math.round(quantity * priceAud * 100);
      feeCents = tradeFeeCents(req.market, grossCents, fees);
    }

    const netCashDeltaCents = req.side === 'buy' ? -(grossCents + feeCents) : grossCents - feeCents;

    const fill = this.db.transaction((): Fill => {
      const order = this.db
        .prepare(
          `INSERT INTO orders (round_id, client_order_id, symbol, side, requested_cents, quantity, status, placed_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'filled', ?, ?)`,
        )
        .run(req.roundId, req.clientOrderId, req.symbol, req.side, req.amountCents ?? null, req.quantity ?? null, req.placedBy, now);
      const orderId = Number(order.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO trades (order_id, round_id, symbol, side, quantity, price_aud, gross_cents, fee_cents, executed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(orderId, req.roundId, req.symbol, req.side, quantity, priceAud, grossCents, feeCents, now);
      return { orderId, quantity, priceAud, grossCents, feeCents, netCashDeltaCents };
    })();

    return fill;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- paper-broker`
Expected: PASS — 9 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/broker backend/test/paper-broker.test.ts
git commit -m "feat: paper broker with fees, FX, slippage and idempotent orders"
```

---

### Task 8: RoundService

**Files:**
- Create: `backend/src/rounds/service.ts`
- Test: `backend/test/round-service.test.ts`

Trading permission matrix (spec §2.3, §5): `agent` may trade only in `active`; `operator` may trade in `active`/`paused`/`takeover`; `stop_loss` may sell in anything except `archived`. Terminal states `goal_reached`/`busted`/`archived` block agent and stop_loss; operator is blocked in `goal_reached`/`busted`/`archived` too (chain a new round instead).

- [ ] **Step 1: Write the failing test** — `backend/test/round-service.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/broker/types.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { RoundService } from '../src/rounds/service.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'test round',
    startingBalanceCents: cents(50),
    profitGoalCents: cents(1000),
    markets: ['US'],
    watchlist: ['AAPL'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null },
    fees: NO_FEES,
    model: 'claude-sonnet-5',
    checkinCron: ['0 8 * * 1-5'],
    ...overrides,
  };
}

function q(price: number): Quote {
  return { symbol: 'AAPL', market: 'US', price, currency: 'USD', ts: new Date().toISOString(), stale: false };
}

describe('RoundService', () => {
  let db: DB;
  let rounds: RoundService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
  });

  it('creates a round with a deposit ledger entry', () => {
    const id = rounds.create(config());
    const round = rounds.get(id);
    expect(round.cash_cents).toBe(cents(50));
    expect(round.status).toBe('active');
    const ledger = db.prepare('SELECT type, amount_cents, balance_after_cents FROM ledger_entries WHERE round_id = ?').all(id);
    expect(ledger).toEqual([{ type: 'deposit', amount_cents: cents(50), balance_after_cents: cents(50) }]);
  });

  it('runs the spec §2.2 worked example: buy $20, sell at 2x, skim $20', () => {
    const id = rounds.create(config());
    const buy = rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    expect(buy.status).toBe('filled');
    expect(rounds.get(id).cash_cents).toBe(cents(30));

    const sell = rounds.sell(id, 'AAPL', 'all', q(20), 1, 'agent');
    expect(sell.status).toBe('filled');
    expect(sell.skimCents).toBe(cents(20));
    expect(rounds.get(id).cash_cents).toBe(cents(50));
    expect(rounds.totalSkimsCents(id)).toBe(cents(20));

    const position = db.prepare('SELECT quantity, closed_at FROM positions WHERE round_id = ?').get(id) as { quantity: number; closed_at: string | null };
    expect(position.quantity).toBe(0);
    expect(position.closed_at).not.toBeNull();
  });

  it('does not skim when cash stays below starting balance', () => {
    const id = rounds.create(config());
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const sell = rounds.sell(id, 'AAPL', 'all', q(9), 1, 'agent'); // sell at a loss
    expect(sell.skimCents).toBe(0);
    expect(rounds.get(id).cash_cents).toBe(cents(48)); // 30 + 18
  });

  it('reaches goal_reached when skims hit the profit goal', () => {
    const id = rounds.create(config({ profitGoalCents: cents(20) }));
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    rounds.sell(id, 'AAPL', 'all', q(20), 1, 'agent');
    expect(rounds.get(id).status).toBe('goal_reached');
  });

  it('clips buys to the max position guardrail', () => {
    const id = rounds.create(config({ guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: 40 } }));
    const buy = rounds.buy(id, 'AAPL', 'US', cents(30), q(10), 1, 'agent'); // cap = $20
    expect(buy.status).toBe('filled');
    const pos = db.prepare('SELECT cost_basis_cents FROM positions WHERE round_id = ?').get(id) as { cost_basis_cents: number };
    expect(pos.cost_basis_cents).toBe(cents(20));
  });

  it('rejects agent trades when the round is paused, but allows the operator', () => {
    const id = rounds.create(config());
    rounds.setStatus(id, 'paused', 'manual pause');
    expect(rounds.buy(id, 'AAPL', 'US', cents(10), q(10), 1, 'agent').status).toBe('rejected');
    expect(rounds.buy(id, 'AAPL', 'US', cents(10), q(10), 1, 'operator').status).toBe('filled');
  });

  it('marks the round busted when cash is exhausted and no positions remain', () => {
    const id = rounds.create(config());
    rounds.buy(id, 'AAPL', 'US', cents(50), q(10), 1, 'agent'); // all-in
    rounds.sell(id, 'AAPL', 'all', q(0.1), 1, 'stop_loss'); // near-total loss → cash $0.50
    expect(rounds.get(id).status).toBe('busted');
  });

  it('sells partially and reduces cost basis proportionally', () => {
    const id = rounds.create(config());
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent'); // 2 shares
    rounds.sell(id, 'AAPL', 1, q(10), 1, 'agent');
    const pos = db.prepare('SELECT quantity, cost_basis_cents, closed_at FROM positions WHERE round_id = ?').get(id) as {
      quantity: number; cost_basis_cents: number; closed_at: string | null;
    };
    expect(pos.quantity).toBe(1);
    expect(pos.cost_basis_cents).toBe(cents(10));
    expect(pos.closed_at).toBeNull();
  });

  it('computes equity from cash plus holdings at given prices', () => {
    const id = rounds.create(config());
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent'); // 2 shares, cash $30
    const equity = rounds.equityCents(id, new Map([['AAPL', 15]])); // 2 × $15 = $30
    expect(equity).toBe(cents(60));
  });

  it('records equity snapshots', () => {
    const id = rounds.create(config());
    rounds.recordEquity(id, new Map());
    const snap = db.prepare('SELECT cash_cents, holdings_cents, equity_cents FROM equity_snapshots WHERE round_id = ?').get(id);
    expect(snap).toEqual({ cash_cents: cents(50), holdings_cents: 0, equity_cents: cents(50) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- round-service`
Expected: FAIL — cannot find module `../src/rounds/service.js`.

- [ ] **Step 3: Create `backend/src/rounds/service.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Broker, Quote } from '../broker/types.js';
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import { clipBuy } from '../engine/guardrails.js';
import { computeSkimCents } from '../engine/skim.js';
import type { Market, RoundConfig } from '../engine/types.js';

export type RoundStatus = 'active' | 'paused' | 'takeover' | 'goal_reached' | 'busted' | 'archived';
export type Actor = 'agent' | 'operator' | 'stop_loss';

export interface RoundRow {
  id: number;
  name: string;
  status: RoundStatus;
  starting_balance_cents: number;
  cash_cents: number;
  profit_goal_cents: number;
  config_json: string;
}

export interface PositionRow {
  id: number;
  round_id: number;
  symbol: string;
  market: Market;
  quantity: number;
  cost_basis_cents: number;
  stop_loss_price: number | null;
}

export interface TradeResult {
  status: 'filled' | 'rejected';
  reason: string | null;
  skimCents: number;
}

/** Cash floor below which a positionless round is busted (can't buy anything with < $1). */
const BUST_CENTS = 100;

const TERMINAL: RoundStatus[] = ['goal_reached', 'busted', 'archived'];

function canTrade(status: RoundStatus, actor: Actor, side: 'buy' | 'sell'): boolean {
  if (TERMINAL.includes(status)) return false;
  if (actor === 'operator') return true;
  if (actor === 'stop_loss') return side === 'sell';
  return status === 'active';
}

export class RoundService {
  constructor(private db: DB, private broker: Broker) {}

  create(config: RoundConfig): number {
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO rounds (name, status, starting_balance_cents, cash_cents, profit_goal_cents, config_json, created_at, updated_at)
         VALUES (?, 'active', ?, ?, ?, ?, ?, ?)`,
      )
      .run(config.name, config.startingBalanceCents, config.startingBalanceCents, config.profitGoalCents, JSON.stringify(config), now, now);
    const id = Number(r.lastInsertRowid);
    this.ledger(id, 'deposit', config.startingBalanceCents, config.startingBalanceCents, null, 'starting balance');
    logEvent(this.db, 'info', 'round_created', `round ${id} created`, id);
    return id;
  }

  get(id: number): RoundRow {
    const row = this.db.prepare('SELECT * FROM rounds WHERE id = ?').get(id) as RoundRow | undefined;
    if (!row) throw new Error(`round ${id} not found`);
    return row;
  }

  config(id: number): RoundConfig {
    return JSON.parse(this.get(id).config_json) as RoundConfig;
  }

  setStatus(id: number, status: RoundStatus, note: string): void {
    this.db.prepare('UPDATE rounds SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    logEvent(this.db, 'info', 'round_status', `round ${id} → ${status}: ${note}`, id);
  }

  openPositions(roundId: number): PositionRow[] {
    return this.db.prepare('SELECT * FROM positions WHERE round_id = ? AND closed_at IS NULL').all(roundId) as PositionRow[];
  }

  openPosition(roundId: number, symbol: string): PositionRow | undefined {
    return this.db
      .prepare('SELECT * FROM positions WHERE round_id = ? AND symbol = ? AND closed_at IS NULL')
      .get(roundId, symbol) as PositionRow | undefined;
  }

  totalSkimsCents(roundId: number): number {
    const { total } = this.db
      .prepare("SELECT COALESCE(SUM(-amount_cents), 0) AS total FROM ledger_entries WHERE round_id = ? AND type = 'skim'")
      .get(roundId) as { total: number };
    return total;
  }

  buy(roundId: number, symbol: string, market: Market, requestedCents: number, quote: Quote, audUsdRate: number, actor: Actor): TradeResult {
    const round = this.get(roundId);
    if (!canTrade(round.status, actor, 'buy')) {
      return this.reject(roundId, symbol, 'buy', actor, `round is ${round.status}`);
    }
    const cfg = this.config(roundId);
    const held = this.openPosition(roundId, symbol);
    const clip = clipBuy({
      requestedCents,
      cashCents: round.cash_cents,
      heldCostCents: held?.cost_basis_cents ?? 0,
      startingBalanceCents: round.starting_balance_cents,
      maxPositionPct: cfg.guardrails.maxPositionPct,
    });
    if (clip.rejected) return this.reject(roundId, symbol, 'buy', actor, clip.reason ?? 'rejected by guardrails');

    let fill;
    try {
      fill = this.broker.execute(
        { roundId, clientOrderId: randomUUID(), symbol, market, side: 'buy', amountCents: clip.allowedCents, placedBy: actor },
        quote, audUsdRate, cfg.fees,
      );
    } catch (err) {
      return this.reject(roundId, symbol, 'buy', actor, (err as Error).message);
    }

    const now = new Date().toISOString();
    if (held) {
      this.db
        .prepare('UPDATE positions SET quantity = quantity + ?, cost_basis_cents = cost_basis_cents + ? WHERE id = ?')
        .run(fill.quantity, fill.grossCents, held.id);
    } else {
      this.db
        .prepare('INSERT INTO positions (round_id, symbol, market, quantity, cost_basis_cents, opened_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(roundId, symbol, market, fill.quantity, fill.grossCents, now);
    }

    let cash = round.cash_cents - fill.grossCents;
    this.ledger(roundId, 'buy', -fill.grossCents, cash, fill.orderId, `buy ${symbol}${clip.reason ? ` (${clip.reason})` : ''}`);
    if (fill.feeCents > 0) {
      cash -= fill.feeCents;
      this.ledger(roundId, 'fee', -fill.feeCents, cash, fill.orderId, `fee for buy ${symbol}`);
    }
    this.setCash(roundId, cash);
    return { status: 'filled', reason: clip.reason, skimCents: 0 };
  }

  sell(roundId: number, symbol: string, quantity: number | 'all', quote: Quote, audUsdRate: number, actor: Actor): TradeResult {
    const round = this.get(roundId);
    if (!canTrade(round.status, actor, 'sell')) {
      return this.reject(roundId, symbol, 'sell', actor, `round is ${round.status}`);
    }
    const position = this.openPosition(roundId, symbol);
    if (!position) return this.reject(roundId, symbol, 'sell', actor, 'no open position');

    const qty = quantity === 'all' ? position.quantity : Math.min(quantity, position.quantity);
    const cfg = this.config(roundId);

    let fill;
    try {
      fill = this.broker.execute(
        { roundId, clientOrderId: randomUUID(), symbol, market: position.market, side: 'sell', quantity: qty, placedBy: actor },
        quote, audUsdRate, cfg.fees,
      );
    } catch (err) {
      return this.reject(roundId, symbol, 'sell', actor, (err as Error).message);
    }

    const now = new Date().toISOString();
    const fullSell = qty >= position.quantity;
    const costRemoved = fullSell ? position.cost_basis_cents : Math.round(position.cost_basis_cents * (qty / position.quantity));
    this.db
      .prepare('UPDATE positions SET quantity = quantity - ?, cost_basis_cents = cost_basis_cents - ?, closed_at = ? WHERE id = ?')
      .run(qty, costRemoved, fullSell ? now : null, position.id);

    let cash = round.cash_cents + fill.grossCents;
    this.ledger(roundId, 'sell', fill.grossCents, cash, fill.orderId, `sell ${symbol} (${actor})`);
    if (fill.feeCents > 0) {
      cash -= fill.feeCents;
      this.ledger(roundId, 'fee', -fill.feeCents, cash, fill.orderId, `fee for sell ${symbol}`);
    }

    const skim = computeSkimCents(cash, round.starting_balance_cents);
    if (skim > 0) {
      cash -= skim;
      this.ledger(roundId, 'skim', -skim, cash, fill.orderId, 'profit pocketed');
      logEvent(this.db, 'info', 'skim', `round ${roundId} pocketed ${skim} cents`, roundId);
    }
    this.setCash(roundId, cash);

    if (skim > 0 && this.totalSkimsCents(roundId) >= round.profit_goal_cents) {
      this.setStatus(roundId, 'goal_reached', 'profit goal reached');
    } else if (cash < BUST_CENTS && this.openPositions(roundId).length === 0) {
      this.setStatus(roundId, 'busted', 'cash and holdings exhausted');
    }
    return { status: 'filled', reason: null, skimCents: skim };
  }

  equityCents(roundId: number, priceAudBySymbol: Map<string, number>): number {
    const round = this.get(roundId);
    let holdings = 0;
    for (const pos of this.openPositions(roundId)) {
      const price = priceAudBySymbol.get(pos.symbol);
      // Fall back to cost basis when no live price is available (never value a holding at zero).
      holdings += price !== undefined ? Math.round(pos.quantity * price * 100) : pos.cost_basis_cents;
    }
    return round.cash_cents + holdings;
  }

  recordEquity(roundId: number, priceAudBySymbol: Map<string, number>): void {
    const round = this.get(roundId);
    const equity = this.equityCents(roundId, priceAudBySymbol);
    this.db
      .prepare('INSERT INTO equity_snapshots (round_id, ts, cash_cents, holdings_cents, equity_cents) VALUES (?, ?, ?, ?, ?)')
      .run(roundId, new Date().toISOString(), round.cash_cents, equity - round.cash_cents, equity);
  }

  private reject(roundId: number, symbol: string, side: 'buy' | 'sell', actor: Actor, reason: string): TradeResult {
    this.db
      .prepare(
        `INSERT INTO orders (round_id, client_order_id, symbol, side, status, placed_by, reason, created_at)
         VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?)`,
      )
      .run(roundId, randomUUID(), symbol, side, actor, reason, new Date().toISOString());
    logEvent(this.db, 'warn', 'order_rejected', `${side} ${symbol}: ${reason}`, roundId);
    return { status: 'rejected', reason, skimCents: 0 };
  }

  private setCash(roundId: number, cashCents: number): void {
    this.db.prepare('UPDATE rounds SET cash_cents = ?, updated_at = ? WHERE id = ?').run(cashCents, new Date().toISOString(), roundId);
  }

  private ledger(roundId: number, type: string, amountCents: number, balanceAfterCents: number, refOrderId: number | null, note: string): void {
    this.db
      .prepare(
        `INSERT INTO ledger_entries (round_id, type, amount_cents, balance_after_cents, ref_order_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(roundId, type, amountCents, balanceAfterCents, refOrderId, note, new Date().toISOString());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- round-service`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/rounds backend/test/round-service.test.ts
git commit -m "feat: round service - trading, ledger, skim, goal and bust transitions"
```

---

### Task 9: MarketDataService

**Files:**
- Create: `backend/src/market/data.ts`, `backend/src/market/yahoo.ts`
- Test: `backend/test/market-data.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/market-data.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';

function fakeFetcher(prices: Record<string, { price: number; currency: string }>): QuoteFetcher {
  return async (symbols) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };
}

describe('MarketDataService', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('polls quotes, caches them, and persists price bars', async () => {
    const svc = new MarketDataService(db, fakeFetcher({ 'AAPL': { price: 150, currency: 'USD' }, 'BHP.AX': { price: 40, currency: 'AUD' } }));
    const quotes = await svc.poll(['AAPL', 'BHP.AX']);
    expect(quotes.get('AAPL')).toMatchObject({ symbol: 'AAPL', market: 'US', price: 150, currency: 'USD', stale: false });
    expect(quotes.get('BHP.AX')).toMatchObject({ market: 'ASX', price: 40, currency: 'AUD' });
    expect(db.prepare('SELECT COUNT(*) AS c FROM price_bars').get()).toEqual({ c: 2 });
  });

  it('marks cached quotes stale after the threshold', async () => {
    const svc = new MarketDataService(db, fakeFetcher({ 'AAPL': { price: 150, currency: 'USD' } }), 0); // stale immediately
    await svc.poll(['AAPL']);
    await new Promise((r) => setTimeout(r, 5));
    const quotes = svc.latest(['AAPL']);
    expect(quotes.get('AAPL')?.stale).toBe(true);
  });

  it('omits symbols the fetcher could not price', async () => {
    const svc = new MarketDataService(db, fakeFetcher({}));
    const quotes = await svc.poll(['MISSING']);
    expect(quotes.has('MISSING')).toBe(false);
  });

  it('fetches the AUDUSD rate', async () => {
    const svc = new MarketDataService(db, fakeFetcher({ 'AUDUSD=X': { price: 0.65, currency: 'USD' } }));
    expect(await svc.audUsdRate()).toBe(0.65);
  });

  it('throws when the AUDUSD rate is unavailable', async () => {
    const svc = new MarketDataService(db, fakeFetcher({}));
    await expect(svc.audUsdRate()).rejects.toThrow(/AUDUSD/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- market-data`
Expected: FAIL — cannot find module `../src/market/data.js`.

- [ ] **Step 3: Create `backend/src/market/data.ts`**

```ts
import type { Quote } from '../broker/types.js';
import type { DB } from '../db/connection.js';
import type { Market } from '../engine/types.js';

export type QuoteFetcher = (symbols: string[]) => Promise<Map<string, { price: number; currency: string }>>;

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

export function marketForSymbol(symbol: string): Market {
  return symbol.endsWith('.AX') ? 'ASX' : 'US';
}

export class MarketDataService {
  private cache = new Map<string, Quote>();

  constructor(
    private db: DB,
    private fetcher: QuoteFetcher,
    private staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  ) {}

  /** Fetch fresh quotes, persist a price bar per symbol, refresh the cache. */
  async poll(symbols: string[]): Promise<Map<string, Quote>> {
    if (symbols.length === 0) return new Map();
    const ts = new Date().toISOString();
    const results = await this.fetcher(symbols);
    const insert = this.db.prepare('INSERT INTO price_bars (symbol, ts, price, currency, stale) VALUES (?, ?, ?, ?, 0)');
    for (const [symbol, { price, currency }] of results) {
      this.cache.set(symbol, {
        symbol,
        market: marketForSymbol(symbol),
        price,
        currency: currency as 'AUD' | 'USD',
        ts,
        stale: false,
      });
      insert.run(symbol, ts, price, currency);
    }
    return this.latest(symbols);
  }

  /** Last known quotes with staleness recomputed against the clock. */
  latest(symbols: string[]): Map<string, Quote> {
    const out = new Map<string, Quote>();
    const now = Date.now();
    for (const symbol of symbols) {
      const cached = this.cache.get(symbol);
      if (cached) out.set(symbol, { ...cached, stale: now - Date.parse(cached.ts) > this.staleAfterMs });
    }
    return out;
  }

  async audUsdRate(): Promise<number> {
    const result = await this.fetcher(['AUDUSD=X']);
    const rate = result.get('AUDUSD=X')?.price;
    if (!rate) throw new Error('AUDUSD rate unavailable');
    return rate;
  }
}
```

- [ ] **Step 4: Create `backend/src/market/yahoo.ts`** (production fetcher — exercised in integration, not unit tests)

```ts
import yahooFinance from 'yahoo-finance2';
import type { QuoteFetcher } from './data.js';

yahooFinance.suppressNotices(['yahooSurvey']);

export const yahooFetcher: QuoteFetcher = async (symbols) => {
  const out = new Map<string, { price: number; currency: string }>();
  const results = await yahooFinance.quote(symbols);
  for (const r of Array.isArray(results) ? results : [results]) {
    if (r.regularMarketPrice != null) {
      out.set(r.symbol, { price: r.regularMarketPrice, currency: r.currency ?? 'USD' });
    }
  }
  return out;
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- market-data`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/market/data.ts backend/src/market/yahoo.ts backend/test/market-data.test.ts
git commit -m "feat: market data service with cache, persistence and staleness"
```

---

### Task 10: Scheduler — poll, guardrail sweep, cron wiring

**Files:**
- Create: `backend/src/scheduler.ts`
- Test: `backend/test/scheduler.test.ts`

`pollOnce()` is the testable unit; `start()` merely wires it to node-cron. Per spec §2.3/§5: stop-losses fire for `active`, `paused`, and `takeover` rounds (protective); drawdown pause applies to `active` rounds only; stale quotes never trigger anything.

- [ ] **Step 1: Write the failing test** — `backend/test/scheduler.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { RoundService } from '../src/rounds/service.js';
import { pollOnce } from '../src/scheduler.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };
// Monday 2026-08-03 14:00 UTC = 10:00 New York (US open, ASX closed).
const US_SESSION = new Date('2026-08-03T14:00:00Z');

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'sched round',
    startingBalanceCents: cents(50),
    profitGoalCents: cents(1000),
    markets: ['US'],
    watchlist: ['AAPL'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null, stopLossPct: 10, drawdownPausePct: 50 },
    fees: NO_FEES,
    model: 'claude-sonnet-5',
    checkinCron: ['0 8 * * 1-5'],
    ...overrides,
  };
}

describe('pollOnce', () => {
  let db: DB;
  let rounds: RoundService;
  let prices: Record<string, { price: number; currency: string }>;
  let market: MarketDataService;

  const fetcher: QuoteFetcher = async (symbols) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    market = new MarketDataService(db, fetcher);
    prices = { 'AAPL': { price: 10, currency: 'USD' }, 'AUDUSD=X': { price: 1, currency: 'USD' } };
  });

  async function buyAt(roundId: number, price: number): Promise<void> {
    prices['AAPL'] = { price, currency: 'USD' };
    const quotes = await market.poll(['AAPL']);
    rounds.buy(roundId, 'AAPL', 'US', cents(20), quotes.get('AAPL')!, 1, 'agent');
  }

  it('does nothing when all markets are closed', async () => {
    const id = rounds.create(config());
    // Sunday 12:00 UTC — both markets closed.
    await pollOnce({ db, rounds, market }, new Date('2026-08-02T12:00:00Z'));
    expect(db.prepare('SELECT COUNT(*) AS c FROM price_bars').get()).toEqual({ c: 0 });
    expect(rounds.get(id).status).toBe('active');
  });

  it('fires the stop-loss when price falls past the threshold', async () => {
    const id = rounds.create(config());
    await buyAt(id, 10);
    prices['AAPL'] = { price: 8.5, currency: 'USD' }; // −15% < −10% stop
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.openPositions(id)).toHaveLength(0);
    const sells = db.prepare("SELECT placed_by FROM orders WHERE side = 'sell'").all() as { placed_by: string }[];
    expect(sells).toEqual([{ placed_by: 'stop_loss' }]);
  });

  it('leaves positions alone above the stop threshold and snapshots equity', async () => {
    const id = rounds.create(config());
    await buyAt(id, 10);
    prices['AAPL'] = { price: 9.5, currency: 'USD' }; // −5%
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.openPositions(id)).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM equity_snapshots WHERE round_id = ?').get(id) as { c: number }).c).toBeGreaterThan(0);
  });

  it('pauses the round on drawdown breach', async () => {
    const id = rounds.create(config({ guardrails: { stopLossPct: null, maxPositionPct: null, drawdownPausePct: 50 } }));
    prices['AAPL'] = { price: 10, currency: 'USD' };
    const quotes = await market.poll(['AAPL']);
    rounds.buy(id, 'AAPL', 'US', cents(50), quotes.get('AAPL')!, 1, 'agent'); // all-in, 5 shares
    prices['AAPL'] = { price: 4, currency: 'USD' }; // equity $20 < $25 threshold
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.get(id).status).toBe('paused');
  });

  it('still fires stop-losses for paused rounds', async () => {
    const id = rounds.create(config());
    await buyAt(id, 10);
    rounds.setStatus(id, 'paused', 'manual');
    prices['AAPL'] = { price: 8, currency: 'USD' };
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.openPositions(id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scheduler`
Expected: FAIL — cannot find module `../src/scheduler.js`.

- [ ] **Step 3: Create `backend/src/scheduler.ts`**

```ts
import cron from 'node-cron';
import type { DB } from './db/connection.js';
import { logEvent } from './db/events.js';
import { drawdownBreached, stopLossTriggered } from './engine/guardrails.js';
import type { Market, RoundConfig } from './engine/types.js';
import { isMarketOpen } from './market/hours.js';
import { marketForSymbol, type MarketDataService } from './market/data.js';
import type { RoundRow, RoundService } from './rounds/service.js';

export interface SchedulerDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
}

const SWEEPABLE = ['active', 'paused', 'takeover'];

/** One protective sweep: poll open-market prices, fire stop-losses, check drawdown, snapshot equity. */
export async function pollOnce(deps: SchedulerDeps, now = new Date()): Promise<void> {
  const { db, rounds, market } = deps;
  const openMarkets = (['ASX', 'US'] as Market[]).filter((m) => isMarketOpen(m, now));
  if (openMarkets.length === 0) return;

  const roundRows = db
    .prepare(`SELECT * FROM rounds WHERE status IN ('active', 'paused', 'takeover')`)
    .all() as RoundRow[];
  if (roundRows.length === 0) return;

  // Union of watchlists and open-position symbols, restricted to open markets.
  const symbols = new Set<string>();
  for (const round of roundRows) {
    const cfg = JSON.parse(round.config_json) as RoundConfig;
    for (const s of cfg.watchlist) symbols.add(s);
    for (const p of rounds.openPositions(round.id)) symbols.add(p.symbol);
  }
  const pollable = [...symbols].filter((s) => openMarkets.includes(marketForSymbol(s)));
  const quotes = await market.poll(pollable);

  const needsUs = [...quotes.values()].some((q) => q.currency === 'USD');
  const audUsd = needsUs ? await market.audUsdRate() : 1;

  const priceAudBySymbol = new Map<string, number>();
  for (const [symbol, q] of quotes) {
    priceAudBySymbol.set(symbol, q.currency === 'USD' ? q.price / audUsd : q.price);
  }

  for (const round of roundRows) {
    if (!SWEEPABLE.includes(round.status)) continue;
    const cfg = JSON.parse(round.config_json) as RoundConfig;

    for (const pos of rounds.openPositions(round.id)) {
      const q = quotes.get(pos.symbol);
      if (!q || q.stale) continue; // never act on stale prices (spec §7)
      const priceAud = priceAudBySymbol.get(pos.symbol)!;
      const avgCostPrice = pos.cost_basis_cents / 100 / pos.quantity;
      if (stopLossTriggered({ avgCostPrice, currentPrice: priceAud, stopLossPct: cfg.guardrails.stopLossPct, stopPrice: pos.stop_loss_price })) {
        logEvent(db, 'warn', 'stop_loss', `round ${round.id} stop-loss on ${pos.symbol} at ${priceAud.toFixed(4)}`, round.id);
        rounds.sell(round.id, pos.symbol, 'all', q, audUsd, 'stop_loss');
      }
    }

    rounds.recordEquity(round.id, priceAudBySymbol);

    const fresh = rounds.get(round.id); // status/cash may have changed above
    if (fresh.status === 'active') {
      const equity = rounds.equityCents(round.id, priceAudBySymbol);
      if (drawdownBreached(equity, fresh.starting_balance_cents, cfg.guardrails.drawdownPausePct)) {
        rounds.setStatus(round.id, 'paused', 'drawdown pause breached');
      }
    }
  }
}

/** Wire pollOnce to a cron cadence. Returns a stop function. */
export function start(deps: SchedulerDeps, cadence = '*/5 * * * *'): () => void {
  const task = cron.schedule(cadence, () => {
    pollOnce(deps).catch((err: unknown) => {
      logEvent(deps.db, 'error', 'poll_failed', (err as Error).message);
    });
  });
  return () => task.stop();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scheduler`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scheduler.ts backend/test/scheduler.test.ts
git commit -m "feat: scheduler with protective guardrail sweep"
```

---

### Task 11: Full round lifecycle integration test

**Files:**
- Test: `backend/test/round-lifecycle.test.ts`

This test replays the user's worked example end-to-end through the scheduler + services (not unit shortcuts) and proves the chain: deposit → buy → poll → sell → skim → goal.

- [ ] **Step 1: Write the integration test** — `backend/test/round-lifecycle.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { RoundService } from '../src/rounds/service.js';
import { pollOnce } from '../src/scheduler.js';

const US_SESSION = new Date('2026-08-03T14:00:00Z'); // Monday, US market open

describe('round lifecycle (spec §2.2 worked example, goal $20)', () => {
  let db: DB;
  let rounds: RoundService;
  let market: MarketDataService;
  let prices: Record<string, { price: number; currency: string }>;

  const fetcher: QuoteFetcher = async (symbols) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    market = new MarketDataService(db, fetcher);
    prices = { 'AAPL': { price: 10, currency: 'USD' }, 'AUDUSD=X': { price: 1, currency: 'USD' } };
  });

  it('deposit → buy $20 → price doubles → sell → skim $20 → goal reached', async () => {
    const config: RoundConfig = {
      name: 'lifecycle',
      startingBalanceCents: cents(50),
      profitGoalCents: cents(20),
      markets: ['US'],
      watchlist: ['AAPL'],
      riskProfile: 'balanced',
      tradingStyle: 'swing',
      guardrails: { stopLossPct: 10, maxPositionPct: null, drawdownPausePct: 50 },
      fees: { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 },
      model: 'claude-sonnet-5',
      checkinCron: ['0 8 * * 1-5'],
    };
    const id = rounds.create(config);

    // Day 1: agent buys $20 of AAPL at $10.
    let quotes = await market.poll(['AAPL']);
    const buy = rounds.buy(id, 'AAPL', 'US', cents(20), quotes.get('AAPL')!, 1, 'agent');
    expect(buy.status).toBe('filled');
    expect(rounds.get(id).cash_cents).toBe(cents(30));

    // Protective sweep at $9.50 (−5%): nothing fires.
    prices['AAPL'] = { price: 9.5, currency: 'USD' };
    await pollOnce({ db, rounds, market }, US_SESSION);
    expect(rounds.openPositions(id)).toHaveLength(1);
    expect(rounds.get(id).status).toBe('active');

    // Day 2: price doubles; agent sells everything for $40.
    prices['AAPL'] = { price: 20, currency: 'USD' };
    quotes = await market.poll(['AAPL']);
    const sell = rounds.sell(id, 'AAPL', 'all', quotes.get('AAPL')!, 1, 'agent');
    expect(sell.skimCents).toBe(cents(20));

    // Cash restored to the starting balance; $20 pocketed; goal reached.
    const round = rounds.get(id);
    expect(round.cash_cents).toBe(cents(50));
    expect(rounds.totalSkimsCents(id)).toBe(cents(20));
    expect(round.status).toBe('goal_reached');

    // Ledger is append-only and complete: deposit, buy, sell, skim.
    const types = (db.prepare('SELECT type FROM ledger_entries WHERE round_id = ? ORDER BY id').all(id) as { type: string }[]).map((r) => r.type);
    expect(types).toEqual(['deposit', 'buy', 'sell', 'skim']);

    // Post-goal: agent can no longer trade.
    expect(rounds.buy(id, 'AAPL', 'US', cents(10), quotes.get('AAPL')!, 1, 'agent').status).toBe('rejected');
  });
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — all test files green (smoke, migrate, skim, guardrails, fees, hours, paper-broker, round-service, market-data, scheduler, round-lifecycle).

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build`
Expected: exit 0, `dist/` produced.

- [ ] **Step 4: Commit**

```bash
git add backend/test/round-lifecycle.test.ts
git commit -m "test: end-to-end round lifecycle covering the spec worked example"
```

---

## Done Criteria

- `npm test` green across all 11 test files; `npm run build` compiles.
- The spec §2.2 worked example passes end-to-end through scheduler + services.
- No HTTP, no Claude, no Docker yet — those are Plan 2 (Claude + API + auth + settings + ntfy) and Plan 3 (frontend + Docker), which build on `RoundService`, `MarketDataService`, and the `checkins`/`journal_entries`/`daily_summaries`/`settings`/`users` tables created here.
