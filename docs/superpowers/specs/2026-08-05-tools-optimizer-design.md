# Tools tab + agent-optimizer function — design spec

**Date:** 2026-08-05
**Status:** ready for planning

## Problem

The user wants a new top-level "Tools" tab — a home for functions that operate across the
whole app rather than one round — and its first function: a button that runs an agent which
reads the history of everything the app's other agents have produced (check-in journals/
actions, research briefings, market-scan outcomes), looks for repeated patterns that could be
replaced by deterministic code instead of an LLM call every time, and outputs a ready-to-paste
prompt for a future Claude Code session to implement that change. Visibility/suggestion only —
it never edits the codebase itself and never changes agent behavior automatically.

Decided scope, from user Q&A:
- **Input:** check-ins + research briefings + market scans, across **every round** (not
  scoped to one round — matches "all the other agents").
- **Volume bound:** a recent window (most recent 200 check-ins / 50 briefings / 50 scans
  across all rounds), not unbounded history and not a pre-aggregation step — same "recent
  window" shape the AI-usage-monitor's pattern detector already established, just widened to
  cross-round.
- **Persistence:** every run is saved (new table, same pattern as `research_briefings`/
  `market_scans`), with a history list in the UI.
- **Output:** one markdown response containing both the agent's findings/reasoning and a
  clearly delimited, ready-to-paste "Implementation prompt" block.
- **Web search:** a per-run toggle (checkbox next to the run button) — the operator decides
  each time whether to grant `WebSearch`/`WebFetch` for that run.

## Design

### 1. `optimizer_runs` table (migration index 6)

No `round_id` — this is the first genuinely global (non-round-scoped) table in the schema.

```sql
CREATE TABLE optimizer_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  web_search_enabled INTEGER NOT NULL,
  output TEXT NOT NULL,
  detail TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_optimizer_runs_created ON optimizer_runs(created_at);
```

Appended as a new migration array element after index 5 (`checkins.cost_usd`) — indices 0-5
stay byte-frozen, per the existing convention.

### 2. Input assembly + prompt (`backend/src/optimizer/prompt.ts`)

```ts
export interface OptimizerPromptInput {
  checkins: { roundName: string; ts: string; status: string; actions: string[]; journalNotes: string[] }[];
  briefings: { roundName: string; createdAt: string; briefing: string }[];
  scans: { roundName: string; createdAt: string; detail: string; added: string[]; removed: string[] }[];
  codebaseConventions: string;
}
```

`OptimizerService` (§3) queries, per input type, `ORDER BY id DESC LIMIT {200|50|50}` joined
against `rounds` for the round name label, across all rounds — a direct SQL cap, no in-memory
truncation. This keeps token cost predictable regardless of how much history the app
accumulates, matching the usage-gate's existing cost-discipline philosophy.

`buildOptimizerPrompt(input)` renders three labelled sections (check-ins, research, scans),
each entry tagged with its round name and timestamp, plus a final section embedding
`codebaseConventions` verbatim under a heading like "This codebase's real constraints — any
suggestion must respect these:".

**`codebaseConventions`is a live excerpt of this repo's own CLAUDE.md**, not a hand-maintained
duplicate that can drift. `OptimizerService` reads `CLAUDE.md` from disk (path resolved via
`fileURLToPath`/`join` relative to the repo root, the same resolution style
`agent/runner-options.ts` already uses for its wrapper-script path) and extracts the substring
between the `## Hard-won invariants` heading and the next `##` heading — a small, already-
curated block (hardened-files list, money-is-integer-cents, read-only-analytics, deep-merge-
config, etc.), not the whole 68KB document, which would dominate token cost and drown the
actual signal. If the file is missing or the heading isn't found (should not happen, but this
must never throw), it falls back to a short hardcoded default string of the same handful of
invariants. This is a **server-side file read**, not a capability granted to the agent — the
agent itself still gets zero filesystem tools (§4); the server reads its own repo file once per
run and pastes the text into the prompt, exactly like it already does for round config values.

```ts
export const OPTIMIZER_SYSTEM_PROMPT = [
  'You are a process auditor for a paper-trading agent app. You read the history of other AI',
  'agent runs (check-ins, research, market scans) and look for repeated, mechanical patterns —',
  'the same tool-call sequence firing every check-in, the same kind of reasoning repeated',
  'verbatim, work that does not actually require judgment — that could be replaced by',
  'deterministic code instead of an LLM call. You do not have any tools: you cannot read the',
  'codebase, place trades, or change anything. Your entire output is read by a human, who may',
  'paste part of it into a separate Claude Code session to implement a change.',
  '',
  'Structure your response in two parts:',
  '1. Findings — the patterns you found and why they look mechanical/repeatable, in plain',
  '   prose. If you found nothing worth automating, say so plainly rather than padding.',
  '2. A section starting with the literal heading "## Implementation prompt", containing a',
  '   single self-contained prompt a developer could paste directly into a fresh Claude Code',
  '   session to implement the change — it must reference the specific hardened-file and',
  '   process constraints given to you below, not generic advice.',
].join('\n');
```

### 3. `OptimizerService` (`backend/src/optimizer/service.ts`)

```ts
export interface OptimizerDeps {
  db: DB;
  settings: SettingsStore;
  usageGate?: UsageGateService;
}

export interface OptimizerOutcome {
  status: 'success' | 'error' | 'skipped';
  detail: string;
}

export interface OptimizerRunRow {
  id: number;
  created_at: string;
  status: 'success' | 'error';
  web_search_enabled: boolean;
  output: string;
  detail: string;
  tokens_used: number;
  cost_usd: number;
}
```

(`web_search_enabled` is stored as SQLite `INTEGER` 0/1 like every other boolean column in this
schema — `list()` converts it to a real `boolean` via `Boolean(row.web_search_enabled)` before
returning, the same read-time conversion pattern used elsewhere for SQLite's lack of a native
boolean type.)

- **A single global `inFlight: boolean` lock** (not a per-round `Set`, since there is only ever
  one global optimizer run at a time) — a second click while a run is in progress returns
  `{status: 'skipped', detail: 'an optimizer run is already in progress'}`, mirroring
  `DecisionService`'s existing overlap guard.
- Usage-gate check first (`if (this.deps.usageGate) { ... }`), identical shape to the other
  three gated services — a gated run does zero query/prompt-building work.
- `model`: `settings.get('roundDefaults').model` — there is no round to take a model from, and
  reusing the existing round-default setting avoids inventing a new settings field for a
  function that runs rarely (manual button only, no schedule).
- `maxTurns`: 4 when `webSearch` is off (single-shot reasoning, no search needed), 10 when on
  (matches `RESEARCH_MAX_TURNS` — each search is a turn).
- `tools: []` always — this agent never gets trading tools, exactly like research and scans.
  `webTools: webSearch` (the per-run toggle) — reuses `RESEARCH_TOOLS` (`WebSearch`/`WebFetch`)
  via the existing `buildRunnerOptions` boolean; **no changes needed to
  `agent/runner-options.ts` or `sdk-runner.ts`** — the capability boundary they already enforce
  covers this call site with zero new code.
- `run(webSearch: boolean): Promise<OptimizerOutcome>` — never throws (try/catch around the
  runner call, error path records an `error` row exactly like `ResearchService`/
  `MarketScanService`). Records tokens/cost/output on success; logs `optimizer_run` /
  `optimizer_run_failed` via `logEvent(db, level, kind, message, null)` — `logEvent` already
  accepts `roundId: number | null = null`, so this needs no change either.
- `list(limit = 20): OptimizerRunRow[]`.

### 4. Routes (`backend/src/api/optimizer-routes.ts`)

```
GET  /api/optimizer        → optimizer.list()
POST /api/optimizer/run    → body { webSearch: boolean } → optimizer.run(webSearch)
```

Same `requireSession(auth)` gating as every other route, no round-scoping (no `:id` param) —
the first non-round-scoped route pair in the API besides `/api/analytics/summary` and
`/api/market/*`.

### 5. Wiring (`backend/src/index.ts`)

```ts
const optimizer = new OptimizerService({ db, settings, usageGate }, runner);
```

Added alongside the existing `research`/`marketScan` construction, sharing the same
`usageGate` instance — this becomes the app's 5th AI call site, gated exactly like the other
four (scheduled/manual check-ins, research, market-scan, CLI checkin). `runner` is the same
`SdkAgentRunner` instance already shared across the other services.

### 6. Frontend

- **Types** (`api/types.ts`): `OptimizerRun { id, created_at, status, web_search_enabled,
  output, detail, tokens_used, cost_usd }`.
- **Hooks** (`api/hooks.ts`): `useOptimizerRuns()` (query), `useRunOptimizer()` (mutation
  taking `{ webSearch: boolean }`, invalidating the runs list on success) — same shape as
  `useBriefings`/`useRunResearch`.
- **`pages/ToolsPage.tsx`** (new): an "Optimizer" panel — a checkbox ("Enable web search for
  this run"), a "Run optimizer" button (disabled while pending, label switches to "Running…"),
  and a history list below rendering each run via the existing `<Markdown>` component (already
  used by `BriefingsList.tsx`) with timestamp + tokens/cost, same visual pattern as
  `BriefingsList.tsx`/`ScansPanel.tsx`. An error-status run renders with the `loss` class,
  matching the existing failed-briefing treatment.
- **Nav**: `shell/AppShell.tsx`'s `LINKS` array gains `{ to: '/tools', label: 'Tools' }`.
  `App.tsx` gains `<Route path="/tools" element={<ToolsPage />} />`. This is the shell for
  future cross-round functions — `ToolsPage.tsx` renders one panel today; a second such
  function later is a second panel on the same page, not a new tab.

### 7. Testing

- **Backend**: `optimizer/service.test.ts` — never throws (error row + event on a failing
  runner); the SQL caps are respected (seed 250 check-ins across 2 rounds, assert exactly 200
  are queried/appear in the built prompt, oldest excluded); the `inFlight` guard rejects a
  second concurrent call; the usage-gate skip path costs zero query/prompt work (assert no DB
  read happens when gated — spy or count queries); `codebaseConventions` extraction pulls the
  real `## Hard-won invariants` section from the actual repo `CLAUDE.md` in one test, and falls
  back to the hardcoded default when given a path to a file without that heading, in another.
  `optimizer-routes.test.ts` (`api-optimizer.test.ts`): `GET` list, `POST /run` success/skip
  paths, auth-gating (401 without a session).
- **Frontend**: `tools-page.test.tsx` — checkbox toggles the `webSearch` value sent to the
  mutation; run button disables while pending; history list renders markdown output and an
  error-status run gets the `loss` class; empty-history state renders a plain message.

## Explicitly out of scope

- **No auto-scheduling.** Manual button only — no cron, no `researchCron`-style config field.
  Matches "a button that runs an agent," not a background job.
- **No automatic implementation of suggestions.** The output is a prompt for a human to review
  and hand to a separate Claude Code session — this function never writes to the codebase, and
  never changes any agent's runtime behavior (no auto-scripting), per the same "visibility, not
  auto-optimization" boundary the AI-usage-monitor feature already established for a related
  idea.
- **No filesystem or bash tools for the agent**, web-search toggle or not — the capability
  boundary in `agent/runner-options.ts` is unchanged; this call site only ever uses the
  existing `tools: []` / `webTools: boolean` shape already proven by research/market-scan.
- **No per-round scoping or filtering UI** for this first pass — always all rounds, always the
  same recency caps. A future refinement (date range, round picker) is a separate, small
  follow-on if the fixed window proves insufficient in practice.
