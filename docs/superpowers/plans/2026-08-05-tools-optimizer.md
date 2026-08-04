# Tools tab + agent-optimizer implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new "Tools" tab (cross-round, not per-round) with its first function: a button that
runs an agent which reads recent history from every other agent in the app (check-ins,
research briefings, market scans) across all rounds, finds mechanical/repeatable patterns, and
outputs a markdown response containing findings plus a ready-to-paste Claude Code
implementation prompt. Manual trigger only, every run saved, no auto-implementation.

**Architecture:** A new `OptimizerService` (backend/src/optimizer/), modeled directly on
`ResearchService`/`MarketScanService` but with no `round_id` — the first genuinely global,
non-round-scoped agent-run table in the schema. It queries a capped recent window (200
check-ins / 50 briefings / 50 scans) across all rounds, builds a prompt that also embeds a live
excerpt of this repo's own CLAUDE.md ("Hard-won invariants" section) so the generated
implementation prompt respects real codebase constraints, and runs through the same
`AgentRunner`/`UsageGateService`/`buildRunnerOptions` machinery every other AI call site already
uses — zero changes needed to the capability-boundary file (`agent/runner-options.ts`). A new
"Tools" nav tab renders one panel (`ToolsPage.tsx`) with a web-search checkbox, a run button, and
a history list.

**Tech Stack:** Node 22 / TypeScript strict ESM (backend), better-sqlite3, express 5, vitest +
supertest (backend tests); React 19 + TanStack Query, vitest + jsdom + Testing Library + msw
(frontend tests).

**Read first:** `docs/superpowers/specs/2026-08-05-tools-optimizer-design.md` — this plan
implements that spec exactly.

**Hardened files touched:** `db/migrations.ts` (Task 1 appends one array element only — never
edit indices 0-5). `agent/runner-options.ts` and `agent/sdk-runner.ts` are **not touched at
all** by this plan — the spec's whole point is that the existing `tools: []` / `webTools:
boolean` shape already covers this call site with no new code there.

---

### Task 1: `optimizer_runs` table (migration index 6)

**Files:**
- Edit: `backend/src/db/migrations.ts` (append migration index 6 — do not touch indices 0-5)
- Test: `backend/test/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/migrate.test.ts — add to the existing test file
it('creates optimizer_runs with no round_id column (a global, non-round-scoped table)', () => {
  db.prepare(
    `INSERT INTO optimizer_runs (created_at, status, web_search_enabled, output, detail, tokens_used, cost_usd)
     VALUES (?, 'success', 0, 'findings...', '3 patterns found', 500, 0.02)`,
  ).run(new Date().toISOString());
  const row = db.prepare('SELECT * FROM optimizer_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  expect(row.round_id).toBeUndefined(); // column does not exist at all
  expect(row.status).toBe('success');
  expect(row.web_search_enabled).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- migrate`
Expected: FAIL — `no such table: optimizer_runs`.

- [ ] **Step 3: Append the migration**

Append as a new array element at the end of `MIGRATIONS` in `backend/src/db/migrations.ts`
(after the `checkins.cost_usd` ALTER, index 5) — do not reformat or touch any earlier entry:

```ts
`
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
`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- migrate`

- [ ] **Step 5: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: all pass, one new test, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/migrations.ts backend/test/migrate.test.ts
git commit -m "feat(optimizer): add optimizer_runs table (migration index 6)

Task 1 of docs/superpowers/plans/2026-08-05-tools-optimizer.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `optimizer/prompt.ts` — CLAUDE.md excerpt + system prompt + prompt builder

**Files:**
- Create: `backend/src/optimizer/prompt.ts`
- Test: `backend/test/optimizer-prompt.test.ts`

Depends on nothing (pure functions + one guarded file read, no DB).

- [ ] **Step 1: Write the failing tests**

```ts
// backend/test/optimizer-prompt.test.ts
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOptimizerPrompt, OPTIMIZER_SYSTEM_PROMPT, readCodebaseConventions } from '../src/optimizer/prompt.js';

describe('readCodebaseConventions', () => {
  it('extracts the real Hard-won invariants section from this repo\'s own CLAUDE.md', () => {
    const text = readCodebaseConventions();
    expect(text).toContain('Money is integer AUD cents everywhere');
    expect(text).not.toContain('## Claude/auth integration'); // a later section, must not bleed in
  });

  it('falls back to the hardcoded default when the heading is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-test-'));
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, '# Some doc\n\nNo invariants heading here.\n');
    const text = readCodebaseConventions(path);
    expect(text).toContain('integer AUD cents'); // the hardcoded fallback's own wording
  });

  it('falls back to the hardcoded default when the file does not exist', () => {
    const text = readCodebaseConventions('/nonexistent/path/CLAUDE.md');
    expect(text).toContain('integer AUD cents');
  });
});

describe('buildOptimizerPrompt', () => {
  it('renders labelled sections for check-ins, research, scans, and the conventions block', () => {
    const prompt = buildOptimizerPrompt({
      checkins: [{ roundName: 'round A', ts: '2026-08-01T00:00:00Z', status: 'success', actions: ['write_journal'], journalNotes: ['nothing to do'] }],
      briefings: [{ roundName: 'round A', createdAt: '2026-08-01T00:00:00Z', briefing: 'no material news' }],
      scans: [{ roundName: 'round A', createdAt: '2026-08-01T00:00:00Z', detail: 'watchlist now: AAPL', added: ['AAPL'], removed: [] }],
      codebaseConventions: 'FAKE CONVENTIONS TEXT',
    });
    expect(prompt).toContain('round A');
    expect(prompt).toContain('write_journal');
    expect(prompt).toContain('no material news');
    expect(prompt).toContain('watchlist now: AAPL');
    expect(prompt).toContain('FAKE CONVENTIONS TEXT');
  });

  it('renders an explicit empty note for a section with no rows, rather than an empty heading', () => {
    const prompt = buildOptimizerPrompt({ checkins: [], briefings: [], scans: [], codebaseConventions: 'x' });
    expect(prompt.toLowerCase()).toContain('no check-ins');
    expect(prompt.toLowerCase()).toContain('no research');
    expect(prompt.toLowerCase()).toContain('no market scans');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- optimizer-prompt`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Write `optimizer/prompt.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface OptimizerCheckinInput {
  roundName: string;
  ts: string;
  status: string;
  actions: string[];
  journalNotes: string[];
}

export interface OptimizerBriefingInput {
  roundName: string;
  createdAt: string;
  briefing: string;
}

export interface OptimizerScanInput {
  roundName: string;
  createdAt: string;
  detail: string;
  added: string[];
  removed: string[];
}

export interface OptimizerPromptInput {
  checkins: OptimizerCheckinInput[];
  briefings: OptimizerBriefingInput[];
  scans: OptimizerScanInput[];
  codebaseConventions: string;
}

const HEADING = '## Hard-won invariants';

/** A short, hand-written fallback covering the same handful of invariants as CLAUDE.md's own
 * "Hard-won invariants" section, used only if that file/heading can't be read — must never throw. */
const FALLBACK_CONVENTIONS = [
  'Money is integer AUD cents everywhere. No epsilon heuristics in money math.',
  'engine/*, broker/paper.ts, rounds/service.ts, scheduler.ts, db/migrations.ts are hardened files',
  '— touch only with surgical, review-flagged diffs.',
  'Nested config objects (guardrails/fees) deep-merge over defaults, never wholesale-replace.',
  'Analytics and replay code must stay strictly read-only — no INSERT/UPDATE/DELETE.',
].join('\n');

/**
 * Reads this repo's own CLAUDE.md and extracts just the "## Hard-won invariants" section (not
 * the whole ~70KB document, which would dominate token cost). Never throws — a missing file or
 * heading falls back to a short hardcoded default covering the same ground.
 */
export function readCodebaseConventions(
  claudeMdPath: string = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'CLAUDE.md'),
): string {
  try {
    if (!existsSync(claudeMdPath)) return FALLBACK_CONVENTIONS;
    const text = readFileSync(claudeMdPath, 'utf8');
    const start = text.indexOf(HEADING);
    if (start === -1) return FALLBACK_CONVENTIONS;
    const nextHeadingRelative = text.slice(start + HEADING.length).indexOf('\n## ');
    const end = nextHeadingRelative === -1 ? text.length : start + HEADING.length + nextHeadingRelative;
    const section = text.slice(start, end).trim();
    return section.length > 0 ? section : FALLBACK_CONVENTIONS;
  } catch {
    return FALLBACK_CONVENTIONS;
  }
}

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

function checkinsSection(rows: OptimizerCheckinInput[]): string {
  if (rows.length === 0) return 'Recent check-ins:\n(no check-ins in the sampled window)';
  const lines = rows.map(
    (r) => `- [${r.roundName} @ ${r.ts}] status=${r.status} actions=[${r.actions.join(', ')}] journal="${r.journalNotes.join(' / ')}"`,
  );
  return `Recent check-ins:\n${lines.join('\n')}`;
}

function briefingsSection(rows: OptimizerBriefingInput[]): string {
  if (rows.length === 0) return 'Recent research briefings:\n(no research briefings in the sampled window)';
  const lines = rows.map((r) => `- [${r.roundName} @ ${r.createdAt}] "${r.briefing}"`);
  return `Recent research briefings:\n${lines.join('\n')}`;
}

function scansSection(rows: OptimizerScanInput[]): string {
  if (rows.length === 0) return 'Recent market scans:\n(no market scans in the sampled window)';
  const lines = rows.map(
    (r) => `- [${r.roundName} @ ${r.createdAt}] ${r.detail} (added=[${r.added.join(', ')}] removed=[${r.removed.join(', ')}])`,
  );
  return `Recent market scans:\n${lines.join('\n')}`;
}

export function buildOptimizerPrompt(input: OptimizerPromptInput): string {
  return [
    checkinsSection(input.checkins),
    '',
    briefingsSection(input.briefings),
    '',
    scansSection(input.scans),
    '',
    "This codebase's real constraints — any suggestion must respect these:",
    input.codebaseConventions,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test -- optimizer-prompt`

- [ ] **Step 5: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add backend/src/optimizer/prompt.ts backend/test/optimizer-prompt.test.ts
git commit -m "feat(optimizer): prompt builder + live CLAUDE.md invariants excerpt

Task 2 of docs/superpowers/plans/2026-08-05-tools-optimizer.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `OptimizerService`

**Files:**
- Create: `backend/src/optimizer/service.ts`
- Test: `backend/test/optimizer-service.test.ts`

Depends on Task 1 (table exists) and Task 2 (`buildOptimizerPrompt`/`readCodebaseConventions`).

- [ ] **Step 1: Write the failing tests**

Read `backend/test/agent-helper.ts`'s `FakeAgentRunner` first (already used by
`decision.test.ts`/research tests — constructor takes `(script, finalText, resultOverrides)`)
and `backend/src/db/connection.ts`/`backend/src/db/migrate.ts` for the `openDb`/`migrate` test
setup pattern every other service test file uses.

```ts
// backend/test/optimizer-service.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { OptimizerService } from '../src/optimizer/service.js';
import { SettingsStore } from '../src/settings/store.js';
import { FakeAgentRunner } from './agent-helper.js';

function seedRound(db: DB, name: string): number {
  const now = new Date().toISOString();
  return Number(
    db.prepare(
      `INSERT INTO rounds (name, status, starting_balance_cents, cash_cents, profit_goal_cents, config_json, created_at, updated_at)
       VALUES (?, 'active', 5000, 5000, 100000, '{}', ?, ?)`,
    ).run(name, now, now).lastInsertRowid,
  );
}

function seedCheckin(db: DB, roundId: number, ts: string): void {
  db.prepare(
    `INSERT INTO checkins (round_id, ts, snapshot_json, actions_json, status, tokens_used, cost_usd)
     VALUES (?, ?, '{}', '[{"tool":"write_journal","args":{},"ok":true,"detail":"ok"}]', 'success', 100, 0.01)`,
  ).run(roundId, ts);
}

describe('OptimizerService', () => {
  let db: DB;
  let settings: SettingsStore;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    settings = new SettingsStore(db);
  });

  it('never throws and records an error row when the runner fails', async () => {
    const failing = new FakeAgentRunner([], '', { status: 'error', subtype: 'error_max_turns' });
    const svc = new OptimizerService({ db, settings }, failing);
    const outcome = await svc.run(false);
    expect(outcome.status).toBe('error');
    const rows = svc.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('error');
  });

  it('records a success row with the runner\'s tokens/cost and output text', async () => {
    const runner = new FakeAgentRunner([], '## Findings\n...\n## Implementation prompt\n...', {
      status: 'success', inputTokens: 400, outputTokens: 100, costUsd: 0.03,
    });
    const svc = new OptimizerService({ db, settings }, runner);
    const outcome = await svc.run(true);
    expect(outcome.status).toBe('success');
    const rows = svc.list();
    expect(rows[0]!.tokens_used).toBe(500);
    expect(rows[0]!.cost_usd).toBeCloseTo(0.03);
    expect(rows[0]!.web_search_enabled).toBe(true);
    expect(rows[0]!.output).toContain('Implementation prompt');
  });

  it('caps input to the most recent 200 check-ins across all rounds', async () => {
    const roundId = seedRound(db, 'round A');
    for (let i = 0; i < 250; i++) {
      seedCheckin(db, roundId, new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60_000).toISOString());
    }
    const runner = new FakeAgentRunner([], 'ok');
    const svc = new OptimizerService({ db, settings }, runner);
    await svc.run(false);
    const sentPrompt = runner.requests[0]!.prompt;
    // The oldest seeded check-in (i=0) must have been excluded by the 200-row cap.
    expect(sentPrompt).not.toContain('2026-01-01T00:00:00.000Z');
    // The most recent one must be present.
    expect(sentPrompt).toContain(new Date(Date.parse('2026-01-01T00:00:00Z') + 249 * 60_000).toISOString());
  });

  it('rejects a second concurrent run while one is in flight', async () => {
    let resolveRun!: () => void;
    const slow = {
      async run() {
        await new Promise<void>((resolve) => { resolveRun = resolve; });
        return { status: 'success' as const, subtype: 'success', text: 'ok', inputTokens: 1, outputTokens: 1, costUsd: 0 };
      },
    };
    const svc = new OptimizerService({ db, settings }, slow);
    const first = svc.run(false);
    const second = await svc.run(false);
    expect(second).toEqual({ status: 'skipped', detail: 'an optimizer run is already in progress' });
    resolveRun();
    await first;
  });

  it('never queries the database when the usage gate blocks the run', async () => {
    const gate = { check: async () => ({ allowed: false, reason: 'session usage at 95%' }) };
    const runner = new FakeAgentRunner([], 'should not be called');
    const svc = new OptimizerService({ db, settings, usageGate: gate as never }, runner);
    const outcome = await svc.run(false);
    expect(outcome).toEqual({ status: 'skipped', detail: 'session usage at 95%' });
    expect(runner.requests).toHaveLength(0);
    expect(svc.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- optimizer-service`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Write `optimizer/service.ts`**

```ts
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { AgentRunner } from '../agent/types.js';
import type { UsageGateService } from '../agent/usage-gate.js';
import type { SettingsStore } from '../settings/store.js';
import { parseActions } from '../analytics/service.js';
import { buildOptimizerPrompt, OPTIMIZER_SYSTEM_PROMPT, readCodebaseConventions } from './prompt.js';

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

const CHECKIN_LIMIT = 200;
const BRIEFING_LIMIT = 50;
const SCAN_LIMIT = 50;
/** Web search means each search is a turn, mirrors ResearchService's RESEARCH_MAX_TURNS. */
const MAX_TURNS_WITH_WEB = 10;
const MAX_TURNS_NO_WEB = 4;

interface CheckinRow { round_name: string; ts: string; status: string; actions_json: string; notes: string[] }

export class OptimizerService {
  private inFlight = false;

  constructor(private deps: OptimizerDeps, private runner: AgentRunner) {}

  async run(webSearch: boolean): Promise<OptimizerOutcome> {
    if (this.inFlight) {
      return { status: 'skipped', detail: 'an optimizer run is already in progress' };
    }
    this.inFlight = true;
    try {
      return await this.runInner(webSearch);
    } finally {
      this.inFlight = false;
    }
  }

  private async runInner(webSearch: boolean): Promise<OptimizerOutcome> {
    const { db, settings } = this.deps;

    if (this.deps.usageGate) {
      const gate = await this.deps.usageGate.check();
      if (!gate.allowed) {
        logEvent(db, 'warn', 'usage_gated', gate.reason!, null);
        return { status: 'skipped', detail: gate.reason! };
      }
    }

    const prompt = buildOptimizerPrompt({
      checkins: this.recentCheckins(),
      briefings: this.recentBriefings(),
      scans: this.recentScans(),
      codebaseConventions: readCodebaseConventions(),
    });

    const model = settings.get('roundDefaults').model;

    try {
      const result = await this.runner.run({
        model,
        systemPrompt: OPTIMIZER_SYSTEM_PROMPT,
        prompt,
        tools: [],
        webTools: webSearch,
        maxTurns: webSearch ? MAX_TURNS_WITH_WEB : MAX_TURNS_NO_WEB,
      });

      const tokens = result.inputTokens + result.outputTokens;
      if (result.status !== 'success' || result.text.trim() === '') {
        return this.record(false, webSearch, `optimizer run failed (${result.subtype})`, '', tokens, result.costUsd);
      }
      return this.record(true, webSearch, `${result.text.trim().split(/\s+/).length} words`, result.text.trim(), tokens, result.costUsd);
    } catch (err) {
      return this.record(false, webSearch, (err as Error).message, '', 0, 0);
    }
  }

  list(limit = 20): OptimizerRunRow[] {
    return this.deps.db
      .prepare(
        `SELECT id, created_at, status, web_search_enabled, output, detail, tokens_used, cost_usd
           FROM optimizer_runs ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => {
        const r = row as Omit<OptimizerRunRow, 'web_search_enabled'> & { web_search_enabled: number };
        return { ...r, web_search_enabled: Boolean(r.web_search_enabled) };
      });
  }

  private record(
    success: boolean, webSearch: boolean, detail: string, output: string, tokens: number, costUsd: number,
  ): OptimizerOutcome {
    const status = success ? 'success' : 'error';
    this.deps.db
      .prepare(
        `INSERT INTO optimizer_runs (created_at, status, web_search_enabled, output, detail, tokens_used, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), status, webSearch ? 1 : 0, output, detail, tokens, costUsd);

    if (success) {
      logEvent(this.deps.db, 'info', 'optimizer_run', `optimizer run complete: ${detail}`, null);
      return { status: 'success', detail };
    }
    logEvent(this.deps.db, 'warn', 'optimizer_run_failed', `optimizer run failed: ${detail}`, null);
    return { status: 'error', detail };
  }

  private recentCheckins(): { roundName: string; ts: string; status: string; actions: string[]; journalNotes: string[] }[] {
    const rows = this.deps.db
      .prepare(
        `SELECT c.id, c.ts, c.status, c.actions_json, r.name AS round_name
           FROM checkins c JOIN rounds r ON r.id = c.round_id
          ORDER BY c.id DESC LIMIT ?`,
      )
      .all(CHECKIN_LIMIT) as { id: number; ts: string; status: string; actions_json: string; round_name: string }[];

    const notesByCheckin = new Map<number, string[]>();
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const notes = this.deps.db
        .prepare(`SELECT checkin_id, note FROM journal_entries WHERE checkin_id IN (${placeholders})`)
        .all(...ids) as { checkin_id: number; note: string }[];
      for (const n of notes) {
        const list = notesByCheckin.get(n.checkin_id) ?? [];
        list.push(n.note);
        notesByCheckin.set(n.checkin_id, list);
      }
    }

    return rows.map((r) => ({
      roundName: r.round_name,
      ts: r.ts,
      status: r.status,
      actions: parseActions(r.actions_json),
      journalNotes: notesByCheckin.get(r.id) ?? [],
    }));
  }

  private recentBriefings(): { roundName: string; createdAt: string; briefing: string }[] {
    const rows = this.deps.db
      .prepare(
        `SELECT b.created_at, b.briefing, r.name AS round_name
           FROM research_briefings b JOIN rounds r ON r.id = b.round_id
          WHERE b.status = 'success'
          ORDER BY b.id DESC LIMIT ?`,
      )
      .all(BRIEFING_LIMIT) as { created_at: string; briefing: string; round_name: string }[];
    return rows.map((r) => ({ roundName: r.round_name, createdAt: r.created_at, briefing: r.briefing }));
  }

  private recentScans(): { roundName: string; createdAt: string; detail: string; added: string[]; removed: string[] }[] {
    const rows = this.deps.db
      .prepare(
        `SELECT s.created_at, s.detail, s.added_json, s.removed_json, r.name AS round_name
           FROM market_scans s JOIN rounds r ON r.id = s.round_id
          ORDER BY s.id DESC LIMIT ?`,
      )
      .all(SCAN_LIMIT) as { created_at: string; detail: string; added_json: string; removed_json: string; round_name: string }[];
    return rows.map((r) => ({
      roundName: r.round_name,
      createdAt: r.created_at,
      detail: r.detail,
      added: JSON.parse(r.added_json) as string[],
      removed: JSON.parse(r.removed_json) as string[],
    }));
  }
}
```

Note `parseActions` is imported from `../analytics/service.js`, where it's already exported
(confirmed by reading that file) — reused, not duplicated.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test -- optimizer-service`

- [ ] **Step 5: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add backend/src/optimizer/service.ts backend/test/optimizer-service.test.ts
git commit -m "feat(optimizer): OptimizerService — cross-round history, usage-gated agent run

Task 3 of docs/superpowers/plans/2026-08-05-tools-optimizer.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Routes + wiring (`api/optimizer-routes.ts`, `app.ts`, `index.ts`, `api-helper.ts`)

**Files:**
- Create: `backend/src/api/optimizer-routes.ts`
- Edit: `backend/src/api/app.ts`
- Edit: `backend/src/index.ts`
- Edit: `backend/test/api-helper.ts`
- Test: `backend/test/api-optimizer.test.ts`

Depends on Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/test/api-optimizer.test.ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp, loginCookie } from './api-helper.js';

describe('optimizer routes', () => {
  it('requires auth', async () => {
    const { app } = createTestApp();
    await request(app).get('/api/optimizer').expect(401);
    await request(app).post('/api/optimizer/run').send({ webSearch: false }).expect(401);
  });

  it('lists runs and triggers a new one', async () => {
    const ctx = createTestApp();
    const cookie = await loginCookie(ctx);

    const empty = await request(ctx.app).get('/api/optimizer').set('Cookie', cookie);
    expect(empty.body).toEqual([]);

    const run = await request(ctx.app).post('/api/optimizer/run').set('Cookie', cookie).send({ webSearch: false });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('success');

    const list = await request(ctx.app).get('/api/optimizer').set('Cookie', cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].web_search_enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- api-optimizer`
Expected: FAIL — `createTestApp` doesn't wire an optimizer service/route yet, 404s.

- [ ] **Step 3: Write `api/optimizer-routes.ts`**

```ts
import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { OptimizerService } from '../optimizer/service.js';
import { requireSession } from './middleware.js';

export function optimizerRoutes(auth: AuthService, optimizer: OptimizerService): Router {
  const router = Router();
  router.use('/api/optimizer', requireSession(auth));

  router.get('/api/optimizer', (_req, res) => {
    res.json(optimizer.list());
  });

  router.post('/api/optimizer/run', async (req, res) => {
    const webSearch = req.body?.webSearch === true;
    res.json(await optimizer.run(webSearch));
  });

  return router;
}
```

- [ ] **Step 4: Wire into `api/app.ts`**

Add the import, add `optimizer: OptimizerService;` to `ApiDeps`, and mount the route:

```ts
import type { OptimizerService } from '../optimizer/service.js';
import { optimizerRoutes } from './optimizer-routes.js';
// ...in ApiDeps interface, alongside marketScan:
  optimizer: OptimizerService;
// ...in buildApp, alongside the marketScanRoutes line:
  app.use(optimizerRoutes(deps.auth, deps.optimizer));
```

- [ ] **Step 5: Wire into `backend/src/index.ts`**

Add the import and construct it alongside `marketScan`, sharing the same `usageGate`:

```ts
import { OptimizerService } from './optimizer/service.js';
// ...after the marketScan construction:
const optimizer = new OptimizerService({ db, settings, usageGate }, runner);
// ...in the buildApp({...}) call, add `optimizer,` alongside `marketScan,`
```

- [ ] **Step 6: Wire into `backend/test/api-helper.ts`**

Add the import, construct an `OptimizerService` with its own `FakeAgentRunner` (same reasoning
comment pattern as `research`/`marketScan` — a check-in-scripted fake would throw if replayed
against a tools-less optimizer run), add `optimizer: OptimizerService;` to `TestCtx`, pass it
into `buildApp`, and return it:

```ts
import { OptimizerService } from '../src/optimizer/service.js';
// ...
export interface TestCtx {
  // ...existing fields...
  optimizer: OptimizerService;
}
// ...in createTestApp(), after marketScan construction:
  // Separate fake runner from research/decision/marketScan (same reasoning as those) —
  // the optimizer offers no tools at all, so a scripted tool-call fake would throw if reused.
  const optimizer = new OptimizerService({ db, settings }, new FakeAgentRunner([], '## Findings\nNothing notable.\n## Implementation prompt\nn/a'));

  const app = buildApp({
    db, auth, settings, rounds, market, decision, history, symbols, analytics, replay, research, marketScan,
    usageGate, candidates: scanCandidates, optimizer,
    cookieSecure: opts.cookieSecure ?? false,
  });
  return {
    app, db, auth, settings, rounds, market, decision, history, symbols, analytics, replay, research, marketScan,
    usageGate, barFetcher, prices, optimizer,
  };
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && npm test -- api-optimizer`

- [ ] **Step 8: Full backend suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: every other API test file that also uses `createTestApp`/`TestCtx` must still pass
unmodified — `optimizer` is purely additive to both.

- [ ] **Step 9: Commit**

```bash
git add backend/src/api/optimizer-routes.ts backend/src/api/app.ts backend/src/index.ts backend/test/api-helper.ts backend/test/api-optimizer.test.ts
git commit -m "feat(optimizer): GET/POST /api/optimizer routes, wire into app + index

Task 4 of docs/superpowers/plans/2026-08-05-tools-optimizer.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend types + hooks

**Files:**
- Edit: `frontend/src/api/types.ts`
- Edit: `frontend/src/api/hooks.ts`

Depends on Task 4 (backend response shape final). No dedicated test file — covered by Task 6's
component test via msw.

- [ ] **Step 1: Add the type to `api/types.ts`**

```ts
export interface OptimizerRun {
  id: number;
  created_at: string;
  status: string;
  web_search_enabled: boolean;
  output: string;
  detail: string;
  tokens_used: number;
  cost_usd: number;
}
```

- [ ] **Step 2: Add hooks to `api/hooks.ts`**

Read the file's existing `qk` query-key factory and `useBriefings`/`useRunResearch` pair first
(they are the exact pattern to mirror) before editing.

```ts
// add to the qk factory object:
  optimizerRuns: ['optimizer', 'runs'] as const,

// add near useBriefings/useRunResearch:
export function useOptimizerRuns(): UseQueryResult<OptimizerRun[]> {
  return useQuery({ queryKey: qk.optimizerRuns, queryFn: () => apiFetch<OptimizerRun[]>('/api/optimizer') });
}

export function useRunOptimizer(): UseMutationResult<{ status: string; detail: string }, Error, { webSearch: boolean }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ status: string; detail: string }>('/api/optimizer/run', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: qk.optimizerRuns }); },
  });
}
```

Import `OptimizerRun` from `./types.js` at the top of the file alongside the other type
imports. Confirm `apiFetch`'s actual signature for a POST body (read an existing mutation like
`useRunResearch` — it likely already handles `JSON.stringify` internally or expects a raw
object; match whatever the real signature is, don't guess).

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean (nothing calls these hooks yet, so this only proves the types/signatures compile).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/hooks.ts
git commit -m "feat(optimizer): frontend OptimizerRun type + useOptimizerRuns/useRunOptimizer hooks

Task 5 of docs/superpowers/plans/2026-08-05-tools-optimizer.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `ToolsPage.tsx` + nav + route

**Files:**
- Create: `frontend/src/pages/ToolsPage.tsx`
- Edit: `frontend/src/shell/AppShell.tsx`
- Edit: `frontend/src/App.tsx`
- Edit: `frontend/test/server.ts` (msw fixture)
- Test: `frontend/test/tools-page.test.tsx`

Depends on Task 5.

- [ ] **Step 1: Add an msw fixture and handler to `frontend/test/server.ts`**

Read the file's existing fixture/handler pattern for `briefingsFixture`/`GET
/api/rounds/:id/briefings` first and mirror it exactly (non-round-scoped, so the handler has
no `:id` param):

```ts
// add near the other fixtures:
export const optimizerRunsFixture: OptimizerRun[] = [
  {
    id: 1, created_at: '2026-08-05T00:00:00.000Z', status: 'success', web_search_enabled: false,
    output: '## Findings\nEvery check-in journals the same phrase when nothing trades.\n\n## Implementation prompt\nAdd a short-circuit...',
    detail: '42 words', tokens_used: 800, cost_usd: 0.02,
  },
];

// add to the handlers array:
  http.get('/api/optimizer', () => HttpResponse.json(optimizerRunsFixture)),
  http.post('/api/optimizer/run', () => HttpResponse.json({ status: 'success', detail: '42 words' })),
```

Import `OptimizerRun` from `../src/api/types` alongside the file's other type imports.

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/test/tools-page.test.tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ToolsPage } from '../src/pages/ToolsPage';
import { renderWithProviders } from './render';
import { optimizerRunsFixture, server } from './server';

describe('ToolsPage', () => {
  it('renders run history from the optimizer', async () => {
    renderWithProviders(<ToolsPage />);
    expect(await screen.findByText(/Every check-in journals the same phrase/)).toBeInTheDocument();
  });

  it('sends the web-search checkbox state when running', async () => {
    let sentBody: unknown;
    server.use(
      http.post('/api/optimizer/run', async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ status: 'success', detail: 'ok' });
      }),
    );
    renderWithProviders(<ToolsPage />);
    await screen.findByText(/Every check-in journals the same phrase/);

    await userEvent.click(screen.getByLabelText(/enable web search/i));
    await userEvent.click(screen.getByRole('button', { name: /run optimizer/i }));

    await waitFor(() => expect(sentBody).toEqual({ webSearch: true }));
  });

  it('shows an empty state with no runs yet', async () => {
    server.use(http.get('/api/optimizer', () => HttpResponse.json([])));
    renderWithProviders(<ToolsPage />);
    expect(await screen.findByText(/no optimizer runs yet/i)).toBeInTheDocument();
  });

  it('renders an error-status run with the loss class', async () => {
    server.use(
      http.get('/api/optimizer', () =>
        HttpResponse.json([{ ...optimizerRunsFixture[0]!, status: 'error', output: '', detail: 'optimizer run failed (error_max_turns)' }]),
      ),
    );
    renderWithProviders(<ToolsPage />);
    const row = await screen.findByText(/optimizer run failed/i);
    expect(row.closest('section')).toHaveClass('loss');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npm test -- tools-page`
Expected: FAIL — `ToolsPage` module does not exist.

- [ ] **Step 4: Write `pages/ToolsPage.tsx`**

Read `pages/round/BriefingsList.tsx` first (the exact pattern to mirror: `Markdown`,
`ErrorBox`, `Spinner`, `formatTs` imports and the section-per-row structure) — write this file
to match its style, not a fresh invention:

```tsx
import { useState } from 'react';
import { useOptimizerRuns, useRunOptimizer } from '../api/hooks';
import { ErrorBox } from '../components/ErrorBox';
import { Markdown } from '../components/Markdown';
import { Spinner } from '../components/Spinner';
import { formatTs } from '../lib/format';

export function ToolsPage() {
  const [webSearch, setWebSearch] = useState(false);
  const runs = useOptimizerRuns();
  const runOptimizer = useRunOptimizer();

  if (runs.isPending) return <Spinner label="Loading tools" />;
  if (runs.error) return <ErrorBox error={runs.error} />;

  const rows = runs.data ?? [];

  return (
    <section className="grid">
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Tools</h1>

      <div className="panel grid" style={{ gap: '0.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Agent optimizer</h2>
        <p className="muted" style={{ margin: 0 }}>
          Reads recent check-ins, research, and market scans across every round, looks for
          repeatable patterns, and writes a prompt you can hand to a Claude Code session to
          implement the change. It never edits the codebase itself.
        </p>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label className="row">
            <input
              type="checkbox"
              checked={webSearch}
              onChange={(e) => setWebSearch(e.target.checked)}
            />
            Enable web search for this run
          </label>
          <button onClick={() => runOptimizer.mutate({ webSearch })} disabled={runOptimizer.isPending}>
            {runOptimizer.isPending ? 'Running…' : 'Run optimizer'}
          </button>
        </div>
        <ErrorBox error={runOptimizer.error} />

        {rows.length === 0 ? (
          <p className="muted">No optimizer runs yet.</p>
        ) : (
          rows.map((row) => (
            <section
              key={row.id}
              className={row.status === 'error' ? 'loss' : undefined}
              style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{formatTs(row.created_at)}</strong>
                <span className="muted" style={{ fontSize: '0.85em' }}>
                  {row.web_search_enabled ? 'web search on' : 'web search off'} ·{' '}
                  {row.tokens_used.toLocaleString('en-AU')} tokens · ${row.cost_usd.toFixed(4)}
                </span>
              </div>
              <div style={{ margin: '0.3rem 0 0' }}>
                {row.status === 'error' ? <p>{row.detail}</p> : <Markdown text={row.output} />}
              </div>
            </section>
          ))
        )}
      </div>
    </section>
  );
}
```

If `Markdown`/`ErrorBox`/`Spinner`/`formatTs`'s real prop names differ from this sketch (verify
by reading them, per the file-read instruction above), match the real signatures — this is a
guide, not gospel.

- [ ] **Step 5: Wire the nav link into `shell/AppShell.tsx`**

```ts
const LINKS = [
  { to: '/rounds', label: 'Rounds' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/markets', label: 'Markets' },
  { to: '/tools', label: 'Tools' },
  { to: '/settings', label: 'Settings' },
];
```

- [ ] **Step 6: Wire the route into `App.tsx`**

Add the import and a route, alongside the existing `/markets`/`/settings` routes:

```tsx
import { ToolsPage } from './pages/ToolsPage';
// ...
            <Route path="/tools" element={<ToolsPage />} />
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npm test -- tools-page`

- [ ] **Step 8: Full frontend suite + typecheck + build**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/ToolsPage.tsx frontend/src/shell/AppShell.tsx frontend/src/App.tsx frontend/test/server.ts frontend/test/tools-page.test.tsx
git commit -m "feat(optimizer): Tools tab — ToolsPage with optimizer run history + trigger

Task 6 of docs/superpowers/plans/2026-08-05-tools-optimizer.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Whole-branch review + merge

- [ ] Re-run both full suites (`cd backend && npm test && npx tsc --noEmit`; `cd frontend &&
  npm test && npx tsc --noEmit && npm run build`) and record the exact new totals (count them,
  don't assume) for the CLAUDE.md update.
- [ ] Confirm `db/migrations.ts` indices 0-5 are byte-identical to `master` (only a new index 6
  element was appended) — `git diff master -- backend/src/db/migrations.ts`.
- [ ] Confirm `agent/runner-options.ts` and `agent/sdk-runner.ts` have an **empty diff** against
  `master` — `git diff master -- backend/src/agent/runner-options.ts backend/src/agent/sdk-runner.ts`
  must return nothing. This is the spec's central claim (existing capability boundary already
  covers this call site) — verify it, don't assume it.
- [ ] Confirm `optimizer/service.ts` and `optimizer-routes.ts` never write to any table other
  than `optimizer_runs` — `grep -rnE "INSERT|UPDATE|DELETE" backend/src/optimizer/` should show
  only the one `INSERT INTO optimizer_runs` in `record()`.
- [ ] Live-verify manually: log into the running app, open the new Tools tab, click "Run
  optimizer" with web search off, confirm a row appears with real token/cost numbers (not
  zeros) and readable markdown output. If the Docker container is the target environment, do
  this against it specifically (rebuild first if needed).
- [ ] Merge `--no-ff` into `master`, re-run both suites post-merge, update CLAUDE.md's "CURRENT
  STATE" section (new test totals, a new numbered plan entry, TODO.md note if this maps to an
  existing backlog item, and a short "how it was built" paragraph following the established
  pattern for prior features — call out the live-CLAUDE.md-excerpt mechanism and the "zero
  changes to runner-options.ts" finding as the two most reusable lessons for the next AI call
  site).
