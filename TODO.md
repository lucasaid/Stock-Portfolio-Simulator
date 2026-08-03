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
