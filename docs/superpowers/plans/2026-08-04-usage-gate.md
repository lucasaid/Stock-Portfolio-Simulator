# Usage Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop firing AI (Claude Agent SDK) calls once the account's Claude subscription
session/weekly usage gets close to configurable thresholds, and resume automatically once
the usage window rolls over — gating check-ins, research briefings, market-scan runs, and
the CLI `checkin` command, with a settings UI and a shell status banner.

**Architecture:** A new `UsageGateService` polls a local, free, zero-cost
`claude -p "/usage" --output-format json` call (via the same already-authenticated wrapper
script the Agent SDK itself uses) through a 60s-cached `UsageChecker` abstraction
(`ClaudeCliUsageChecker` in prod, `FakeUsageChecker` in tests — mirrors the existing
`AgentRunner`/`FakeAgentRunner` split). `DecisionService`, `ResearchService`, and
`MarketScanService` each take an optional `usageGate` dependency and call `.check()` before
their (expensive) agent run; a blocked call is skipped entirely and logged as a `usage_gated`
event, never partially started. Thresholds live in a new `usageGate` `SettingsStore`
namespace (same pattern as `integrations`/`notifications`). A `GET /api/usage` route exposes
the live snapshot + thresholds + gated booleans for both the Settings page and an
`AppShell`-level banner.

**Tech Stack:** Node 22 / TypeScript strict ESM (backend), `node:child_process.execFile`,
better-sqlite3, express 5, vitest + supertest (backend tests); React 19 + TanStack Query,
vitest + jsdom + Testing Library + msw (frontend).

**Read first:** `docs/superpowers/specs/2026-08-03-usage-gate-design.md` — this plan
implements that spec exactly, with one clarified deviation noted in Task 3 (an explicit `db`
dependency on `UsageGateService`, needed to satisfy the spec's own
"logs a warn-level `usage_check_failed` event" requirement, which the spec's illustrative
2-arg constructor snippet omitted).

---

### Task 1: `UsageChecker` — parser + real + fake implementations

**Files:**
- Create: `backend/src/agent/usage-checker.ts`
- Test: `backend/test/usage-checker.test.ts`
- Create: `backend/test/usage-helper.ts`

- [ ] **Step 1: Write the failing parser tests**

```ts
// backend/test/usage-checker.test.ts
import { describe, expect, it } from 'vitest';
import { parseUsageResult } from '../src/agent/usage-checker.js';

describe('parseUsageResult', () => {
  it('parses both fixed-format lines from a real captured result', () => {
    const result =
      'Current session: 19% used · resets Aug 4 at 3:20am (Australia/Melbourne)\n' +
      'Current week (all models): 17% used · resets Aug 10 at 11am (Australia/Melbourne)\n';

    const snapshot = parseUsageResult(result);

    expect(snapshot).toEqual({
      sessionPct: 19,
      sessionResetsAt: 'Aug 4 at 3:20am (Australia/Melbourne)',
      weeklyPct: 17,
      weeklyResetsAt: 'Aug 10 at 11am (Australia/Melbourne)',
    });
  });

  it('parses lines surrounded by unrelated preface/trailer text', () => {
    const result =
      'Some other status line\n' +
      'Current session: 82% used · resets Aug 4 at 3:20am (Australia/Melbourne)\n' +
      'Current week (all models): 90% used · resets Aug 10 at 11am (Australia/Melbourne)\n' +
      'Another trailing line\n';

    const snapshot = parseUsageResult(result);

    expect(snapshot.sessionPct).toBe(82);
    expect(snapshot.weeklyPct).toBe(90);
  });

  it('leaves weekly fields null when only the session line is present', () => {
    const snapshot = parseUsageResult('Current session: 5% used · resets Aug 4 at 3:20am (Australia/Melbourne)');

    expect(snapshot.sessionPct).toBe(5);
    expect(snapshot.weeklyPct).toBeNull();
    expect(snapshot.weeklyResetsAt).toBeNull();
  });

  it('returns all-null fields for a malformed or truncated result', () => {
    expect(parseUsageResult('')).toEqual({
      sessionPct: null, sessionResetsAt: null, weeklyPct: null, weeklyResetsAt: null,
    });
    expect(parseUsageResult('garbage output, no usage lines here')).toEqual({
      sessionPct: null, sessionResetsAt: null, weeklyPct: null, weeklyResetsAt: null,
    });
    // Truncated mid-line (e.g. a cut-off subprocess pipe) — no "% used" to match.
    expect(parseUsageResult('Current session: 4').sessionPct).toBeNull();
  });

  it('parses a session line with no reset clause', () => {
    const snapshot = parseUsageResult('Current session: 3% used');
    expect(snapshot.sessionPct).toBe(3);
    expect(snapshot.sessionResetsAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- usage-checker`
Expected: FAIL — `usage-checker.ts` does not exist yet (module not found).

- [ ] **Step 3: Write `usage-checker.ts`**

```ts
// backend/src/agent/usage-checker.ts
import { execFile } from 'node:child_process';

export interface UsageSnapshot {
  sessionPct: number | null;
  sessionResetsAt: string | null; // raw display string, e.g. "Aug 4 at 3:20am (Australia/Melbourne)"
  weeklyPct: number | null;
  weeklyResetsAt: string | null;
}

export interface UsageChecker {
  checkUsage(): Promise<UsageSnapshot>;
}

const NO_DATA: UsageSnapshot = { sessionPct: null, sessionResetsAt: null, weeklyPct: null, weeklyResetsAt: null };

const SESSION_LINE = /^Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/;
const WEEKLY_LINE = /^Current week[^:]*:\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/;

/**
 * Parses the `.result` text block from `claude -p "/usage" --output-format json`. Pure and
 * total: a line that doesn't match either fixed format is ignored, so a malformed or
 * truncated result yields partial or all-null fields, never a throw.
 */
export function parseUsageResult(resultText: string): UsageSnapshot {
  const snapshot: UsageSnapshot = { ...NO_DATA };
  for (const rawLine of resultText.split('\n')) {
    const line = rawLine.trim();
    const session = SESSION_LINE.exec(line);
    if (session) {
      snapshot.sessionPct = Number(session[1]);
      snapshot.sessionResetsAt = session[2]?.trim() ?? null;
      continue;
    }
    const weekly = WEEKLY_LINE.exec(line);
    if (weekly) {
      snapshot.weeklyPct = Number(weekly[1]);
      snapshot.weeklyResetsAt = weekly[2]?.trim() ?? null;
    }
  }
  return snapshot;
}

/**
 * Spawns the same already-authenticated wrapper script the Agent SDK itself uses (see
 * runner-options.ts's CLAUDE_WRAPPER_PATH) for a one-shot, zero-cost `/usage` check. Never
 * throws: any spawn error, non-zero exit, malformed JSON, or timeout resolves to an all-null
 * snapshot, so a broken usage check can never block the app (fail-open lives in
 * UsageGateService, which treats null as "under threshold"). Not unit tested with a real
 * subprocess per the design spec ("no subprocess spawned in any test") — like
 * agent/sdk-runner.ts, this is compile-checked only; parseUsageResult carries the real test
 * coverage.
 */
export class ClaudeCliUsageChecker implements UsageChecker {
  constructor(private wrapperPath: string, private timeoutMs = 10_000) {}

  async checkUsage(): Promise<UsageSnapshot> {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          this.wrapperPath,
          ['-p', '/usage', '--output-format', 'json'],
          { timeout: this.timeoutMs },
          (err, out) => (err ? reject(err) : resolve(out)),
        );
      });
      const parsed = JSON.parse(stdout) as { result?: string };
      if (typeof parsed.result !== 'string') return { ...NO_DATA };
      return parseUsageResult(parsed.result);
    } catch {
      return { ...NO_DATA };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- usage-checker`
Expected: PASS (5 tests)

- [ ] **Step 5: Add the `FakeUsageChecker` test double**

```ts
// backend/test/usage-helper.ts
import type { UsageChecker, UsageSnapshot } from '../src/agent/usage-checker.js';

const NO_DATA: UsageSnapshot = { sessionPct: null, sessionResetsAt: null, weeklyPct: null, weeklyResetsAt: null };

/** Scripted fake usage checker (mirrors FakeAgentRunner): no subprocess, returns a fixed snapshot. */
export class FakeUsageChecker implements UsageChecker {
  calls = 0;

  constructor(private snapshot: UsageSnapshot = NO_DATA) {}

  async checkUsage(): Promise<UsageSnapshot> {
    this.calls++;
    return this.snapshot;
  }
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

```bash
git add backend/src/agent/usage-checker.ts backend/test/usage-checker.test.ts backend/test/usage-helper.ts
git commit -m "feat(usage-gate): add UsageChecker parser + real/fake implementations"
```

---

### Task 2: `usageGate` settings namespace

**Files:**
- Modify: `backend/src/settings/store.ts`
- Modify: `backend/src/api/settings-routes.ts`
- Modify: `backend/test/settings-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/settings-store.test.ts` (inside the existing `describe('SettingsStore', ...)`):

```ts
  it('returns usage gate defaults', () => {
    const gate = store.get('usageGate');
    expect(gate).toEqual({ enabled: true, sessionThresholdPct: 80, weeklyThresholdPct: 90 });
  });
```

And update the existing `'returns all settings namespaces'` test:

```ts
  it('returns all settings namespaces', () => {
    const all = store.all();
    expect(Object.keys(all).sort()).toEqual([
      'integrations', 'lookAndFeel', 'notifications', 'roundDefaults', 'usageGate',
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- settings-store`
Expected: FAIL — `usageGate` key missing from `DEFAULT_SETTINGS` / `all()`

- [ ] **Step 3: Add the namespace to `settings/store.ts`**

In `backend/src/settings/store.ts`, add the interface after `NotificationToggles`:

```ts
export interface UsageGateSettings {
  enabled: boolean;
  sessionThresholdPct: number;
  weeklyThresholdPct: number;
}
```

Add it to the `Settings` interface:

```ts
export interface Settings {
  roundDefaults: Omit<RoundConfig, 'name'>;
  integrations: IntegrationSettings;
  lookAndFeel: LookAndFeelSettings;
  notifications: NotificationToggles;
  usageGate: UsageGateSettings;
}
```

Add its default to `DEFAULT_SETTINGS` (after `notifications`):

```ts
  usageGate: {
    enabled: true,
    sessionThresholdPct: 80,
    weeklyThresholdPct: 90,
  },
```

Add it to `all()`:

```ts
  all(): Settings {
    return {
      roundDefaults: this.get('roundDefaults'),
      integrations: this.get('integrations'),
      lookAndFeel: this.get('lookAndFeel'),
      notifications: this.get('notifications'),
      usageGate: this.get('usageGate'),
    };
  }
```

- [ ] **Step 4: Add `usageGate` to the settings route's namespace allowlist**

In `backend/src/api/settings-routes.ts`:

```ts
const NAMESPACES: (keyof Settings)[] = ['roundDefaults', 'integrations', 'lookAndFeel', 'notifications', 'usageGate'];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npm test -- settings-store`
Expected: PASS

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add backend/src/settings/store.ts backend/src/api/settings-routes.ts backend/test/settings-store.test.ts
git commit -m "feat(usage-gate): add usageGate settings namespace"
```

---

### Task 3: `UsageGateService`

**Files:**
- Create: `backend/src/agent/usage-gate.ts`
- Test: `backend/test/usage-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// backend/test/usage-gate.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { SettingsStore } from '../src/settings/store.js';
import { UsageGateService } from '../src/agent/usage-gate.js';
import { FakeUsageChecker } from './usage-helper.js';

describe('UsageGateService', () => {
  let db: DB;
  let settings: SettingsStore;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    settings = new SettingsStore(db);
  });

  it('allows when disabled, even over threshold', async () => {
    settings.set('usageGate', { enabled: false, sessionThresholdPct: 80, weeklyThresholdPct: 90 });
    const checker = new FakeUsageChecker({ sessionPct: 99, sessionResetsAt: null, weeklyPct: 99, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    expect((await gate.check()).allowed).toBe(true);
  });

  it('allows when both percentages are under their thresholds', async () => {
    const checker = new FakeUsageChecker({ sessionPct: 10, sessionResetsAt: null, weeklyPct: 10, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    expect((await gate.check()).allowed).toBe(true);
  });

  it('blocks when session usage meets or exceeds its threshold', async () => {
    const checker = new FakeUsageChecker({
      sessionPct: 80, sessionResetsAt: 'Aug 4 at 3:20am (Australia/Melbourne)', weeklyPct: 5, weeklyResetsAt: null,
    });
    const gate = new UsageGateService({ db, settings }, checker);

    const result = await gate.check();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('session usage 80%');
    expect(result.reason).toContain('resets Aug 4 at 3:20am (Australia/Melbourne)');
  });

  it('blocks when weekly usage meets or exceeds its threshold', async () => {
    const checker = new FakeUsageChecker({ sessionPct: 5, sessionResetsAt: null, weeklyPct: 90, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    const result = await gate.check();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('weekly usage 90%');
  });

  it('fails open on a null snapshot and logs a warn event', async () => {
    const checker = new FakeUsageChecker(); // defaults to all-null
    const gate = new UsageGateService({ db, settings }, checker);

    expect((await gate.check()).allowed).toBe(true);
    const events = db.prepare("SELECT level, kind FROM event_log WHERE kind = 'usage_check_failed'").all();
    expect(events).toHaveLength(1);
    expect((events[0] as { level: string }).level).toBe('warn');
  });

  it('caches the snapshot within the TTL instead of re-checking every call', async () => {
    const checker = new FakeUsageChecker({ sessionPct: 10, sessionResetsAt: null, weeklyPct: 10, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    await gate.check();
    await gate.check();
    await gate.status();

    expect(checker.calls).toBe(1);
  });

  it('status() reports the gated booleans and configured thresholds for the API', async () => {
    const checker = new FakeUsageChecker({ sessionPct: 85, sessionResetsAt: null, weeklyPct: 20, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    const status = await gate.status();
    expect(status.enabled).toBe(true);
    expect(status.sessionThresholdPct).toBe(80);
    expect(status.weeklyThresholdPct).toBe(90);
    expect(status.sessionGated).toBe(true);
    expect(status.weeklyGated).toBe(false);
    expect(status.snapshot.sessionPct).toBe(85);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- usage-gate`
Expected: FAIL — `usage-gate.ts` does not exist yet.

- [ ] **Step 3: Write `usage-gate.ts`**

```ts
// backend/src/agent/usage-gate.ts
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { SettingsStore } from '../settings/store.js';
import type { UsageChecker, UsageSnapshot } from './usage-checker.js';

export interface UsageGateDeps {
  db: DB;
  settings: SettingsStore;
}

export interface UsageStatus {
  snapshot: UsageSnapshot;
  enabled: boolean;
  sessionThresholdPct: number;
  weeklyThresholdPct: number;
  sessionGated: boolean;
  weeklyGated: boolean;
}

/** Bounds subprocess overhead across multiple schedulers ticking close together. Not user-configurable. */
const CACHE_TTL_MS = 60_000;

/**
 * Sits in front of every AI call site (check-ins, research, market-scan, CLI checkin).
 * Fail-open: a broken usage check (parse error, binary missing, onecli down, timeout — all
 * surface as an all-null UsageSnapshot from the UsageChecker) never blocks a run; it only
 * logs a warn-level `usage_check_failed` event so the failure stays visible without stopping
 * the app from trading/researching.
 */
export class UsageGateService {
  private cached: { snapshot: UsageSnapshot; checkedAt: number } | null = null;

  constructor(private deps: UsageGateDeps, private checker: UsageChecker) {}

  /** Full status for the /api/usage route (settings page + shell banner). */
  async status(): Promise<UsageStatus> {
    const settings = this.deps.settings.get('usageGate');
    const { snapshot, fresh } = await this.snapshot();

    if (fresh && snapshot.sessionPct === null && snapshot.weeklyPct === null) {
      logEvent(this.deps.db, 'warn', 'usage_check_failed', 'usage check returned no data — failing open');
    }

    const sessionGated = snapshot.sessionPct !== null && snapshot.sessionPct >= settings.sessionThresholdPct;
    const weeklyGated = snapshot.weeklyPct !== null && snapshot.weeklyPct >= settings.weeklyThresholdPct;
    return {
      snapshot,
      enabled: settings.enabled,
      sessionThresholdPct: settings.sessionThresholdPct,
      weeklyThresholdPct: settings.weeklyThresholdPct,
      sessionGated,
      weeklyGated,
    };
  }

  /** Called by every AI call site before starting an agent run. */
  async check(): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.status();
    if (!status.enabled) return { allowed: true };
    if (!status.sessionGated && !status.weeklyGated) return { allowed: true };

    const reasons: string[] = [];
    if (status.sessionGated) {
      reasons.push(
        `session usage ${status.snapshot.sessionPct}% >= ${status.sessionThresholdPct}% threshold ` +
          `(resets ${status.snapshot.sessionResetsAt ?? 'unknown'})`,
      );
    }
    if (status.weeklyGated) {
      reasons.push(
        `weekly usage ${status.snapshot.weeklyPct}% >= ${status.weeklyThresholdPct}% threshold ` +
          `(resets ${status.snapshot.weeklyResetsAt ?? 'unknown'})`,
      );
    }
    return { allowed: false, reason: reasons.join('; ') };
  }

  private async snapshot(): Promise<{ snapshot: UsageSnapshot; fresh: boolean }> {
    const now = Date.now();
    if (this.cached && now - this.cached.checkedAt < CACHE_TTL_MS) {
      return { snapshot: this.cached.snapshot, fresh: false };
    }
    const snapshot = await this.checker.checkUsage();
    this.cached = { snapshot, checkedAt: now };
    return { snapshot, fresh: true };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- usage-gate`
Expected: PASS (7 tests)

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/usage-gate.ts backend/test/usage-gate.test.ts
git commit -m "feat(usage-gate): add UsageGateService"
```

---

### Task 4: `GET /api/usage` route + test harness wiring

**Files:**
- Create: `backend/src/api/usage-routes.ts`
- Modify: `backend/src/api/app.ts`
- Modify: `backend/test/api-helper.ts`
- Test: `backend/test/api-usage.test.ts`

- [ ] **Step 1: Write the failing supertest test**

```ts
// backend/test/api-usage.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- api-usage`
Expected: FAIL — 404 (route doesn't exist) / `ctx.usageGate` type error once referenced

- [ ] **Step 3: Write `usage-routes.ts`**

```ts
// backend/src/api/usage-routes.ts
import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { UsageGateService } from '../agent/usage-gate.js';
import { requireSession } from './middleware.js';

export function usageRoutes(auth: AuthService, usageGate: UsageGateService): Router {
  const router = Router();
  router.use('/api/usage', requireSession(auth));

  router.get('/api/usage', async (_req, res) => {
    res.json(await usageGate.status());
  });

  return router;
}
```

- [ ] **Step 4: Wire it into `app.ts`**

In `backend/src/api/app.ts`, add the import:

```ts
import type { UsageGateService } from '../agent/usage-gate.js';
import { usageRoutes } from './usage-routes.js';
```

Add to `ApiDeps`:

```ts
export interface ApiDeps {
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
  decision: DecisionService;
  analytics: AnalyticsService;
  replay: ReplayService;
  research: ResearchService;
  marketScan: MarketScanService;
  usageGate: UsageGateService;
  history: MarketHistoryService;
  symbols: SymbolRegistry;
  cookieSecure?: boolean;
  trustProxy?: boolean;
}
```

Mount the router (after `marketScanRoutes`):

```ts
  app.use(marketScanRoutes({ auth: deps.auth, db: deps.db, marketScan: deps.marketScan }));
  app.use(usageRoutes(deps.auth, deps.usageGate));
```

- [ ] **Step 5: Wire a real `UsageGateService` (with a fake, always-null checker by default) into the test harness**

In `backend/test/api-helper.ts`, add imports:

```ts
import { UsageGateService } from '../src/agent/usage-gate.js';
import { FakeUsageChecker } from './usage-helper.js';
```

Construct it (after `settings` is created) and add to `TestCtx` + `buildApp` + the returned object:

```ts
export interface TestCtx {
  app: Express;
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
  decision: DecisionService;
  analytics: AnalyticsService;
  replay: ReplayService;
  research: ResearchService;
  marketScan: MarketScanService;
  usageGate: UsageGateService;
  history: MarketHistoryService;
  symbols: SymbolRegistry;
  barFetcher: { fail: boolean };
  prices: Record<string, { price: number; currency: string }>;
}
```

```ts
  const settings = new SettingsStore(db);
  // Default fake checker returns an all-null snapshot, which fails open — existing tests'
  // check-in/research/scan behaviour is unaffected unless a test explicitly overrides it.
  const usageGate = new UsageGateService({ db, settings }, new FakeUsageChecker());
```

```ts
  const app = buildApp({
    db, auth, settings, rounds, market, decision, history, symbols, analytics, replay, research, marketScan,
    usageGate,
    cookieSecure: opts.cookieSecure ?? false,
  });
  return {
    app, db, auth, settings, rounds, market, decision, history, symbols, analytics, replay, research, marketScan,
    usageGate, barFetcher, prices,
  };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npm test -- api-usage`
Expected: PASS (2 tests)

Run: `cd backend && npm test`
Expected: all existing suites still pass (unaffected — `usageGate` is additive to `TestCtx`)

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add backend/src/api/usage-routes.ts backend/src/api/app.ts backend/test/api-helper.ts backend/test/api-usage.test.ts
git commit -m "feat(usage-gate): add GET /api/usage route"
```

---

### Task 5: Gate `DecisionService`

**Files:**
- Modify: `backend/src/agent/decision.ts`
- Modify: `backend/test/decision.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/test/decision.test.ts`. First add the imports at the top of the file:

```ts
import { SettingsStore } from '../src/settings/store.js';
import { UsageGateService } from '../src/agent/usage-gate.js';
import { FakeUsageChecker } from './usage-helper.js';
```

Then add a test inside `describe('DecisionService', ...)` (reuse the existing `beforeEach`-created `db`, `rounds`, `market`, `id`):

```ts
  it('skips the check-in when the usage gate blocks it', async () => {
    const settings = new SettingsStore(db);
    const usageGate = new UsageGateService(
      { db, settings },
      new FakeUsageChecker({ sessionPct: 95, sessionResetsAt: null, weeklyPct: 10, weeklyResetsAt: null }),
    );
    const runner = new FakeAgentRunner([{ tool: 'write_journal', args: { note: 'should not run' } }], 'ok');
    const decision = new DecisionService({ db, rounds, market, usageGate }, runner);

    const outcome = await decision.runCheckin(id);

    expect(outcome.status).toBe('skipped');
    expect(outcome.detail).toContain('session usage 95%');
    expect(runner.requests).toHaveLength(0);
    const events = db.prepare("SELECT kind, level FROM event_log WHERE round_id = ? AND kind = 'usage_gated'").all(id);
    expect(events).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- decision`
Expected: FAIL — `usageGate` is not a recognised property of `DecisionDeps` (TS error) / gate never checked

- [ ] **Step 3: Add the optional `usageGate` dependency and the gate check**

In `backend/src/agent/decision.ts`, add the import and the deps field:

```ts
import type { UsageGateService } from './usage-gate.js';
```

```ts
export interface DecisionDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
  /** Optional so existing tests keep compiling; when absent the briefing slot reads "none". */
  research?: ResearchService;
  /** Optional so existing tests keep compiling; when absent every check-in is always allowed. */
  usageGate?: UsageGateService;
}
```

In `runCheckinInner`, insert the gate check right after the status/terminal check and before quote polling (the expensive part):

```ts
    const config = rounds.config(roundId);

    if (this.deps.usageGate) {
      const gate = await this.deps.usageGate.check();
      if (!gate.allowed) {
        logEvent(db, 'warn', 'usage_gated', gate.reason!, roundId);
        return { status: 'skipped', detail: gate.reason! };
      }
    }

    // Fresh quotes for watchlist + held symbols (stale protection lives in RoundService).
    const symbols = new Set<string>(config.watchlist);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- decision`
Expected: PASS (including the new test)

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/decision.ts backend/test/decision.test.ts
git commit -m "feat(usage-gate): gate DecisionService check-ins"
```

---

### Task 6: Gate `ResearchService`

**Files:**
- Modify: `backend/src/research/service.ts`
- Modify: `backend/test/research-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/test/research-service.test.ts`. Add imports at the top:

```ts
import { SettingsStore } from '../src/settings/store.js';
import { UsageGateService } from '../src/agent/usage-gate.js';
import { FakeUsageChecker } from './usage-helper.js';
```

Add a test inside `describe('ResearchService', ...)`:

```ts
  it('skips the run when the usage gate blocks it', async () => {
    const settings = new SettingsStore(db);
    const usageGate = new UsageGateService(
      { db, settings },
      new FakeUsageChecker({ sessionPct: 10, sessionResetsAt: null, weeklyPct: 95, weeklyResetsAt: null }),
    );
    const runner = new FakeAgentRunner([], 'should not run');
    const outcome = await new ResearchService({ db, rounds, usageGate }, runner).runBriefing(id);

    expect(outcome.status).toBe('skipped');
    expect(outcome.detail).toContain('weekly usage 95%');
    expect(runner.requests).toHaveLength(0);
    const events = db.prepare("SELECT kind FROM event_log WHERE round_id = ? AND kind = 'usage_gated'").all(id);
    expect(events).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- research-service`
Expected: FAIL — `usageGate` not a recognised property of `ResearchDeps`

- [ ] **Step 3: Add the optional `usageGate` dependency and the gate check**

In `backend/src/research/service.ts`, add the import:

```ts
import type { UsageGateService } from '../agent/usage-gate.js';
```

```ts
export interface ResearchDeps {
  db: DB;
  rounds: RoundService;
  /** Optional so existing tests keep compiling; when absent every research run is always allowed. */
  usageGate?: UsageGateService;
}
```

In `runBriefing`, insert the check right after the terminal-round check:

```ts
  async runBriefing(roundId: number): Promise<ResearchOutcome> {
    const { rounds } = this.deps;
    const round = rounds.get(roundId);
    if (TERMINAL.includes(round.status)) {
      return { status: 'skipped', detail: `round is ${round.status}` };
    }

    if (this.deps.usageGate) {
      const gate = await this.deps.usageGate.check();
      if (!gate.allowed) {
        logEvent(this.deps.db, 'warn', 'usage_gated', gate.reason!, roundId);
        return { status: 'skipped', detail: gate.reason! };
      }
    }

    const config = rounds.config(roundId);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- research-service`
Expected: PASS

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add backend/src/research/service.ts backend/test/research-service.test.ts
git commit -m "feat(usage-gate): gate ResearchService briefings"
```

---

### Task 7: Gate `MarketScanService`

**Files:**
- Modify: `backend/src/market-scan/service.ts`
- Modify: `backend/test/market-scan-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/test/market-scan-service.test.ts`. Add imports at the top:

```ts
import { SettingsStore } from '../src/settings/store.js';
import { UsageGateService } from '../src/agent/usage-gate.js';
import { FakeUsageChecker } from './usage-helper.js';
```

Add a test inside `describe('MarketScanService', ...)` (reuse the file's existing `db`, `rounds`, `market`, `id`, `candidatesFor`):

```ts
  it('skips the scan when the usage gate blocks it', async () => {
    const settings = new SettingsStore(db);
    const usageGate = new UsageGateService(
      { db, settings },
      new FakeUsageChecker({ sessionPct: 99, sessionResetsAt: null, weeklyPct: 10, weeklyResetsAt: null }),
    );
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL"]}');
    const service = new MarketScanService({ db, rounds, market, usageGate }, runner, candidatesFor);

    const outcome = await service.runScan(id);

    expect(outcome.status).toBe('skipped');
    expect(outcome.detail).toContain('session usage 99%');
    expect(runner.requests).toHaveLength(0);
    const events = db.prepare("SELECT kind FROM event_log WHERE round_id = ? AND kind = 'usage_gated'").all(id);
    expect(events).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- market-scan-service`
Expected: FAIL — `usageGate` not a recognised property of `MarketScanDeps`

- [ ] **Step 3: Add the optional `usageGate` dependency and the gate check**

In `backend/src/market-scan/service.ts`, add the import:

```ts
import type { UsageGateService } from '../agent/usage-gate.js';
```

```ts
export interface MarketScanDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
  /** Optional so existing tests keep compiling; when absent every scan is always allowed. */
  usageGate?: UsageGateService;
}
```

In `runScan`, insert the check right after the terminal-round check:

```ts
  async runScan(roundId: number): Promise<ScanOutcome> {
    const { db, rounds, market } = this.deps;
    const round = rounds.get(roundId);
    if (TERMINAL.includes(round.status)) {
      return { status: 'skipped', detail: `round is ${round.status}` };
    }

    if (this.deps.usageGate) {
      const gate = await this.deps.usageGate.check();
      if (!gate.allowed) {
        logEvent(db, 'warn', 'usage_gated', gate.reason!, roundId);
        return { status: 'skipped', detail: gate.reason! };
      }
    }

    const config = rounds.config(roundId);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- market-scan-service`
Expected: PASS

Run: `cd backend && npm test` (full backend suite)
Expected: all pass — note the new total (was 388 before this plan; expect 388 + new tests from Tasks 1,3,4,5,6,7 = roughly +5 parser tests +7 gate tests +2 api tests +3 gate-integration tests ≈ 405; report the exact observed number, don't assume)

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add backend/src/market-scan/service.ts backend/test/market-scan-service.test.ts
git commit -m "feat(usage-gate): gate MarketScanService scans"
```

---

### Task 8: Wire `UsageGateService` into `index.ts` and `cli.ts`

**Files:**
- Modify: `backend/src/index.ts`
- Modify: `backend/src/cli.ts`

No new tests in this task — it's pure wiring of already-tested components. Verify with the full suite + a manual smoke check.

- [ ] **Step 1: Wire `index.ts`**

Add imports (near the other `agent/` imports):

```ts
import { ClaudeCliUsageChecker } from './agent/usage-checker.js';
import { UsageGateService } from './agent/usage-gate.js';
```

Construct the gate right after `settings` is created:

```ts
const auth = new AuthService(db);
const settings = new SettingsStore(db);
const usageChecker = new ClaudeCliUsageChecker(CLAUDE_WRAPPER_PATH);
const usageGate = new UsageGateService({ db, settings }, usageChecker);
const rounds = new RoundService(db, new PaperBroker(db));
```

Thread it into `research`, `decision`, and `marketScan`:

```ts
const runner = new SdkAgentRunner();
const research = new ResearchService({ db, rounds, usageGate }, runner);
const decision = new DecisionService({ db, rounds, market, research, usageGate }, runner);
```

```ts
const marketScan = new MarketScanService({ db, rounds, market, usageGate }, runner, yahooCandidateFetcher);
```

Add it to the `buildApp` call:

```ts
const app = buildApp({
  db, auth, settings, rounds, market, decision, history, symbols, analytics, replay, research, marketScan, usageGate,
  cookieSecure: COOKIE_SECURE, trustProxy: TRUST_PROXY,
});
```

- [ ] **Step 2: Wire `cli.ts`'s `checkin` command**

In `backend/src/cli.ts`, inside the `if (command === 'checkin')` block, add the two new dynamic imports and construct the gate:

```ts
  if (command === 'checkin') {
    const roundId = Number(args[0]);
    if (!Number.isInteger(roundId)) {
      console.error('usage: npm run cli -- checkin <roundId>');
      process.exit(1);
    }
    const { PaperBroker } = await import('./broker/paper.js');
    const { RoundService } = await import('./rounds/service.js');
    const { MarketDataService } = await import('./market/data.js');
    const { yahooFetcher } = await import('./market/yahoo.js');
    const { DecisionService } = await import('./agent/decision.js');
    const { SdkAgentRunner } = await import('./agent/sdk-runner.js');
    const { SettingsStore } = await import('./settings/store.js');
    const { ClaudeCliUsageChecker } = await import('./agent/usage-checker.js');
    const { UsageGateService } = await import('./agent/usage-gate.js');
    const { CLAUDE_WRAPPER_PATH } = await import('./agent/runner-options.js');
    const rounds = new RoundService(db, new PaperBroker(db));
    const market = new MarketDataService(db, yahooFetcher);
    const settings = new SettingsStore(db);
    const usageGate = new UsageGateService({ db, settings }, new ClaudeCliUsageChecker(CLAUDE_WRAPPER_PATH));
    const decision = new DecisionService({ db, rounds, market, usageGate }, new SdkAgentRunner());
    const outcome = await decision.runCheckin(roundId);
    console.log(`check-in: ${outcome.status} (${outcome.detail})`);
    return;
  }
```

- [ ] **Step 3: Run the full backend suite and typecheck**

Run: `cd backend && npm test`
Expected: all pass

Run: `cd backend && npx tsc --noEmit`
Expected: no errors (this also compile-checks `index.ts` and `cli.ts`, which aren't covered by vitest)

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts backend/src/cli.ts
git commit -m "feat(usage-gate): wire UsageGateService into index.ts and cli.ts"
```

---

### Task 9: Frontend types + `useUsage()` hook

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/hooks.ts`

- [ ] **Step 1: Add types to `frontend/src/api/types.ts`**

Add near `NtfySettings`/`IntegrationSettings`:

```ts
export interface UsageGateSettings {
  enabled: boolean;
  sessionThresholdPct: number;
  weeklyThresholdPct: number;
}
```

Add `usageGate` to `Settings`:

```ts
export interface Settings {
  roundDefaults: Omit<RoundConfig, 'name'>;
  integrations: IntegrationSettings;
  lookAndFeel: LookAndFeelSettings;
  notifications: Record<string, boolean>;
  usageGate: UsageGateSettings;
}
```

Add near `ScanOutcome`:

```ts
export interface UsageSnapshot {
  sessionPct: number | null;
  sessionResetsAt: string | null;
  weeklyPct: number | null;
  weeklyResetsAt: string | null;
}

export interface UsageStatus {
  snapshot: UsageSnapshot;
  enabled: boolean;
  sessionThresholdPct: number;
  weeklyThresholdPct: number;
  sessionGated: boolean;
  weeklyGated: boolean;
}
```

- [ ] **Step 2: Add `qk.usage` and `useUsage()` to `frontend/src/api/hooks.ts`**

Update the type import list to include `UsageStatus`:

```ts
import type {
  BriefingRow, CheckinOutcome, CheckinRow, ChartRange, EquityPoint, EventRow, HistoryResult, JournalRow,
  LedgerRow, ResearchOutcome, RoundConfig, RoundDetail, RoundListItem, ScanOutcome, ScanRow, Settings,
  SummaryRow, SymbolRow, TradeResult, TradeRow, UsageStatus,
} from './types';
```

Add to the `qk` factory:

```ts
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
  briefings: (id: number) => ['round', id, 'briefings'] as const,
  scans: (id: number) => ['round', id, 'scans'] as const,
  events: (roundId?: number) => ['events', roundId ?? 'all'] as const,
  settings: ['settings'] as const,
  usage: ['usage'] as const,
  symbols: ['symbols'] as const,
  quotes: (symbols: string[]) => ['quotes', [...symbols].sort().join(',')] as const,
  fx: ['fx'] as const,
  history: (symbol: string, range: ChartRange) => ['history', symbol, range] as const,
  allRounds: ['round'] as const,
};
```

Add the hook (near `useSettings`):

```ts
/** refetchInterval matches the backend's 60s usage-check cache TTL. */
export function useUsage(): UseQueryResult<UsageStatus> {
  return useQuery({
    queryKey: qk.usage,
    queryFn: () => apiFetch<UsageStatus>('/api/usage'),
    refetchInterval: 60_000,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/hooks.ts
git commit -m "feat(usage-gate): add frontend usage types and useUsage hook"
```

---

### Task 10: Settings page — usage gate form

**Files:**
- Modify: `frontend/src/pages/SettingsPage.tsx`
- Modify: `frontend/test/server.ts`
- Modify: `frontend/test/settings-page.test.tsx`

- [ ] **Step 1: Add the `usageGate` fixture to the test server**

In `frontend/test/server.ts`, add `usageGate` to `settingsFixture`:

```ts
export const settingsFixture: Settings = {
  roundDefaults: { /* ...unchanged... */ },
  integrations: { /* ...unchanged... */ },
  lookAndFeel: { theme: 'system', accent: '#6E56CF', chartStyle: 'line', timezone: 'Australia/Sydney' },
  notifications: { trade: true, skim: true, goal: true, stop_loss: true, drawdown: true, busted: true, error: true },
  usageGate: { enabled: true, sessionThresholdPct: 80, weeklyThresholdPct: 90 },
};
```

- [ ] **Step 2: Write the failing tests**

Add to `frontend/test/settings-page.test.tsx`:

```ts
  it('loads the usage gate section', async () => {
    renderWithProviders(<SettingsPage />);

    await waitFor(() => expect(screen.getByLabelText(/session threshold/i)).toHaveValue('80'));
    expect(screen.getByLabelText(/weekly threshold/i)).toHaveValue('90');
    expect(screen.getByLabelText(/pause ai calls/i)).toBeChecked();
  });

  it('saves usage gate thresholds', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/settings/usageGate', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<SettingsPage />);

    const sessionInput = await screen.findByLabelText(/session threshold/i);
    await userEvent.clear(sessionInput);
    await userEvent.type(sessionInput, '70');
    await userEvent.click(screen.getByRole('button', { name: /save usage gate/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ enabled: true, sessionThresholdPct: 70, weeklyThresholdPct: 90 });
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npm test -- settings-page`
Expected: FAIL — no element with label `/session threshold/i`

- [ ] **Step 4: Add the `UsageGateForm` to `SettingsPage.tsx`**

Add `UsageGateSettings` to the type import at the top of the file:

```ts
import type { IntegrationSettings, LookAndFeelSettings, Market, RoundConfig, Settings, UsageGateSettings } from '../api/types';
```

Add the form (place it after `IntegrationsForm`, before `LookAndFeelForm`):

```tsx
function UsageGateForm({ initial }: { initial: UsageGateSettings }) {
  const save = useSaveSettings('usageGate');
  const [enabled, setEnabled] = useState(initial.enabled);
  const [sessionPct, setSessionPct] = useState(String(initial.sessionThresholdPct));
  const [weeklyPct, setWeeklyPct] = useState(String(initial.weeklyThresholdPct));

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        const session = Number(sessionPct);
        const weekly = Number(weeklyPct);
        save.mutate({
          enabled,
          sessionThresholdPct: Number.isFinite(session) && session > 0 ? Math.round(session) : initial.sessionThresholdPct,
          weeklyThresholdPct: Number.isFinite(weekly) && weekly > 0 ? Math.round(weekly) : initial.weeklyThresholdPct,
        });
      }}
    >
      <label className="row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Pause AI calls near Claude subscription usage limits
      </label>
      <label>
        Session threshold (%)
        <input value={sessionPct} onChange={(e) => setSessionPct(e.target.value)} inputMode="numeric" />
      </label>
      <label>
        Weekly threshold (%)
        <input value={weeklyPct} onChange={(e) => setWeeklyPct(e.target.value)} inputMode="numeric" />
      </label>
      <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
        Checked via the local <code>claude /usage</code> command — free, no API cost. Once usage crosses
        either threshold, check-ins, research, and market-scan runs are skipped (never partially started)
        until the usage window rolls over on its own.
      </p>
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save usage gate
      </button>
    </form>
  );
}
```

Mount it in `SettingsPage` (after the Integrations section):

```tsx
      <Section title="Integrations">
        <IntegrationsForm initial={settings.data.integrations} />
      </Section>
      <Section title="Usage gate">
        <UsageGateForm initial={settings.data.usageGate} />
      </Section>
      <Section title="Look &amp; feel">
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- settings-page`
Expected: PASS (all settings-page tests, including the 2 new ones)

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/SettingsPage.tsx frontend/test/server.ts frontend/test/settings-page.test.tsx
git commit -m "feat(usage-gate): add usage gate settings form"
```

---

### Task 11: Shell status banner

**Files:**
- Modify: `frontend/src/shell/AppShell.tsx`
- Modify: `frontend/test/server.ts`
- Test: `frontend/test/app-shell.test.tsx`

- [ ] **Step 1: Add a `/api/usage` handler + fixture to the test server**

In `frontend/test/server.ts`, add the type import:

```ts
import type { BriefingRow, RoundDetail, RoundListItem, ScanRow, Settings, UsageStatus } from '../src/api/types';
```

Add a fixture (near `settingsFixture`):

```ts
export const usageStatusFixture: UsageStatus = {
  snapshot: {
    sessionPct: 19, sessionResetsAt: 'Aug 4 at 3:20am (Australia/Melbourne)',
    weeklyPct: 17, weeklyResetsAt: 'Aug 10 at 11am (Australia/Melbourne)',
  },
  enabled: true, sessionThresholdPct: 80, weeklyThresholdPct: 90, sessionGated: false, weeklyGated: false,
};
```

Add the handler to the `handlers` array (near `/api/settings`):

```ts
  http.get('/api/usage', () => HttpResponse.json(usageStatusFixture)),
```

- [ ] **Step 2: Write the failing tests**

```tsx
// frontend/test/app-shell.test.tsx
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../src/shell/AppShell';
import { AuthProvider } from '../src/auth/AuthProvider';
import { renderWithProviders } from './render';
import { server } from './server';

describe('AppShell usage gate banner', () => {
  it('shows nothing when usage is under threshold', async () => {
    renderWithProviders(
      <AuthProvider>
        <AppShell>content</AppShell>
      </AuthProvider>,
    );

    await screen.findByText('content');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a banner when session usage is gated', async () => {
    server.use(
      http.get('/api/usage', () =>
        HttpResponse.json({
          snapshot: {
            sessionPct: 92, sessionResetsAt: 'Aug 4 at 3:20am (Australia/Melbourne)',
            weeklyPct: 30, weeklyResetsAt: null,
          },
          enabled: true, sessionThresholdPct: 80, weeklyThresholdPct: 90, sessionGated: true, weeklyGated: false,
        }),
      ),
    );

    renderWithProviders(
      <AuthProvider>
        <AppShell>content</AppShell>
      </AuthProvider>,
    );

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/session usage 92%/i);
    expect(banner).toHaveTextContent(/resets aug 4 at 3:20am/i);
  });

  it('shows nothing when gated but the gate is disabled', async () => {
    server.use(
      http.get('/api/usage', () =>
        HttpResponse.json({
          snapshot: { sessionPct: 99, sessionResetsAt: null, weeklyPct: 99, weeklyResetsAt: null },
          enabled: false, sessionThresholdPct: 80, weeklyThresholdPct: 90, sessionGated: true, weeklyGated: true,
        }),
      ),
    );

    renderWithProviders(
      <AuthProvider>
        <AppShell>content</AppShell>
      </AuthProvider>,
    );

    await screen.findByText('content');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npm test -- app-shell`
Expected: FAIL — no element with `role="status"` (banner doesn't exist yet)

- [ ] **Step 4: Add `UsageGateBanner` to `AppShell.tsx`**

```tsx
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useLogout, useUsage } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { KillSwitch } from './KillSwitch';

const LINKS = [
  { to: '/rounds', label: 'Rounds' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/markets', label: 'Markets' },
  { to: '/settings', label: 'Settings' },
];

function UsageGateBanner() {
  const usage = useUsage();
  const status = usage.data;
  if (!status || !status.enabled || (!status.sessionGated && !status.weeklyGated)) return null;

  const parts: string[] = [];
  if (status.sessionGated) {
    const resets = status.snapshot.sessionResetsAt ? ` (resets ${status.snapshot.sessionResetsAt})` : '';
    parts.push(`session usage ${status.snapshot.sessionPct}%${resets}`);
  }
  if (status.weeklyGated) {
    const resets = status.snapshot.weeklyResetsAt ? ` (resets ${status.snapshot.weeklyResetsAt})` : '';
    parts.push(`weekly usage ${status.snapshot.weeklyPct}%${resets}`);
  }

  return (
    <div
      role="status"
      className="panel"
      style={{
        margin: '0.6rem 1rem 0', padding: '0.5rem 0.75rem',
        borderColor: 'var(--loss)', color: 'var(--loss)',
      }}
    >
      AI calls paused — {parts.join(', ')}.
    </div>
  );
}

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
          <strong style={{ marginRight: '0.5rem' }}>stock_portfolio_simulator</strong>
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
      <UsageGateBanner />
      <main style={{ padding: '1rem', maxWidth: 1200, margin: '0 auto' }}>{children}</main>
    </>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- app-shell`
Expected: PASS (3 tests)

Run: `cd frontend && npm test` (full frontend suite)
Expected: all pass — report the exact observed total (was 185 before this plan)

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

Run: `cd frontend && npm run build`
Expected: builds clean

- [ ] **Step 6: Commit**

```bash
git add frontend/src/shell/AppShell.tsx frontend/test/server.ts frontend/test/app-shell.test.tsx
git commit -m "feat(usage-gate): add shell status banner"
```

---

### Task 12: Whole-branch review

No new files — this is a review pass, matching the pattern used for every prior plan
(`docs/superpowers/plans/2026-08-03-phase3-research-briefings.md`,
`docs/superpowers/plans/2026-08-03-market-scan.md`).

- [ ] **Step 1: Run both full suites**

```bash
cd backend && npm test && npx tsc --noEmit && npm run build
cd ../frontend && npm test && npx tsc --noEmit && npm run build
```

Expected: all pass, both builds clean. Record the exact new totals (backend was 388, frontend
was 185 before this plan).

- [ ] **Step 2: Verify the invariants this feature must not violate**

- `grep -rn "usage_gated\|usage_check_failed" backend/src` — confirm both event kinds are only
  ever logged from `UsageGateService.status()` (the check-failure warn) and from the three call
  sites (`decision.ts`, `research/service.ts`, `market-scan/service.ts`) via the shared
  `if (!gate.allowed)` pattern — never duplicated logic.
- Confirm `UsageGateService` never throws: read through `usage-checker.ts`'s
  `ClaudeCliUsageChecker.checkUsage` and confirm every failure path (spawn error, non-zero
  exit, timeout, bad JSON) is caught and resolves to the all-null snapshot, not a rejection
  that could propagate into `status()`/`check()`.
- Confirm `agent/runner-options.ts` was **not** touched — the usage checker spawns the same
  already-authenticated wrapper via `execFile`, not through the SDK's options object, so the
  SDK-in-one-file rule (`sdk-runner.ts` is the only file importing the Agent SDK) is untouched.
- Confirm every AI call site (`DecisionService.runCheckinInner`, `ResearchService.runBriefing`,
  `MarketScanService.runScan`, `cli.ts`'s `checkin` command) either received `usageGate` at
  construction in `index.ts`/`cli.ts`, or (for the `research`/`decision`/`market-scan` service
  test suites) is documented as optional-and-absent-means-allowed. No call site should read
  from settings/usage state via any path other than the injected `UsageGateService`.
- Confirm `frontend/src/pages/SettingsPage.tsx`'s `UsageGateForm` sends the **complete**
  `usageGate` object on every save (not a partial patch) — matches the existing
  "Settings forms must send every field of their namespace" invariant.

- [ ] **Step 3: Update CLAUDE.md**

Add a "Usage-gate feature — how it was built, for future reference" subsection to
`stock_portfolio_simulator/CLAUDE.md`'s CURRENT STATE, mirroring the existing Research/Market-scan
subsections: what `UsageGateService` does, the fail-open/60s-cache/optional-dependency
design, the `usage_gated`/`usage_check_failed` event kinds, and the settings namespace. Update
the backend/frontend test-count line with the real observed totals from Step 1. Check the
`usage-gate` box in `TODO.md`.

- [ ] **Step 4: Commit**

```bash
git add stock_portfolio_simulator/CLAUDE.md TODO.md
git commit -m "docs: usage-gate feature complete, update CLAUDE.md and TODO.md"
```

Then merge the feature branch `--no-ff` into `master` per the established process (see
CLAUDE.md's "Execution process" section) and re-run both suites post-merge.
