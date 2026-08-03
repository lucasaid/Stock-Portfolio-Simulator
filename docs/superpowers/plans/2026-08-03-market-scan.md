# Market-Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TODO.md item 3 — "watch the full market when the round tracks no symbols." A per-round
`autoWatchlist` flag lets the agent manage its own watchlist: on, it scans at creation and weekly,
free to add and remove symbols; off, it adheres strictly to the operator's symbols; off with an
empty watchlist, it gets exactly one bootstrap scan at creation, then stays frozen. Design was
agreed with the user in the Phase 3 session — see CLAUDE.md "Decisions made this session" for the
full rationale — but deliberately kept out of the `feature/research` branch to keep that branch
scoped to spec §10 phase 3.

**Architecture:** A third kind of budgeted agent run, sibling to `ResearchService`, reusing the
exact same capability boundary (`agent/runner-options.ts`'s `webTools: true`, no trading tools).
Where research free-writes prose, a scan run must return a strict, machine-checked list of
symbols — so its prompt asks for one fenced JSON object, and its output goes through three layers
of defence before it can touch a round's watchlist: (1) the system prompt forbids picking outside
the given candidate list, (2) the service throws away anything not in the candidate list or
already held, (3) every survivor must return a live quote before it lands. The candidate list
itself is a cheap, deterministic Yahoo screener pull (most-actives + day-gainers) — the scan is
never given a blank-page "what's good right now?" prompt. Scheduling is NOT cron-based (unlike
check-ins and research): it is a fixed rule — weekly for `autoWatchlist: true`, exactly once for
the empty-watchlist bootstrap case — evaluated on the same kind of minute-tick used elsewhere.

**Tech Stack:** Unchanged. `yahoo-finance2` v4's `screener()` module (`most_actives` /
`day_gainers`, region-scoped) for the candidate pull; `@anthropic-ai/claude-agent-sdk` 0.3.x via
the existing research-style runner; vitest + `FakeAgentRunner`; React frontend panel.

---

## Prerequisites and key facts

Plans 1–6, the `ux-fixes` branch, and Phase 3 (research briefings) are merged to `master`. Read
CLAUDE.md **Hard-won invariants** and **Research invariants** first — this plan extends the same
capability boundary rather than inventing a new one.

- **`buildRunnerOptions`** (`backend/src/agent/runner-options.ts`) is the single place `tools`
  (what exists) and `allowedTools` (what auto-approves) are set. A scan run passes `webTools: true`
  and `tools: []` on its `AgentRunRequest` — no trading tools, exactly like research.
- **`yahoo-finance2`'s `screener()`** takes `{ scrIds, region, count }`. Verified locally against
  the installed package: `scrIds` includes `'most_actives'` and `'day_gainers'`; `region` accepts
  `'US'` and (for ASX) `'AU'`. **Verify the AU region actually returns `.AX`-suffixed symbols as
  part of Task 1** — if it does not, the market filter in Task 2 (Defence 2) silently drops those
  candidates rather than corrupting anything, but the ASX candidate pool would be empty and needs
  a fallback noted as a sanctioned deviation.
- **Money/watchlist boundary:** this plan never touches cash, positions, orders, or trades — it
  only ever rewrites `rounds.config_json`'s `watchlist` field, the same field the existing
  `update_watchlist` agent tool (`agent/tools.ts:102-121`) and the config-PATCH route
  (`api/rounds-routes.ts:179`) already write via a direct `UPDATE ... SET config_json`. Follow
  that exact established pattern — it is a **sanctioned existing pattern, not a new deviation**
  (see CLAUDE.md's Plan 3 carried-over note about `set_stop_loss` for the analogous precedent).
  Do **not** add a new method to `rounds/service.ts` — it is a hardened file; this feature does
  not need to touch it.
- **Never add network calls to tests.** Everything is tested against `FakeAgentRunner` and a fake
  `CandidateFetcher`/`QuoteFetcher`; the real Yahoo screener and web tools are exercised only in
  the live smoke path.

---

## File structure

**Created:** `backend/src/market/candidates.ts` (Yahoo screener candidate fetcher),
`backend/src/market-scan/prompt.ts` (pure prompt builder + response parser),
`backend/src/market-scan/service.ts` (`MarketScanService`),
`backend/src/market-scan/scheduler.ts` (due-scan gating + scheduler),
`backend/src/api/market-scan-routes.ts`,
`backend/test/market-scan-prompt.test.ts`, `backend/test/market-scan-service.test.ts`,
`backend/test/market-scan-scheduler.test.ts`, `backend/test/api-market-scan.test.ts`,
`frontend/src/pages/round/ScansPanel.tsx`, `frontend/test/scans.test.tsx`.

**Modified:** `backend/src/db/migrations.ts` (append index 3), `backend/src/engine/types.ts`
(`autoWatchlist` field), `backend/src/settings/store.ts` (default), `backend/src/index.ts` +
`backend/src/api/app.ts` + `backend/test/api-helper.ts` (wiring), `backend/src/api/rounds-routes.ts`
(`autoWatchlist` in `CREATE_KEYS`/`PATCHABLE`), `frontend/src/api/{types,hooks}.ts`,
`frontend/src/pages/{NewRoundPage,round/ConfigPanel,RoundDetailPage}.tsx`, `frontend/test/server.ts`.

---

## Task 1: Storage, config field, and the candidate fetcher

**Files:** modify `backend/src/db/migrations.ts`, `backend/src/engine/types.ts`,
`backend/src/settings/store.ts`; create `backend/src/market/candidates.ts`.

- [ ] **Step 1: Append the migration**

Append a **fourth** element to the `migrations` array in `backend/src/db/migrations.ts` (indices
0-2 stay byte-identical — this becomes the 19th table):

```sql
CREATE TABLE market_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  watchlist_json TEXT,
  added_json TEXT NOT NULL,
  removed_json TEXT NOT NULL,
  detail TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_market_scans_round_created ON market_scans(round_id, created_at);
```

- [ ] **Step 2: Add the config field**

`backend/src/engine/types.ts` — surgical edit to a hardened file (same precedent as `researchCron`
in Phase 3), add to `RoundConfig` after `researchCron`:

```ts
  /** When true, the agent manages its own watchlist via scheduled market scans (TODO.md item 3). */
  autoWatchlist: boolean;
```

`backend/src/settings/store.ts` — add to `roundDefaults`, after `researchCron`:

```ts
    autoWatchlist: false,
```

Existing rounds have no `autoWatchlist` in stored `config_json`; every read site must treat
`undefined` as `false` (`config.autoWatchlist === true` checks, never a bare truthy check that
would also pass on `undefined`... actually `undefined === true` is `false`, so a plain `===`
check is already safe — use that form everywhere, not `??`).

- [ ] **Step 3: Write the candidate fetcher**

`backend/src/market/candidates.ts`:

```ts
import YahooFinance from 'yahoo-finance2';
import type { Market } from '../engine/types.js';

export interface ScanCandidate {
  symbol: string;
  name?: string;
  changePct?: number;
}

/** Cheap, deterministic grounding for the scan prompt — never a blank-page "what's good?" ask. */
export type CandidateFetcher = (market: Market) => Promise<ScanCandidate[]>;

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export const yahooCandidateFetcher: CandidateFetcher = async (market) => {
  const region = market === 'ASX' ? 'AU' : 'US';
  const [actives, gainers] = await Promise.all([
    yahooFinance.screener({ scrIds: 'most_actives', region, count: 15 }),
    yahooFinance.screener({ scrIds: 'day_gainers', region, count: 15 }),
  ]);
  const seen = new Map<string, ScanCandidate>();
  for (const q of [...actives.quotes, ...gainers.quotes]) {
    if (q.symbol && !seen.has(q.symbol)) {
      seen.set(q.symbol, {
        symbol: q.symbol,
        name: q.longName ?? q.shortName,
        changePct: q.regularMarketChangePercent,
      });
    }
  }
  return [...seen.values()];
};
```

- [ ] **Step 4: Manually verify the ASX region call**

Run a one-off script (not committed) against the real Yahoo endpoint:

```bash
cd backend && node -e "
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({suppressNotices:['yahooSurvey']});
yf.screener({ scrIds: 'most_actives', region: 'AU', count: 5 }).then(r =>
  console.log(r.quotes.map(q => q.symbol)));
"
```

If the returned symbols are **not** `.AX`-suffixed, record that as a sanctioned deviation and
note it in Task 6's CLAUDE.md update — Defence 2 in Task 2 (market filter) already makes this a
silent no-candidates-for-ASX outcome rather than a correctness bug, so it does not block this
task, but it does mean ASX rounds would never get real candidates until fixed.

- [ ] **Step 5: Typecheck**

Run: `cd backend && npx tsc --noEmit` (no new tests yet — `candidates.ts` is exercised indirectly
via a fake `CandidateFetcher` in Task 2's tests, matching how `market/yahoo.ts` is never
unit-tested directly).

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/migrations.ts backend/src/engine/types.ts backend/src/settings/store.ts backend/src/market/candidates.ts
git commit -m "feat: market-scan storage, config flag, and Yahoo candidate fetcher"
```

---

## Task 2: The pure prompt builder and response parser

**Files:** create `backend/src/market-scan/prompt.ts`, `backend/test/market-scan-prompt.test.ts`.

- [ ] **Step 1: Write the failing test**

`backend/test/market-scan-prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildScanPrompt, parseScanResponse, SCAN_SYSTEM_PROMPT } from '../src/market-scan/prompt.js';

const candidates = [
  { symbol: 'AAPL', name: 'Apple Inc.', changePct: 2.1 },
  { symbol: 'NVDA', name: 'NVIDIA Corp', changePct: -1.4 },
];

describe('buildScanPrompt', () => {
  it('lists every candidate symbol', () => {
    const prompt = buildScanPrompt({
      roundName: 'r', markets: ['US'], tradingStyle: 'swing', mode: 'bootstrap',
      held: [], currentWatchlist: [], candidates,
    });
    expect(prompt).toContain('AAPL');
    expect(prompt).toContain('NVDA');
  });

  it('bootstrap mode asks for a one-time, small starter set', () => {
    const prompt = buildScanPrompt({
      roundName: 'r', markets: ['US'], tradingStyle: 'swing', mode: 'bootstrap',
      held: [], currentWatchlist: [], candidates,
    });
    expect(prompt).toMatch(/one-time|no further scans/i);
  });

  it('manage mode shows the current watchlist and allows dropping names', () => {
    const prompt = buildScanPrompt({
      roundName: 'r', markets: ['US'], tradingStyle: 'swing', mode: 'manage',
      held: ['AAPL'], currentWatchlist: ['AAPL', 'MSFT'], candidates,
    });
    expect(prompt).toContain('MSFT');
    expect(prompt).toMatch(/drop|remove/i);
  });

  it('names held positions so they are not silently dropped', () => {
    const prompt = buildScanPrompt({
      roundName: 'r', markets: ['US'], tradingStyle: 'swing', mode: 'manage',
      held: ['AAPL'], currentWatchlist: [], candidates,
    });
    expect(prompt).toMatch(/held[\s\S]*AAPL/i);
  });
});

describe('SCAN_SYSTEM_PROMPT', () => {
  it('forbids picking outside the candidate list', () => {
    expect(SCAN_SYSTEM_PROMPT).toMatch(/only.*candidate list|candidate list.*only/i);
  });
  it('is advisory and asks for JSON-only output', () => {
    expect(SCAN_SYSTEM_PROMPT).toMatch(/do not trade|cannot trade/i);
    expect(SCAN_SYSTEM_PROMPT).toMatch(/json/i);
  });
});

describe('parseScanResponse', () => {
  it('parses a bare JSON object', () => {
    expect(parseScanResponse('{"watchlist": ["AAPL", "msft"]}')).toEqual({ watchlist: ['AAPL', 'MSFT'] });
  });

  it('parses JSON wrapped in a fenced code block with surrounding prose', () => {
    const text = 'Here is my pick:\n```json\n{"watchlist": ["BHP.AX"]}\n```\nDone.';
    expect(parseScanResponse(text)).toEqual({ watchlist: ['BHP.AX'] });
  });

  it('returns null for prose with no JSON', () => {
    expect(parseScanResponse('I could not decide.')).toBeNull();
  });

  it('returns null when watchlist is missing or not a string array', () => {
    expect(parseScanResponse('{"symbols": ["AAPL"]}')).toBeNull();
    expect(parseScanResponse('{"watchlist": "AAPL"}')).toBeNull();
    expect(parseScanResponse('{"watchlist": [1, 2]}')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(parseScanResponse('{"watchlist": [')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npm test -- market-scan-prompt` → FAIL, module not found.

- [ ] **Step 3: Write the prompt builder and parser**

`backend/src/market-scan/prompt.ts`:

```ts
import type { Market, TradingStyle } from '../engine/types.js';
import type { ScanCandidate } from '../market/candidates.js';

export interface ScanPromptInput {
  roundName: string;
  markets: Market[];
  tradingStyle: TradingStyle;
  mode: 'bootstrap' | 'manage';
  held: string[];
  currentWatchlist: string[];
  candidates: ScanCandidate[];
}

export const SCAN_SYSTEM_PROMPT = [
  'You are the market scout for a small paper-trading agent. You choose which symbols the round',
  'pays attention to. You cannot trade, set stops, or change any other configuration — you have no',
  'trading tools, and your output is read by a separate process, never executed as instructions.',
  '',
  'Pick ONLY from the candidate list given to you, and only from that list. Do not propose a ticker',
  'that is not on it, even one you believe exists and would be a good pick — an invented or',
  'misremembered ticker breaks the round permanently once traded, so the candidate list is a hard',
  'boundary, not a suggestion.',
  '',
  'Respond with a single fenced JSON code block and nothing else:',
  '```json',
  '{"watchlist": ["SYM1", "SYM2"]}',
  '```',
  'No prose outside the code block.',
].join('\n');

export function buildScanPrompt(input: ScanPromptInput): string {
  const candidateLines = input.candidates
    .map((c) => `${c.symbol}${c.name ? ` (${c.name})` : ''}${c.changePct != null ? ` ${c.changePct.toFixed(1)}%` : ''}`)
    .join('\n');

  const sections = [
    `Round "${input.roundName}" trades ${input.markets.join(' and ')} in a ${input.tradingStyle} style.`,
    input.held.length === 0 ? 'Currently held: none.' : `Currently held: ${input.held.join(', ')}.`,
  ];

  if (input.mode === 'bootstrap') {
    sections.push(
      'This round has no watchlist yet. Choose a small, sensible starting set (roughly 3-8 symbols)',
      'from the candidates below. This is a ONE-TIME choice — there will be no further scans, so',
      'favour names you can justify holding for a while over anything narrowly of-the-moment.',
    );
  } else {
    sections.push(
      input.currentWatchlist.length === 0
        ? 'The current watchlist is empty.'
        : `Current watchlist: ${input.currentWatchlist.join(', ')}.`,
      'You may keep, add, or drop symbols freely based on the candidates below — this is a',
      'recurring weekly scan, so it is fine to drop or remove names that no longer look interesting.',
    );
  }

  sections.push(
    "Candidates (symbol, name, today's % move):",
    candidateLines,
    'This is a qualitative shortlist, not a quantitative screen — use your judgement, not just the % move.',
  );

  return sections.join('\n');
}

/** Extracts {"watchlist": [...]} from a response that may wrap it in prose or a fenced code block. */
export function parseScanResponse(text: string): { watchlist: string[] } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null && 'watchlist' in parsed &&
      Array.isArray((parsed as { watchlist: unknown }).watchlist) &&
      (parsed as { watchlist: unknown[] }).watchlist.every((s) => typeof s === 'string')
    ) {
      return { watchlist: (parsed as { watchlist: string[] }).watchlist.map((s) => s.trim().toUpperCase()) };
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npm test -- market-scan-prompt && npx tsc --noEmit` → all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/market-scan/prompt.ts backend/test/market-scan-prompt.test.ts
git commit -m "feat: market-scan pure prompt builder and response parser"
```

---

## Task 3: The market-scan service — the security/correctness-relevant task

This is where the three defence layers against a hallucinated ticker actually get enforced.
Review this task's diff with the same scrutiny Phase 3 gave the capability boundary.

**Files:** create `backend/src/market-scan/service.ts`, `backend/test/market-scan-service.test.ts`.

- [ ] **Step 1: Write the failing test**

`backend/test/market-scan-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService } from '../src/market/data.js';
import type { CandidateFetcher } from '../src/market/candidates.js';
import { MarketScanService } from '../src/market-scan/service.js';
import { RoundService } from '../src/rounds/service.js';
import { FakeAgentRunner } from './agent-helper.js';

function config(over: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'scan round', startingBalanceCents: cents(50), profitGoalCents: cents(1000),
    markets: ['US'], watchlist: [], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS, fees: DEFAULT_FEES, model: 'claude-sonnet-5',
    checkinCron: [], researchCron: [], autoWatchlist: false,
    ...over,
  };
}

const candidatesFor: CandidateFetcher = async (market) =>
  market === 'US'
    ? [{ symbol: 'AAPL', name: 'Apple', changePct: 1 }, { symbol: 'NVDA', name: 'Nvidia', changePct: 2 }]
    : [{ symbol: 'BHP.AX', name: 'BHP', changePct: 0.5 }];

function fakeQuoteFetcher(known: string[]) {
  return async (symbols: string[]) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (known.includes(s)) out.set(s, { price: 10, currency: 'USD' });
    return out;
  };
}

describe('MarketScanService', () => {
  let db: DB;
  let rounds: RoundService;
  let market: MarketDataService;
  let id: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    market = new MarketDataService(db, fakeQuoteFetcher(['AAPL', 'NVDA', 'BHP.AX']));
    id = rounds.create(config());
  });

  it('adopts a valid watchlist chosen from the candidate list', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL", "NVDA"]}');
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('success');
    expect(rounds.config(id).watchlist.sort()).toEqual(['AAPL', 'NVDA']);
  });

  it('requests the web tools, no trading tools, and no maxTurns explosion', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL"]}');
    await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    const request = runner.requests[0]!;
    expect(request.webTools).toBe(true);
    expect(request.tools).toHaveLength(0);
    expect(request.maxTurns).toBeGreaterThan(0);
  });

  it('drops a symbol not on the candidate list (Defence 1: hallucination)', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL", "FAKECO"]}');
    await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(rounds.config(id).watchlist).toEqual(['AAPL']);
  });

  it('drops a candidate outside the round\'s configured markets (Defence 2)', async () => {
    // BHP.AX is a real candidate but this round only trades US.
    const mixedCandidates: CandidateFetcher = async () => [
      { symbol: 'AAPL' }, { symbol: 'BHP.AX' },
    ];
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL", "BHP.AX"]}');
    await new MarketScanService({ db, rounds, market }, runner, mixedCandidates).runScan(id);

    expect(rounds.config(id).watchlist).toEqual(['AAPL']);
  });

  it('drops a candidate-list symbol with no live quote (Defence 3)', async () => {
    const noisyMarket = new MarketDataService(db, fakeQuoteFetcher(['AAPL'])); // NVDA has no quote
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL", "NVDA"]}');
    await new MarketScanService({ db, rounds, market: noisyMarket }, runner, candidatesFor).runScan(id);

    expect(rounds.config(id).watchlist).toEqual(['AAPL']);
  });

  it('always keeps a held position\'s symbol even if the scan drops it', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), { symbol: 'AAPL', market: 'US', price: 10, currency: 'USD', ts: new Date().toISOString(), stale: false }, 1.5, 'operator');
    const runner = new FakeAgentRunner([], '{"watchlist": ["NVDA"]}'); // does not mention AAPL
    await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(rounds.config(id).watchlist).toContain('AAPL');
  });

  it('does not touch the watchlist when the response cannot be parsed', async () => {
    const runner = new FakeAgentRunner([], 'I could not decide.');
    const before = rounds.config(id).watchlist;
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('error');
    expect(rounds.config(id).watchlist).toEqual(before);
  });

  it('does not touch the watchlist when nothing survives validation', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["FAKECO"]}');
    const before = rounds.config(id).watchlist;
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('error');
    expect(rounds.config(id).watchlist).toEqual(before);
  });

  it('records a failed run instead of throwing', async () => {
    const runner = { run: async () => { throw new Error('web tool unavailable'); } };
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('error');
    const events = db.prepare("SELECT kind FROM event_log WHERE round_id = ? AND kind = 'market_scan_failed'").all(id);
    expect(events).toHaveLength(1);
  });

  it('skips terminal rounds without spending a token', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL"]}');
    rounds.setStatus(id, 'archived', 'test');
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('skipped');
    expect(runner.requests).toHaveLength(0);
  });

  it('errors cleanly when no candidates are available for the round\'s markets', async () => {
    const noCandidates: CandidateFetcher = async () => [];
    const runner = new FakeAgentRunner([], '{"watchlist": []}');
    const outcome = await new MarketScanService({ db, rounds, market }, runner, noCandidates).runScan(id);

    expect(outcome.status).toBe('error');
    expect(runner.requests).toHaveLength(0); // never spend a token with nothing to offer
  });

  it('records added/removed symbols relative to the prior watchlist', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), { symbol: 'AAPL', market: 'US', price: 10, currency: 'USD', ts: new Date().toISOString(), stale: false }, 1.5, 'operator');
    // seed a prior watchlist entry that the new scan will drop
    const cfg = rounds.config(id);
    db.prepare('UPDATE rounds SET config_json = ? WHERE id = ?').run(JSON.stringify({ ...cfg, watchlist: ['NVDA'] }), id);

    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL"]}'); // drops NVDA implicitly
    await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    const row = db.prepare('SELECT added_json, removed_json FROM market_scans WHERE round_id = ?').get(id) as {
      added_json: string; removed_json: string;
    };
    expect(JSON.parse(row.removed_json)).toContain('NVDA');
  });

  it('list() returns scans newest first', async () => {
    const service = new MarketScanService({ db, rounds, market }, new FakeAgentRunner([], '{"watchlist": ["AAPL"]}'), candidatesFor);
    await service.runScan(id);
    await service.runScan(id);
    const rows = service.list(id);
    expect(rows.length).toBe(2);
    expect(rows[0]!.id).toBeGreaterThan(rows[1]!.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npm test -- market-scan-service` → FAIL.

- [ ] **Step 3: Write the service**

`backend/src/market-scan/service.ts`:

```ts
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { AgentRunner } from '../agent/types.js';
import { marketForSymbol, type MarketDataService } from '../market/data.js';
import type { CandidateFetcher } from '../market/candidates.js';
import type { RoundService } from '../rounds/service.js';
import { buildScanPrompt, parseScanResponse, SCAN_SYSTEM_PROMPT } from './prompt.js';

export interface MarketScanDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
}

export interface ScanOutcome {
  status: 'success' | 'error' | 'skipped';
  detail: string;
}

export interface ScanRow {
  id: number;
  created_at: string;
  status: string;
  watchlist_json: string | null;
  added_json: string;
  removed_json: string;
  detail: string;
  tokens_used: number;
  cost_usd: number;
}

/** Scanning is a shorter, more constrained task than research — fewer turns needed. */
const SCAN_MAX_TURNS = 8;
const CANDIDATES_PER_MARKET = 15;
const MAX_WATCHLIST = 15;
const TERMINAL = ['goal_reached', 'busted', 'archived'];

/**
 * TODO.md item 3 / spec's market-scan feature: a budgeted agent run, sibling to
 * ResearchService, that proposes a round's watchlist from a deterministic candidate
 * pool. Three independent defences stop a hallucinated or out-of-market ticker from
 * ever landing: the candidate-list allowlist, the configured-markets filter, and a
 * live-quote check. Never throws — a failed or unparsable run leaves the watchlist
 * untouched and is recorded as an 'error' row, exactly like ResearchService.
 */
export class MarketScanService {
  constructor(
    private deps: MarketScanDeps,
    private runner: AgentRunner,
    private candidates: CandidateFetcher,
  ) {}

  async runScan(roundId: number): Promise<ScanOutcome> {
    const { db, rounds, market } = this.deps;
    const round = rounds.get(roundId);
    if (TERMINAL.includes(round.status)) {
      return { status: 'skipped', detail: `round is ${round.status}` };
    }

    const config = rounds.config(roundId);
    const positions = rounds.openPositions(roundId);
    const heldSymbols = positions.map((p) => p.symbol);

    const pool = (
      await Promise.all(config.markets.map((m) => this.candidates(m)))
    ).flatMap((list) => list.slice(0, CANDIDATES_PER_MARKET));
    const poolSymbols = pool.map((c) => c.symbol);

    if (pool.length === 0) {
      return this.record(roundId, [], config.watchlist, null, [], [], 'error', 'no candidates available for the configured markets', 0, 0);
    }

    const prompt = buildScanPrompt({
      roundName: config.name,
      markets: config.markets,
      tradingStyle: config.tradingStyle,
      mode: config.autoWatchlist === true ? 'manage' : 'bootstrap',
      held: heldSymbols,
      currentWatchlist: config.watchlist,
      candidates: pool,
    });

    let text: string;
    let tokens = 0;
    let costUsd = 0;
    try {
      const result = await this.runner.run({
        model: config.model,
        systemPrompt: SCAN_SYSTEM_PROMPT,
        prompt,
        tools: [], // no trading tools — a scan can only propose, never act
        webTools: true,
        maxTurns: SCAN_MAX_TURNS,
      });
      tokens = result.inputTokens + result.outputTokens;
      costUsd = result.costUsd;
      if (result.status !== 'success') {
        return this.record(roundId, poolSymbols, config.watchlist, null, [], [], 'error', `scan run failed (${result.subtype})`, tokens, costUsd);
      }
      text = result.text;
    } catch (err) {
      return this.record(roundId, poolSymbols, config.watchlist, null, [], [], 'error', (err as Error).message, 0, 0);
    }

    const parsed = parseScanResponse(text);
    if (!parsed) {
      return this.record(roundId, poolSymbols, config.watchlist, null, [], [], 'error', 'could not parse a watchlist from the scan response', tokens, costUsd);
    }

    // Defence 1: only symbols actually offered as candidates, or already held — never an invented ticker.
    const candidateSet = new Set(poolSymbols);
    const onList = parsed.watchlist.filter((s) => candidateSet.has(s) || heldSymbols.includes(s));
    // Defence 2: must belong to a market this round actually trades.
    const inMarket = onList.filter((s) => config.markets.includes(marketForSymbol(s)));
    // Held positions always stay trackable, regardless of what the scan chose.
    const withHeld = [...new Set([...heldSymbols, ...inMarket])].slice(0, MAX_WATCHLIST);

    // Defence 3: a live quote must exist — a hallucinated, delisted, or misfiltered ticker never lands.
    const quotes = await market.poll(withHeld);
    const finalList = withHeld.filter((s) => quotes.has(s));

    if (finalList.length === 0) {
      return this.record(roundId, poolSymbols, config.watchlist, null, [], [], 'error', 'no proposed symbol survived validation', tokens, costUsd);
    }

    const before = new Set(config.watchlist);
    const after = new Set(finalList);
    const added = finalList.filter((s) => !before.has(s));
    const removed = config.watchlist.filter((s) => !after.has(s));

    db.prepare('UPDATE rounds SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...config, watchlist: finalList }), new Date().toISOString(), roundId);

    return this.record(
      roundId, poolSymbols, config.watchlist, finalList, added, removed, 'success',
      `watchlist now: ${finalList.join(', ')}`, tokens, costUsd,
    );
  }

  list(roundId: number, limit = 20): ScanRow[] {
    return this.deps.db
      .prepare(
        `SELECT id, created_at, status, watchlist_json, added_json, removed_json, detail, tokens_used, cost_usd
           FROM market_scans WHERE round_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(roundId, limit) as ScanRow[];
  }

  private record(
    roundId: number, candidateSymbols: string[], _priorWatchlist: string[],
    watchlist: string[] | null, added: string[], removed: string[],
    status: 'success' | 'error', detail: string, tokens: number, costUsd: number,
  ): ScanOutcome {
    this.deps.db
      .prepare(
        `INSERT INTO market_scans (round_id, created_at, status, candidates_json, watchlist_json, added_json, removed_json, detail, tokens_used, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        roundId, new Date().toISOString(), status, JSON.stringify(candidateSymbols),
        watchlist ? JSON.stringify(watchlist) : null, JSON.stringify(added), JSON.stringify(removed),
        detail, tokens, costUsd,
      );

    if (status === 'error') {
      logEvent(this.deps.db, 'warn', 'market_scan_failed', `round ${roundId} market scan failed: ${detail}`, roundId);
    } else {
      logEvent(this.deps.db, 'info', 'market_scan', `round ${roundId} market scan: ${detail}`, roundId);
    }
    return { status, detail };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npm test -- market-scan-service && npx tsc --noEmit`
Expected: all pass. Other suites' `RoundConfig` fixtures will need `autoWatchlist: false` added —
mechanical fix, report as a sanctioned deviation (same as `researchCron` was in Phase 3).

- [ ] **Step 5: Commit**

```bash
git add backend/src/market-scan/service.ts backend/test/market-scan-service.test.ts backend/test
git commit -m "feat: market-scan service with three-layer hallucination defence"
```

---

## Task 4: Scheduling — weekly cadence and the once-only bootstrap

Deliberately **not** cron-based, unlike check-ins and research: the design calls for a fixed
weekly cadence (autoWatchlist on) or a single bootstrap scan (off + empty watchlist), neither of
which needs operator-configurable timing.

**Files:** create `backend/src/market-scan/scheduler.ts`, `backend/test/market-scan-scheduler.test.ts`.

- [ ] **Step 1: Write the failing test**

`backend/test/market-scan-scheduler.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { dueMarketScanRoundIds } from '../src/market-scan/scheduler.js';
import { RoundService } from '../src/rounds/service.js';

function config(over: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'r', startingBalanceCents: cents(50), profitGoalCents: cents(1000),
    markets: ['US'], watchlist: [], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS, fees: DEFAULT_FEES, model: 'claude-sonnet-5',
    checkinCron: [], researchCron: [], autoWatchlist: false,
    ...over,
  };
}

describe('dueMarketScanRoundIds', () => {
  let db: DB;
  let rounds: RoundService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
  });

  it('is due for a bootstrap: autoWatchlist off, empty watchlist, never scanned', () => {
    const id = rounds.create(config({ watchlist: [] }));
    expect(dueMarketScanRoundIds(db, new Date())).toContain(id);
  });

  it('is NOT due when autoWatchlist is off and the watchlist is non-empty', () => {
    const id = rounds.create(config({ watchlist: ['AAPL'] }));
    expect(dueMarketScanRoundIds(db, new Date())).not.toContain(id);
  });

  it('bootstrap fires only once — a prior scan row (even an error) freezes it', () => {
    const id = rounds.create(config({ watchlist: [] }));
    db.prepare(
      `INSERT INTO market_scans (round_id, created_at, status, candidates_json, added_json, removed_json, detail)
       VALUES (?, ?, 'error', '[]', '[]', '[]', 'x')`,
    ).run(id, new Date().toISOString());
    expect(dueMarketScanRoundIds(db, new Date())).not.toContain(id);
  });

  it('is due immediately for a fresh autoWatchlist:true round with no prior scan', () => {
    const id = rounds.create(config({ autoWatchlist: true }));
    expect(dueMarketScanRoundIds(db, new Date())).toContain(id);
  });

  it('is NOT due for autoWatchlist:true less than a week after the last scan', () => {
    const id = rounds.create(config({ autoWatchlist: true }));
    db.prepare(
      `INSERT INTO market_scans (round_id, created_at, status, candidates_json, added_json, removed_json, detail)
       VALUES (?, ?, 'success', '[]', '[]', '[]', 'x')`,
    ).run(id, new Date().toISOString());
    expect(dueMarketScanRoundIds(db, new Date())).not.toContain(id);
  });

  it('IS due for autoWatchlist:true a week after the last scan', () => {
    const id = rounds.create(config({ autoWatchlist: true }));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
    db.prepare(
      `INSERT INTO market_scans (round_id, created_at, status, candidates_json, added_json, removed_json, detail)
       VALUES (?, ?, 'success', '[]', '[]', '[]', 'x')`,
    ).run(id, eightDaysAgo);
    expect(dueMarketScanRoundIds(db, new Date())).toContain(id);
  });

  it('ignores non-active rounds', () => {
    const id = rounds.create(config({ autoWatchlist: true }));
    rounds.setStatus(id, 'paused', 'test');
    expect(dueMarketScanRoundIds(db, new Date())).not.toContain(id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npm test -- market-scan-scheduler` → FAIL.

- [ ] **Step 3: Write the scheduler**

`backend/src/market-scan/scheduler.ts`:

```ts
import type { DB } from '../db/connection.js';
import type { RoundConfig } from '../engine/types.js';
import type { MarketScanService } from './service.js';

const WEEKLY_MS = 7 * 24 * 3_600_000;

/**
 * Rounds due for a scan right now. Not cron-based (unlike check-ins/research) — a
 * fixed rule: weekly for autoWatchlist:true, or a one-time bootstrap when off with
 * an empty watchlist. A prior scan row of ANY status (success or error) satisfies
 * the bootstrap case and resets the weekly clock — a persistently-failing scan must
 * not spin every tick; an operator can always retrigger by hand via the API.
 */
export function dueMarketScanRoundIds(db: DB, now: Date): number[] {
  const rows = db.prepare("SELECT id, config_json FROM rounds WHERE status = 'active'").all() as {
    id: number;
    config_json: string;
  }[];
  const due: number[] = [];
  for (const row of rows) {
    const config = JSON.parse(row.config_json) as RoundConfig;
    const last = db
      .prepare('SELECT created_at FROM market_scans WHERE round_id = ? ORDER BY id DESC LIMIT 1')
      .get(row.id) as { created_at: string } | undefined;

    if (config.autoWatchlist === true) {
      if (!last || now.getTime() - Date.parse(last.created_at) >= WEEKLY_MS) due.push(row.id);
    } else if (config.watchlist.length === 0 && !last) {
      due.push(row.id);
    }
  }
  return due;
}

/** Minute tick, mirroring startCheckinScheduler/startResearchScheduler's never-overlap guard. */
export function startMarketScanScheduler(db: DB, scans: MarketScanService, intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    const due = dueMarketScanRoundIds(db, new Date());
    if (due.length === 0) return;
    running = true;
    void (async () => {
      for (const roundId of due) await scans.runScan(roundId); // never throws
      running = false;
    })();
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run everything**

Run: `cd backend && npm test && npx tsc --noEmit && npm run build`

- [ ] **Step 5: Commit**

```bash
git add backend/src/market-scan/scheduler.ts backend/test/market-scan-scheduler.test.ts
git commit -m "feat: market-scan scheduling (weekly cadence + once-only bootstrap)"
```

---

## Task 5: Routes and wiring

**Files:** create `backend/src/api/market-scan-routes.ts`, `backend/test/api-market-scan.test.ts`;
modify `backend/src/api/app.ts`, `backend/src/api/rounds-routes.ts`, `backend/src/index.ts`,
`backend/test/api-helper.ts`.

- [ ] **Step 1: Write the failing test**

`backend/test/api-market-scan.test.ts` — mirror `backend/test/api-research.test.ts`'s structure
exactly (read it first): `GET /api/rounds/:id/scans` requires auth and 404s for an unknown round;
`POST /api/rounds/:id/scan` requires auth, runs a scan on demand, and 404s for an unknown round.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test -- api-market-scan` → FAIL.

- [ ] **Step 3: Write the routes**

`backend/src/api/market-scan-routes.ts`, mirroring `research-routes.ts`'s pattern (session-gated,
`loadRound` 404 helper, manual validation, no zod):

```ts
router.get('/api/rounds/:id/scans', ...)  // marketScan.list(id)
router.post('/api/rounds/:id/scan', ...)  // await marketScan.runScan(id)
```

- [ ] **Step 4: Add `autoWatchlist` to the create/patch key lists**

`backend/src/api/rounds-routes.ts` — add `'autoWatchlist'` to both `CREATE_KEYS` and `PATCHABLE`.

- [ ] **Step 5: Wire it all up**

Add `marketScan: MarketScanService` to `ApiDeps`/`app.ts`, mount the router. In `index.ts`:

```ts
import { yahooCandidateFetcher } from './market/candidates.js';
import { startMarketScanScheduler } from './market-scan/scheduler.js';
import { MarketScanService } from './market-scan/service.js';
```

```ts
const marketScan = new MarketScanService({ db, rounds, market }, runner, yahooCandidateFetcher);
const stopMarketScan = startMarketScanScheduler(db, marketScan);
```

Add `marketScan` to the `buildApp(...)` call, add `stopMarketScan()` to `shutdown()`, and add
`marketScan` to `backend/test/api-helper.ts`'s test fixture (a `FakeAgentRunner` + a fake
`CandidateFetcher`, mirroring how `research` gets its own separate `FakeAgentRunner` instance
there — same reasoning as Phase 3: the fake blindly replays whatever `request.tools` it receives,
and a scan run must never be handed check-in-scripted tool calls).

- [ ] **Step 6: Run everything**

Run: `cd backend && npm test && npx tsc --noEmit && npm run build`

- [ ] **Step 7: Commit**

```bash
git add backend/src/api backend/src/index.ts backend/test
git commit -m "feat: market-scan routes and wiring"
```

---

## Task 6: UI — autoWatchlist toggle and the scans panel

**Files:** create `frontend/src/pages/round/ScansPanel.tsx`, `frontend/test/scans.test.tsx`;
modify `frontend/src/api/types.ts`, `frontend/src/api/hooks.ts`,
`frontend/src/pages/NewRoundPage.tsx`, `frontend/src/pages/round/ConfigPanel.tsx`,
`frontend/src/pages/RoundDetailPage.tsx`, `frontend/test/server.ts`.

- [ ] **Step 1: Write the failing tests**

`frontend/test/scans.test.tsx` — render `<ScansPanel roundId={1} />`, mirroring
`frontend/test/briefings.test.tsx`'s structure, and assert:

1. Each scan row shows its status, timestamp, and added/removed symbols.
2. Token spend and cost are shown per scan.
3. An error-status scan renders with the `loss` class and its detail text.
4. "Scan now" posts to `/api/rounds/1/scan` and disables while pending.
5. The empty state reads "No market scans yet."
6. A load error surfaces via `role="alert"`.

Add fixtures + handlers to `frontend/test/server.ts`'s base `handlers` array (not `server.use()`
at module scope — `resetHandlers()` strips that, same caveat Phase 3 flagged).

Also add a test (in `NewRoundPage.test.tsx` or `ConfigPanel.test.tsx`, whichever already exists)
that toggling "Auto-manage watchlist" is present and submits `autoWatchlist` in the create/PATCH
body.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- scans` → FAIL.

- [ ] **Step 3: Types, hooks, component**

Add `ScanRow` to `src/api/types.ts` and `autoWatchlist: boolean` to the `RoundConfig` type. Add
`useScans(id)` and `useRunScan(id)` to `src/api/hooks.ts` with a `qk.scans(id)` key in the
factory; the mutation invalidates `qk.scans(id)` and `qk.round(id)` (a successful scan changes
the watchlist shown elsewhere on the page). Build `ScansPanel` in the established style —
`Spinner`/`ErrorBox`/`formatTs`, matching `BriefingsList.tsx`'s shape.

- [ ] **Step 4: Wire the toggle and the panel**

`NewRoundPage.tsx` and `ConfigPanel.tsx` — add an "Auto-manage watchlist" checkbox next to the
watchlist field, with `<small>` helper text explaining the three modes (on: agent scans and edits
freely; off with symbols: strict; off with no symbols: one bootstrap scan then frozen) — matching
the guardrail helper-text precedent from `ux-fixes`. `RoundDetailPage.tsx` gets a `'scans'` tab
rendering `ScansPanel`.

- [ ] **Step 5: Run everything**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "feat: market-scan UI — autoWatchlist toggle and scans panel"
```

---

## Task 7: Review, docs, merge

- [ ] **Step 1: Full suites**

```bash
cd backend && npm test && npx tsc --noEmit && npm run build
cd ../frontend && npm test && npx tsc --noEmit && npm run build
```

- [ ] **Step 2: Whole-branch review**

Two stages, spec-compliance then code-quality. Priorities:

1. **Capability boundary unchanged.** A scan run still goes through `buildRunnerOptions` with
   `webTools: true` and no trading tools — confirm no new SDK-touching file was added outside
   `sdk-runner.ts`.
2. **The three defence layers actually run in order and can't be short-circuited**: candidate-list
   allowlist → configured-markets filter → live-quote check. Write (or re-verify) a test where a
   symbol passes Defence 1 and 2 but has no quote, and confirm it's still dropped.
3. **Held positions can never be silently dropped from the watchlist** by a scan, even in
   `autoWatchlist: true` mode — re-check the union-with-held logic.
4. **Bootstrap really is once-only.** Confirm an error row still freezes it (Task 4's test), and
   that a manual retrigger via `POST /api/rounds/:id/scan` is the only way to retry after a failed
   bootstrap.
5. **`migrations.ts`** indices 0–2 byte-identical to master.
6. **Old rounds** — a `config_json` without `autoWatchlist` must read as `false` (strict `===
   true` checks everywhere, never a bare truthy check), never crash.
7. **Cost controls** — `SCAN_MAX_TURNS`, `CANDIDATES_PER_MARKET`, `MAX_WATCHLIST` all present; no
   path scans more than once per bootstrap/week without an explicit manual trigger.
8. **Money/watchlist boundary** — confirm nothing in `market-scan/` touches `positions`, `orders`,
   `trades`, or `ledger_entries`; it only ever reads and writes `rounds.config_json.watchlist`.

- [ ] **Step 3: Update CLAUDE.md**

Record: the new `market-scan/` module and `market_scans` table (schema v3 index 3, 19 tables);
`autoWatchlist` on `RoundConfig`; whether the Task 1 Step 4 manual ASX-region check passed or
needed a workaround; and a new hard-won invariant —

> **A market scan can only ever propose symbols it was actually offered.** `MarketScanService`
> enforces three independent layers before a scan's output can change a round's watchlist: the
> candidate-list allowlist (nothing outside what the scan was shown), the configured-markets
> filter, and a live-quote check. Held positions are always force-kept in the watchlist regardless
> of what the scan chose. The bootstrap case (autoWatchlist off, empty watchlist) fires exactly
> once — any prior `market_scans` row, success or error, freezes it; a failed bootstrap is
> retried only by an explicit operator call to `POST /api/rounds/:id/scan`.

Mark TODO.md item 3 done, pointing at this plan and the merged branch. Move the market-scan design
note out of "Decisions made this session (not yet implemented)."

- [ ] **Step 4: Merge**

```bash
git checkout master
git merge --no-ff feature/market-scan -m "Merge market-scan feature (reviewed)"
```
