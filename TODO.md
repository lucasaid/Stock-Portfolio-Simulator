# TODO — findings from the first manual testing pass

Raised by the user after using the app by hand (2026-08-03). Each item now carries the
technical triage done in the same session. Sequencing: these become one small UX branch
**after** the `phase2-replay` branch merges, except item 3 which folds into Phase 3.

- [x] **1. Markets page: hide archived symbols; give them their own unarchive view.**
  Today `MarketsPage.tsx:31-32` splits active/archived and renders archived inline as a
  "Archived: … — restore" row (`:53-62`). Wanted: archived gone from the main list entirely,
  restored from a separate page/tab. Frontend-only, small.
  **Done (`ux-fixes` branch):** gated behind an Active/Archived toggle within the same page —
  no new route needed, the archive/restore endpoint was already bidirectional.

- [x] **2. Distinguish the same ticker across markets (TLS on ASX ≠ TLS on US).**
  **Not a data-model bug.** Yahoo tickers already disambiguate by suffix — `TLS` is the US
  company, `TLS.AX` is Telstra — and `marketForSymbol()` (`market/data.ts:9`) derives the market
  from the `.AX` suffix, with `symbol` as the `symbols` table primary key. The real gap is that
  the **`symbols.name` column exists (`migrations.ts:26`) but is never populated by anything**,
  so every UI surface shows a bare ticker with no company name and no market label — which is
  exactly why the two look interchangeable. Fix: populate `name` (and confirm `market`) from the
  Yahoo quote metadata on `track()`, then show name + market in the markets list, the watchlist
  editor and the new-round wizard.
  **Done (`ux-fixes` branch), scoped down:** `MarketDataService.poll()` backfills `symbols.name`
  from the quote response's `longName`/`shortName` (no new Yahoo call — already fetched every
  poll), only for a tracked symbol with no name yet. Shown as "SYMBOL — Name (MARKET)" on
  `MarketsPage`. The watchlist inputs on `ConfigPanel`/`NewRoundPage` are plain comma-separated
  text fields with no symbol lookup at all — upgrading them to a name-aware picker is a bigger
  change, left out of this "small" branch.

- [x] **3. Watch the full market when the round tracks no symbols.** → Became the **market-scan**
  feature. **Done** (`docs/superpowers/plans/2026-08-03-market-scan.md`, branch
  `feature/market-scan`, merged): `autoWatchlist` per-round flag; scan at creation + weekly when
  on; one bootstrap scan when off with an empty watchlist; every proposed symbol validated against
  the round's configured markets and a live quote before it lands. See CLAUDE.md's "Market-scan
  invariants" and "Market-scan feature — how it was built" sections.

- [x] **4. Make the check-in cron schedule friendlier.**
  Both the wizard (`NewRoundPage.tsx:227`) and the config panel (`ConfigPanel.tsx:227`) take raw
  cron expressions in a `<textarea>`, one per line. Wanted: named presets (market open, hourly
  during session, daily close…) with a raw/advanced escape hatch, plus a human-readable
  "next run" preview. `cron-parser` v5 is already a backend dependency
  (`CronExpressionParser.parse`); decide whether the preview is computed client- or server-side.
  **Done (`ux-fixes` branch):** client-side — `cron-parser` added as a frontend dep too (pure JS,
  no network round trip). Shared `CronScheduleField.tsx` used by both pages: preset buttons that
  append a canonical line, textarea stays the raw escape hatch, "next run …" preview per line
  using the same `Australia/Sydney` timezone the backend scheduler parses against.

- [x] **5. Explain the guardrails in plain English.**
  `ConfigPanel.tsx` shows bare `Stop-loss %` / `Max position %` / `Drawdown pause %` inputs under
  a "Guardrails — blank disables" legend, with no explanation of what each does or what a
  sensible value looks like. Wanted: helper text per field in both the wizard and the config
  panel. Note the existing invariant: **blank means `null` (disabled), never `0`** — a 0%
  stop-loss sells instantly.
  **Done (`ux-fixes` branch):** matching `<small>` helper text under each field in both
  `ConfigPanel.tsx` and `NewRoundPage.tsx` (already fully duplicated markup, kept consistent
  rather than introducing a shared component for three fields), plus the blank-means-disabled
  note made visible in the UI, not just a code comment.

- [x] **usage gate: pause AI calls near Claude subscription session/weekly limits.**
  **Done** (`docs/superpowers/plans/2026-08-04-usage-gate.md`, branch `feature/usage-gate`,
  merged): `UsageGateService` polls `claude -p "/usage" --output-format json` (free, local,
  reuses the existing onecli-wrapped bundled `claude` binary) via a 60s-cached, fail-open check
  in front of all four AI call sites (check-ins, research, market-scan, CLI checkin);
  configurable session/weekly % thresholds in a new `usageGate` settings namespace; a
  Settings-page form and a shell-level status banner. See CLAUDE.md's "Usage-gate invariants"
  and "Usage-gate feature — how it was built" sections.

- [ ] **option for targeted number of watch list symbols on scan.** Spec written:
  `docs/superpowers/specs/2026-08-04-market-scan-target-size-design.md` — per-round
  `targetWatchlistSize` (optional int, null = today's behavior), feeds both the scan prompt
  and replaces the hardcoded `MAX_WATCHLIST` cap in `market-scan/service.ts`; held positions
  always survive as a floor under the target. Ready for an implementation plan.


- [ ] **Market scans should journal their reasoning, not just the resulting watchlist diff.**
  Today `market_scans.detail` only records the outcome (e.g. "watchlist now: X, Y") — there's
  no record of *why* the agent picked or dropped a symbol. Add a reasoning field to the scan
  record itself (`market_scans` table / `ScanRow`, surfaced in `ScansPanel.tsx`) — kept
  separate from the round's `journal_entries` table, which stays check-in-turn journal notes
  only, not mixed with scan-turn reasoning. **Spec needed.**

- [ ] **Live "agent is running" indicator per round, covering check-ins, research, and scans.**
  `DecisionService` already tracks in-flight check-ins per round via an in-memory
  `inFlight: Set<number>` (`agent/decision.ts:24`) purely to guard against an overlapping
  manual+scheduled check-in — nothing exposes that state externally today. `ResearchService`
  and `MarketScanService` have no equivalent tracking at all (a small pre-existing gap: two
  research or scan runs could overlap for the same round with nothing stopping them). Add the
  same in-flight tracking to both, expose all three via a status endpoint, and show a live
  indicator on the round page while any of the three is running. **Spec needed.**

- [ ] **Market-scan candidates should account for the round's risk profile, and use web
  search to inform (not expand) the pick.** The candidate pool today comes only from a fixed
  Yahoo screener (`most_actives`/`day_gainers`, `market/candidates.ts`) with no risk-profile
  signal passed into the prompt at all (`market-scan/prompt.ts`'s `buildScanPrompt` doesn't
  reference `config.riskProfile`). The scan already runs with `webTools: true`
  (`market-scan/service.ts:97`), so web search is available today, but every pick is still
  checked against the screener candidate list before it can touch a watchlist (Defence 1 —
  a documented hardened invariant, see CLAUDE.md's "Market-scan invariants"). Decided scope:
  keep that invariant intact — web search should inform the agent's *reasoning* about which
  screener candidates fit the round's risk profile and current trends (and should reference
  well-documented investment principles), not surface brand-new tickers outside the screener
  pool. **Spec needed.**

- [ ] **Guarantee research runs at least once a day.** Decided approach: no new
  system-level enforcement — just make sure the *default* `researchCron`
  (`settings/store.ts`'s `DEFAULT_SETTINGS.roundDefaults.researchCron`, currently
  `['0 7 * * 1-5']`, i.e. weekdays only) actually covers every day, and call this out in the
  round setup UI copy so a user who edits the cron understands they're opting out of daily
  coverage. No override of a user's custom schedule. **Spec needed.**

- [ ] **A way to reset everything — both per-round and whole-app.** Two distinct, separately
  spec-able tools: (1) a per-round reset/delete to clean up a single test round back to
  nothing, and (2) a dangerous, admin-only whole-database wipe (all rounds, all data) for
  clearing a dev/demo instance, which needs deliberate confirmation friction given it's
  irreversible. **Spec needed** (likely two specs, or one spec with two clearly separated
  sections given how different the blast radius is).

- [x] **AI performance/token-usage monitor (dashboard/analytics scope, not auto-optimization).**
  Decided scope: visibility only. **Done** (`docs/superpowers/specs/2026-08-04-ai-usage-monitor-design.md`,
  `docs/superpowers/plans/2026-08-04-ai-usage-monitor.md`, branch `feature/ai-usage-monitor`,
  merged): `checkins` gained a `cost_usd` column (parity with `research_briefings`/
  `market_scans`, which already had it); `AnalyticsService.aiUsage(roundId)` aggregates
  tokens/cost by run type and by day, and groups repeated check-in tool-call sequences
  (already recorded in `checkins.actions_json` — no new capture point was needed, since
  research/scan runs never call any tools at all). Surfaced on the existing per-round
  `AnalyticsTab.tsx` (new "AI usage" panel) and cross-round `AnalyticsPage.tsx` (cost column +
  trend), both via the existing analytics API rather than new routes. Purely informational —
  no auto-behavior change. See CLAUDE.md's "AI usage monitor feature — how it was built"
  section. 421 backend / 202 frontend tests passing (was 413/200).

- [ ] **Watchlist graphs on the round overview — extend beyond held positions to the full
  watchlist.** There's already an uncommitted, wired-in `HoldingsChartPanel.tsx`
  (`frontend/src/pages/round/HoldingsChartPanel.tsx`, mounted in `RoundDetailPage.tsx:92`)
  showing a sparkline card per currently-HELD position. Decided scope: extend it to show a
  card for every symbol on the round's watchlist, including ones not currently held, so you
  can eyeball what the scan is tracking before anything is actually bought. **Spec needed**
  (should account for/build on the existing uncommitted component rather than duplicating it).

- [x] **"Shuffle" button to randomly populate a watchlist field.** Small UI convenience,
  implemented directly (no plan doc). Scope was revised mid-implementation: the first pass drew
  from the tiny `symbols` table (only symbols this app already happens to track — 4 rows live);
  the user asked for it to draw from the FULL pool of active symbols in the selected markets
  instead.
  **Done:** new shared `WatchlistField.tsx` (input + "Shuffle" button) used by both
  `ConfigPanel.tsx` and `NewRoundPage.tsx`. New `GET /api/market/candidates?markets=US,ASX`
  route reuses `yahooCandidateFetcher` (the same Yahoo screener — most_actives + day_gainers —
  market-scan already uses for its candidate pool) rather than adding a second data source.
  Fetched on click only, never on mount. Applies the same market-mismatch filter market-scan's
  Defence 2 uses (`marketForSymbol(c.symbol) === requested market`) — **this filter is not
  redundant**: live verification during this session confirmed the documented coverage gap in
  CLAUDE.md's market-scan section is real — Yahoo's `region: 'AU'` screener call does not
  actually return `.AX`-suffixed symbols, so an ASX request comes back full of unfiltered US
  symbols. Without the filter, Shuffle would silently mislabel US picks as ASX. The UI shows an
  explicit "No active symbols found" message for that empty-after-filter case rather than
  silently doing nothing. 413 backend / 200 frontend tests passing, `tsc --noEmit` clean on
  both, verified live against the real Yahoo API in the running Docker container (not just
  mocked tests).
  **Follow-up same day:** the ASX empty-pool case above was itself fixed (user asked to get ASX
  data from Yahoo working properly) — see the next item.

- [x] **Fix ASX candidates returning no/wrong data (Yahoo screener region bug).** Follow-up to
  the Shuffle button above. Root cause confirmed live: Yahoo's PREDEFINED `screener()`
  (`most_actives`/`day_gainers`, what `yahoo-finance2`'s public API calls) ignores its `region`
  param entirely — `region: 'AU'` (even combined with `lang: 'en-AU'`) returned the exact same
  US symbols as `region: 'US'`.
  **First pass:** a static curated ASX universe polled via `quote()` (still real `.AX` data,
  just not dynamic). **Then researched further per the user's ask** ("see if we can do this via
  the Yahoo API properly") and found Yahoo's separate CUSTOM screener endpoint
  (`v1/finance/screener`, POST with a JSON criteria body — the same one finance.yahoo.com's own
  screener UI submits to) DOES support real region filtering: `{operator:'eq',
  operands:['region','au']}` returned 3600+ genuine `.AX`-suffixed ASX symbols, live-verified,
  including realistic top-gainers/most-actives rankings. `yahoo-finance2`'s public API has no
  method that reaches this endpoint (GET-only fetch layer), so `market/candidates.ts`'s new
  `customScreener()` hand-rolls the POST, reusing the library's own crumb/cookie machinery via
  its deliberately-exported (checked `package.json`'s `"exports"` map — not a hacky deep import)
  `yahoo-finance2/lib/getCrumb` and `yahoo-finance2/lib/cookieJar`. `asxCandidates()` now tries
  this dynamic path first (region `au`, market cap > $200M, sorted by volume/% change — same
  intent as Yahoo's own predefined screens) and only falls back to the static curated universe
  if it throws — it's an undocumented, private endpoint with no stability guarantee.
  Verified live, both paths: the dynamic screener returned real top-movers (e.g. `DRO.AX`
  +14.6%, `MEI.AX` +13.2%, ranked, not a fixed list); the fallback correctly engaged and
  returned real fallback data when a burst of testing got the crumb-scrape page
  (`finance.yahoo.com/quote/AAPL` — a different, more aggressively rate-limited surface than the
  JSON API hosts) 429'd. `usCandidates()` untouched. 413 backend tests still passing (no new
  tests — `candidates.ts` is network-only/compile-checked-only, same convention as
  `sdk-runner.ts`/the real `UsageChecker`), `tsc --noEmit` clean, Docker backend rebuilt.

- [ ] **Add crypto as a third paper-traded market alongside ASX/US.** Decided scope: paper
  trading only, within the existing `Broker` interface — not real exchange connectivity, and
  not pulled ahead of the planned real-money Stake broker phase. Touches several files marked
  hardened in CLAUDE.md (`engine/types.ts`'s `Market` union, `engine/fees.ts`, `broker/paper.ts`,
  `market/data.ts`) since `Market` is currently the closed union `'ASX' | 'US'` used throughout
  fee calculation and market-hours gating — crypto trades 24/7, so the market-hours concept
  needs a real "always open" case, not a special-cased holiday calendar. Symbol suffix
  convention (e.g. `-USD`) needs deciding. **Spec needed**, and should be scoped carefully
  since it touches multiple hardened, surgical-diff-only files.

- [x] **Fix: the 1M and 3M chart ranges show identical data.** Root cause confirmed exactly as
  hypothesized: `MarketHistoryService` cached OHLC bars keyed by `(symbol, interval)` only, and
  1M/3M share `interval: '1d'` — whichever range was fetched first wrote its own (narrower)
  lookback into that shared bucket, and the other range's request found it fresh and non-empty
  and returned the same too-short bars regardless of its own lookback.
  **Done:** new `ohlc_coverage(symbol, interval, since, fetched_at)` table (migration index 4)
  tracks the actual widest `since` boundary ever fetched per `(symbol, interval)`. A cache entry
  is now "fresh" for a given range only if `coverage.since <= range's requested since` — 1M
  fetched after 3M correctly reuses the cache (3M already covers 1M's narrower window); 3M
  fetched after 1M correctly detects the gap and re-fetches. `write()` widens coverage via
  `since = MIN(existing, new)` on upsert, so coverage only ever grows. Verified against the real
  Yahoo fetcher + live DB (not just unit tests): AMZN 1M returned 21 bars from Jul 6, 3M
  correctly returned 63 bars from May 4 — previously 3M would have been truncated to 1M's cached
  window. Two new regression tests in `test/market-history.test.ts`. 409 backend tests passing
  (was 407), `tsc --noEmit` clean, Docker image rebuilt and migration applied live.
  
  - add round total portfolio value