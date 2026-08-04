# Crypto as a third market + generalized market-adapter registry — design spec

**Date:** 2026-08-04
**Status:** ready for planning

## Problem

TODO.md item: "Add crypto as a third paper-traded market alongside ASX/US." Decided scope:
paper trading only, within the existing `Broker` interface — not real exchange connectivity,
not pulled ahead of the real-money Stake broker phase (spec phase 5).

Confirmed live during research for this spec: `yahoo-finance2` (already a backend dependency)
serves crypto quotes through the exact same `quote()`/`chart()`/`screener()` calls already used
for stocks — `yahoo.quote('BTC-USD')` returns real data (`price`, `currency: 'USD'`,
`exchange: 'CCC'`). No new dependency, no new auth is required to get real crypto data.

**A second, explicitly-requested goal**: today's `Market = 'ASX' | 'US'` handling is not a
plugin system — a code survey (reading every literal `'ASX'`/`'US'` call site) found it is
mostly scattered `if`/`else`/ternary branches and ~4 independently-maintained `['ASX', 'US']`
literal arrays, with exactly one place (`market/hours.ts`'s two `Record<Market, ...>` maps)
where TypeScript would actually force a new market to be handled everywhere else it should be.
Before adding crypto, this spec generalizes the market concept into a **`MarketAdapter`
registry** — each market (ASX, US, CRYPTO, and any future one) is a single self-describing
object: how to recognise its symbols, whether it's open, how to fee a trade, and how to fetch
its quotes/candidates (each of which may come from a **different source with a different raw
data shape**, mapped onto the app's existing common shapes inside the adapter — the
"middleman" the user asked for). Adding a market after this lands means writing one new
adapter object and adding it to one array, not touching N existing branches.

### What the survey found (grounds every design decision below)

| # | File | Today | Signal |
|---|------|-------|--------|
| 1 | `engine/types.ts:1` | `type Market = 'ASX' \| 'US'` | Source of truth for the union; hardened. |
| 2 | `engine/fees.ts` | `if (market === 'ASX') flat; else fxBps` | Pure, 2-branch, hardened. |
| 3 | `broker/paper.ts` | `if (req.market === 'ASX') { floor to whole shares }` — no `else`, non-ASX already falls through as unconstrained float | **Crypto's fractional (8-decimal) quantities already work today with zero broker changes.** |
| 4 | `market/data.ts:12` | `marketForSymbol`: `.AX` suffix → ASX, else → US | A bare `-USD` suffix (Yahoo's crypto convention) would misclassify as US today; no existing US ticker ends in literal `-USD` (share-class suffixes are single letters, e.g. `BRK-B`), so a 3-way suffix dispatch is unambiguous. |
| 5 | `market/hours.ts` | `Record<Market, zone>` / `Record<Market, [open, close)]>`, unconditional Sat/Sun closed | **The one place TS enforces exhaustiveness today.** No "always open" case exists — crypto needs a real branch, not just a data entry. |
| 6 | `market/candidates.ts` | `CandidateFetcher = (market) => Promise<ScanCandidate[]>`, already dispatches ASX (custom Yahoo screener POST, its own response shape) vs US (public `screener()`, a different response shape) into one common `ScanCandidate` shape via `dedupe()` | **This "different source, different raw shape, mapped to a common shape" pattern already exists** — the spec generalizes it into the adapter registry rather than inventing something new. |
| 7 | `market/data.ts:5-7` | `QuoteFetcher = (symbols) => Promise<Map<symbol, {price, currency, name?}>>` | Already source-agnostic; only one Yahoo implementation exists today, nothing ties the type to Yahoo. |
| 8 | `market/symbols.ts` | `SYMBOL_RE = /^[A-Z0-9.\-^=]{1,15}$/` | Already permits hyphens — `BTC-USD` passes `normalizeSymbol()` with zero change. |
| 9 | DB schema | `symbols.market` / `positions.market` are `TEXT NOT NULL`, no CHECK constraint | **Zero migration needed** to store `'CRYPTO'`. |
| 10 | `analytics/service.ts` `costs()` | Splits fees by `note.includes('.AX')` into exactly `asxFeesCents` / `usFeesCents = total - asx` | Already-documented known limitation (CLAUDE.md). A crypto trade's fee would silently fold into `usFeesCents` unless addressed (§7 below). |
| 11 | Fee config UI | `FeeConfig` (`asxFlatCents`/`usFxBps`/`slippageBps`) is **not editable anywhere in the UI** — only read server-side as a round default and client-side by `warnings.ts`'s foot-gun copy | A `cryptoFxBps` field needs no new form; it's a `SettingsStore` default like the other two. |

**Overall difficulty signal**: this is closer to "well-factored 2-market code with a few
closed-world literals to open up" than "hardcoded binary logic to rip out." The genuinely new
work is (a) crypto's "always open" hours semantics, (b) a crypto fee rate, (c) a
`cryptoCandidates()` fetcher, and (d) the adapter registry itself replacing ~4 independent
`['ASX','US']` literals. Broker quantity handling, symbol identity, DB schema, and the
quote/candidate-fetcher interfaces already generalize with little or no change.

## Design

### 1. `Market` union gains `'CRYPTO'` (hardened file, surgical addition)

```ts
// engine/types.ts
export type Market = 'ASX' | 'US' | 'CRYPTO';
```

This one-line change is what makes `market/hours.ts`'s `Record<Market, ...>` maps fail to
compile until crypto is handled — the exhaustiveness check the survey found is the only
existing safety net. Under the design below, those `Record` maps go away entirely (replaced by
each adapter declaring its own hours rule), so the compiler forces the *adapter registry* to
list all three markets instead — same safety property, cleaner shape.

`FeeConfig` gains one new field, alongside the two existing rates:

```ts
export interface FeeConfig {
  asxFlatCents: number;
  usFxBps: number;
  cryptoFxBps: number; // new
  slippageBps: number;
}

export const DEFAULT_FEES: FeeConfig = { asxFlatCents: 300, usFxBps: 70, cryptoFxBps: 100, slippageBps: 0 };
```

`cryptoFxBps: 100` (1%) is a starting placeholder approximating a typical exchange taker fee —
tunable later exactly like the other two rates (a `SettingsStore` default, not a UI form field,
matching how `usFxBps`/`asxFlatCents` already work today per row 11 of the survey table).

`engine/fees.ts`'s `tradeFeeCents` (pure, hardened) gets one more branch — this is the ONLY
place the crypto fee *formula* lives, matching the existing invariant that `engine/` is the
sole source of truth for money math:

```ts
export function tradeFeeCents(market: Market, notionalCents: number, fees: FeeConfig): number {
  if (market === 'ASX') return fees.asxFlatCents;
  const bps = market === 'CRYPTO' ? fees.cryptoFxBps : fees.usFxBps;
  return Math.ceil((notionalCents * bps) / 10_000);
}
```

`broker/paper.ts` needs **no change** — its only market-specific branch is `if (req.market ===
'ASX')` for whole-share clipping; crypto (like US today) falls through as an unconstrained
float quantity, which is exactly right for fractional BTC/ETH.

### 2. `MarketAdapter` registry (new file: `backend/src/market/adapters.ts`)

```ts
export interface MarketAdapter {
  id: Market;
  label: string;
  /** Registry tries adapters in array order; first match wins. */
  matchesSymbol(symbol: string): boolean;
  isOpen(now: Date): boolean;
  quoteFetcher: QuoteFetcher;
  candidateFetcher: CandidateFetcher;
}
```

Note `feeCents` is deliberately **not** on the adapter — `tradeFeeCents(market, ...)` in
`engine/fees.ts` stays the single pure, hardened, testable source of truth for the fee formula
(engine/ must stay I/O-free; a `QuoteFetcher`/`CandidateFetcher` on the adapter is inherently
I/O, which is exactly why those two live in `market/`, not `engine/`, while the fee formula —
pure arithmetic — stays in `engine/` and the adapter's callers reach it directly via
`tradeFeeCents(adapter.id, ...)`). Keeping the formula in one place avoids a second copy that
could drift.

```ts
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
  quoteFetcher: yahooFetcher, // same Yahoo source as ASX/US today — see §4
  candidateFetcher: yahooCandidateFetcher,
};

const usAdapter: MarketAdapter = {
  id: 'US',
  label: 'US',
  matchesSymbol: () => true, // catch-all — MUST be registered last
  isOpen: (now) => isWithinSession('America/New_York', [570, 960], now),
  quoteFetcher: yahooFetcher,
  candidateFetcher: yahooCandidateFetcher,
};

// Order matters: specific suffixes before the US catch-all.
export const MARKET_ADAPTERS: MarketAdapter[] = [asxAdapter, cryptoAdapter, usAdapter];
export const ALL_MARKETS: Market[] = MARKET_ADAPTERS.map((a) => a.id);

export function adapterFor(market: Market): MarketAdapter {
  const adapter = MARKET_ADAPTERS.find((a) => a.id === market);
  if (!adapter) throw new Error(`no adapter registered for market ${market}`); // internal invariant, never user-reachable
  return adapter;
}
```

`isWithinSession(zone, [open, close), now)` is `market/hours.ts`'s existing
`Intl.DateTimeFormat`-based weekday/minutes check, extracted verbatim as a helper — no
behavior change for ASX/US, just moved out of the `Record`-keyed function into something each
adapter calls with its own zone/session. `market/hours.ts`'s `isMarketOpen(market, now)`
becomes a one-line wrapper — `adapterFor(market).isOpen(now)` — kept as a re-export so
`scheduler.ts` and any other existing caller doesn't need to change its call sites, only its
import.

### 3. `marketForSymbol` — routes through the registry

```ts
// market/data.ts
export function marketForSymbol(symbol: string): Market {
  return MARKET_ADAPTERS.find((a) => a.matchesSymbol(symbol))!.id; // US catch-all always matches
}
```

Behavior for every existing symbol is byte-identical (`.AX` → ASX, everything else → US) —
the only new classification is `-USD` → CRYPTO, and no existing US ticker in Yahoo's namespace
uses that literal suffix (share classes use a single letter, e.g. `BRK-B`), so this is not a
behavior-breaking change for any symbol the app already tracks.

### 4. Quote fetching stays a single Yahoo call for today's three markets, but is routed per-adapter

`MarketDataService.poll(symbols)` currently calls one shared `QuoteFetcher` with the whole
symbol list. To support a *future* market whose adapter points at a genuinely different
source, `poll()` groups the requested symbols by `marketForSymbol` → `adapterFor` →
`quoteFetcher`, then calls **each distinct fetcher function once** (dedup by function
reference, not by market) and merges the resulting maps:

```ts
async poll(symbols: string[]): Promise<Map<string, Quote>> {
  const byFetcher = new Map<QuoteFetcher, string[]>();
  for (const symbol of symbols) {
    const fetcher = adapterFor(marketForSymbol(symbol)).quoteFetcher;
    (byFetcher.get(fetcher) ?? byFetcher.set(fetcher, []).get(fetcher)!).push(symbol);
  }
  const results = await Promise.all([...byFetcher].map(([fetcher, syms]) => fetcher(syms)));
  const merged = new Map<string, { price: number; currency: string; name?: string }>();
  for (const map of results) for (const [k, v] of map) merged.set(k, v);
  // ...existing per-symbol persistence/cache logic unchanged, iterating `merged` instead of `results`
}
```

Since ASX/US/CRYPTO all point at the same `yahooFetcher` reference today, this dedups back
down to **exactly one Yahoo call per poll — identical to current behavior**, verified by a
regression test asserting call count. A future market with its own fetcher would add exactly
one more call, only for symbols that actually belong to it. This is the "middleman" the user
asked for: each adapter's `quoteFetcher` is free to hit a different API with a different raw
response shape, as long as it maps its own results into the app's existing `{price, currency,
name?}` shape before returning — exactly what `yahooFetcher` already does for Yahoo's raw quote
object, and exactly the pattern `market/candidates.ts`'s `asxCandidates()` vs `usCandidates()`
already establishes for two different raw Yahoo response shapes today.

### 5. `cryptoCandidates()` (`market/candidates.ts`)

Mirrors the existing `asxFallbackCandidates()` pattern (a fixed curated list polled via
`quote()`) rather than a screener — Yahoo has no crypto-specific screener endpoint, and a
curated top-N-by-market-cap list (BTC-USD, ETH-USD, SOL-USD, ...) is a perfectly adequate,
deterministic candidate pool for the market-scan agent, matching the existing "cheap,
deterministic grounding, never a blank-page ask" design goal stated in the file's own doc
comment. A fixed list, roughly 15-20 major coins, hardcoded the same way
`ASX_FALLBACK_UNIVERSE` is today.

```ts
const CRYPTO_UNIVERSE = ['BTC-USD', 'ETH-USD', 'SOL-USD', /* ... */];
async function cryptoCandidates(): Promise<ScanCandidate[]> {
  const quotes = await yahooFinance.quote(CRYPTO_UNIVERSE);
  return quotes.map((q) => ({ symbol: q.symbol, name: q.longName ?? q.shortName, changePct: q.regularMarketChangePercent }));
}
```

`yahooCandidateFetcher` becomes a 3-way dispatch (`market === 'ASX' ? asxCandidates() : market === 'CRYPTO' ? cryptoCandidates() : usCandidates()`), or — cleaner, and consistent with the
adapter registry — each adapter's `candidateFetcher` field points directly at its own
function (`asxAdapter.candidateFetcher = asxCandidatesFetcher`, etc.), and the exported
`yahooCandidateFetcher` used by callers outside the registry (the `/api/market/candidates`
Shuffle-button route) becomes `(market) => adapterFor(market).candidateFetcher(market)` — a
thin wrapper preserving the existing `CandidateFetcher` call signature so
`market-scan/service.ts` and `market-routes.ts` need zero changes beyond accepting `'CRYPTO'`
as a valid `Market` value.

### 6. Config validation, scheduler, and every other `['ASX', 'US']` literal

Every one of the 4 duplicated literal arrays the survey found is replaced by importing
`ALL_MARKETS` from the new registry:

- `api/rounds-routes.ts:64` — `config.markets.some((m) => !ALL_MARKETS.includes(m))` replaces
  the hand-written `m !== 'ASX' && m !== 'US'` check.
- `api/market-routes.ts:10` — `const MARKETS = ALL_MARKETS` replaces the local literal.
- `scheduler.ts:24` — `ALL_MARKETS.filter((m) => isMarketOpen(m, now))` (unchanged call site
  shape, just no longer hand-listing markets).
- `frontend/src/pages/NewRoundPage.tsx:182`, `SettingsPage.tsx:62` — these render checkbox
  lists from a **frontend** literal (`Market` is duplicated on the frontend, per the existing
  "types mirror backend payloads" convention — there is no runtime import across the
  frontend/backend boundary). Both become `(['ASX', 'US', 'CRYPTO'] as Market[])`. This is the
  one place a genuinely new market still requires touching 2 literal call sites — acceptable,
  since the frontend has no equivalent "registry" concept and inventing one for two checkbox
  lists would be over-engineering for what CLAUDE.md's guidance calls out directly (no
  abstraction beyond what the task requires).

### 7. Analytics fee-split (`analytics/service.ts` `costs()`) — decided scope: extend, not defer

The existing `asxFeesCents` / `usFeesCents = total - asx` split would silently fold every
crypto trade's fee into `usFeesCents`, which is actively misleading (not just imprecise) once
crypto trades exist — worth fixing now rather than carrying forward as a known limitation.
`CostBreakdown` generalizes to a per-market map:

```ts
export interface CostBreakdown {
  totalFeesCents: number;
  feesByMarket: Partial<Record<Market, number>>; // replaces usFeesCents/asxFeesCents
  byDay: { day: string; feesCents: number }[];
}
```

Computed by parsing the market out of the ledger note the same way the existing code detects
`.AX` — generalized to `marketForSymbol(symbolFromNote)` if the note already carries the
symbol, or (simpler, and the recommended approach) by joining `ledger_entries` against
`trades`/`orders` on `ref_order_id` to read the trade's actual `symbol` and derive its market
via `marketForSymbol` directly, rather than string-sniffing the note. This is a strictly
additive, backward-compatible read — no schema change. **Frontend consumers**
(`AnalyticsTab.tsx`'s costs panel) change from two fixed fields to iterating
`Object.entries(feesByMarket)`.

### 8. Frontend

- `frontend/src/api/types.ts`: `Market = 'ASX' | 'US' | 'CRYPTO'`.
- `NewRoundPage.tsx` / `SettingsPage.tsx`: add `'CRYPTO'` to the markets checkbox list (§6).
- `warnings.ts`: no change required for correctness (crypto rounds simply don't trigger the
  ASX-specific warnings), but a symmetrical warning is worth adding — crypto's 24/7 trading
  combined with a `day` trading style and tight guardrails is a real foot-gun the existing
  warning pattern is built to catch. Suggested addition:
  ```ts
  if (markets.includes('CRYPTO') && guardrails.stopLossPct === null) {
    warnings.push('Crypto trades 24/7 with no circuit breakers — running without a stop-loss here is riskier than the same setup on ASX/US.');
  }
  ```
- Market badges/labels: anywhere a market renders as a plain string already displays
  `'CRYPTO'` correctly with no code change (no hardcoded ASX/US label switch exists on the
  frontend per the survey).

### 9. DB / migration

**None required.** `symbols.market` and `positions.market` are already free-text columns with
no CHECK constraint (survey row 9). `SYMBOL_RE` already accepts the `-USD` suffix (row 8).

## Testing

- **Backend — `engine/`**: `tradeFeeCents` gains a `CRYPTO` case (bps formula, same shape as
  the existing US case, different config field) — pure function, trivial to test exhaustively
  including boundary/rounding cases mirroring the existing US tests.
- **Backend — `market/hours.ts` / adapters**: `isOpen('CRYPTO', <any timestamp incl. Sat/Sun
  3am>)` always `true`; ASX/US behavior byte-identical to today (existing tests must still
  pass unmodified — this is a refactor of *where* the logic lives, not a behavior change for
  those two markets, and is provable by running the existing hours test suite against the new
  implementation with zero edits).
- **Backend — `marketForSymbol`**: `'BTC-USD'` → `'CRYPTO'`, `'BHP.AX'` → `'ASX'`, `'AAPL'` →
  `'US'`, plus a regression case asserting a real US ticker with a hyphen (`'BRK-B'`) still
  classifies as `'US'` (proves the `-USD` suffix check doesn't over-match).
- **Backend — `MarketDataService.poll()`**: a test with a fake `QuoteFetcher` registered
  against two different adapters (simulating a future non-Yahoo market) asserts it's called
  exactly twice with the correct symbol partitions; a test with all-Yahoo adapters (today's
  real configuration) asserts the shared fetcher is called exactly **once** for a mixed
  ASX+US+CRYPTO symbol list — the regression test proving §4's "identical call count to today"
  claim.
- **Backend — `market/candidates.ts`**: `cryptoCandidates()` tested against a mocked
  `yahooFinance.quote()` the same way `usCandidates()` is tested today.
- **Backend — `analytics/service.ts` `costs()`**: extend the existing fee-split test with a
  seeded crypto trade, asserting `feesByMarket.CRYPTO` is correct and `feesByMarket.US` no
  longer silently absorbs it.
- **Backend — round creation/config routes**: `markets: ['CRYPTO']` and
  `markets: ['ASX', 'US', 'CRYPTO']` both accepted; an invalid market string still rejected
  (existing test, assert it still passes against the `ALL_MARKETS`-based check).
- **Backend — `broker/paper.ts`**: a CRYPTO buy/sell with an 8-decimal-place quantity (e.g.
  `0.00034521`), asserting no rounding/clipping is applied (the existing "ASX floors to whole
  shares" test must still pass unmodified — proves the `if (market === 'ASX')` branch is
  untouched).
- **Live verification** (matching this project's established pattern for every Yahoo-backed
  feature): confirm `yahoo.quote('BTC-USD')`/`yahoo.chart('BTC-USD', ...)` against the real API
  from inside the running Docker container, not just mocked tests, before merging.
- **Frontend**: `NewRoundPage`/`SettingsPage` market-checkbox tests extended with a CRYPTO
  option; `AnalyticsTab.tsx` costs-panel test updated for the `feesByMarket` shape; a new
  `warnings.test.ts` case for the crypto/no-stop-loss warning.

## Explicitly out of scope

- Real exchange connectivity (Binance/Coinbase/etc.) — paper trading only, via the existing
  `Broker` interface, per TODO.md's decided scope.
- A crypto-specific `Broker` implementation — `PaperBroker` already handles crypto correctly
  with zero changes (§1).
- Non-Yahoo crypto data sources (CoinGecko, Coinpaprika, Binance public API) — Yahoo already
  provides live, working crypto quotes/history through the exact same call shape already used
  for stocks; the adapter registry makes swapping to one of these later a single new adapter
  object, not a rearchitecture, but doing so now is unmotivated extra work.
- Real-money Stake work of any kind (spec phase 5, unaffected by this change).
- A UI form for editing `FeeConfig` (including the new `cryptoFxBps`) — fees remain a
  `SettingsStore`-only default today for all three markets alike (survey row 11); adding an
  editable fees form is a separate, unscoped UI project.
