# TODO — findings from the first manual testing pass

Raised by the user after using the app by hand (2026-08-03). Each item now carries the
technical triage done in the same session. Sequencing: these become one small UX branch
**after** the `phase2-replay` branch merges, except item 3 which folds into Phase 3.

- [ ] **1. Markets page: hide archived symbols; give them their own unarchive view.**
  Today `MarketsPage.tsx:31-32` splits active/archived and renders archived inline as a
  "Archived: … — restore" row (`:53-62`). Wanted: archived gone from the main list entirely,
  restored from a separate page/tab. Frontend-only, small.

- [ ] **2. Distinguish the same ticker across markets (TLS on ASX ≠ TLS on US).**
  **Not a data-model bug.** Yahoo tickers already disambiguate by suffix — `TLS` is the US
  company, `TLS.AX` is Telstra — and `marketForSymbol()` (`market/data.ts:9`) derives the market
  from the `.AX` suffix, with `symbol` as the `symbols` table primary key. The real gap is that
  the **`symbols.name` column exists (`migrations.ts:26`) but is never populated by anything**,
  so every UI surface shows a bare ticker with no company name and no market label — which is
  exactly why the two look interchangeable. Fix: populate `name` (and confirm `market`) from the
  Yahoo quote metadata on `track()`, then show name + market in the markets list, the watchlist
  editor and the new-round wizard.

- [ ] **3. Watch the full market when the round tracks no symbols.** → Became the **market-scan**
  feature. See CLAUDE.md "Decisions made this session" for the agreed design (`autoWatchlist`
  per-round flag; scan at creation + weekly when on; one bootstrap scan when off with an empty
  watchlist; symbols validated against a live quote before they land). Folds into the Phase 3
  research-briefings plan because it is the same web-tools agent runner — **do not build a
  separate screener before Phase 3.**

- [ ] **4. Make the check-in cron schedule friendlier.**
  Both the wizard (`NewRoundPage.tsx:227`) and the config panel (`ConfigPanel.tsx:227`) take raw
  cron expressions in a `<textarea>`, one per line. Wanted: named presets (market open, hourly
  during session, daily close…) with a raw/advanced escape hatch, plus a human-readable
  "next run" preview. `cron-parser` v5 is already a backend dependency
  (`CronExpressionParser.parse`); decide whether the preview is computed client- or server-side.

- [ ] **5. Explain the guardrails in plain English.**
  `ConfigPanel.tsx` shows bare `Stop-loss %` / `Max position %` / `Drawdown pause %` inputs under
  a "Guardrails — blank disables" legend, with no explanation of what each does or what a
  sensible value looks like. Wanted: helper text per field in both the wizard and the config
  panel. Note the existing invariant: **blank means `null` (disabled), never `0`** — a 0%
  stop-loss sells instantly.
