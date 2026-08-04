# AI performance / token-usage monitor — design spec

**Date:** 2026-08-04
**Status:** ready for planning

## Problem

TODO.md item: "AI performance/token-usage monitor (dashboard/analytics scope, not
auto-optimization)." Decided scope: visibility only — aggregate tokens/cost per round, per
check-in, per research briefing, and per market scan over time, and surface repeated
tool-call-sequence patterns as informational analytics. No automatic behavior change.

Current state (confirmed by reading the code, not guessed):

- `research_briefings` and `market_scans` already have `tokens_used INTEGER` +
  `cost_usd REAL` columns, populated correctly by `ResearchService`/`MarketScanService` from
  `AgentRunResult.inputTokens/outputTokens/costUsd`.
- `checkins` has only `tokens_used INTEGER` (combined input+output) — **no `cost_usd` column
  at all**. `agent/decision.ts` sums `result.inputTokens + result.outputTokens` into `tokens`
  but never reads `result.costUsd`, so check-in cost is currently unrecoverable even though
  the SDK already returns it (`sdk-runner.ts` reads `message.total_cost_usd` into
  `AgentRunResult.costUsd` for every run type).
- **Tool-call sequences are already captured for check-ins** — `agent/tools.ts`'s `record()`
  pushes one `CheckinAction { tool, args, ok, detail }` per tool invocation, in call order,
  into the `actions` array persisted as `checkins.actions_json`. `analytics/service.ts`
  already has `parseActions(json)` (extracts the ordered `tool` name list) and
  `checkinLedger()` (per-checkin rows including `actions: string[]`). **No new capture point
  is needed for pattern detection** — research and market-scan runs pass `tools: []` (no
  trading tools at all), so check-ins are the only run type with a tool-call sequence to
  analyse, and it's already on disk.
- `analytics/service.ts` already has a `tokenTotals(roundId)` method (checkin-only,
  `{checkinTokens, checkins}`) surfaced on `RoundAnalytics` and cross-round via
  `GET /api/analytics/summary`. This is the precedent to generalize, not a parallel system to
  build.
- Frontend precedent: `pages/round/AnalyticsTab.tsx` (per-round) and `pages/AnalyticsPage.tsx`
  (cross-round, already reads `GET /api/analytics/summary`) are the two existing analytics
  surfaces to extend — no new page or route needed for either scope.

## Design

### 1. Check-in cost parity (migration index 5)

```sql
ALTER TABLE checkins ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
```

Appended as a new migration array element (never touch migration indices 0–4). Existing rows
default to `0` — read sites must treat `0` as "unknown/pre-migration", not "this check-in was
free"; the UI labels a check-in ledger row's cost as `—` when `cost_usd === 0 &&
tokens_used > 0` (a real free run is impossible once billing is involved, so `0` cost with
nonzero tokens is unambiguously "recorded before this column existed").

`agent/decision.ts`'s `runCheckinInner`: capture `result.costUsd` alongside the existing
`tokens` sum, persist it in the same `UPDATE checkins SET status = ?, tokens_used = ?,
cost_usd = ?, actions_json = ? WHERE id = ?` statement. On the `catch` path (exception before
a result exists), `cost_usd` stays `0` exactly like `tokens` does today.

### 2. Backend aggregation (`analytics/service.ts`)

New method, added to `RoundAnalytics`:

```ts
export interface AiUsageByType {
  type: 'checkin' | 'research' | 'scan';
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface AiUsagePattern {
  /** Ordered tool-name sequence, e.g. ['place_order', 'write_journal']. Empty = no tool calls. */
  sequence: string[];
  count: number;
}

export interface AiUsageBreakdown {
  byType: AiUsageByType[];
  totalTokens: number;
  totalCostUsd: number;
  byDay: { day: string; tokens: number; costUsd: number }[];
  patterns: AiUsagePattern[];
}
```

`aiUsage(roundId): AiUsageBreakdown`:

- `byType`: one `SELECT COUNT(*), COALESCE(SUM(tokens_used),0), COALESCE(SUM(cost_usd),0)`
  per table (`checkins`, `research_briefings`, `market_scans`), each `WHERE round_id = ?`.
  Replaces `tokenTotals()` as the source `roundAnalytics()` uses (see §3 for the compatibility
  note).
- `byDay`: unions all three tables' `(day, tokens_used, cost_usd)` — `checkins.ts`,
  `research_briefings.created_at`, `market_scans.created_at`, each sliced to `YYYY-MM-DD`
  (same UTC-day convention `costs()`'s `byDay` already uses) — summed per day, sorted
  ascending. Pure aggregation, one extra query per table, no new tables.
- `patterns`: reuses `checkinLedger(roundId)` (or a lighter direct query — implementer's
  call) → for each checkin, `parseActions(actions_json)` gives the ordered tool-name list;
  group by `JSON.stringify(sequence)`, count occurrences, return top 10 by count descending
  (ties broken by most-recent-first, matching `checkinLedger`'s existing `ORDER BY id DESC`
  input order.) A checkin with zero tool calls contributes the empty-array sequence, which
  bubbles up as "no action taken" in the UI — a legitimate, informative pattern (e.g. "8 of the
  last 10 check-ins did nothing").

Strictly read-only, same rule as the rest of the file (no new query does an
INSERT/UPDATE/DELETE) — covered by the existing "row counts unchanged after a full
`roundAnalytics()` call" test, which must still pass unmodified.

### 3. `RoundAnalytics` / `tokenTotals` compatibility

`tokenTotals: { checkinTokens: number; checkins: number }` stays on `RoundAnalytics` exactly
as-is (existing frontend code reads it, e.g. `AnalyticsPage.tsx`'s per-round table) — it is
now just `{ checkinTokens: aiUsage.byType.find(t => t.type === 'checkin')?.tokens ?? 0,
checkins: ...runs }`, computed from the same underlying query rather than a second
`SELECT SUM`. `RoundAnalytics` gains a new `aiUsage: AiUsageBreakdown` field alongside it — no
existing field is removed or renamed, so no frontend call site breaks.

### 4. Cross-round summary (`GET /api/analytics/summary`)

Each `perRound` entry gains `aiUsage: { totalTokens: number; totalCostUsd: number }` (totals
only — the full per-type/pattern breakdown stays a per-round-page concern, keeping the
already-flagged "recomputes `roundAnalytics()` for every round on each request" cost from
growing further). The response gains a top-level `aiUsageTotals: { totalTokens: number;
totalCostUsd: number; byDay: {day, tokens, costUsd}[] }` — summed across all rounds' `byDay`
series — for a single "usage over time across every round" trend on the cross-round page.

### 5. Frontend types (`api/analytics.ts`)

Mirror `AiUsageByType`/`AiUsagePattern`/`AiUsageBreakdown` exactly; add `aiUsage` to the
`RoundAnalytics` interface; add `aiUsage`/`aiUsageTotals` to `AnalyticsSummary`.

### 6. Frontend — per-round (`pages/round/AnalyticsTab.tsx`)

New "AI usage" panel, mounted as a new section (existing sections: trips/histogram/scatter/
costs/checkins/eras — this is a sibling, not a replacement):

- A small table: one row per `byType` entry (Check-ins / Research / Scans), columns Runs /
  Tokens / Cost (USD, `$0.0000`-style like `research/service.ts`'s log line already
  formats), plus a totals row.
- A cost-over-time trend using the existing `components/charts/Sparkline.tsx` (SVG, not
  `lightweight-charts` — do not add a new `lightweight-charts` import site) fed `byDay`'s
  `costUsd` series, following the same per-card sparkline pattern as the uncommitted
  `HoldingsChartPanel.tsx`.
- A "Repeated check-in patterns" list: each `patterns` entry rendered as
  `sequence.join(' → ') || '(no action taken)'` with a `×count` suffix, sorted as returned
  (already count-desc). Purely informational text — no interactivity, no "optimize this"
  affordance, matching the decided no-auto-behavior scope.

### 7. Frontend — cross-round (`pages/AnalyticsPage.tsx`)

- Per-round table gains a "Cost" column (`$X.XXXX`) next to the existing "Tokens" column,
  sourced from the new `aiUsage.totalCostUsd`.
- A new small stat tile (matching the existing Closed/Win rate/Net/Fees row) for total AI
  cost across all rounds, sourced from `aiUsageTotals.totalCostUsd`.
- A `Sparkline` (same component as §6, not a second chart library) for `aiUsageTotals.byDay`
  cost trend, placed near the existing equity-comparison chart.

### 8. Testing

- **Backend**: `test/analytics.test.ts` (or wherever `AnalyticsService` is tested) gains cases
  for `aiUsage()`: mixed checkin/research/scan rows aggregate correctly per type; `byDay`
  buckets and sums across all three sources; `patterns` groups identical sequences
  (including the empty-sequence "no action" case) and sorts by count descending; an
  all-empty round returns zeroed totals and empty arrays without throwing. A migration test
  asserts `checkins.cost_usd` defaults to `0` on a pre-existing row. A `decision.ts` test
  (via `FakeAgentRunner`) asserts `cost_usd` is persisted from `result.costUsd` on both the
  success and non-exception-error paths, and stays `0` on the exception path. The existing
  "row counts unchanged after `roundAnalytics()`" read-only-invariant test must still pass
  with no edits beyond whatever new tables it already iterates.
- **Frontend**: `AnalyticsTab.test.tsx` asserts the AI usage table renders totals and at least
  one pattern row; `AnalyticsPage.test.tsx` asserts the new Cost column and stat tile render
  from a summary fixture including `aiUsage`/`aiUsageTotals`.

## Explicitly out of scope (per TODO.md's decided scope)

- No auto-optimization, no scripted behavior change from detected patterns — display only.
- No new capture point for research/market-scan tool sequences (they have none — no trading
  tools are offered on those runs).
- No per-check-in cost breakdown by individual tool call (SDK only returns one total cost per
  run, not per-tool-call).
