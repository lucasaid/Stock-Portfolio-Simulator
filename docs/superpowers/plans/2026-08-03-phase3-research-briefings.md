# Phase 3 Research Briefings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the research-briefing slot the check-in snapshot has carried empty since Plan 3 (spec §4.2, §10 phase 3). A separate, budgeted agent run gathers news and sentiment for a round's symbols, stores a compact briefing, and normal check-ins consume it.

**Architecture:** A second kind of agent run. The check-in runner keeps its absolute zero-tool lockdown; the *research* runner — and only it — gets the SDK's built-in `WebSearch` and `WebFetch`. That distinction is a single opt-in flag on the runner contract, so `sdk-runner.ts` stays the one file that touches the SDK. Briefings are stored in a new `research_briefings` table, surfaced in the snapshot builder, scheduled on their own cron, and triggerable by hand.

**Tech Stack:** Unchanged. `@anthropic-ai/claude-agent-sdk` 0.3.x, better-sqlite3, node-cron, vitest + `FakeAgentRunner`; React frontend for the briefings panel.

---

## Prerequisites and key facts

Plans 1–5 and the pre-flight fixes are merged. Read `CLAUDE.md` **Hard-won invariants** first, plus these, which were verified against the installed SDK typings (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) — do not re-derive them from memory:

- **`options.tools`** is `string[] | {type:'preset',preset:'claude_code'}` and selects the *base set of available built-in tools*. `[]` disables all built-ins — that is what the check-in runner passes today, and it must keep passing it.
- **`options.allowedTools`** is a separate list of tools that *execute without asking for approval*. It does not make a tool available; `tools` does. Both are needed: `tools` to enable, `allowedTools` to auto-approve under `permissionMode: 'dontAsk'`.
- The built-in tool names are **`WebSearch`** and **`WebFetch`** (matching `WebSearchInput` / `WebFetchInput` in `sdk-tools.d.ts`).
- **Never add network calls to tests.** Everything is tested against `FakeAgentRunner`; the real web tools are exercised only in the live smoke path.

**Cost is the main risk in this plan.** A research run makes real web searches and can burn far more tokens than a check-in. Every task below caps it: `maxTurns`, one run per cron occurrence, and recorded token/cost figures per briefing so the operator can see the spend.

---

## File structure

**Created:** `backend/src/research/service.ts` (briefing generation + storage), `backend/src/research/prompt.ts` (pure prompt builder), `backend/src/api/research-routes.ts`, `backend/test/research-prompt.test.ts`, `backend/test/research-service.test.ts`, `backend/test/api-research.test.ts`, `frontend/src/pages/round/BriefingsList.tsx`, `frontend/test/briefings.test.tsx`.

**Modified:** `backend/src/db/migrations.ts` (append index 2), `backend/src/agent/types.ts` (`webTools` flag), `backend/src/agent/sdk-runner.ts` (enable the web tools when asked), `backend/src/agent/snapshot.ts` (fill the briefing slot), `backend/src/engine/types.ts` (`researchCron`), `backend/src/settings/store.ts` (default), `backend/src/index.ts` + `backend/src/api/app.ts` + `backend/test/api-helper.ts` (wiring), `frontend/src/api/{types,hooks}.ts`, `frontend/src/pages/RoundDetailPage.tsx`, `frontend/test/server.ts`.

---

## Task 1: Storage and the pure prompt builder

**Files:** modify `backend/src/db/migrations.ts`; create `backend/src/research/prompt.ts`, `backend/test/research-prompt.test.ts`.

- [ ] **Step 1: Write the failing test**

`backend/test/research-prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildResearchPrompt, RESEARCH_SYSTEM_PROMPT } from '../src/research/prompt.js';

describe('buildResearchPrompt', () => {
  const input = {
    roundName: 'first run',
    markets: ['US', 'ASX'] as ('US' | 'ASX')[],
    held: [{ symbol: 'AAPL', quantity: 2 }],
    watchlist: ['AAPL', 'BHP.AX'],
    tradingStyle: 'swing' as const,
    previousBriefing: null,
  };

  it('names every held and watched symbol', () => {
    const prompt = buildResearchPrompt(input);
    expect(prompt).toContain('AAPL');
    expect(prompt).toContain('BHP.AX');
  });

  it('marks which symbols are actually held', () => {
    const prompt = buildResearchPrompt(input);
    expect(prompt).toMatch(/held[\s\S]*AAPL/i);
  });

  it('asks for a compact briefing with a length bound', () => {
    expect(buildResearchPrompt(input)).toMatch(/\b(\d+)\s*words?\b/i);
  });

  it('includes the previous briefing so the agent can report only what changed', () => {
    const prompt = buildResearchPrompt({ ...input, previousBriefing: 'Yesterday: AAPL flat on no news.' });
    expect(prompt).toContain('Yesterday: AAPL flat on no news.');
    expect(prompt).toMatch(/changed|new since/i);
  });

  it('omits the previous-briefing section entirely when there is none', () => {
    expect(buildResearchPrompt(input)).not.toMatch(/previous briefing/i);
  });

  it('handles an empty watchlist without producing a dangling list', () => {
    const prompt = buildResearchPrompt({ ...input, watchlist: [], held: [] });
    expect(prompt).not.toMatch(/:\s*\n\s*\n/);
    expect(prompt).toMatch(/no symbols/i);
  });

  it('tells the agent it is advisory and cannot trade', () => {
    expect(RESEARCH_SYSTEM_PROMPT).toMatch(/cannot (place|make) (any )?trades?|no trading|advisory/i);
  });

  it('forbids invented facts and requires a source per claim', () => {
    expect(RESEARCH_SYSTEM_PROMPT).toMatch(/source/i);
    expect(RESEARCH_SYSTEM_PROMPT).toMatch(/do not (invent|speculate|fabricate)/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npm test -- research-prompt` → FAIL, module not found.

- [ ] **Step 3: Append the migration**

Append a **third** element to the `migrations` array in `backend/src/db/migrations.ts` (indices 0 and 1 stay byte-identical):

```ts
  `
CREATE TABLE research_briefings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  created_at TEXT NOT NULL,
  symbols_json TEXT NOT NULL,
  briefing TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_briefings_round_created ON research_briefings(round_id, created_at);
`,
```

- [ ] **Step 4: Write the prompt builder**

`backend/src/research/prompt.ts`:

```ts
import type { Market, TradingStyle } from '../engine/types.js';

export interface ResearchPromptInput {
  roundName: string;
  markets: Market[];
  held: { symbol: string; quantity: number }[];
  watchlist: string[];
  tradingStyle: TradingStyle;
  /** The last briefing for this round, so the agent can report deltas rather than repeat itself. */
  previousBriefing: string | null;
}

/** Hard bound on the briefing so it stays cheap to carry in every later check-in snapshot. */
export const BRIEFING_MAX_WORDS = 250;

export const RESEARCH_SYSTEM_PROMPT = [
  'You are the research analyst for a small paper-trading agent. You gather information; you do not trade.',
  'You cannot place trades, set stops, or change any configuration — you have no trading tools and your',
  'output is read later by the trading agent as one input among several.',
  '',
  'Use web search and web fetch to find what actually changed. For every claim, name the source',
  '(publication or site) inline. Do not invent, speculate, or pad: if there is no material news for a',
  'symbol, say so in a few words and move on. An honest "nothing material" is more useful than a',
  'paragraph of filler, and the trading agent is instructed to distrust unsourced claims.',
  '',
  'Cover, in this order: company-specific news for held positions, then watchlist symbols, then any',
  'market-wide or macro event that plausibly moves them. Note retail sentiment only where it is loud',
  'enough to matter and label it as sentiment, not fact.',
].join('\n');

export function buildResearchPrompt(input: ResearchPromptInput): string {
  const heldLine =
    input.held.length === 0
      ? 'Currently held: none.'
      : `Currently held: ${input.held.map((p) => `${p.symbol} (${p.quantity})`).join(', ')}.`;

  const heldSymbols = new Set(input.held.map((p) => p.symbol));
  const watching = input.watchlist.filter((s) => !heldSymbols.has(s));
  const watchLine = watching.length === 0 ? 'Also watching: none.' : `Also watching: ${watching.join(', ')}.`;

  const anySymbols = input.held.length > 0 || input.watchlist.length > 0;

  const sections = [
    `Round "${input.roundName}" trades ${input.markets.join(' and ')} in a ${input.tradingStyle} style.`,
    heldLine,
    watchLine,
  ];

  if (!anySymbols) {
    sections.push(
      'There are no symbols on this round yet, so there is nothing company-specific to research.',
      'Give a short market-wide briefing only.',
    );
  }

  if (input.previousBriefing !== null) {
    sections.push(
      'Your previous briefing for this round follows. Report what has changed since it — do not repeat',
      'anything still true and already stated there.',
      '--- previous briefing ---',
      input.previousBriefing,
      '--- end previous briefing ---',
    );
  }

  sections.push(
    `Write the briefing as plain prose, at most ${BRIEFING_MAX_WORDS} words. No preamble, no headings,`,
    'no bullet characters — it is injected verbatim into another agent\'s context.',
  );

  return sections.join('\n');
}
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npm test -- research-prompt && npx tsc --noEmit` → 8 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/migrations.ts backend/src/research/prompt.ts backend/test/research-prompt.test.ts
git commit -m "feat: research briefing storage and pure prompt builder"
```

---

## Task 2: Give the research run web tools — and only that run

This is the security-relevant task. The check-in runner's lockdown must be provably unchanged.

**Files:** modify `backend/src/agent/types.ts`, `backend/src/agent/sdk-runner.ts`, `backend/test/agent-helper.ts`; create `backend/test/sdk-runner-options.test.ts`.

- [ ] **Step 1: Write the failing test**

`sdk-runner.ts` is compile-checked only today because it imports the SDK. Rather than weaken that, extract the options object into a pure exported function and test *that*. Create `backend/test/sdk-runner-options.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildRunnerOptions, SERVER_NAME } from '../src/agent/runner-options.js';

describe('buildRunnerOptions', () => {
  const base = { model: 'claude-sonnet-5', systemPrompt: 'sys', maxTurns: 6 };

  it('disables every built-in tool by default', () => {
    const options = buildRunnerOptions(base);
    expect(options.tools).toEqual([]);
  });

  it('allows only the in-process trading tools by default', () => {
    expect(buildRunnerOptions(base).allowedTools).toEqual([`mcp__${SERVER_NAME}__*`]);
  });

  it('enables web search and fetch only when explicitly asked', () => {
    const options = buildRunnerOptions({ ...base, webTools: true });
    // `tools` is what makes a built-in available at all.
    expect(options.tools).toEqual(['WebSearch', 'WebFetch']);
    // `allowedTools` is what stops it prompting for approval.
    expect(options.allowedTools).toContain('WebSearch');
    expect(options.allowedTools).toContain('WebFetch');
    expect(options.allowedTools).toContain(`mcp__${SERVER_NAME}__*`);
  });

  it('never enables a filesystem or shell tool, even with web tools on', () => {
    const withWeb = buildRunnerOptions({ ...base, webTools: true });
    const names = [...(withWeb.tools as string[]), ...withWeb.allowedTools];
    for (const forbidden of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('keeps the non-negotiable lockdown flags in both modes', () => {
    for (const options of [buildRunnerOptions(base), buildRunnerOptions({ ...base, webTools: true })]) {
      expect(options.permissionMode).toBe('dontAsk');
      expect(options.settingSources).toEqual([]);
    }
  });

  it('strips ANTHROPIC_API_KEY from the child environment', () => {
    const options = buildRunnerOptions({ ...base, env: { ANTHROPIC_API_KEY: 'sk-leak', PATH: '/usr/bin' } });
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env.PATH).toBe('/usr/bin');
  });

  it('defaults maxTurns and lets the caller raise it for research', () => {
    expect(buildRunnerOptions({ ...base, maxTurns: undefined }).maxTurns).toBe(6);
    expect(buildRunnerOptions({ ...base, maxTurns: 10 }).maxTurns).toBe(10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npm test -- sdk-runner-options` → FAIL, module not found.

- [ ] **Step 3: Extend the runner contract**

In `backend/src/agent/types.ts`, add to `AgentRunRequest`:

```ts
  /**
   * Enable the SDK's built-in WebSearch/WebFetch tools for this run only.
   * Check-ins must never set this: the trading agent gets in-process tools only.
   */
  webTools?: boolean;
```

- [ ] **Step 4: Extract the options builder**

Create `backend/src/agent/runner-options.ts` — no SDK import, so it is unit-testable:

```ts
export const SERVER_NAME = 'trading';
const DEFAULT_MAX_TURNS = 6;

/** The built-ins a research run may use. Deliberately excludes every filesystem and shell tool. */
export const RESEARCH_TOOLS = ['WebSearch', 'WebFetch'] as const;

export interface RunnerOptionsInput {
  model: string;
  systemPrompt: string;
  maxTurns?: number;
  webTools?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunnerOptions {
  model: string;
  systemPrompt: string;
  maxTurns: number;
  /** `tools` selects which BUILT-IN tools exist at all; [] means none. */
  tools: string[];
  /** `allowedTools` auto-approves; it does not make a tool available. Both are required. */
  allowedTools: string[];
  permissionMode: 'dontAsk';
  settingSources: never[];
  env: NodeJS.ProcessEnv;
}

/**
 * The single place the agent's capability surface is decided.
 *
 * Two separate SDK options are in play and they are not interchangeable:
 * `tools` is the base set of built-ins that exist for the run, and `allowedTools`
 * is the set that runs without an approval prompt. A built-in listed only in
 * `allowedTools` still does not exist; one listed only in `tools` would block on
 * approval under any permissionMode that prompts.
 */
export function buildRunnerOptions(input: RunnerOptionsInput): RunnerOptions {
  const builtins = input.webTools === true ? [...RESEARCH_TOOLS] : [];
  return {
    model: input.model,
    systemPrompt: input.systemPrompt,
    maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
    tools: builtins,
    allowedTools: [`mcp__${SERVER_NAME}__*`, ...builtins],
    permissionMode: 'dontAsk',
    settingSources: [],
    // A stray host API key would outrank the proxy token — never inherit it.
    env: { ...(input.env ?? process.env), ANTHROPIC_API_KEY: undefined },
  };
}
```

- [ ] **Step 5: Use it from the SDK runner**

Rewrite the options block in `backend/src/agent/sdk-runner.ts` to delegate. The `query({ prompt, options })` call keeps its shape; only the options object changes:

```ts
import { buildRunnerOptions, SERVER_NAME } from './runner-options.js';
```

```ts
    for await (const message of query({
      prompt: request.prompt,
      options: {
        ...buildRunnerOptions({
          model: request.model,
          systemPrompt: request.systemPrompt,
          maxTurns: request.maxTurns,
          webTools: request.webTools,
        }),
        mcpServers: { [SERVER_NAME]: server },
      },
    })) {
```

Delete the now-duplicated `SERVER_NAME` / `DEFAULT_MAX_TURNS` constants from `sdk-runner.ts` and import them instead.

- [ ] **Step 6: Record the flag on the fake runner**

`FakeAgentRunner` in `backend/test/agent-helper.ts` already stores `requests`. Confirm the stored request retains `webTools` (it stores the whole object, so this should need no change) — add an assertion in Task 3's tests rather than changing the helper.

- [ ] **Step 7: Run everything**

Run: `cd backend && npm test && npx tsc --noEmit && npm run build`
Expected: 7 new tests pass, existing suites unchanged. **`sdk-runner.ts` must still compile** — the build is the only check on it.

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent backend/test/sdk-runner-options.test.ts
git commit -m "feat: opt-in web tools for research runs, extracted runner options"
```

---

## Task 3: The research service

**Files:** create `backend/src/research/service.ts`, `backend/test/research-service.test.ts`; modify `backend/src/engine/types.ts`, `backend/src/settings/store.ts`.

- [ ] **Step 1: Write the failing test**

`backend/test/research-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { ResearchService } from '../src/research/service.js';
import { RoundService } from '../src/rounds/service.js';
import { FakeAgentRunner } from './agent-helper.js';

function config(over: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'research round',
    startingBalanceCents: cents(50),
    profitGoalCents: cents(1000),
    markets: ['US'],
    watchlist: ['AAPL'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS,
    fees: DEFAULT_FEES,
    model: 'claude-sonnet-5',
    checkinCron: ['30 23 * * 1-5'],
    researchCron: ['0 7 * * 1-5'],
    ...over,
  };
}

describe('ResearchService', () => {
  let db: DB;
  let rounds: RoundService;
  let id: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    id = rounds.create(config());
  });

  it('stores a briefing and reports success', async () => {
    const runner = new FakeAgentRunner([], 'AAPL: nothing material (Reuters).');
    const service = new ResearchService({ db, rounds }, runner);

    const outcome = await service.runBriefing(id);

    expect(outcome.status).toBe('success');
    const row = db.prepare('SELECT * FROM research_briefings WHERE round_id = ?').get(id) as {
      briefing: string; status: string; symbols_json: string;
    };
    expect(row.briefing).toBe('AAPL: nothing material (Reuters).');
    expect(row.status).toBe('success');
    expect(JSON.parse(row.symbols_json)).toContain('AAPL');
  });

  it('requests the web tools and a raised turn budget', async () => {
    const runner = new FakeAgentRunner([], 'ok');
    await new ResearchService({ db, rounds }, runner).runBriefing(id);

    const request = runner.requests[0]!;
    expect(request.webTools).toBe(true);
    expect(request.tools).toHaveLength(0); // no in-process trading tools for research
    expect(request.maxTurns).toBeGreaterThan(6);
  });

  it('records token spend and cost so the operator can see it', async () => {
    const runner = new FakeAgentRunner([], 'ok');
    await new ResearchService({ db, rounds }, runner).runBriefing(id);

    const row = db.prepare('SELECT tokens_used, cost_usd FROM research_briefings WHERE round_id = ?').get(id) as {
      tokens_used: number; cost_usd: number;
    };
    expect(row.tokens_used).toBeGreaterThanOrEqual(0);
    expect(row.cost_usd).toBeGreaterThanOrEqual(0);
  });

  it('feeds the previous briefing back in so the agent reports deltas', async () => {
    const runner = new FakeAgentRunner([], 'first briefing');
    const service = new ResearchService({ db, rounds }, runner);
    await service.runBriefing(id);
    await service.runBriefing(id);

    expect(runner.requests[1]!.prompt).toContain('first briefing');
  });

  it('records a failed run instead of throwing', async () => {
    const runner = { run: async () => { throw new Error('search unavailable'); } };
    const outcome = await new ResearchService({ db, rounds }, runner).runBriefing(id);

    expect(outcome.status).toBe('error');
    const row = db.prepare('SELECT status, briefing FROM research_briefings WHERE round_id = ?').get(id) as {
      status: string; briefing: string;
    };
    expect(row.status).toBe('error');
    expect(row.briefing).toContain('search unavailable');
    const events = db.prepare("SELECT kind FROM event_log WHERE round_id = ? AND kind = 'research_failed'").all(id);
    expect(events).toHaveLength(1);
  });

  it('does not store an empty briefing as a success', async () => {
    const runner = new FakeAgentRunner([], '   ');
    const outcome = await new ResearchService({ db, rounds }, runner).runBriefing(id);
    expect(outcome.status).toBe('error');
  });

  it('skips terminal rounds without spending a token', async () => {
    const runner = new FakeAgentRunner([], 'should not run');
    rounds.setStatus(id, 'archived', 'test');

    const outcome = await new ResearchService({ db, rounds }, runner).runBriefing(id);

    expect(outcome.status).toBe('skipped');
    expect(runner.requests).toHaveLength(0);
  });

  it('latestBriefing returns only a recent successful one', async () => {
    const service = new ResearchService({ db, rounds }, new FakeAgentRunner([], 'fresh'));
    await service.runBriefing(id);

    expect(service.latestBriefing(id)?.briefing).toBe('fresh');
    // Age it past the freshness window.
    db.prepare("UPDATE research_briefings SET created_at = '2020-01-01T00:00:00.000Z' WHERE round_id = ?").run(id);
    expect(service.latestBriefing(id)).toBeNull();
  });

  it('truncates an over-long briefing rather than carrying it into every snapshot', async () => {
    const long = 'word '.repeat(1000);
    const service = new ResearchService({ db, rounds }, new FakeAgentRunner([], long));
    await service.runBriefing(id);

    const row = db.prepare('SELECT briefing FROM research_briefings WHERE round_id = ?').get(id) as { briefing: string };
    expect(row.briefing.split(/\s+/).length).toBeLessThanOrEqual(300);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npm test -- research-service` → FAIL.

- [ ] **Step 3: Add the config field**

`backend/src/engine/types.ts` — add to `RoundConfig` (surgical edit to a hardened file):

```ts
  /** Cron expressions for the research pass (spec §10 phase 3). Empty disables research. */
  researchCron: string[];
```

`backend/src/settings/store.ts` — add to `roundDefaults`, after `checkinCron`:

```ts
    researchCron: ['0 7 * * 1-5'], // Sydney weekday morning, before the ASX open
```

Existing rounds have no `researchCron` in their stored `config_json`; every read site must treat `undefined` as "no research". The service does this with `?? []`.

- [ ] **Step 4: Write the service**

`backend/src/research/service.ts`:

```ts
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { AgentRunner } from '../agent/types.js';
import type { RoundService } from '../rounds/service.js';
import { buildResearchPrompt, BRIEFING_MAX_WORDS, RESEARCH_SYSTEM_PROMPT } from './prompt.js';

export interface ResearchDeps {
  db: DB;
  rounds: RoundService;
}

export interface ResearchOutcome {
  status: 'success' | 'error' | 'skipped';
  detail: string;
}

export interface BriefingRow {
  id: number;
  created_at: string;
  briefing: string;
  status: string;
  tokens_used: number;
  cost_usd: number;
}

/** Research needs more turns than a check-in: each search is a turn. */
const RESEARCH_MAX_TURNS = 10;
/** A briefing older than this is stale context, not intelligence. */
const FRESHNESS_MS = 36 * 3_600_000;
/** Belt-and-braces cap in case the model ignores the word bound in the prompt. */
const HARD_WORD_CAP = 300;
const TERMINAL = ['goal_reached', 'busted', 'archived'];

function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(' ')}…`;
}

/**
 * Spec §10 phase 3: a separate, budgeted agent run that fills the research
 * briefing slot in the check-in snapshot. It is the ONLY run that gets web
 * access, and it has no trading tools at all.
 */
export class ResearchService {
  constructor(private deps: ResearchDeps, private runner: AgentRunner) {}

  async runBriefing(roundId: number): Promise<ResearchOutcome> {
    const { db, rounds } = this.deps;
    const round = rounds.get(roundId);
    if (TERMINAL.includes(round.status)) {
      return { status: 'skipped', detail: `round is ${round.status}` };
    }

    const config = rounds.config(roundId);
    const positions = rounds.openPositions(roundId);
    const symbols = [...new Set([...positions.map((p) => p.symbol), ...config.watchlist])];
    const previous = this.latestBriefing(roundId);

    const prompt = buildResearchPrompt({
      roundName: config.name,
      markets: config.markets,
      held: positions.map((p) => ({ symbol: p.symbol, quantity: p.quantity })),
      watchlist: config.watchlist,
      tradingStyle: config.tradingStyle,
      previousBriefing: previous?.briefing ?? null,
    });

    try {
      const result = await this.runner.run({
        model: config.model,
        systemPrompt: RESEARCH_SYSTEM_PROMPT,
        prompt,
        tools: [], // research has NO trading tools — it only reads the web
        webTools: true,
        maxTurns: RESEARCH_MAX_TURNS,
      });

      const text = result.text.trim();
      if (result.status !== 'success' || text === '') {
        return this.record(roundId, symbols, 'error', `empty or failed research run (${result.subtype})`, result.inputTokens + result.outputTokens, result.costUsd);
      }

      return this.record(
        roundId, symbols, 'success', clampWords(text, HARD_WORD_CAP),
        result.inputTokens + result.outputTokens, result.costUsd,
      );
    } catch (err) {
      return this.record(roundId, symbols, 'error', (err as Error).message, 0, 0);
    }
  }

  /** Most recent successful briefing, if it is still fresh enough to be worth showing the agent. */
  latestBriefing(roundId: number, now = new Date()): BriefingRow | null {
    const row = this.deps.db
      .prepare(
        `SELECT id, created_at, briefing, status, tokens_used, cost_usd
           FROM research_briefings WHERE round_id = ? AND status = 'success'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(roundId) as BriefingRow | undefined;
    if (!row) return null;
    return now.getTime() - Date.parse(row.created_at) <= FRESHNESS_MS ? row : null;
  }

  list(roundId: number, limit = 50): BriefingRow[] {
    return this.deps.db
      .prepare(
        `SELECT id, created_at, briefing, status, tokens_used, cost_usd
           FROM research_briefings WHERE round_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(roundId, limit) as BriefingRow[];
  }

  private record(
    roundId: number, symbols: string[], status: 'success' | 'error',
    briefing: string, tokens: number, costUsd: number,
  ): ResearchOutcome {
    this.deps.db
      .prepare(
        `INSERT INTO research_briefings (round_id, created_at, symbols_json, briefing, status, tokens_used, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(roundId, new Date().toISOString(), JSON.stringify(symbols), briefing, status, tokens, costUsd);

    if (status === 'error') {
      logEvent(this.deps.db, 'warn', 'research_failed', `round ${roundId} research failed: ${briefing}`, roundId);
      return { status: 'error', detail: briefing };
    }
    logEvent(
      this.deps.db, 'info', 'research',
      `round ${roundId} research briefing ready (${tokens} tokens, $${costUsd.toFixed(4)})`, roundId,
    );
    return { status: 'success', detail: `${briefing.split(/\s+/).length} words` };
  }
}

export { BRIEFING_MAX_WORDS };
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: 9 new tests pass. Other suites may need `researchCron` added to their `RoundConfig` fixtures — that is a mechanical fix; report it as a sanctioned deviation.

- [ ] **Step 6: Commit**

```bash
git add backend/src backend/test
git commit -m "feat: research service - budgeted web-enabled briefing runs"
```

---

## Task 4: Feed briefings into check-ins, schedule them, expose them

**Files:** modify `backend/src/agent/snapshot.ts`, `backend/src/agent/checkin-scheduler.ts` (or add `research-scheduler.ts`), `backend/src/index.ts`, `backend/src/api/app.ts`, `backend/test/api-helper.ts`; create `backend/src/api/research-routes.ts`, `backend/test/api-research.test.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/snapshot.test.ts` (read the file first and mirror its existing fixture style):

```ts
  it('fills the research briefing slot when a fresh briefing exists', () => {
    // Insert a successful briefing for the round, then build the snapshot.
    // Expect the snapshot text/object to contain the briefing prose.
  });

  it('says so plainly when there is no briefing rather than omitting the slot', () => {
    // Expect a "no research briefing" marker so the agent knows the slot exists and is empty.
  });

  it('ignores a stale briefing', () => {
    // Age the row past the freshness window; expect the empty-slot marker.
  });
```

Write these out fully against the real snapshot builder — read `backend/src/agent/snapshot.ts` first and match how it returns the snapshot (object vs string) before writing assertions.

`backend/test/api-research.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('research API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let roundId: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const created = await request(ctx.app).post('/api/rounds').set('Cookie', cookie)
      .send({ name: 'research', startingBalanceCents: cents(50), profitGoalCents: cents(100) });
    roundId = created.body.id as number;
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get(`/api/rounds/${roundId}/briefings`)).status).toBe(401);
    expect((await request(ctx.app).post(`/api/rounds/${roundId}/research`)).status).toBe(401);
  });

  it('lists briefings, newest first', async () => {
    await request(ctx.app).post(`/api/rounds/${roundId}/research`).set('Cookie', cookie);
    const res = await request(ctx.app).get(`/api/rounds/${roundId}/briefings`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ status: 'success', briefing: expect.any(String) });
  });

  it('runs a briefing on demand', async () => {
    const res = await request(ctx.app).post(`/api/rounds/${roundId}/research`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('404s for an unknown round', async () => {
    expect((await request(ctx.app).get('/api/rounds/9999/briefings').set('Cookie', cookie)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test -- api-research snapshot` → FAIL.

- [ ] **Step 3: Fill the snapshot slot**

Read `backend/src/agent/snapshot.ts`. It already assembles the check-in context and leaves the briefing slot empty (spec §4.2). Add an optional `researchBriefing: string | null` input threaded from `DecisionService`, and render it as:

```
Research briefing (gathered <relative time> ago):
<briefing prose>
```

or, when absent:

```
Research briefing: none available for this check-in.
```

Make the empty case explicit — an omitted section reads to the agent as "this does not exist", whereas an explicit "none" reads as "nothing was found", which is the truth. In `DecisionService`, pass `research.latestBriefing(roundId)?.briefing ?? null`; that means `DecisionService` gains an optional `research?: ResearchService` dependency — optional so existing tests keep compiling.

- [ ] **Step 4: Schedule research**

`backend/src/agent/checkin-scheduler.ts` matches cron occurrences against `config.checkinCron`. Add a sibling `startResearchScheduler(db, research)` in `backend/src/research/scheduler.ts` that does the same against `config.researchCron ?? []`. Reuse the existing cron-matching helper rather than duplicating it — extract it if it is currently inline, and note that extraction as a sanctioned deviation.

The same catch-up-coalescing behaviour as check-ins applies and is deliberate (one run after a laptop wake, not five).

- [ ] **Step 5: Routes and wiring**

`backend/src/api/research-routes.ts` — two routes, both session-gated, mirroring `agent-routes.ts`:

```ts
router.get('/api/rounds/:id/briefings', ...)   // research.list(id)
router.post('/api/rounds/:id/research', ...)   // await research.runBriefing(id)
```

Add `research: ResearchService` to `ApiDeps`, mount the router, construct it in `index.ts` (`new ResearchService({ db, rounds }, runner)` — the same `SdkAgentRunner` instance), start the scheduler, and add it to `api-helper.ts` so every API test still compiles.

- [ ] **Step 6: Run everything**

Run: `cd backend && npm test && npx tsc --noEmit && npm run build`

- [ ] **Step 7: Commit**

```bash
git add backend/src backend/test
git commit -m "feat: briefings in the check-in snapshot, research scheduler and routes"
```

---

## Task 5: Briefings in the UI

**Files:** create `frontend/src/pages/round/BriefingsList.tsx`, `frontend/test/briefings.test.tsx`; modify `frontend/src/api/types.ts`, `frontend/src/api/hooks.ts`, `frontend/src/pages/RoundDetailPage.tsx`, `frontend/test/server.ts`.

- [ ] **Step 1: Write the failing test**

`frontend/test/briefings.test.tsx` — render `<BriefingsList roundId={1} />` and assert:

1. Each briefing renders its prose and its relative timestamp.
2. Token spend and cost are shown per briefing (this is the operator's cost signal).
3. A failed briefing renders with the `loss` class and its error text.
4. "Research now" posts to `/api/rounds/1/research` and disables while pending.
5. The empty state reads "No research briefings yet."
6. A load error surfaces via `role="alert"`.

Add fixtures + handlers to `frontend/test/server.ts` (`GET /api/rounds/:id/briefings`, `POST /api/rounds/:id/research`) in the base `handlers` array — **not** via `server.use()` at module scope, which `resetHandlers()` would strip.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- briefings` → FAIL.

- [ ] **Step 3: Types, hooks, component, tab**

Add `BriefingRow` to `src/api/types.ts`; `useBriefings(id)` and `useRunResearch(id)` to `src/api/hooks.ts` with keys `qk.briefings(id)` in the factory (the mutation invalidates `qk.briefings(id)` and `qk.round(id)`). Build `BriefingsList` in the established style — `Spinner` / `ErrorBox` / `formatTs`, table or list, no inline query keys. Add a `'research'` tab to `RoundDetailPage`'s `TABS` and render it.

- [ ] **Step 4: Run everything**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`

- [ ] **Step 5: Commit**

```bash
git add frontend/
git commit -m "feat: research briefings panel on the round detail page"
```

---

## Task 6: Review, docs, merge

- [ ] **Step 1: Full suites**

```bash
cd backend && npm test && npx tsc --noEmit && npm run build
cd ../frontend && npm test && npx tsc --noEmit && npm run build
```

- [ ] **Step 2: Whole-branch review**

Two stages, spec-compliance then code-quality. Priorities:

1. **The capability boundary.** Confirm `buildRunnerOptions` is the only place `tools`/`allowedTools` are set, that a check-in run cannot reach a web tool, and that no filesystem or shell tool appears in either list in either mode. This is the security-relevant change in the plan.
2. **`ANTHROPIC_API_KEY` is still stripped** in both modes.
3. **`migrations.ts`** indices 0 and 1 byte-identical to master.
4. **Cost controls** — `RESEARCH_MAX_TURNS`, the word cap, and per-briefing token/cost recording all present; no path runs research more than once per cron occurrence.
5. **Old rounds** — a `config_json` without `researchCron` must read as "no research", never crash.
6. **Prompt-injection surface.** The briefing is fetched web content that lands in the trading agent's context. Confirm the snapshot renders it as clearly-delimited untrusted input and that the check-in system prompt tells the agent the briefing is advisory and may be wrong. **Flag anything that lets briefing text read as an instruction rather than data.**

- [ ] **Step 3: Update CLAUDE.md**

Record: the new `research/` module and `research_briefings` table (schema v3, 18 tables); `researchCron` on `RoundConfig`; and a new hard-won invariant —

> **Only the research run gets web tools.** `buildRunnerOptions` is the single place the agent capability surface is set: `tools` enables built-ins (`[]` for check-ins), `allowedTools` auto-approves. A check-in must never pass `webTools: true`. Research has no trading tools at all, and the briefing it produces is untrusted web content — the snapshot must render it as delimited data, never as instructions.

Move spec phase 3 from "not yet done" to done, and note that the briefing slot in §4.2 is now filled.

- [ ] **Step 4: Merge**

```bash
git checkout master
git merge --no-ff feature/research -m "Merge Plan 6: research briefings (reviewed)"
```
