# Crypto market + market-adapter registry implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add crypto (via Yahoo Finance, already confirmed live) as a third paper-traded market,
and replace the scattered `if`/`else`/ternary `'ASX'`/`'US'` branches + ~4 duplicated
`['ASX','US']` literal arrays with a single `MarketAdapter` registry — so a future market is one
new adapter object, not N scattered edits.

**Architecture:** `Market` gains `'CRYPTO'`. A new `market/adapters.ts` holds one
`MarketAdapter` object per market (symbol matcher, open-hours rule, quote fetcher, candidate
fetcher) plus `ALL_MARKETS`/`adapterFor`. `market/hours.ts` becomes a thin wrapper over
`adapterFor(market).isOpen(now)`. `market/data.ts`'s `marketForSymbol` and
`MarketDataService.poll()` route through the registry — `poll()` dedups by fetcher *reference*,
so today's three Yahoo-backed adapters still make exactly one Yahoo call per poll (regression
tested), while a future market with a different source gets its own call for free. The pure fee
formula stays in `engine/fees.ts` (hardened, I/O-free) — adapters do not duplicate it.
`analytics/service.ts`'s fee split generalizes from a hardcoded ASX/US split to a
`feesByMarket` map, since folding crypto fees into "US fees" would be actively misleading.

**Tech Stack:** Node 22 / TypeScript strict ESM (backend), better-sqlite3, express 5,
yahoo-finance2 v4, vitest + supertest (backend tests); React 19 + TanStack Query, vitest +
jsdom + Testing Library + msw (frontend tests).

**Read first:** `docs/superpowers/specs/2026-08-04-crypto-market-design.md` — this plan
implements that spec exactly, including its survey table of every existing `'ASX'`/`'US'`
call site.

**Hardened files touched:** `engine/types.ts` (Task 1: add `'CRYPTO'` to the `Market` union,
add `FeeConfig.cryptoFxBps`, update `DEFAULT_FEES` — additive only, no existing field
removed/renamed) and `engine/fees.ts` (Task 1: one new branch in `tradeFeeCents`, formula
unchanged for ASX/US). **`db/migrations.ts` is NOT touched by this plan** — `symbols.market`/
`positions.market` are already free-text columns with no CHECK constraint (confirmed by
reading the schema before writing the spec), so no migration is needed to store `'CRYPTO'`.
Task 10 verifies this by diffing `db/migrations.ts` against `master` and expecting no change.

---

### Task 1: `Market` union + crypto fee rate + `tradeFeeCents` crypto branch

**Files:**
- Edit: `backend/src/engine/types.ts`
- Edit: `backend/src/engine/fees.ts`
- Test: `backend/test/fees.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// backend/test/fees.test.ts — add to the existing `describe('tradeFeeCents', ...)` block
it('charges FX bps on crypto notional (100bps of $100 = $1.00)', () => {
  expect(tradeFeeCents('CRYPTO', cents(100), DEFAULT_FEES)).toBe(100);
});

it('rounds crypto fees up so fees are never understated', () => {
  expect(tradeFeeCents('CRYPTO', 1, DEFAULT_FEES)).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- fees`
Expected: FAIL — `'CRYPTO'` is not assignable to `Market`, and `tradeFeeCents` has no crypto
branch yet.

- [ ] **Step 3: Extend `engine/types.ts`**

```ts
export type Market = 'ASX' | 'US' | 'CRYPTO';
// ...
export interface FeeConfig {
  asxFlatCents: number;
  usFxBps: number;
  cryptoFxBps: number;
  slippageBps: number;
}
// ...
export const DEFAULT_FEES: FeeConfig = { asxFlatCents: 300, usFxBps: 70, cryptoFxBps: 100, slippageBps: 0 };
```

`cryptoFxBps: 100` (1%) approximates a typical exchange taker fee — a starting default, tuned
later exactly like `usFxBps` (a `SettingsStore` default only; `FeeConfig` has no UI form today
for any of its three rates, confirmed by grepping the frontend before writing the spec — do not
add one in this task).

- [ ] **Step 4: Extend `engine/fees.ts`**

```ts
export function tradeFeeCents(market: Market, notionalCents: number, fees: FeeConfig): number {
  if (market === 'ASX') return fees.asxFlatCents;
  const bps = market === 'CRYPTO' ? fees.cryptoFxBps : fees.usFxBps;
  return Math.ceil((notionalCents * bps) / 10_000);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npm test -- fees`

- [ ] **Step 6: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: many pre-existing failures across the codebase at this point are FINE and expected —
every other file that does an exhaustive-by-convention `market === 'ASX' ? x : y` still compiles
(TypeScript won't flag it, per the spec's survey finding that none of these are exhaustiveness-
checked), but `market/hours.ts`'s two `Record<Market, ...>` maps WILL fail to compile now that
`Market` has three members. **This is expected and is fixed in Task 3, not this task.** Confirm
the failure is exactly there (`error TS2739: Type is missing the following properties from type
'Record<Market, ...>': CRYPTO` in `market/hours.ts`) and nowhere else surprising, then stop —
do not attempt to fix `hours.ts` in this task.

---

### Task 2: `cryptoCandidates()` + 3-way dispatch in `market/candidates.ts`

**Files:**
- Edit: `backend/src/market/candidates.ts`

Depends on Task 1 (`Market` includes `'CRYPTO'`).

`market/candidates.ts` is network-only / compile-checked-only by existing convention (same as
`sdk-runner.ts` and the real `UsageChecker` — no automated tests mock the live Yahoo network
call; verified live instead, per Task 10). No test file changes in this task.

- [ ] **Step 1: Add a curated crypto universe + fetcher**

```ts
/** No crypto-specific Yahoo screener exists — a fixed curated list, same pattern as
 * ASX_FALLBACK_UNIVERSE, is adequate deterministic grounding for the scan prompt. */
const CRYPTO_UNIVERSE = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD', 'DOGE-USD', 'AVAX-USD', 'LINK-USD',
  'LTC-USD', 'DOT-USD', 'MATIC-USD', 'BCH-USD', 'UNI-USD', 'ATOM-USD', 'XLM-USD',
];

async function cryptoCandidates(): Promise<ScanCandidate[]> {
  const quotes = await yahooFinance.quote(CRYPTO_UNIVERSE);
  const list = Array.isArray(quotes) ? quotes : [quotes];
  return list.map((q) => ({
    symbol: q.symbol,
    name: q.longName ?? q.shortName,
    changePct: q.regularMarketChangePercent,
  }));
}
```

(Match `yahooFinance.quote()`'s actual return-type shape used elsewhere in this file — read
`asxFallbackCandidates()`'s existing implementation just above this addition and mirror its
exact handling of the single-vs-array response quirk rather than guessing.)

- [ ] **Step 2: Extend the dispatcher**

```ts
export const yahooCandidateFetcher: CandidateFetcher = async (market) => {
  if (market === 'ASX') return asxCandidates();
  if (market === 'CRYPTO') return cryptoCandidates();
  return usCandidates();
};
```

- [ ] **Step 3: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: same pre-existing `market/hours.ts` failure as Task 1 left it (still not yet fixed);
no NEW failures from this file.

---

### Task 3: `market/adapters.ts` registry + `market/hours.ts` rewrite

**Files:**
- Create: `backend/src/market/adapters.ts`
- Edit: `backend/src/market/hours.ts`
- Test: `backend/test/hours.test.ts` (existing tests must pass UNMODIFIED — this task proves
  the refactor is behavior-preserving for ASX/US)

Depends on Task 1 (`Market`), Task 2 (`yahooCandidateFetcher` handles all three markets).

- [ ] **Step 1: Write the failing test (new crypto case only — do not touch existing cases)**

```ts
// backend/test/hours.test.ts — add to the existing describe block, do not edit existing tests
it('CRYPTO is always open, including 3am Saturday', () => {
  expect(isMarketOpen('CRYPTO', new Date('2026-08-01T03:00:00Z'))).toBe(true); // a Saturday
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- hours`
Expected: FAIL (or a build error, since `hours.ts` doesn't compile yet per Task 1's Step 6).

- [ ] **Step 3: Create `market/adapters.ts`**

```ts
import type { Market } from '../engine/types.js';
import type { CandidateFetcher } from './candidates.js';
import { yahooCandidateFetcher } from './candidates.js';
import type { QuoteFetcher } from './data.js';
import { yahooFetcher } from './yahoo.js';

export interface MarketAdapter {
  id: Market;
  label: string;
  /** Registry tries adapters in array order; first match wins. */
  matchesSymbol(symbol: string): boolean;
  isOpen(now: Date): boolean;
  quoteFetcher: QuoteFetcher;
  candidateFetcher: CandidateFetcher;
}

/** Weekday/session check in the given IANA timezone. Session bounds are [open, close)
 * in minutes-since-midnight local time. Public holidays are intentionally ignored (spec §11:
 * acceptable paper-mode simplification). */
function isWithinSession(zone: string, session: [number, number], now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const [open, close] = session;
  return minutes >= open && minutes < close;
}

const asxAdapter: MarketAdapter = {
  id: 'ASX',
  label: 'ASX',
  matchesSymbol: (s) => s.endsWith('.AX'),
  isOpen: (now) => isWithinSession('Australia/Sydney', [600, 960], now),
  quoteFetcher: yahooFetcher,
  candidateFetcher: yahooCandidateFetcher,
};

const cryptoAdapter: MarketAdapter = {
  id: 'CRYPTO',
  label: 'Crypto',
  matchesSymbol: (s) => s.endsWith('-USD'),
  isOpen: () => true, // trades 24/7, no weekend/holiday closure
  quoteFetcher: yahooFetcher,
  candidateFetcher: yahooCandidateFetcher,
};

const usAdapter: MarketAdapter = {
  id: 'US',
  label: 'US',
  matchesSymbol: () => true, // catch-all — MUST stay last in MARKET_ADAPTERS
  isOpen: (now) => isWithinSession('America/New_York', [570, 960], now),
  quoteFetcher: yahooFetcher,
  candidateFetcher: yahooCandidateFetcher,
};

// Order matters: specific suffixes are tried before the US catch-all.
export const MARKET_ADAPTERS: MarketAdapter[] = [asxAdapter, cryptoAdapter, usAdapter];
export const ALL_MARKETS: Market[] = MARKET_ADAPTERS.map((a) => a.id);

export function adapterFor(market: Market): MarketAdapter {
  const adapter = MARKET_ADAPTERS.find((a) => a.id === market);
  if (!adapter) throw new Error(`no adapter registered for market ${market}`); // internal invariant
  return adapter;
}
```

Confirm import direction has no cycle: `adapters.ts` imports (value) from `market/yahoo.ts` and
`market/candidates.ts`, and (type-only) from `market/data.ts`; `market/data.ts` will import
(value) from `adapters.ts` in Task 4 — this is a one-directional dependency
(`yahoo.ts`/`candidates.ts` → `adapters.ts` → `data.ts`), not a cycle. Verify with `npx tsc
--noEmit` (a real import cycle would surface as a build error, not silently work).

- [ ] **Step 4: Rewrite `market/hours.ts` as a thin wrapper**

```ts
import type { Market } from '../engine/types.js';
import { adapterFor } from './adapters.js';

export function isMarketOpen(market: Market, now: Date): boolean {
  return adapterFor(market).isOpen(now);
}
```

Delete the old `ZONES`/`SESSIONS` `Record<Market, ...>` maps and the inline
`Intl.DateTimeFormat` logic — it now lives in `adapters.ts`'s `isWithinSession`. This file
keeps its existing export name and signature, so `scheduler.ts` and every other caller needs no
import change.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npm test -- hours`
Expected: PASS — the pre-existing ASX/US test cases (Monday-open, pre-open, close, Saturday-
closed, for both markets) must pass with **zero edits to their assertions**, proving the
refactor preserved behavior exactly. Plus the new CRYPTO case.

- [ ] **Step 6: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: `market/hours.ts`'s compile error from Task 1 is now resolved. Any OTHER file still
using a hand-written `['ASX','US']` literal (rounds-routes, market-routes, scheduler) still
compiles fine (those are runtime checks, not type errors) — they're generalized in Task 5, not
required to compile-fail here.

---

### Task 4: `market/data.ts` — registry-routed `marketForSymbol` + adapter-routed `poll()`

**Files:**
- Edit: `backend/src/market/data.ts`
- Test: `backend/test/market-data.test.ts`

Depends on Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/test/market-data.test.ts
describe('marketForSymbol', () => {
  it('classifies a crypto symbol by its -USD suffix', () => {
    expect(marketForSymbol('BTC-USD')).toBe('CRYPTO');
  });

  it('still classifies an ASX symbol by its .AX suffix', () => {
    expect(marketForSymbol('BHP.AX')).toBe('ASX');
  });

  it('does not misclassify a real US ticker with a hyphen as crypto', () => {
    expect(marketForSymbol('BRK-B')).toBe('US'); // Berkshire Hathaway class B, not a -USD suffix
  });
});

describe('MarketDataService.poll adapter routing', () => {
  it('calls a single shared fetcher exactly once for a mixed ASX+US+CRYPTO symbol list', async () => {
    // spy on / wrap the fetcher registered on all three adapters (today's real config: all
    // three point at the same yahooFetcher reference) and assert call count === 1
    // for poll(['BHP.AX', 'AAPL', 'BTC-USD'])
  });

  it('calls two distinct fetchers once each when a market has its own quoteFetcher', async () => {
    // construct a MarketDataService with a fetcher map where CRYPTO is swapped for a
    // second fake fetcher distinct from the ASX/US one (simulating a future non-Yahoo
    // market) and assert each fake is called exactly once, with the correct symbol subset
  });
});
```

Adapt these to however `MarketDataService` is actually constructed/injected in the existing
test file (read it first — it likely takes a `QuoteFetcher` directly in its constructor today;
this task's Step 3 changes that shape, so the test-construction pattern needs updating
alongside the implementation, not left stale).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- market-data`

- [ ] **Step 3: Implement**

```ts
// market/data.ts
import { adapterFor, MARKET_ADAPTERS } from './adapters.js';

export function marketForSymbol(symbol: string): Market {
  return MARKET_ADAPTERS.find((a) => a.matchesSymbol(symbol))!.id; // US catch-all always matches
}
```

In `MarketDataService.poll(symbols)`, replace the single `this.fetcher(symbols)` call with
per-adapter-fetcher routing, deduped by function reference:

```ts
async poll(symbols: string[]): Promise<Map<string, Quote>> {
  if (symbols.length === 0) return new Map();
  const byFetcher = new Map<QuoteFetcher, string[]>();
  for (const symbol of symbols) {
    const fetcher = adapterFor(marketForSymbol(symbol)).quoteFetcher;
    const bucket = byFetcher.get(fetcher);
    if (bucket) bucket.push(symbol); else byFetcher.set(fetcher, [symbol]);
  }
  const partials = await Promise.all([...byFetcher].map(([fetcher, syms]) => fetcher(syms)));
  const results = new Map<string, { price: number; currency: string; name?: string }>();
  for (const partial of partials) for (const [symbol, quote] of partial) results.set(symbol, quote);
  // ...rest of the existing method body (ts/insert/backfillName/cache-set loop) unchanged,
  // now iterating `results` instead of a directly-awaited single fetcher call
}
```

Whether `MarketDataService`'s constructor still takes a single injected `QuoteFetcher` (used
as a fallback/default, e.g. for tests that don't care about per-adapter routing) or drops that
parameter entirely in favor of always routing through the registry is an implementation
judgment call — read the constructor's current callers (`index.ts`, test helpers) before
deciding, and prefer the smaller diff. The regression requirement is behavioral, not
structural: a mixed-market `poll()` call against today's real (all-Yahoo) adapter config must
issue exactly one Yahoo call, proven by the Step 1 test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test -- market-data`

- [ ] **Step 5: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: any OTHER test file that constructs a `MarketDataService` directly (grep for `new
MarketDataService(` across `backend/test`) may need its construction call updated to match
whatever constructor shape Step 3 settled on — find and fix all of them in this task, don't
leave any broken.

---

### Task 5: Route every remaining `['ASX', 'US']` literal through `ALL_MARKETS`

**Files:**
- Edit: `backend/src/api/rounds-routes.ts`
- Edit: `backend/src/api/market-routes.ts`
- Edit: `backend/src/scheduler.ts`
- Test: whichever existing test files cover round-creation market validation and the
  `/api/market/candidates` route (grep for `'markets must be ASX and/or US'` and for the
  `MARKETS` constant's test coverage to find them — likely `test/rounds-routes.test.ts` /
  similar and `test/api-market.test.ts`)

Depends on Task 3 (`ALL_MARKETS` exists).

- [ ] **Step 1: Write the failing tests**

Extend the round-creation validation test: a round with `markets: ['CRYPTO']` and one with
`markets: ['ASX', 'US', 'CRYPTO']` are both accepted (201, not 400); a round with
`markets: ['NOTAMARKET']` is still rejected (400) — this must keep passing unmodified, proving
the generalized check is not accidentally permissive.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- rounds-routes api-market scheduler` (adjust to real filenames)

- [ ] **Step 3: Implement**

```ts
// api/rounds-routes.ts
import { ALL_MARKETS } from '../market/adapters.js';
// ...
if (!Array.isArray(config.markets) || config.markets.some((m) => !ALL_MARKETS.includes(m))) {
  res.status(400).json({ error: `markets must be one of ${ALL_MARKETS.join(', ')}` });
  return;
}
```

```ts
// api/market-routes.ts
import { ALL_MARKETS } from '../market/adapters.js';
// replace: const MARKETS: Market[] = ['ASX', 'US'];
// with direct use of ALL_MARKETS wherever MARKETS was referenced
```

```ts
// scheduler.ts
import { ALL_MARKETS } from './market/adapters.js';
// replace: const openMarkets = (['ASX', 'US'] as Market[]).filter((m) => isMarketOpen(m, now));
// with:
const openMarkets = ALL_MARKETS.filter((m) => isMarketOpen(m, now));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test -- rounds-routes api-market scheduler`

- [ ] **Step 5: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`

---

### Task 6: `broker/paper.ts` crypto fractional-quantity regression test (no source change expected)

**Files:**
- Test: `backend/test/paper-broker.test.ts`

Depends on Task 1 (`Market` includes `'CRYPTO'`) — no dependency on Tasks 2-5.

The spec claims `broker/paper.ts` needs zero code changes: its only market-specific branch is
`if (req.market === 'ASX')` for whole-share clipping, and CRYPTO (like US today) falls through
as an unconstrained float quantity — exactly right for fractional BTC/ETH. This task proves
that claim with a test; **do not edit `broker/paper.ts` in this task**. If the test reveals the
claim is wrong, STOP and report back rather than patching `broker/paper.ts` improvised — that
file is hardened and any real fix belongs in a reviewed follow-up, not an ad hoc patch here.

- [ ] **Step 1: Write the test**

```ts
it('fills a CRYPTO buy with an 8-decimal-place quantity, unclipped', () => {
  // mirror this test file's existing buy-order test setup, with market: 'CRYPTO',
  // a quote price chosen so the resulting quantity has a real fractional remainder
  // (e.g. amountCents sized so quantity works out to something like 0.00034521)
  const fill = broker.execute({ ...baseReq, market: 'CRYPTO', side: 'buy', amountCents: cents(50) }, quote, 1, DEFAULT_FEES);
  expect(fill.quantity).not.toBe(Math.floor(fill.quantity)); // genuinely fractional, not silently floored
  expect(Number.isFinite(fill.quantity)).toBe(true);
});
```

- [ ] **Step 2: Run test**

Run: `cd backend && npm test -- paper-broker`
Expected: PASS on the first run, with zero source changes — confirming the spec's claim.

- [ ] **Step 3: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`

---

### Task 7: `analytics/service.ts` — `feesByMarket` (backend)

**Files:**
- Edit: `backend/src/analytics/service.ts`
- Test: `backend/test/analytics-service.test.ts`

Depends on Task 4 (`marketForSymbol` routes through the registry).

- [ ] **Step 1: Write the failing tests**

Extend/replace whatever existing test covers `costs()`'s `asxFeesCents`/`usFeesCents` split:
seed fee ledger rows for an ASX trade, a US trade, and a CRYPTO trade (matching the real note
format `fee for buy ${symbol}` / `fee for sell ${symbol}` written by `rounds/service.ts`'s
`ledger()` calls), and assert `feesByMarket` has the correct `{ASX, US, CRYPTO}` cents split
and `totalFeesCents` is still their sum.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- analytics-service`

- [ ] **Step 3: Implement**

```ts
export interface CostBreakdown {
  totalFeesCents: number;
  feesByMarket: Partial<Record<Market, number>>;
  byDay: { day: string; feesCents: number }[];
}
```

```ts
private costs(roundId: number): CostBreakdown {
  const rows = this.db
    .prepare("SELECT amount_cents, note, created_at FROM ledger_entries WHERE round_id = ? AND type = 'fee' ORDER BY id")
    .all(roundId) as { amount_cents: number; note: string | null; created_at: string }[];

  const byDay = new Map<string, number>();
  const byMarket = new Map<Market, number>();
  let total = 0;
  const SYMBOL_RE = /^fee for (?:buy|sell) (.+)$/;
  for (const row of rows) {
    const cents = -row.amount_cents;
    total += cents;
    const day = row.created_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + cents);
    const symbol = row.note === null ? null : SYMBOL_RE.exec(row.note)?.[1] ?? null;
    if (symbol !== null) {
      const market = marketForSymbol(symbol);
      byMarket.set(market, (byMarket.get(market) ?? 0) + cents);
    }
  }

  return {
    totalFeesCents: total,
    feesByMarket: Object.fromEntries(byMarket),
    byDay: [...byDay.entries()].map(([day, feesCents]) => ({ day, feesCents })).sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}
```

Note this reads the symbol directly out of the fee ledger note (already embedded there by
`rounds/service.ts`'s `fee for buy ${symbol}` / `fee for sell ${symbol}` notes) and classifies
it via the same `marketForSymbol` the rest of the app uses — this is a strict improvement over
today's `.includes('.AX')` substring check (which only ever detected ASX, silently bucketing
everything else as US), not just an addition. A fee row whose note doesn't match the expected
format (defensive — should not happen given `rounds/service.ts` always writes it) is counted
in `totalFeesCents`/`byDay` but skipped from `feesByMarket`, matching this file's existing
never-throw-on-a-parse-miss style (see `parseActions`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test -- analytics-service`

- [ ] **Step 5: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`

---

### Task 8: `AnalyticsTab.tsx` costs panel — `feesByMarket` (frontend)

**Files:**
- Edit: `frontend/src/api/analytics.ts`
- Edit: `frontend/src/pages/round/AnalyticsTab.tsx`
- Test: `frontend/test/analytics-tab.test.tsx`

Depends on Task 7 (backend shape must be final).

- [ ] **Step 1: Write the failing test**

Update the msw fixture for `GET /api/analytics/rounds/:id` to return `costs.feesByMarket:
{ASX: 300, US: 70, CRYPTO: 100}` instead of `asxFeesCents`/`usFeesCents`, then assert the panel
renders a line per market present in the map (not two hardcoded ASX/US lines).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- analytics-tab`

- [ ] **Step 3: Implement**

```ts
// api/analytics.ts
export interface CostBreakdown {
  totalFeesCents: number;
  feesByMarket: Partial<Record<'ASX' | 'US' | 'CRYPTO', number>>;
  byDay: { day: string; feesCents: number }[];
}
```

```tsx
// AnalyticsTab.tsx — replace the two hardcoded Stat lines:
// <Stat label="ASX brokerage" .../> <Stat label="US / FX" .../>
// with an iteration over whatever markets are actually present:
{Object.entries(costs.feesByMarket).map(([market, feesCents]) => (
  <Stat key={market} label={`${market} fees`} value={<span>{formatCents(feesCents)}</span>} testId={`fees-${market.toLowerCase()}`} />
))}
```

Keep the existing `data-testid="fees-asx"`/`"fees-us"` naming convention (lowercased market id)
so any other test/selector referencing them by that pattern still resolves.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- analytics-tab`

- [ ] **Step 5: Full frontend suite + typecheck + build**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`

---

### Task 9: Frontend `Market` type, checkboxes, and the crypto foot-gun warning

**Files:**
- Edit: `frontend/src/api/types.ts`
- Edit: `frontend/src/pages/NewRoundPage.tsx`
- Edit: `frontend/src/pages/SettingsPage.tsx`
- Edit: `frontend/src/pages/round/warnings.ts`
- Test: whichever test files cover the market checkboxes and `roundWarnings` (grep for
  `roundWarnings` / the wizard's markets-checkbox test to find them)

Depends only on Task 1 (no runtime dependency on the backend registry — the frontend `Market`
type is an independently-maintained mirror, per the existing "types mirror backend payloads"
convention). Can be dispatched in parallel with Tasks 2-8 if desired; this plan sequences it
last for simplicity of review, not because of a hard ordering requirement.

- [ ] **Step 1: Write the failing tests**

- A `NewRoundPage`/`SettingsPage` test asserting a "Crypto" (or "CRYPTO") checkbox is present
  alongside the existing ASX/US ones.
- A `roundWarnings` test: `markets: ['CRYPTO']` + `guardrails.stopLossPct: null` produces the
  new crypto/no-stop-loss warning; `markets: ['CRYPTO']` + a set `stopLossPct` does not.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- new-round settings-page warnings` (adjust to real filenames)

- [ ] **Step 3: Implement**

```ts
// api/types.ts
export type Market = 'ASX' | 'US' | 'CRYPTO';
```

```tsx
// NewRoundPage.tsx and SettingsPage.tsx — both currently do:
// (['ASX', 'US'] as Market[]).map(...)
// change to:
(['ASX', 'US', 'CRYPTO'] as Market[]).map(...)
```

```ts
// pages/round/warnings.ts
if (markets.includes('CRYPTO') && guardrails.stopLossPct === null) {
  warnings.push('Crypto trades 24/7 with no circuit breakers — running without a stop-loss here is riskier than the same setup on ASX/US.');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test -- new-round settings-page warnings`

- [ ] **Step 5: Full frontend suite + typecheck + build**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`

---

### Task 10: Whole-branch review + live verification + merge

- [ ] Re-run both full suites (`cd backend && npm test && npx tsc --noEmit`; `cd frontend &&
  npm test && npx tsc --noEmit && npm run build`) and record the exact new totals (count them,
  don't assume) for the CLAUDE.md update.
- [ ] `git diff master -- backend/src/db/migrations.ts` must be **empty** — confirms the "no
  migration needed" claim from the spec held throughout implementation.
- [ ] Confirm `engine/types.ts` and `engine/fees.ts` diffs are additive-only (no existing field
  renamed/removed, no existing branch's formula changed) — these are the only two hardened
  files this plan touches.
- [ ] Confirm no import cycle was introduced: `npx tsc --noEmit` succeeding is necessary but
  not sufficient for this (TS can resolve some cycles); explicitly trace
  `market/adapters.ts`'s imports and confirm `market/yahoo.ts`/`market/candidates.ts` do not
  import (value-level) from `market/adapters.ts` or `market/data.ts`.
- [ ] Confirm the `MarketDataService.poll()` dedup-by-fetcher-reference regression test (Task
  4) actually asserts call count, not just result correctness — re-read it, don't take the
  task's self-report on faith.
- [ ] **Live verification** (matching this project's established pattern for every
  Yahoo-backed feature — see CLAUDE.md's market-scan/Shuffle-button/ASX-candidates sections):
  from inside the running Docker container (or a throwaway `node -e` script reusing one
  long-lived `yahoo-finance2` instance, per this project's documented crumb-rate-limit lesson —
  do NOT spin up a fresh process per check), confirm `yahoo.quote('BTC-USD')` and
  `yahoo.chart('BTC-USD', {period1: ...})` both return real data, and that a manual
  `POST /api/rounds` with `markets: ['CRYPTO']` followed by a watchlist add of `BTC-USD` and a
  manual check-in round-trips correctly (quote polls, a paper buy fills with a fractional
  quantity, a fee is charged at the crypto bps rate).
- [ ] Merge `--no-ff` into `master`, re-run both suites post-merge, update CLAUDE.md's
  "CURRENT STATE" section (new test totals, a new numbered plan entry, TODO.md's crypto
  checkbox, and a short "how it was built" paragraph following the existing pattern — call out
  the `MarketAdapter` registry as the reusable extension point for any future market, per the
  user's original ask).
