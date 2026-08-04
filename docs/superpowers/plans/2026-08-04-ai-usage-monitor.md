# AI usage monitor implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visibility-only dashboard for AI token/cost usage — aggregated per round, per
check-in, per research briefing, and per market scan over time, plus a read-only surface for
repeated check-in tool-call patterns. No automatic behavior change.

**Architecture:** Check-ins currently have no `cost_usd` column (research/scans already do) —
add it and wire `agent/decision.ts` to persist `AgentRunResult.costUsd`, the same field
`ResearchService`/`MarketScanService` already read. Add one new read-only aggregation method,
`AnalyticsService.aiUsage(roundId)`, that sums tokens/cost across `checkins`,
`research_briefings`, `market_scans`, buckets by day, and groups check-ins' already-recorded
`actions_json` tool-call sequences into a frequency table (no new capture point — the
sequences are already on disk via `agent/tools.ts`'s `record()`). Surface it on the existing
per-round (`GET /api/analytics/rounds/:id`) and cross-round (`GET /api/analytics/summary`)
analytics endpoints, and render it on the existing `AnalyticsTab.tsx` (per round) and
`AnalyticsPage.tsx` (cross-round) — no new pages or routes.

**Tech Stack:** Node 22 / TypeScript strict ESM (backend), better-sqlite3, express 5, vitest +
supertest (backend tests); React 19 + TanStack Query, vitest + jsdom + Testing Library + msw
(frontend tests). Reuses `components/charts/Sparkline.tsx` (plain SVG) — do not add a fourth
`lightweight-charts` import site.

**Read first:** `docs/superpowers/specs/2026-08-04-ai-usage-monitor-design.md` — this plan
implements that spec exactly.

**Hardened files touched:** `db/migrations.ts` (Task 1 appends one array element only — never
edit indices 0–4). `analytics/service.ts` and `api/analytics-routes.ts` are not in the
hardened list but are governed by the "analytics is strictly read-only" invariant — no task
in this plan may add an INSERT/UPDATE/DELETE to either file (Task 1's write lives in
`agent/decision.ts`, not analytics).

---

### Task 1: `checkins.cost_usd` column + persist it in `decision.ts`

**Files:**
- Edit: `backend/src/db/migrations.ts` (append migration index 5 — do not touch indices 0–4)
- Edit: `backend/src/agent/decision.ts`
- Test: `backend/test/decision.test.ts`
- Test: `backend/test/migrations.test.ts` (or wherever schema/migration tests live — locate
  via `grep -rn "ohlc_coverage" backend/test`)

- [ ] **Step 1: Write the failing tests**

Migration test — a pre-existing `checkins` row (inserted before the new column existed, i.e.
via a plain `INSERT` that doesn't set `cost_usd`) reads back `cost_usd === 0`:

```ts
it('defaults cost_usd to 0 on checkins', () => {
  db.prepare("INSERT INTO checkins (round_id, ts, snapshot_json, actions_json, status) VALUES (1, ?, '{}', '[]', 'success')")
    .run(new Date().toISOString());
  const row = db.prepare('SELECT cost_usd FROM checkins ORDER BY id DESC LIMIT 1').get() as { cost_usd: number };
  expect(row.cost_usd).toBe(0);
});
```

`decision.test.ts` — extend an existing successful-checkin test (or add one) asserting the
persisted row's `cost_usd` matches what the runner returned:

```ts
it('persists cost_usd from the agent run result', async () => {
  const runner = new FakeAgentRunner([], 'ok', { costUsd: 0.0123 });
  // ...build DecisionService with runner, call runCheckin(roundId) as the surrounding test already does...
  const row = db.prepare('SELECT cost_usd FROM checkins ORDER BY id DESC LIMIT 1').get() as { cost_usd: number };
  expect(row.cost_usd).toBeCloseTo(0.0123);
});
```

Also assert the exception path (existing "runner throws" test, if present) leaves
`cost_usd === 0`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- decision migrations` (adjust to the real migration test
filename found via grep)
Expected: FAIL — column doesn't exist / value not persisted.

- [ ] **Step 3: Add the migration**

Append as a new array element at the end of `MIGRATIONS` in `backend/src/db/migrations.ts`
(after the `ohlc_coverage` entry, index 4) — do not reformat or touch any earlier entry:

```ts
`
ALTER TABLE checkins ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
`,
```

- [ ] **Step 4: Persist it in `decision.ts`**

In `runCheckinInner`, alongside the existing `tokens = result.inputTokens +
result.outputTokens`:

```ts
let costUsd = 0;
// ...
tokens = result.inputTokens + result.outputTokens;
costUsd = result.costUsd;
```

And the final `UPDATE`:

```ts
db.prepare('UPDATE checkins SET status = ?, tokens_used = ?, cost_usd = ?, actions_json = ? WHERE id = ?')
  .run(status, tokens, costUsd, JSON.stringify(actions), checkinId);
```

`costUsd` stays `0` on the `catch` path exactly like `tokens` does today — no change to that
branch's logic.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npm test -- decision migrations`
Expected: PASS.

- [ ] **Step 6: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: all pass, previous total + the new tests, clean typecheck.

---

### Task 2: `AnalyticsService.aiUsage()` aggregation

**Files:**
- Edit: `backend/src/analytics/service.ts`
- Test: `backend/test/analytics-service.test.ts`

Depends on Task 1 (`checkins.cost_usd` must exist).

- [ ] **Step 1: Write the failing tests**

```ts
describe('aiUsage', () => {
  it('aggregates tokens and cost across checkins, research, and scans', () => {
    // seed 2 checkins (tokens 100+50, cost 0.01+0.02), 1 research_briefings row
    // (tokens 500, cost 0.05), 1 market_scans row (tokens 300, cost 0.03)
    // all round_id = roundId
    const result = analytics['aiUsage'](roundId); // or however the plan exposes it — see Step 3
    expect(result.totalTokens).toBe(100 + 50 + 500 + 300);
    expect(result.totalCostUsd).toBeCloseTo(0.01 + 0.02 + 0.05 + 0.03);
    const checkinRow = result.byType.find((t) => t.type === 'checkin')!;
    expect(checkinRow).toEqual({ type: 'checkin', runs: 2, tokens: 150, costUsd: expect.closeTo(0.03) });
  });

  it('buckets tokens/cost by day across all three sources', () => {
    // seed rows on two distinct days across different tables; assert byDay has 2 entries,
    // ascending, each summing the right sources for that day
  });

  it('groups identical check-in tool-call sequences and counts them, including empty sequences', () => {
    // seed 3 checkins: two with actions_json '[{"tool":"place_order",...}]' (same tool),
    // one with actions_json '[]'
    const result = analytics['aiUsage'](roundId);
    expect(result.patterns).toContainEqual({ sequence: ['place_order'], count: 2 });
    expect(result.patterns).toContainEqual({ sequence: [], count: 1 });
  });

  it('returns zeroed totals and empty arrays for a round with no runs', () => {
    const result = analytics['aiUsage'](otherRoundId);
    expect(result).toEqual({ byType: [
      { type: 'checkin', runs: 0, tokens: 0, costUsd: 0 },
      { type: 'research', runs: 0, tokens: 0, costUsd: 0 },
      { type: 'scan', runs: 0, tokens: 0, costUsd: 0 },
    ], totalTokens: 0, totalCostUsd: 0, byDay: [], patterns: [] });
  });
});

it('roundAnalytics() includes aiUsage and leaves tokenTotals unchanged', async () => {
  const result = await analytics.roundAnalytics(roundId);
  expect(result.aiUsage.totalTokens).toBeGreaterThanOrEqual(0);
  expect(result.tokenTotals).toEqual({ checkinTokens: ..., checkins: ... }); // matches aiUsage's checkin row
});
```

Also extend the existing read-only invariant test ("row counts unchanged after a full
`roundAnalytics()` call") — it should already cover this by construction since no new writes
are added; just confirm it still passes, don't weaken it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- analytics-service`
Expected: FAIL — `aiUsage` doesn't exist.

- [ ] **Step 3: Implement `aiUsage()`**

Add types near the top of `analytics/service.ts` (exported, alongside `RoundAnalytics` etc.):

```ts
export interface AiUsageByType {
  type: 'checkin' | 'research' | 'scan';
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface AiUsagePattern {
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

Add `aiUsage: AiUsageBreakdown` to `RoundAnalytics`, and wire it into `roundAnalytics()`:

```ts
aiUsage: this.aiUsage(roundId),
```

Implementation (private method), roughly:

```ts
private aiUsage(roundId: number): AiUsageBreakdown {
  const sources: { type: AiUsageByType['type']; table: string; tsCol: string }[] = [
    { type: 'checkin', table: 'checkins', tsCol: 'ts' },
    { type: 'research', table: 'research_briefings', tsCol: 'created_at' },
    { type: 'scan', table: 'market_scans', tsCol: 'created_at' },
  ];

  const byType: AiUsageByType[] = [];
  const dayTotals = new Map<string, { tokens: number; costUsd: number }>();

  for (const source of sources) {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_used),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
           FROM ${source.table} WHERE round_id = ?`,
      )
      .get(roundId) as { runs: number; tokens: number; cost: number };
    byType.push({ type: source.type, runs: totals.runs, tokens: totals.tokens, costUsd: totals.cost });

    const rows = this.db
      .prepare(`SELECT ${source.tsCol} AS ts, tokens_used AS tokens, cost_usd AS cost FROM ${source.table} WHERE round_id = ?`)
      .all(roundId) as { ts: string; tokens: number; cost: number }[];
    for (const row of rows) {
      const day = row.ts.slice(0, 10);
      const existing = dayTotals.get(day) ?? { tokens: 0, costUsd: 0 };
      existing.tokens += row.tokens ?? 0;
      existing.costUsd += row.cost ?? 0;
      dayTotals.set(day, existing);
    }
  }

  const byDay = [...dayTotals.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  const patterns = this.patternCounts(roundId);

  return {
    byType,
    totalTokens: byType.reduce((sum, t) => sum + t.tokens, 0),
    totalCostUsd: byType.reduce((sum, t) => sum + t.costUsd, 0),
    byDay,
    patterns,
  };
}

private patternCounts(roundId: number, limit = 10): AiUsagePattern[] {
  const rows = this.db
    .prepare('SELECT actions_json FROM checkins WHERE round_id = ? ORDER BY id DESC')
    .all(roundId) as { actions_json: string }[];

  const counts = new Map<string, { sequence: string[]; count: number }>();
  for (const row of rows) {
    const sequence = parseActions(row.actions_json);
    const key = JSON.stringify(sequence);
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { sequence, count: 1 });
  }

  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
```

Table/column names are interpolated from a fixed internal array (never user input) — not a
SQL-injection surface, matches the existing style of hardcoded queries elsewhere in this
file.

Table interpolation note: `better-sqlite3` doesn't parameterize identifiers, so the
`${source.table}` interpolation is required here — keep the `sources` array as the only
place table names are chosen (never build it from a request param).

`tokenTotals()` can stay as-is (it's still called from `roundAnalytics()`) or be rewritten to
derive from `aiUsage(roundId).byType` to avoid a duplicate `SUM` query — implementer's call;
either way `RoundAnalytics.tokenTotals` must keep its existing shape and values unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test -- analytics-service`
Expected: PASS.

- [ ] **Step 5: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`

---

### Task 3: `GET /api/analytics/summary` — cross-round totals

**Files:**
- Edit: `backend/src/api/analytics-routes.ts`
- Test: `backend/test/api-analytics.test.ts`

Depends on Task 2 (`RoundAnalytics.aiUsage` must exist).

- [ ] **Step 1: Write the failing test**

```ts
it('summary includes per-round and total ai usage', async () => {
  // seed rounds with known checkins/research/scans token+cost totals
  const res = await request(app).get('/api/analytics/summary').set('Cookie', cookie);
  expect(res.body.rounds[0].aiUsage).toEqual({ totalTokens: expect.any(Number), totalCostUsd: expect.any(Number) });
  expect(res.body.aiUsageTotals.totalTokens).toBe(/* sum across rounds */);
  expect(res.body.aiUsageTotals.byDay).toEqual(expect.any(Array));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- api-analytics`

- [ ] **Step 3: Extend the route**

In the `/api/analytics/summary` handler, per-round push gains:

```ts
aiUsage: { totalTokens: result.aiUsage.totalTokens, totalCostUsd: result.aiUsage.totalCostUsd },
```

After the loop, merge every round's `aiUsage.byDay` into one combined series (sum tokens/cost
per day across rounds) and return it as a new top-level field:

```ts
const dayTotals = new Map<string, { tokens: number; costUsd: number }>();
for (const result of allRoundResults) { // whatever the loop's per-round `result` variable is named
  for (const d of result.aiUsage.byDay) {
    const existing = dayTotals.get(d.day) ?? { tokens: 0, costUsd: 0 };
    existing.tokens += d.tokens;
    existing.costUsd += d.costUsd;
    dayTotals.set(d.day, existing);
  }
}
const aiUsageTotals = {
  totalTokens: perRound.reduce((sum, r) => sum + r.aiUsage.totalTokens, 0),
  totalCostUsd: perRound.reduce((sum, r) => sum + r.aiUsage.totalCostUsd, 0),
  byDay: [...dayTotals.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? -1 : 1)),
};

res.json({ rounds: perRound, totals: summarizeRoundTrips(allTrips), aiUsageTotals });
```

Note the loop currently discards each `result` after pulling a few fields into `perRound` —
keep a reference to `result.aiUsage.byDay` inside the loop (e.g. push into a local array) since
it's needed after the loop for `aiUsageTotals`; don't call `roundAnalytics()` a second time per
round.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- api-analytics`

- [ ] **Step 5: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`

---

### Task 4: Frontend types + per-round "AI usage" panel (`AnalyticsTab.tsx`)

**Files:**
- Edit: `frontend/src/api/analytics.ts`
- Edit: `frontend/src/pages/round/AnalyticsTab.tsx`
- Test: `frontend/test/analytics-tab.test.tsx`

Depends on Task 2/3 (backend shape must be final).

- [ ] **Step 1: Write the failing test**

Extend `analytics-tab.test.tsx`'s msw fixture for `GET /api/analytics/rounds/:id` to include
an `aiUsage` block, then assert the panel renders:

```tsx
it('renders the AI usage panel with totals and patterns', async () => {
  // msw fixture: aiUsage: { byType: [...], totalTokens: 950, totalCostUsd: 0.11,
  //   byDay: [{day:'2026-08-01', tokens: 950, costUsd: 0.11}],
  //   patterns: [{ sequence: ['place_order','write_journal'], count: 3 }, { sequence: [], count: 1 }] }
  render(<AnalyticsTab roundId={1} />, { wrapper: Providers });
  expect(await screen.findByText(/AI usage/i)).toBeInTheDocument();
  expect(screen.getByText(/950/)).toBeInTheDocument();
  expect(screen.getByText(/place_order → write_journal/)).toBeInTheDocument();
  expect(screen.getByText(/\(no action taken\)/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- analytics-tab`

- [ ] **Step 3: Add types to `api/analytics.ts`**

```ts
export interface AiUsageByType {
  type: 'checkin' | 'research' | 'scan';
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface AiUsagePattern {
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

Add `aiUsage: AiUsageBreakdown` to `RoundAnalytics`, and add `aiUsage: { totalTokens: number;
totalCostUsd: number }` to each entry of `AnalyticsSummary['rounds']`, plus a top-level
`aiUsageTotals: { totalTokens: number; totalCostUsd: number; byDay: { day: string; tokens:
number; costUsd: number }[] }` on `AnalyticsSummary`.

- [ ] **Step 4: Add the panel to `AnalyticsTab.tsx`**

New section, sibling to the existing trips/histogram/costs/checkins/eras sections (exact
mount point: implementer picks a sensible spot, e.g. after the costs panel). Labels use
`type` → display-name mapping (`checkin` → "Check-ins", `research` → "Research", `scan` →
"Scans"):

```tsx
<div className="panel grid">
  <h2 style={{ marginTop: 0, fontSize: '1rem' }}>AI usage</h2>
  <table>
    <thead>
      <tr><th></th><th className="num">Runs</th><th className="num">Tokens</th><th className="num">Cost</th></tr>
    </thead>
    <tbody>
      {data.aiUsage.byType.map((t) => (
        <tr key={t.type}>
          <td>{TYPE_LABELS[t.type]}</td>
          <td className="num">{t.runs}</td>
          <td className="num">{t.tokens.toLocaleString('en-AU')}</td>
          <td className="num">${t.costUsd.toFixed(4)}</td>
        </tr>
      ))}
      <tr>
        <td><strong>Total</strong></td>
        <td className="num" />
        <td className="num"><strong>{data.aiUsage.totalTokens.toLocaleString('en-AU')}</strong></td>
        <td className="num"><strong>${data.aiUsage.totalCostUsd.toFixed(4)}</strong></td>
      </tr>
    </tbody>
  </table>
  <Sparkline values={data.aiUsage.byDay.map((d) => d.costUsd)} />
  <div>
    <h3 style={{ fontSize: '0.9rem' }}>Repeated check-in patterns</h3>
    <ul>
      {data.aiUsage.patterns.map((p, i) => (
        <li key={i}>{p.sequence.length === 0 ? '(no action taken)' : p.sequence.join(' → ')} — ×{p.count}</li>
      ))}
    </ul>
  </div>
</div>
```

(`TYPE_LABELS` a small const map at module scope.) Purely informational — no buttons, no
"apply" affordance.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- analytics-tab`

- [ ] **Step 6: Full frontend suite + typecheck**

Run: `cd frontend && npm test && npx tsc --noEmit`

---

### Task 5: Cross-round cost column + trend (`AnalyticsPage.tsx`)

**Files:**
- Edit: `frontend/src/pages/AnalyticsPage.tsx`
- Test: `frontend/test/analytics-page.test.tsx`

Depends on Task 4 (shared types in `api/analytics.ts`).

- [ ] **Step 1: Write the failing test**

Extend the `analytics-page.test.tsx` msw fixture for `GET /api/analytics/summary` to include
`aiUsage` per round and top-level `aiUsageTotals`, then assert:

```tsx
it('shows a cost column and total AI cost tile', async () => {
  render(<AnalyticsPage />, { wrapper: Providers });
  expect(await screen.findByText('Cost')).toBeInTheDocument(); // new column header
  expect(screen.getByTestId('total-ai-cost')).toHaveTextContent('$0.1100'); // fixture total
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- analytics-page`

- [ ] **Step 3: Implement**

Add a "Cost" column to the existing `round-comparison` table (next to "Tokens"):

```tsx
<th className="num">Cost</th>
...
<td className="num">${round.aiUsage.totalCostUsd.toFixed(4)}</td>
```

Add a stat tile to the existing top row (Closed/Win rate/Net/Fees):

```tsx
<div>
  <div className="muted" style={{ fontSize: '0.8em' }}>AI cost</div>
  <div data-testid="total-ai-cost" style={{ fontSize: '1.2rem' }}>${totals... }</div>
</div>
```

using `summary.data.aiUsageTotals.totalCostUsd`. Add a `Sparkline` fed
`aiUsageTotals.byDay.map(d => d.costUsd)` near the existing equity-comparison chart panel.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- analytics-page`

- [ ] **Step 5: Full frontend suite + typecheck + build**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`

---

### Task 6: Whole-branch review

- [ ] Re-run both full suites (`cd backend && npm test && npx tsc --noEmit`; `cd frontend &&
  npm test && npx tsc --noEmit && npm run build`) and record the exact new totals (do not
  assume — count them) for the CLAUDE.md update.
- [ ] `grep -rnE "INSERT|UPDATE|DELETE"` over `backend/src/analytics` and
  `backend/src/api/analytics-routes.ts` — must return nothing (Task 2/3 must not have added a
  write; Task 1's write lives in `decision.ts`, outside this grep's scope, which is correct).
- [ ] Confirm `backend/src/db/migrations.ts` indices 0–4 are byte-identical to `master` (only
  a new index 5 element was appended).
- [ ] Confirm no new `lightweight-charts` import was added anywhere under
  `frontend/src/components/charts/` beyond the pre-existing four files.
- [ ] Confirm `RoundAnalytics.tokenTotals` still returns the same values it did before this
  branch (spot-check against `aiUsage.byType`'s checkin row) — no frontend call site outside
  this plan's two edited files should need to change.
- [ ] Merge `--no-ff` into `master`, re-run both suites post-merge, update CLAUDE.md's
  "CURRENT STATE" section (new test totals, TODO.md checkbox, a short "how it was built"
  paragraph following the existing pattern for prior features).
