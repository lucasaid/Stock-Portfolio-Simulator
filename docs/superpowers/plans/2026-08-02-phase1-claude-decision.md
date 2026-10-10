# Phase 1 / Plan 3 — Claude DecisionService & Agent Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give rounds their Claude brain: scheduled check-ins where a tightly constrained Agent SDK turn reads a prepared snapshot and acts through four in-process tools, plus daily summaries / rolling memory, agent API routes, and the OneCLI subscription-auth setup script.

**Architecture:** The Claude Agent SDK is isolated behind a one-method `AgentRunner` interface in a single file (`sdk-runner.ts`, compile-checked but not unit-tested). Everything else — snapshot builder, tool handlers, DecisionService orchestration, check-in scheduler, summaries — is deterministic code tested against a scripted `FakeAgentRunner` (spec §9). Tool handlers call the existing `RoundService` with actor `'agent'`, so every guardrail, ledger, and skim rule from Plans 1–2 applies unchanged. Auth: the SDK subprocess inherits `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` env vars pointing at the local OneCLI gateway (nanoclaw pattern) — no secrets in this codebase.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (^0.3), `zod`, `cron-parser`. Everything else exists.

**Spec:** `docs/superpowers/specs/2026-08-02-trading-agent-design.md` §2.4–2.5 (personas), §4 (auth, check-in contract, daily summaries). Plans 1–2 are merged on `master`; 142 tests green. Branch: `git checkout -b feature/claude-decision` from repo root before Task 1.

**Verified SDK facts (researched 2026-08-02 against code.claude.com/docs/en/agent-sdk):** `query({prompt, options})` async-iterates messages; final `type: 'result'` message carries `subtype` (`'success' | 'error_max_turns' | ...`) and usage (input/output tokens, `total_cost_usd`). Custom in-process tools: `tool(name, description, zodRawShape, handler)` bundled with `createSdkMcpServer({name, version, tools})`, registered via `options.mcpServers`, callable names `mcp__<server>__<tool>`. Built-ins removed with `options.tools: []`; permissions via `allowedTools: ['mcp__<server>__*']` + `permissionMode: 'dontAsk'` + `settingSources: []`. `maxTurns` caps assistant round-trips. Exact TS typings may drift between SDK minors — Task 1 instructs the implementer to adapt `sdk-runner.ts` to the installed typings while keeping the `AgentRunner` contract fixed.

---

## File Structure

```
backend/src/agent/
  types.ts             # AgentRunner interface, AgentToolDescriptor, AgentRunRequest/Result
  sdk-runner.ts        # SdkAgentRunner — the ONLY file importing @anthropic-ai/claude-agent-sdk
  personas.ts          # risk-profile + trading-style prompt blocks, buildSystemPrompt()
  snapshot.ts          # buildSnapshot(): DB state + quotes → check-in prompt text
  tools.ts             # buildDecisionTools(): 4 tool descriptors bound to a round + action recorder
  decision.ts          # DecisionService.runCheckin() orchestration
  checkin-scheduler.ts # cron-parser matching per round config, minute tick
  summaries.ts         # daily digest (deterministic) + narrative + rolling history + abstract
backend/src/api/agent-routes.ts   # GET checkins/journal/summaries, POST manual checkin
backend/src/cli.ts               # MODIFY: add `checkin <roundId>` command
backend/src/index.ts             # MODIFY: wire runner, DecisionService, schedulers
backend/scripts/setup-claude-auth.sh  # OneCLI + claude setup-token registration (nanoclaw pattern)
backend/.env.example
backend/test/
  agent-helper.ts      # FakeAgentRunner (scripted), test fixtures
  personas.test.ts  snapshot.test.ts  agent-tools.test.ts  decision.test.ts
  checkin-scheduler.test.ts  summaries.test.ts  api-agent.test.ts
```

Run commands from `backend/` unless noted. Suite baseline: 142. Per-task expected totals below are exact if nothing drifts; if your total differs by a prior sanctioned test, adjust by the same delta and report it.

---

### Task 1: Dependencies, AgentRunner contract, SdkAgentRunner, FakeAgentRunner

**Files:**
- Create: `backend/src/agent/types.ts`, `backend/src/agent/sdk-runner.ts`
- Create: `backend/test/agent-helper.ts`
- Test: `backend/test/agent-helper.test.ts` (validates the fake's scripting behavior so later tests can trust it)

- [ ] **Step 1: Install dependencies**

```bash
npm install @anthropic-ai/claude-agent-sdk zod cron-parser
```
Expected: exit 0.

- [ ] **Step 2: Create `backend/src/agent/types.ts`**

```ts
import type { ZodRawShape } from 'zod';

export interface AgentToolResult {
  text: string;
  isError?: boolean;
}

/** SDK-agnostic tool description; sdk-runner maps these onto in-process MCP tools. */
export interface AgentToolDescriptor {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<AgentToolResult> | AgentToolResult;
}

export interface AgentRunRequest {
  model: string;
  systemPrompt: string;
  prompt: string;
  tools: AgentToolDescriptor[];
  maxTurns?: number;
}

export interface AgentRunResult {
  status: 'success' | 'error';
  /** SDK result subtype, e.g. 'success', 'error_max_turns'. */
  subtype: string;
  /** Final assistant text (empty on error). */
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
```

- [ ] **Step 3: Create `backend/src/agent/sdk-runner.ts`** (reference implementation — ADAPT to the installed SDK's typings; the `AgentRunner` contract and the option values shown are fixed, exact TS property shapes may need adjusting. Report any adaptation you make.)

```ts
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunner, AgentRunRequest, AgentRunResult } from './types.js';

const SERVER_NAME = 'trading';
const DEFAULT_MAX_TURNS = 6;

/**
 * The only file that touches the Agent SDK. Runs one tightly constrained
 * agentic exchange: no built-in tools, no file/bash/web access, no user or
 * project settings, auto-deny anything outside our in-process tools.
 * Auth comes from ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN in process env
 * (the OneCLI gateway injects the real subscription token on the wire).
 */
export class SdkAgentRunner implements AgentRunner {
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const sdkTools = request.tools.map((descriptor) =>
      tool(descriptor.name, descriptor.description, descriptor.schema, async (args: Record<string, unknown>) => {
        const result = await descriptor.handler(args);
        return {
          content: [{ type: 'text' as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }),
    );
    const server = createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools: sdkTools });

    let final: AgentRunResult = {
      status: 'error',
      subtype: 'no_result',
      text: '',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };

    for await (const message of query({
      prompt: request.prompt,
      options: {
        model: request.model,
        systemPrompt: request.systemPrompt,
        maxTurns: request.maxTurns ?? DEFAULT_MAX_TURNS,
        tools: [],
        mcpServers: { [SERVER_NAME]: server },
        allowedTools: [`mcp__${SERVER_NAME}__*`],
        permissionMode: 'dontAsk',
        settingSources: [],
        env: { ...process.env },
      },
    })) {
      if (message.type === 'result') {
        const success = message.subtype === 'success';
        // Usage fields: adapt to installed typings (usage.input_tokens /
        // usage.total_cost_usd, or top-level total_cost_usd on older minors).
        const usage = (message as { usage?: Record<string, number> }).usage ?? {};
        final = {
          status: success ? 'success' : 'error',
          subtype: message.subtype,
          text: success ? ((message as { result?: string }).result ?? '') : '',
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          costUsd: usage.total_cost_usd ?? (message as { total_cost_usd?: number }).total_cost_usd ?? 0,
        };
      }
    }
    return final;
  }
}
```

- [ ] **Step 4: Create `backend/test/agent-helper.ts`**

```ts
import type { AgentRunner, AgentRunRequest, AgentRunResult, AgentToolResult } from '../src/agent/types.js';

export interface ScriptedCall {
  /** Tool name to invoke, with args. */
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Scripted fake Claude (spec §9): executes a fixed list of tool calls against
 * the real handlers, then "responds" with the given text. Captures everything
 * for assertions.
 */
export class FakeAgentRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  toolResults: AgentToolResult[] = [];

  constructor(
    private script: ScriptedCall[] = [],
    private finalText = 'ok',
    private result: Partial<AgentRunResult> = {},
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    for (const call of this.script) {
      const descriptor = request.tools.find((t) => t.name === call.tool);
      if (!descriptor) throw new Error(`scripted tool not offered: ${call.tool}`);
      this.toolResults.push(await descriptor.handler(call.args));
    }
    return {
      status: 'success',
      subtype: 'success',
      text: this.finalText,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0,
      ...this.result,
    };
  }
}
```

- [ ] **Step 5: Write the failing test** — `backend/test/agent-helper.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeAgentRunner } from './agent-helper.js';
import type { AgentToolDescriptor } from '../src/agent/types.js';

describe('FakeAgentRunner', () => {
  it('executes scripted tool calls against the offered handlers and records results', async () => {
    const seen: unknown[] = [];
    const echo: AgentToolDescriptor = {
      name: 'echo',
      description: 'echoes',
      schema: { value: z.string() },
      handler: (args) => {
        seen.push(args);
        return { text: `echo:${String(args.value)}` };
      },
    };
    const runner = new FakeAgentRunner([{ tool: 'echo', args: { value: 'hi' } }], 'done');
    const result = await runner.run({ model: 'm', systemPrompt: 's', prompt: 'p', tools: [echo] });
    expect(result.status).toBe('success');
    expect(result.text).toBe('done');
    expect(seen).toEqual([{ value: 'hi' }]);
    expect(runner.toolResults).toEqual([{ text: 'echo:hi' }]);
    expect(runner.requests[0]!.prompt).toBe('p');
  });

  it('throws when the script names a tool that was not offered', async () => {
    const runner = new FakeAgentRunner([{ tool: 'ghost', args: {} }]);
    await expect(runner.run({ model: 'm', systemPrompt: 's', prompt: 'p', tools: [] })).rejects.toThrow(/ghost/);
  });

  it('supports overriding the result (e.g. error_max_turns)', async () => {
    const runner = new FakeAgentRunner([], '', { status: 'error', subtype: 'error_max_turns' });
    const result = await runner.run({ model: 'm', systemPrompt: 's', prompt: 'p', tools: [] });
    expect(result.subtype).toBe('error_max_turns');
  });
});
```

- [ ] **Step 6: Run** `npm test -- agent-helper` → 3 passing; full suite → 145. `npx tsc --noEmit` → clean (this compile-checks `sdk-runner.ts` against the installed SDK; fix type adaptations here, do not change the AgentRunner contract).

- [ ] **Step 7: Commit** (repo root)

```bash
git add backend/package.json backend/package-lock.json backend/src/agent backend/test/agent-helper.ts backend/test/agent-helper.test.ts
git commit -m "feat: agent runner contract, SDK runner, scripted fake"
```

---

### Task 2: Personas and system prompt

**Files:**
- Create: `backend/src/agent/personas.ts`
- Modify: `backend/src/engine/types.ts` (two optional RoundConfig fields)
- Test: `backend/test/personas.test.ts`

- [ ] **Step 1: Add optional persona overrides to `RoundConfig`** in `backend/src/engine/types.ts` — append to the interface (spec §2.4: prompt text is config, editable via the existing PATCH):

```ts
  /** Optional override for the risk-profile prompt block (spec §2.4). */
  riskPrompt?: string;
  /** Optional override for the trading-style prompt block (spec §2.5). */
  stylePrompt?: string;
```

Also add `'riskPrompt', 'stylePrompt'` to the `CREATE_KEYS` and `PATCHABLE` arrays in `backend/src/api/rounds-routes.ts` so they are settable at create and via live config PATCH.

- [ ] **Step 2: Write the failing test** — `backend/test/personas.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { RISK_PROMPTS, STYLE_PROMPTS, buildSystemPrompt } from '../src/agent/personas.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'p', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS, fees: DEFAULT_FEES, model: 'claude-sonnet-5',
    checkinCron: ['0 8 * * 1-5'], ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('has a block for every risk profile and trading style', () => {
    for (const key of ['conservative', 'balanced', 'aggressive', 'custom'] as const) {
      expect(RISK_PROMPTS[key]).toBeTruthy();
    }
    for (const key of ['day', 'swing', 'long'] as const) {
      expect(STYLE_PROMPTS[key]).toBeTruthy();
    }
  });

  it('assembles base rules + selected persona blocks', () => {
    const prompt = buildSystemPrompt(config({ riskProfile: 'aggressive', tradingStyle: 'day' }));
    expect(prompt).toContain(RISK_PROMPTS.aggressive);
    expect(prompt).toContain(STYLE_PROMPTS.day);
    expect(prompt).toMatch(/paper[- ]trading/i);
    expect(prompt).toMatch(/write_journal/);
  });

  it('prefers config overrides over presets', () => {
    const prompt = buildSystemPrompt(config({ riskPrompt: 'CUSTOM RISK RULES', stylePrompt: 'CUSTOM STYLE' }));
    expect(prompt).toContain('CUSTOM RISK RULES');
    expect(prompt).toContain('CUSTOM STYLE');
    expect(prompt).not.toContain(RISK_PROMPTS.balanced);
  });
});
```

- [ ] **Step 3: Verify FAIL:** `npm test -- personas`.

- [ ] **Step 4: Create `backend/src/agent/personas.ts`**

```ts
import type { RiskProfile, RoundConfig, TradingStyle } from '../engine/types.js';

export const RISK_PROMPTS: Record<RiskProfile, string> = {
  conservative:
    'Risk profile: CONSERVATIVE. Favour steady large-caps and ETFs. Hold cash when unsure — no trade is a valid decision. Avoid volatile or speculative symbols. Prefer fewer, higher-conviction positions.',
  balanced:
    'Risk profile: BALANCED. Mix stable large-caps with selective growth positions. Take reasonable, thesis-backed risks but avoid speculation without a clear catalyst.',
  aggressive:
    'Risk profile: AGGRESSIVE. Volatile small-caps and momentum plays are allowed. Faster churn and bigger swings are acceptable. Conviction still required — aggressive is not random.',
  custom: 'Risk profile: CUSTOM. Follow the operator-provided risk instructions exactly.',
};

export const STYLE_PROMPTS: Record<TradingStyle, string> = {
  day: 'Trading style: DAY. Open and close positions within the same session. Avoid holding overnight. Act decisively on intraday moves.',
  swing:
    'Trading style: SWING. Hold positions for days to weeks to ride short-term trends. Do not react to intraday noise; reassess each check-in against your thesis.',
  long: 'Trading style: LONG. Hold for weeks to months. Orient on fundamentals and durable trends. Ignore daily fluctuations; trade rarely and deliberately.',
};

const BASE_RULES = `You are the trading agent for a paper-trading round (simulated fills at real market prices — no real money moves, but treat it as real).

Hard rules:
- You act ONLY by calling the provided tools. Anything not expressed as a tool call does not happen.
- Your working bankroll is capped at the round's starting balance; profits above it are skimmed automatically after sells. Never reason about "reinvesting" skimmed profit.
- Deterministic guardrails (stop-losses, position caps, drawdown pause) are enforced outside of you. Your orders may be clipped or rejected — rejections appear in your next snapshot.
- Stale quotes are marked in the snapshot; orders on stale quotes will be rejected.
- Always finish by calling write_journal exactly once: state what you did, why, and what you are watching for next check-in. This journal is your memory.
- This is one scheduled check-in, not a conversation. Decide, act, journal, stop.`;

export function buildSystemPrompt(config: RoundConfig): string {
  const risk = config.riskPrompt ?? RISK_PROMPTS[config.riskProfile];
  const style = config.stylePrompt ?? STYLE_PROMPTS[config.tradingStyle];
  return [BASE_RULES, risk, style].join('\n\n');
}
```

- [ ] **Step 5: Verify PASS:** `npm test -- personas` → 3 tests; full suite → 148. tsc clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/personas.ts backend/src/engine/types.ts backend/src/api/rounds-routes.ts backend/test/personas.test.ts
git commit -m "feat: persona prompt blocks and system prompt builder"
```

---

### Task 3: Snapshot builder

**Files:**
- Create: `backend/src/agent/snapshot.ts`
- Test: `backend/test/snapshot.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/snapshot.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/broker/types.js';
import { openDb, type DB } from '../src/db/connection.js';
import { logEvent } from '../src/db/events.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { RoundService } from '../src/rounds/service.js';
import { buildSnapshot } from '../src/agent/snapshot.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'snap', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL', 'MSFT'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
    model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'], ...overrides,
  };
}

function q(symbol: string, price: number, stale = false): Quote {
  return { symbol, market: 'US', price, currency: 'USD', ts: new Date().toISOString(), stale };
}

describe('buildSnapshot', () => {
  let db: DB;
  let rounds: RoundService;
  let id: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    id = rounds.create(config());
  });

  it('includes cash, goal progress, watchlist quotes and staleness markers', () => {
    const text = buildSnapshot(db, rounds, id, new Map([['AAPL', q('AAPL', 10)], ['MSFT', q('MSFT', 300, true)]]), 1);
    expect(text).toContain('Cash: $50.00');
    expect(text).toContain('Pocketed so far: $0.00 of $1000.00 goal');
    expect(text).toMatch(/AAPL.*\$10/);
    expect(text).toMatch(/MSFT.*STALE/);
  });

  it('lists open positions with cost basis and unrealised P/L', () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q('AAPL', 10), 1, 'agent');
    const text = buildSnapshot(db, rounds, id, new Map([['AAPL', q('AAPL', 15)]]), 1);
    expect(text).toMatch(/AAPL.*2 shares.*avg cost \$10\.00.*now \$15\.00/);
    expect(text).toContain('+$10.00'); // unrealised P/L
  });

  it('includes recent trades, rejected orders, and events since the last check-in', () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q('AAPL', 10), 1, 'agent');
    rounds.setStatus(id, 'paused', 'drawdown pause breached');
    rounds.setStatus(id, 'active', 'operator resume');
    logEvent(db, 'info', 'config_change', `round ${id}: operator changed 1 config field(s)`, id);
    const text = buildSnapshot(db, rounds, id, new Map(), 1);
    expect(text).toMatch(/buy 2.*AAPL/);
    expect(text).toContain('config_change');
    expect(text).toContain('operator resume');
  });

  it('includes rolling history: recent daily summaries and the last journal note', () => {
    db.prepare(
      "INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, '2026-08-01', '{}', 'Bought AAPL on momentum.', ?)",
    ).run(id, new Date().toISOString());
    db.prepare(
      "INSERT INTO journal_entries (round_id, author, note, created_at) VALUES (?, 'agent', 'Watching MSFT for entry.', ?)",
    ).run(id, new Date().toISOString());
    const text = buildSnapshot(db, rounds, id, new Map(), 1);
    expect(text).toContain('Bought AAPL on momentum.');
    expect(text).toContain('Watching MSFT for entry.');
  });

  it('always carries the (currently empty) research briefing slot', () => {
    const text = buildSnapshot(db, rounds, id, new Map(), 1);
    expect(text).toContain('Research briefing: none');
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- snapshot`.

- [ ] **Step 3: Create `backend/src/agent/snapshot.ts`**

```ts
import type { Quote } from '../broker/types.js';
import type { DB } from '../db/connection.js';
import type { RoundService } from '../rounds/service.js';

function dollars(centsValue: number): string {
  return `$${(centsValue / 100).toFixed(2)}`;
}

function signedDollars(centsValue: number): string {
  return `${centsValue >= 0 ? '+' : '-'}$${Math.abs(centsValue / 100).toFixed(2)}`;
}

/** Spec §4.2: the compact check-in prompt. Everything the agent may act on, nothing else. */
export function buildSnapshot(
  db: DB,
  rounds: RoundService,
  roundId: number,
  quotes: Map<string, Quote>,
  audUsdRate: number,
): string {
  const round = rounds.get(roundId);
  const config = rounds.config(roundId);
  const pocketed = rounds.totalSkimsCents(roundId);
  const lines: string[] = [];

  lines.push(`# Check-in snapshot — round "${round.name}" (${new Date().toISOString()})`);
  lines.push('');
  lines.push(`Cash: ${dollars(round.cash_cents)} (starting balance ${dollars(round.starting_balance_cents)})`);
  lines.push(`Pocketed so far: ${dollars(pocketed)} of ${dollars(round.profit_goal_cents)} goal`);
  lines.push(
    `Guardrails: stop-loss ${config.guardrails.stopLossPct ?? 'off'}% | max position ${config.guardrails.maxPositionPct ?? 'off'}% | drawdown pause ${config.guardrails.drawdownPausePct ?? 'off'}%`,
  );
  lines.push('');

  lines.push('## Open positions');
  const positions = rounds.openPositions(roundId);
  if (positions.length === 0) lines.push('(none)');
  for (const position of positions) {
    const quote = quotes.get(position.symbol);
    const avgCost = position.cost_basis_cents / 100 / position.quantity;
    if (quote) {
      const priceAud = quote.currency === 'USD' ? quote.price / audUsdRate : quote.price;
      const valueCents = Math.round(position.quantity * priceAud * 100);
      const pl = valueCents - position.cost_basis_cents;
      lines.push(
        `- ${position.symbol}: ${position.quantity} shares, avg cost $${avgCost.toFixed(2)}, now $${priceAud.toFixed(2)}${quote.stale ? ' [STALE]' : ''}, unrealised ${signedDollars(pl)}${position.stop_loss_price !== null ? `, stop @ $${position.stop_loss_price}` : ''}`,
      );
    } else {
      lines.push(`- ${position.symbol}: ${position.quantity} shares, avg cost $${avgCost.toFixed(2)}, no live quote`);
    }
  }
  lines.push('');

  lines.push('## Watchlist quotes');
  for (const symbol of config.watchlist) {
    const quote = quotes.get(symbol);
    if (!quote) {
      lines.push(`- ${symbol}: no quote available`);
      continue;
    }
    const priceAud = quote.currency === 'USD' ? quote.price / audUsdRate : quote.price;
    lines.push(`- ${symbol}: $${priceAud.toFixed(2)} AUD${quote.stale ? ' [STALE — orders will be rejected]' : ''}`);
  }
  lines.push('');

  lines.push('## Recent trades (last 10)');
  const trades = db
    .prepare('SELECT side, quantity, symbol, price_aud, executed_at FROM trades WHERE round_id = ? ORDER BY id DESC LIMIT 10')
    .all(roundId) as { side: string; quantity: number; symbol: string; price_aud: number; executed_at: string }[];
  if (trades.length === 0) lines.push('(none)');
  for (const trade of trades) {
    lines.push(`- ${trade.executed_at}: ${trade.side} ${trade.quantity} ${trade.symbol} @ $${trade.price_aud.toFixed(2)}`);
  }
  lines.push('');

  lines.push('## Events since last check-in');
  const lastCheckin = db
    .prepare("SELECT ts FROM checkins WHERE round_id = ? AND status != 'running' ORDER BY id DESC LIMIT 1")
    .get(roundId) as { ts: string } | undefined;
  const since = lastCheckin?.ts ?? '1970-01-01T00:00:00.000Z';
  const events = db
    .prepare('SELECT kind, message, created_at FROM event_log WHERE round_id = ? AND created_at > ? ORDER BY id DESC LIMIT 20')
    .all(roundId, since) as { kind: string; message: string; created_at: string }[];
  if (events.length === 0) lines.push('(none)');
  for (const event of events) lines.push(`- [${event.kind}] ${event.message}`);
  lines.push('');

  lines.push('## Your recent history');
  const summaries = db
    .prepare("SELECT day, narrative FROM daily_summaries WHERE round_id = ? AND day != 'abstract' ORDER BY day DESC LIMIT 7")
    .all(roundId) as { day: string; narrative: string | null }[];
  const abstract = db
    .prepare("SELECT narrative FROM daily_summaries WHERE round_id = ? AND day = 'abstract'")
    .get(roundId) as { narrative: string | null } | undefined;
  if (abstract?.narrative) lines.push(`Long-term summary: ${abstract.narrative}`);
  for (const summary of summaries.reverse()) {
    if (summary.narrative) lines.push(`- ${summary.day}: ${summary.narrative}`);
  }
  const lastJournal = db
    .prepare("SELECT note FROM journal_entries WHERE round_id = ? AND author = 'agent' ORDER BY id DESC LIMIT 1")
    .get(roundId) as { note: string } | undefined;
  if (lastJournal) lines.push(`Last journal note: ${lastJournal.note}`);
  if (!abstract && summaries.length === 0 && !lastJournal) lines.push('(no history yet — this is an early check-in)');
  lines.push('');

  lines.push('Research briefing: none (research mode not yet enabled).');
  lines.push('');
  lines.push('Decide your actions now using the tools, then journal.');
  return lines.join('\n');
}
```

- [ ] **Step 4: Verify PASS:** `npm test -- snapshot` → 5 tests; full suite → 153. tsc clean. (If a string assertion misses due to formatting, fix the FORMATTER or the test to match intent — do not delete assertions.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/snapshot.ts backend/test/snapshot.test.ts
git commit -m "feat: check-in snapshot builder"
```

---

### Task 4: Decision tools

**Files:**
- Create: `backend/src/agent/tools.ts`
- Test: `backend/test/agent-tools.test.ts`

The four tools from spec §4.2, bound to one round + one check-in. Handlers call the real services (actor `'agent'`), record every attempted action, and NEVER throw — errors return `{text, isError: true}` so the agent sees them.

- [ ] **Step 1: Write the failing test** — `backend/test/agent-tools.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { RoundService } from '../src/rounds/service.js';
import { buildDecisionTools } from '../src/agent/tools.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'tools', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
    model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'], ...overrides,
  };
}

describe('decision tools', () => {
  let db: DB;
  let rounds: RoundService;
  let market: MarketDataService;
  let prices: Record<string, { price: number; currency: string }>;
  let id: number;
  let checkinId: number;

  const fetcher: QuoteFetcher = async (symbols) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    market = new MarketDataService(db, fetcher);
    prices = { 'AAPL': { price: 10, currency: 'USD' }, 'AUDUSD=X': { price: 1, currency: 'USD' } };
    id = rounds.create(config());
    checkinId = Number(
      db.prepare("INSERT INTO checkins (round_id, ts, snapshot_json, actions_json, status) VALUES (?, ?, '{}', '[]', 'running')")
        .run(id, new Date().toISOString()).lastInsertRowid,
    );
  });

  function tools() {
    return buildDecisionTools({ db, rounds, market }, id, checkinId);
  }

  it('place_order buys at a fresh quote and records the action', async () => {
    const { tools: t, actions } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    const result = await place.handler({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/filled/i);
    expect(rounds.get(id).cash_cents).toBe(cents(30));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ tool: 'place_order', ok: true });
  });

  it('place_order sells all and reports the skim', async () => {
    const { tools: t } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    await place.handler({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    prices['AAPL'] = { price: 20, currency: 'USD' };
    const result = await place.handler({ symbol: 'AAPL', side: 'sell', quantity: 'all' });
    expect(result.text).toMatch(/pocketed \$20\.00/i);
  });

  it('place_order surfaces engine rejections as tool errors, not throws', async () => {
    rounds.setStatus(id, 'paused', 'test');
    const { tools: t, actions } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    const result = await place.handler({ symbol: 'AAPL', side: 'buy', amountCents: cents(10) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/paused/);
    expect(actions[0]).toMatchObject({ ok: false });
  });

  it('place_order errors cleanly when no quote is available', async () => {
    const { tools: t } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    const result = await place.handler({ symbol: 'GHOST', side: 'buy', amountCents: cents(10) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no quote/i);
  });

  it('set_stop_loss updates the open position and clears with null', async () => {
    const { tools: t } = tools();
    const place = t.find((x) => x.name === 'place_order')!;
    await place.handler({ symbol: 'AAPL', side: 'buy', amountCents: cents(20) });
    const stop = t.find((x) => x.name === 'set_stop_loss')!;
    const result = await stop.handler({ symbol: 'AAPL', stopPrice: 9 });
    expect(result.isError).toBeUndefined();
    expect((db.prepare('SELECT stop_loss_price FROM positions WHERE round_id = ? AND closed_at IS NULL').get(id) as { stop_loss_price: number }).stop_loss_price).toBe(9);
    await stop.handler({ symbol: 'AAPL', stopPrice: null });
    expect((db.prepare('SELECT stop_loss_price FROM positions WHERE round_id = ? AND closed_at IS NULL').get(id) as { stop_loss_price: number | null }).stop_loss_price).toBeNull();
  });

  it('set_stop_loss errors when there is no open position', async () => {
    const { tools: t } = tools();
    const stop = t.find((x) => x.name === 'set_stop_loss')!;
    const result = await stop.handler({ symbol: 'AAPL', stopPrice: 9 });
    expect(result.isError).toBe(true);
  });

  it('update_watchlist adds and removes symbols and writes config_events', async () => {
    const { tools: t } = tools();
    const watch = t.find((x) => x.name === 'update_watchlist')!;
    const result = await watch.handler({ add: ['MSFT'], remove: ['AAPL'] });
    expect(result.isError).toBeUndefined();
    expect(rounds.config(id).watchlist).toEqual(['MSFT']);
    const event = db.prepare("SELECT changed_by, field FROM config_events WHERE round_id = ?").get(id) as { changed_by: string; field: string };
    expect(event).toEqual({ changed_by: 'agent', field: 'watchlist' });
  });

  it('write_journal inserts an agent journal entry linked to the check-in', async () => {
    const { tools: t } = tools();
    const journal = t.find((x) => x.name === 'write_journal')!;
    await journal.handler({ note: 'Holding steady.' });
    const row = db.prepare('SELECT author, note, checkin_id FROM journal_entries WHERE round_id = ?').get(id) as {
      author: string; note: string; checkin_id: number;
    };
    expect(row).toEqual({ author: 'agent', note: 'Holding steady.', checkin_id: checkinId });
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- agent-tools`.

- [ ] **Step 3: Create `backend/src/agent/tools.ts`**

```ts
import { z } from 'zod';
import type { DB } from '../db/connection.js';
import { marketForSymbol, type MarketDataService } from '../market/data.js';
import type { RoundService } from '../rounds/service.js';
import type { AgentToolDescriptor, AgentToolResult } from './types.js';

export interface ToolDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
}

export interface CheckinAction {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  detail: string;
}

function dollars(centsValue: number): string {
  return `$${(centsValue / 100).toFixed(2)}`;
}

/** The four spec §4.2 tools, bound to one round and one check-in. Handlers never throw. */
export function buildDecisionTools(
  deps: ToolDeps,
  roundId: number,
  checkinId: number,
): { tools: AgentToolDescriptor[]; actions: CheckinAction[] } {
  const { db, rounds, market } = deps;
  const actions: CheckinAction[] = [];

  function record(tool: string, args: Record<string, unknown>, ok: boolean, detail: string): AgentToolResult {
    actions.push({ tool, args, ok, detail });
    return ok ? { text: detail } : { text: detail, isError: true };
  }

  const placeOrder: AgentToolDescriptor = {
    name: 'place_order',
    description:
      "Place a market order. Buys take amountCents (AUD cents to spend, fees included). Sells take quantity (number of shares, or 'all'). Fills at the live quote; may be clipped or rejected by guardrails.",
    schema: {
      symbol: z.string().describe('Ticker, e.g. AAPL or BHP.AX'),
      side: z.enum(['buy', 'sell']),
      amountCents: z.number().int().positive().optional().describe('Buys only: AUD cents to spend'),
      quantity: z.union([z.number().positive(), z.literal('all')]).optional().describe("Sells only: shares or 'all'"),
    },
    handler: async (args) => {
      const symbol = String(args.symbol);
      const side = args.side as 'buy' | 'sell';
      try {
        const quotes = await market.poll([symbol]);
        const quote = quotes.get(symbol);
        if (!quote) return record('place_order', args, false, `no quote available for ${symbol}`);
        const audUsd = quote.currency === 'USD' ? await market.audUsdRate() : 1;
        const result =
          side === 'buy'
            ? rounds.buy(roundId, symbol, marketForSymbol(symbol), Number(args.amountCents), quote, audUsd, 'agent')
            : rounds.sell(roundId, symbol, (args.quantity === 'all' ? 'all' : Number(args.quantity)), quote, audUsd, 'agent');
        if (result.status === 'rejected') return record('place_order', args, false, `rejected: ${result.reason}`);
        const skimNote = result.skimCents > 0 ? ` — pocketed ${dollars(result.skimCents)} to the profit ledger` : '';
        return record('place_order', args, true, `filled ${side} ${symbol}${result.reason ? ` (${result.reason})` : ''}${skimNote}`);
      } catch (err) {
        return record('place_order', args, false, `error: ${(err as Error).message}`);
      }
    },
  };

  const setStopLoss: AgentToolDescriptor = {
    name: 'set_stop_loss',
    description: 'Set an explicit stop price on an open position (checked every poll, fires without you). Pass stopPrice null to clear.',
    schema: {
      symbol: z.string(),
      stopPrice: z.number().positive().nullable().describe('AUD price; null clears the explicit stop'),
    },
    handler: (args) => {
      const symbol = String(args.symbol);
      const position = rounds.openPosition(roundId, symbol);
      if (!position) return record('set_stop_loss', args, false, `no open position in ${symbol}`);
      const stopPrice = args.stopPrice === null ? null : Number(args.stopPrice);
      db.prepare('UPDATE positions SET stop_loss_price = ? WHERE id = ?').run(stopPrice, position.id);
      return record('set_stop_loss', args, true, stopPrice === null ? `cleared stop on ${symbol}` : `stop set at $${stopPrice} on ${symbol}`);
    },
  };

  const updateWatchlist: AgentToolDescriptor = {
    name: 'update_watchlist',
    description: 'Add or remove symbols from the round watchlist (they will be polled and appear in future snapshots).',
    schema: {
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    },
    handler: (args) => {
      const add = (args.add as string[] | undefined) ?? [];
      const remove = (args.remove as string[] | undefined) ?? [];
      const config = rounds.config(roundId);
      const before = JSON.stringify(config.watchlist);
      const next = [...config.watchlist.filter((s) => !remove.includes(s)), ...add.filter((s) => !config.watchlist.includes(s))];
      const now = new Date().toISOString();
      db.prepare('UPDATE rounds SET config_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...config, watchlist: next }), now, roundId);
      db.prepare('INSERT INTO config_events (round_id, changed_by, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(roundId, 'agent', 'watchlist', before, JSON.stringify(next), now);
      return record('update_watchlist', args, true, `watchlist is now: ${next.join(', ') || '(empty)'}`);
    },
  };

  const writeJournal: AgentToolDescriptor = {
    name: 'write_journal',
    description: 'Record your reasoning: what you did this check-in, why, and what you are watching next. Call exactly once, last.',
    schema: { note: z.string().min(1) },
    handler: (args) => {
      db.prepare('INSERT INTO journal_entries (round_id, checkin_id, author, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(roundId, checkinId, 'agent', String(args.note), new Date().toISOString());
      return record('write_journal', args, true, 'journal recorded');
    },
  };

  return { tools: [placeOrder, setStopLoss, updateWatchlist, writeJournal], actions };
}
```

- [ ] **Step 4: Verify PASS:** `npm test -- agent-tools` → 8 tests; full suite → 161. tsc clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/tools.ts backend/test/agent-tools.test.ts
git commit -m "feat: agent decision tools bound to round services"
```

---

### Task 5: DecisionService

**Files:**
- Create: `backend/src/agent/decision.ts`
- Test: `backend/test/decision.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/decision.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { RoundService } from '../src/rounds/service.js';
import { DecisionService } from '../src/agent/decision.js';
import { FakeAgentRunner } from './agent-helper.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'dec', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
    model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'], ...overrides,
  };
}

describe('DecisionService', () => {
  let db: DB;
  let rounds: RoundService;
  let market: MarketDataService;
  let prices: Record<string, { price: number; currency: string }>;
  let id: number;

  const fetcher: QuoteFetcher = async (symbols) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    market = new MarketDataService(db, fetcher);
    prices = { 'AAPL': { price: 10, currency: 'USD' }, 'AUDUSD=X': { price: 1, currency: 'USD' } };
    id = rounds.create(config());
  });

  it('runs a full check-in: snapshot → scripted trades → recorded checkin row + tokens', async () => {
    const runner = new FakeAgentRunner(
      [
        { tool: 'place_order', args: { symbol: 'AAPL', side: 'buy', amountCents: cents(20) } },
        { tool: 'write_journal', args: { note: 'Bought AAPL.' } },
      ],
      'Bought AAPL at $10.',
    );
    const decision = new DecisionService({ db, rounds, market }, runner);
    const outcome = await decision.runCheckin(id);
    expect(outcome.status).toBe('success');
    expect(rounds.get(id).cash_cents).toBe(cents(30));

    const checkin = db.prepare('SELECT status, tokens_used, actions_json, snapshot_json FROM checkins WHERE round_id = ?').get(id) as {
      status: string; tokens_used: number; actions_json: string; snapshot_json: string;
    };
    expect(checkin.status).toBe('success');
    expect(checkin.tokens_used).toBe(1200); // 1000 in + 200 out from the fake
    const actions = JSON.parse(checkin.actions_json) as { tool: string }[];
    expect(actions.map((a) => a.tool)).toEqual(['place_order', 'write_journal']);
    expect(JSON.parse(checkin.snapshot_json).prompt).toContain('Watchlist quotes');

    // final agent text is journaled too
    const notes = (db.prepare("SELECT note FROM journal_entries WHERE round_id = ? AND author = 'agent'").all(id) as { note: string }[]).map((r) => r.note);
    expect(notes).toContain('Bought AAPL.');
  });

  it('sends the persona system prompt and the snapshot as the prompt', async () => {
    const runner = new FakeAgentRunner();
    const decision = new DecisionService({ db, rounds, market }, runner);
    await decision.runCheckin(id);
    expect(runner.requests[0]!.systemPrompt).toMatch(/Risk profile: BALANCED/);
    expect(runner.requests[0]!.prompt).toContain('Cash: $50.00');
    expect(runner.requests[0]!.model).toBe('claude-sonnet-5');
  });

  it('skips paused rounds entirely', async () => {
    rounds.setStatus(id, 'paused', 'operator');
    const runner = new FakeAgentRunner();
    const decision = new DecisionService({ db, rounds, market }, runner);
    const outcome = await decision.runCheckin(id);
    expect(outcome.status).toBe('skipped');
    expect(runner.requests).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM checkins').get()).toEqual({ c: 0 });
  });

  it('runs takeover rounds in advisory mode: journal/watchlist only, no trading tools (spec §5)', async () => {
    rounds.setStatus(id, 'takeover', 'operator');
    const runner = new FakeAgentRunner([{ tool: 'write_journal', args: { note: 'Advisory: would buy AAPL here.' } }], '');
    const decision = new DecisionService({ db, rounds, market }, runner);
    const outcome = await decision.runCheckin(id);
    expect(outcome.status).toBe('success');
    const offered = runner.requests[0]!.tools.map((t) => t.name).sort();
    expect(offered).toEqual(['update_watchlist', 'write_journal']);
    expect(runner.requests[0]!.prompt).toMatch(/advisory/i);
  });

  it('records a failed check-in when the runner errors and logs the event', async () => {
    const runner: FakeAgentRunner = new FakeAgentRunner([], '', { status: 'error', subtype: 'error_max_turns' });
    const decision = new DecisionService({ db, rounds, market }, runner);
    const outcome = await decision.runCheckin(id);
    expect(outcome.status).toBe('error');
    const checkin = db.prepare('SELECT status FROM checkins WHERE round_id = ?').get(id) as { status: string };
    expect(checkin.status).toBe('error_max_turns');
    expect(db.prepare("SELECT COUNT(*) AS c FROM event_log WHERE kind = 'checkin_failed'").get()).toEqual({ c: 1 });
  });

  it('survives a runner that throws (network down): checkin marked error, no crash', async () => {
    const runner = { run: async () => { throw new Error('gateway unreachable'); } };
    const decision = new DecisionService({ db, rounds, market }, runner);
    const outcome = await decision.runCheckin(id);
    expect(outcome.status).toBe('error');
    const checkin = db.prepare('SELECT status FROM checkins WHERE round_id = ?').get(id) as { status: string };
    expect(checkin.status).toBe('exception');
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- decision`.

- [ ] **Step 3: Create `backend/src/agent/decision.ts`**

```ts
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { MarketDataService } from '../market/data.js';
import type { RoundService } from '../rounds/service.js';
import { buildSystemPrompt } from './personas.js';
import { buildSnapshot } from './snapshot.js';
import { buildDecisionTools } from './tools.js';
import type { AgentRunner } from './types.js';

export interface DecisionDeps {
  db: DB;
  rounds: RoundService;
  market: MarketDataService;
}

export interface CheckinOutcome {
  status: 'success' | 'error' | 'skipped';
  detail: string;
}

export class DecisionService {
  constructor(
    private deps: DecisionDeps,
    private runner: AgentRunner,
  ) {}

  /**
   * One scheduled check-in for one round (spec §4.2). Never throws.
   * In takeover the agent is advisory-only (spec §5): it still observes and
   * journals, but only journal/watchlist tools are offered — no trading tools.
   */
  async runCheckin(roundId: number): Promise<CheckinOutcome> {
    const { db, rounds, market } = this.deps;
    const round = rounds.get(roundId);
    const advisory = round.status === 'takeover';
    if (round.status !== 'active' && !advisory) {
      logEvent(db, 'info', 'checkin_skipped', `round ${roundId} check-in skipped: status ${round.status}`, roundId);
      return { status: 'skipped', detail: `round is ${round.status}` };
    }
    const config = rounds.config(roundId);

    // Fresh quotes for watchlist + held symbols (stale protection lives in RoundService).
    const symbols = new Set<string>(config.watchlist);
    for (const position of rounds.openPositions(roundId)) symbols.add(position.symbol);
    const quotes = await market.poll([...symbols]).catch(() => new Map());
    const needsUs = [...quotes.values()].some((q) => q.currency === 'USD');
    const audUsd = needsUs ? await market.audUsdRate().catch(() => 1) : 1;

    let prompt = buildSnapshot(db, rounds, roundId, quotes, audUsd);
    if (advisory) {
      prompt += '\n\nADVISORY MODE: the operator has taken over trading. You cannot place orders or set stops this check-in — observe, update the watchlist if useful, and journal what you would do and why.';
    }
    const now = new Date().toISOString();
    const checkinId = Number(
      db.prepare("INSERT INTO checkins (round_id, ts, snapshot_json, actions_json, status) VALUES (?, ?, ?, '[]', 'running')")
        .run(roundId, now, JSON.stringify({ prompt })).lastInsertRowid,
    );
    const built = buildDecisionTools({ db, rounds, market }, roundId, checkinId);
    const tools = advisory
      ? built.tools.filter((t) => t.name === 'write_journal' || t.name === 'update_watchlist')
      : built.tools;
    const actions = built.actions;

    let status: string;
    let detail: string;
    let tokens = 0;
    try {
      const result = await this.runner.run({
        model: config.model,
        systemPrompt: buildSystemPrompt(config),
        prompt,
        tools,
      });
      status = result.status === 'success' ? 'success' : result.subtype;
      detail = result.subtype;
      tokens = result.inputTokens + result.outputTokens;
      if (result.status === 'success' && result.text.trim() !== '') {
        db.prepare('INSERT INTO journal_entries (round_id, checkin_id, author, note, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(roundId, checkinId, 'agent', result.text.trim(), new Date().toISOString());
      }
    } catch (err) {
      status = 'exception';
      detail = (err as Error).message;
    }

    db.prepare('UPDATE checkins SET status = ?, tokens_used = ?, actions_json = ? WHERE id = ?')
      .run(status, tokens, JSON.stringify(actions), checkinId);

    if (status === 'success') {
      logEvent(db, 'info', 'checkin', `round ${roundId} check-in complete: ${actions.length} action(s), ${tokens} tokens`, roundId);
      return { status: 'success', detail: `${actions.length} action(s)` };
    }
    logEvent(db, 'error', 'checkin_failed', `round ${roundId} check-in failed: ${detail}`, roundId);
    return { status: 'error', detail };
  }
}
```

- [ ] **Step 4: Verify PASS:** `npm test -- decision` → 6 tests; full suite → 167. tsc clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/decision.ts backend/test/decision.test.ts
git commit -m "feat: decision service - constrained check-in orchestration"
```

---

### Task 6: Check-in scheduler

**Files:**
- Create: `backend/src/agent/checkin-scheduler.ts`
- Test: `backend/test/checkin-scheduler.test.ts`

Every minute, find active rounds with a `checkinCron` entry that fired since the last tick (evaluated in Australia/Sydney), and run their check-ins sequentially. Uses `cron-parser` (check the installed major: v5 exposes `CronExpressionParser.parse`, v4 `parseExpression` — adapt the import, keep behavior; report which you used).

- [ ] **Step 1: Write the failing test** — `backend/test/checkin-scheduler.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { RoundService } from '../src/rounds/service.js';
import { dueRoundIds } from '../src/agent/checkin-scheduler.js';

function config(cron: string[], overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'sched', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS, fees: { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 },
    model: 'claude-sonnet-5', checkinCron: cron, ...overrides,
  };
}

describe('dueRoundIds', () => {
  let db: DB;
  let rounds: RoundService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
  });

  // 23:30 Sydney on Mon 2026-08-03 == 13:30 UTC (AEST, UTC+10).
  const before = new Date('2026-08-03T13:29:30Z');
  const after = new Date('2026-08-03T13:30:30Z');

  it('returns a round whose cron fired inside the window', () => {
    const id = rounds.create(config(['30 23 * * 1-5']));
    expect(dueRoundIds(db, before, after)).toEqual([id]);
  });

  it('does not return rounds whose cron did not fire', () => {
    rounds.create(config(['0 8 * * 1-5']));
    expect(dueRoundIds(db, before, after)).toEqual([]);
  });

  it('ignores non-active rounds', () => {
    const id = rounds.create(config(['30 23 * * 1-5']));
    rounds.setStatus(id, 'paused', 'test');
    expect(dueRoundIds(db, before, after)).toEqual([]);
  });

  it('deduplicates when multiple cron entries fire in the same window', () => {
    const id = rounds.create(config(['30 23 * * 1-5', '30 23 * * *']));
    expect(dueRoundIds(db, before, after)).toEqual([id]);
  });

  it('skips invalid cron expressions without throwing and flags them in the event log', () => {
    rounds.create(config(['not a cron']));
    expect(dueRoundIds(db, before, after)).toEqual([]);
    const event = db.prepare("SELECT kind FROM event_log WHERE kind = 'bad_cron'").get();
    expect(event).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- checkin-scheduler`.

- [ ] **Step 3: Create `backend/src/agent/checkin-scheduler.ts`**

```ts
import { CronExpressionParser } from 'cron-parser';
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { RoundConfig } from '../engine/types.js';
import type { DecisionService } from './decision.js';

const TIMEZONE = 'Australia/Sydney';

/** Rounds whose checkinCron fired in (previousTick, now]. Pure given the DB. */
export function dueRoundIds(db: DB, previousTick: Date, now: Date): number[] {
  const rows = db.prepare("SELECT id, config_json FROM rounds WHERE status = 'active'").all() as {
    id: number;
    config_json: string;
  }[];
  const due: number[] = [];
  for (const row of rows) {
    const config = JSON.parse(row.config_json) as RoundConfig;
    for (const expression of config.checkinCron) {
      try {
        const interval = CronExpressionParser.parse(expression, { currentDate: now, tz: TIMEZONE });
        const previous = interval.prev().toDate();
        if (previous > previousTick && previous <= now) {
          due.push(row.id);
          break;
        }
      } catch {
        logEvent(db, 'warn', 'bad_cron', `round ${row.id}: invalid checkin cron "${expression}"`, row.id);
      }
    }
  }
  return due;
}

/** Minute tick: run due check-ins sequentially. Returns a stop function. */
export function startCheckinScheduler(
  db: DB,
  decision: DecisionService,
  intervalMs = 60_000,
): () => void {
  let previousTick = new Date();
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap check-in batches
    const now = new Date();
    const due = dueRoundIds(db, previousTick, now);
    previousTick = now;
    if (due.length === 0) return;
    running = true;
    void (async () => {
      for (const roundId of due) {
        await decision.runCheckin(roundId); // never throws
      }
      running = false;
    })();
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Verify PASS:** `npm test -- checkin-scheduler` → 5 tests; full suite → 172. tsc clean. (If the installed cron-parser is v4, adapt the import to `import { parseExpression } from 'cron-parser'` and call `parseExpression(expression, {...})` — same semantics.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/checkin-scheduler.ts backend/test/checkin-scheduler.test.ts
git commit -m "feat: cron-matched check-in scheduler"
```

---

### Task 7: Daily summaries & rolling memory

**Files:**
- Create: `backend/src/agent/summaries.ts`
- Test: `backend/test/summaries.test.ts`

Spec §4.3. Digest = deterministic (no tokens). Narrative = one small runner call (no tools, maxTurns 1). Abstract row uses the reserved `day = 'abstract'` slot in `daily_summaries` (regenerated when >7 dated rows exist). Day boundaries use the UTC date of `created_at`/`executed_at` (documented simplification; timestamps are ISO-UTC throughout the DB).

- [ ] **Step 1: Write the failing test** — `backend/test/summaries.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/broker/types.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { RoundService } from '../src/rounds/service.js';
import { buildDailyDigest, runDailySummaries } from '../src/agent/summaries.js';
import { FakeAgentRunner } from './agent-helper.js';

const NO_FEES = { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 };

function config(): RoundConfig {
  return {
    name: 'sum', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: { ...DEFAULT_GUARDRAILS, maxPositionPct: null }, fees: NO_FEES,
    model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'],
  };
}

function q(price: number): Quote {
  return { symbol: 'AAPL', market: 'US', price, currency: 'USD', ts: new Date().toISOString(), stale: false };
}

describe('daily summaries', () => {
  let db: DB;
  let rounds: RoundService;
  let id: number;
  const today = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    id = rounds.create(config());
  });

  it('builds a deterministic digest of the day', () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    rounds.sell(id, 'AAPL', 'all', q(20), 1, 'agent');
    const digest = buildDailyDigest(db, id, today);
    expect(digest.trades).toBe(2);
    expect(digest.skimsCents).toBe(cents(20));
    expect(digest.events.some((e) => e.includes('skim'))).toBe(true);
  });

  it('writes a daily_summaries row with narrative from the runner', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const runner = new FakeAgentRunner([], 'Quiet day; opened a starter AAPL position.');
    await runDailySummaries({ db, rounds }, runner, today);
    const row = db.prepare('SELECT narrative, digest_json FROM daily_summaries WHERE round_id = ? AND day = ?').get(id, today) as {
      narrative: string; digest_json: string;
    };
    expect(row.narrative).toBe('Quiet day; opened a starter AAPL position.');
    expect(JSON.parse(row.digest_json).trades).toBe(1);
    // narrative prompt included the day's journals/digest
    expect(runner.requests[0]!.prompt).toContain('trades: 1');
    expect(runner.requests[0]!.tools).toHaveLength(0);
  });

  it('skips rounds with no activity that day', async () => {
    const runner = new FakeAgentRunner([], 'nothing');
    await runDailySummaries({ db, rounds }, runner, today);
    expect(db.prepare('SELECT COUNT(*) AS c FROM daily_summaries').get()).toEqual({ c: 0 });
  });

  it('falls back to a digest-only narrative when the runner fails', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const runner = { run: async () => { throw new Error('down'); } };
    await runDailySummaries({ db, rounds }, runner, today);
    const row = db.prepare('SELECT narrative FROM daily_summaries WHERE round_id = ?').get(id) as { narrative: string };
    expect(row.narrative).toMatch(/1 trade/);
  });

  it('is idempotent per (round, day)', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const runner = new FakeAgentRunner([], 'x');
    await runDailySummaries({ db, rounds }, runner, today);
    await runDailySummaries({ db, rounds }, runner, today);
    expect(db.prepare('SELECT COUNT(*) AS c FROM daily_summaries WHERE round_id = ?').get(id)).toEqual({ c: 1 });
  });

  it('regenerates the lifetime abstract when more than 7 dated summaries exist', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const insert = db.prepare(
      "INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, ?, '{}', ?, ?)",
    );
    for (let i = 1; i <= 8; i++) {
      insert.run(id, `2026-07-${String(i).padStart(2, '0')}`, `day ${i} note`, new Date().toISOString());
    }
    const runner = new FakeAgentRunner([], 'Compressed history.');
    await runDailySummaries({ db, rounds }, runner, today);
    const abstract = db.prepare("SELECT narrative FROM daily_summaries WHERE round_id = ? AND day = 'abstract'").get(id) as {
      narrative: string;
    };
    expect(abstract.narrative).toBe('Compressed history.');
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- summaries`.

- [ ] **Step 3: Create `backend/src/agent/summaries.ts`**

```ts
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { RoundService } from '../rounds/service.js';
import type { AgentRunner } from './types.js';

export interface SummaryDeps {
  db: DB;
  rounds: RoundService;
}

export interface DailyDigest {
  trades: number;
  skimsCents: number;
  feesCents: number;
  tokensUsed: number;
  events: string[];
  journals: string[];
}

const SUMMARY_MODEL_MAX_TURNS = 1;

/** Deterministic digest of one round-day (no tokens). Day = UTC date prefix. */
export function buildDailyDigest(db: DB, roundId: number, day: string): DailyDigest {
  const range = [`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`] as const;
  const trades = (db.prepare('SELECT COUNT(*) AS c FROM trades WHERE round_id = ? AND executed_at BETWEEN ? AND ?')
    .get(roundId, ...range) as { c: number }).c;
  const skims = (db.prepare("SELECT COALESCE(SUM(-amount_cents),0) AS s FROM ledger_entries WHERE round_id = ? AND type = 'skim' AND created_at BETWEEN ? AND ?")
    .get(roundId, ...range) as { s: number }).s;
  const fees = (db.prepare("SELECT COALESCE(SUM(-amount_cents),0) AS s FROM ledger_entries WHERE round_id = ? AND type = 'fee' AND created_at BETWEEN ? AND ?")
    .get(roundId, ...range) as { s: number }).s;
  const tokens = (db.prepare('SELECT COALESCE(SUM(tokens_used),0) AS s FROM checkins WHERE round_id = ? AND ts BETWEEN ? AND ?')
    .get(roundId, ...range) as { s: number }).s;
  const events = (db.prepare('SELECT kind, message FROM event_log WHERE round_id = ? AND created_at BETWEEN ? AND ? ORDER BY id')
    .all(roundId, ...range) as { kind: string; message: string }[]).map((e) => `[${e.kind}] ${e.message}`);
  const journals = (db.prepare("SELECT note FROM journal_entries WHERE round_id = ? AND author = 'agent' AND created_at BETWEEN ? AND ? ORDER BY id")
    .all(roundId, ...range) as { note: string }[]).map((j) => j.note);
  return { trades, skimsCents: skims, feesCents: fees, tokensUsed: tokens, events, journals };
}

function digestFallbackNarrative(digest: DailyDigest): string {
  return `${digest.trades} trade(s), $${(digest.skimsCents / 100).toFixed(2)} pocketed, $${(digest.feesCents / 100).toFixed(2)} fees.`;
}

/** Spec §4.3: one summary row per active round-day; narrative via one small runner call. */
export async function runDailySummaries(deps: SummaryDeps, runner: AgentRunner, day: string): Promise<void> {
  const { db } = deps;
  // Activity = trades or check-ins that day. Deliberately NOT event_log —
  // round_created/config events alone don't warrant a daily narrative.
  const roundIds = (db.prepare(
    `SELECT DISTINCT round_id AS id FROM (
       SELECT round_id, executed_at AS at FROM trades
       UNION ALL SELECT round_id, ts FROM checkins
     ) WHERE at BETWEEN ? AND ?`,
  ).all(`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`) as { id: number }[]).map((r) => r.id);

  for (const roundId of roundIds) {
    const existing = db.prepare('SELECT 1 FROM daily_summaries WHERE round_id = ? AND day = ?').get(roundId, day);
    if (existing) continue;
    const digest = buildDailyDigest(db, roundId, day);
    let narrative = digestFallbackNarrative(digest);
    try {
      const result = await runner.run({
        model: deps.rounds.config(roundId).model,
        systemPrompt:
          'You summarize one day of a paper-trading agent. Write 1-3 sentences: what was done, why (from the journals), and what to watch tomorrow. First person, past tense, no preamble.',
        prompt: `Digest — trades: ${digest.trades}, pocketed: $${(digest.skimsCents / 100).toFixed(2)}, fees: $${(digest.feesCents / 100).toFixed(2)}.\nEvents:\n${digest.events.join('\n') || '(none)'}\nJournals:\n${digest.journals.join('\n') || '(none)'}`,
        tools: [],
        maxTurns: SUMMARY_MODEL_MAX_TURNS,
      });
      if (result.status === 'success' && result.text.trim() !== '') narrative = result.text.trim();
    } catch {
      // fall back to the deterministic narrative; never block the job
    }
    db.prepare('INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(roundId, day, JSON.stringify(digest), narrative, new Date().toISOString());
    logEvent(db, 'info', 'daily_summary', `round ${roundId} daily summary written for ${day}`, roundId);

    await maybeCompressHistory(deps, runner, roundId);
  }
}

/** Regenerate the round-lifetime abstract when more than 7 dated summaries exist (spec §4.3). */
async function maybeCompressHistory(deps: SummaryDeps, runner: AgentRunner, roundId: number): Promise<void> {
  const { db } = deps;
  const older = db.prepare(
    "SELECT day, narrative FROM daily_summaries WHERE round_id = ? AND day != 'abstract' ORDER BY day DESC LIMIT -1 OFFSET 7",
  ).all(roundId) as { day: string; narrative: string | null }[];
  if (older.length === 0) return;
  let abstractText = older.map((s) => `${s.day}: ${s.narrative ?? ''}`).join('\n');
  try {
    const result = await runner.run({
      model: deps.rounds.config(roundId).model,
      systemPrompt:
        'Compress this trading history into a short abstract (max 5 sentences) preserving strategy lessons, notable wins/losses, and standing intentions.',
      prompt: abstractText,
      tools: [],
      maxTurns: SUMMARY_MODEL_MAX_TURNS,
    });
    if (result.status === 'success' && result.text.trim() !== '') abstractText = result.text.trim();
  } catch {
    // keep the concatenated fallback
  }
  db.prepare(
    `INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, 'abstract', '{}', ?, ?)
     ON CONFLICT(round_id, day) DO UPDATE SET narrative = excluded.narrative, created_at = excluded.created_at`,
  ).run(roundId, abstractText, new Date().toISOString());
}
```

- [ ] **Step 4: Verify PASS:** `npm test -- summaries` → 6 tests; full suite → 178. tsc clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/summaries.ts backend/test/summaries.test.ts
git commit -m "feat: daily summaries, narrative and rolling history compression"
```

---

### Task 8: Agent API routes, CLI check-in, wiring, auth setup script

**Files:**
- Create: `backend/src/api/agent-routes.ts`, `backend/scripts/setup-claude-auth.sh`, `backend/.env.example`
- Modify: `backend/src/api/app.ts` (deps + mount), `backend/test/api-helper.ts` (wire DecisionService with FakeAgentRunner), `backend/src/cli.ts` (checkin command), `backend/src/index.ts` (wire runner + schedulers), `backend/package.json` (setup script)
- Test: `backend/test/api-agent.test.ts`

- [ ] **Step 1: Write the failing test** — `backend/test/api-agent.test.ts`

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cents } from '../src/engine/types.js';
import { createTestApp, loginCookie, type TestCtx } from './api-helper.js';

describe('agent API', () => {
  let ctx: TestCtx;
  let cookie: string;
  let id: number;

  beforeEach(async () => {
    ctx = createTestApp();
    cookie = await loginCookie(ctx);
    const res = await request(ctx.app).post('/api/rounds').set('Cookie', cookie).send({ name: 'r1', startingBalanceCents: cents(50) });
    id = res.body.id as number;
  });

  it('requires auth', async () => {
    expect((await request(ctx.app).get(`/api/rounds/${id}/checkins`)).status).toBe(401);
  });

  it('triggers a manual check-in and records it', async () => {
    const res = await request(ctx.app).post(`/api/rounds/${id}/checkin`).set('Cookie', cookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    const checkins = await request(ctx.app).get(`/api/rounds/${id}/checkins`).set('Cookie', cookie);
    expect(checkins.body).toHaveLength(1);
    expect(checkins.body[0].status).toBe('success');
  });

  it('serves journal entries and daily summaries', async () => {
    ctx.db.prepare("INSERT INTO journal_entries (round_id, author, note, created_at) VALUES (?, 'agent', 'note', ?)")
      .run(id, new Date().toISOString());
    ctx.db.prepare("INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, '2026-08-01', '{}', 'n', ?)")
      .run(id, new Date().toISOString());
    expect((await request(ctx.app).get(`/api/rounds/${id}/journal`).set('Cookie', cookie)).body).toHaveLength(1);
    expect((await request(ctx.app).get(`/api/rounds/${id}/summaries`).set('Cookie', cookie)).body).toHaveLength(1);
  });

  it('404s on unknown rounds', async () => {
    expect((await request(ctx.app).post('/api/rounds/999/checkin').set('Cookie', cookie).send({})).status).toBe(404);
  });
});
```

- [ ] **Step 2: Verify FAIL:** `npm test -- api-agent`.

- [ ] **Step 3: Create `backend/src/api/agent-routes.ts`**

```ts
import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import type { DecisionService } from '../agent/decision.js';
import { requireSession } from './middleware.js';

export function agentRoutes(db: DB, auth: AuthService, decision: DecisionService): Router {
  const router = Router();
  router.use('/api/rounds/:id/checkin', requireSession(auth));
  router.use('/api/rounds/:id/checkins', requireSession(auth));
  router.use('/api/rounds/:id/journal', requireSession(auth));
  router.use('/api/rounds/:id/summaries', requireSession(auth));

  function exists(idParam: string, res: import('express').Response): number | null {
    const id = Number(idParam);
    if (!db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id)) {
      res.status(404).json({ error: 'round not found' });
      return null;
    }
    return id;
  }

  router.post('/api/rounds/:id/checkin', async (req, res) => {
    const id = exists(req.params.id, res);
    if (id === null) return;
    const outcome = await decision.runCheckin(id);
    res.json(outcome);
  });

  const LISTS: Record<string, string> = {
    checkins: 'SELECT id, ts, status, tokens_used, actions_json FROM checkins WHERE round_id = ? ORDER BY id DESC LIMIT 200',
    journal: 'SELECT id, checkin_id, author, note, created_at FROM journal_entries WHERE round_id = ? ORDER BY id DESC LIMIT 500',
    summaries: "SELECT day, digest_json, narrative, created_at FROM daily_summaries WHERE round_id = ? ORDER BY day DESC LIMIT 400",
  };
  for (const [name, sql] of Object.entries(LISTS)) {
    router.get(`/api/rounds/:id/${name}`, (req, res) => {
      const id = exists(req.params.id, res);
      if (id === null) return;
      res.json(db.prepare(sql).all(id));
    });
  }

  return router;
}
```

- [ ] **Step 4: Wire into the app + test helper.**

In `backend/src/api/app.ts`: add `decision: DecisionService` to `ApiDeps` (import the type), and mount `app.use(agentRoutes(deps.db, deps.auth, deps.decision));` after `eventsRoutes`.

In `backend/test/api-helper.ts`: construct and pass a DecisionService backed by a scripted FakeAgentRunner that only journals:

```ts
import { DecisionService } from '../src/agent/decision.js';
import { FakeAgentRunner } from './agent-helper.js';
// inside createTestApp(), before buildApp:
const decision = new DecisionService({ db, rounds, market }, new FakeAgentRunner([{ tool: 'write_journal', args: { note: 'checked in' } }], 'All quiet.'));
const app = buildApp({ db, auth, settings, rounds, market, decision });
// expose `decision` on TestCtx too.
```

- [ ] **Step 5: Verify PASS:** `npm test -- api-agent` → 4 tests; full suite → 182. tsc clean.

- [ ] **Step 6: Add the CLI command** — in `backend/src/cli.ts`, add a `checkin` branch (uses the REAL SdkAgentRunner; this is the manual live-smoke path):

```ts
  if (command === 'checkin') {
    const roundId = Number(args[0]);
    if (!Number.isInteger(roundId)) {
      console.error('usage: npm run cli -- checkin <roundId>');
      process.exit(1);
    }
    const { PaperBroker } = await import('./broker/paper.js');
    const { RoundService } = await import('./rounds/service.js');
    const { MarketDataService } = await import('./market/data.js');
    const { yahooFetcher } = await import('./market/yahoo.js');
    const { DecisionService } = await import('./agent/decision.js');
    const { SdkAgentRunner } = await import('./agent/sdk-runner.js');
    const rounds = new RoundService(db, new PaperBroker(db));
    const market = new MarketDataService(db, yahooFetcher);
    const decision = new DecisionService({ db, rounds, market }, new SdkAgentRunner());
    const outcome = await decision.runCheckin(roundId);
    console.log(`check-in: ${outcome.status} (${outcome.detail})`);
    return;
  }
```

- [ ] **Step 7: Wire `backend/src/index.ts`** — construct `SdkAgentRunner` + `DecisionService`, pass `decision` into `buildApp`, start the check-in scheduler and the daily summary cron. Add after the dispatcher wiring:

```ts
import { DecisionService } from './agent/decision.js';
import { SdkAgentRunner } from './agent/sdk-runner.js';
import { startCheckinScheduler } from './agent/checkin-scheduler.js';
import { runDailySummaries } from './agent/summaries.js';
import cron from 'node-cron';
// ...
const runner = new SdkAgentRunner();
const decision = new DecisionService({ db, rounds, market }, runner);
if (!process.env.ANTHROPIC_BASE_URL || !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn('ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN not set — check-ins will fail until scripts/setup-claude-auth.sh is run and the env configured');
}
const stopCheckins = startCheckinScheduler(db, decision);
const summaryTask = cron.schedule('10 8 * * *', () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  void runDailySummaries({ db, rounds }, runner, yesterday);
}, { timezone: 'Australia/Sydney' });
// buildApp now takes { db, auth, settings, rounds, market, decision }
// shutdown(): also stopCheckins() and void summaryTask.stop()
```

- [ ] **Step 8: Create `backend/scripts/setup-claude-auth.sh`** (nanoclaw pattern; interactive, host-side, NOT run in CI)

```bash
#!/usr/bin/env bash
set -euo pipefail

# Registers your Claude subscription with the local OneCLI gateway so the
# backend can call Claude without ever holding a real token (spec §4.1).
#
# Flow (mirrors nanoclaw's register-claude-token.sh):
#   1. claude setup-token  → browser OAuth, captures an sk-ant-oat… token
#   2. onecli secrets create --type anthropic --host-pattern api.anthropic.com
#   3. Prints the env values the backend needs.

SECRET_NAME="${SECRET_NAME:-Anthropic}"
HOST_PATTERN="${HOST_PATTERN:-api.anthropic.com}"

command -v onecli >/dev/null || {
  echo "onecli not found. Install the OneCLI gateway first (see https://github.com/nanocoai/nanoclaw setup docs), then re-run." >&2
  exit 1
}
command -v claude >/dev/null || {
  echo "Claude Code CLI not found. Install it first: curl -fsSL https://claude.ai/install.sh | bash" >&2
  exit 1
}
command -v script >/dev/null || { echo "script(1) is required for PTY capture." >&2; exit 1; }

tmpfile=$(mktemp -t claude-setup-token.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT

echo "A browser window will open to sign in with your Claude account."
read -r -p "Press Enter to run 'claude setup-token' (Ctrl-C to abort)… " _ </dev/tty

if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c "claude setup-token" "$tmpfile"
else
  script -q "$tmpfile" claude setup-token
fi

token=$(tr -d '\r' <"$tmpfile" | grep -oE 'sk-ant-oat[A-Za-z0-9_-]+AA' | tail -1 || true)
if [ -z "$token" ]; then
  echo "No sk-ant-oat… token found in the capture. Raw log kept at: $tmpfile" >&2
  trap - EXIT
  exit 1
fi

echo "Got token: ${token:0:16}…${token: -4}"
onecli secrets create --name "$SECRET_NAME" --type anthropic --value "$token" --host-pattern "$HOST_PATTERN"

gateway=$(onecli config get api-host 2>/dev/null | grep -oE 'https?://[^" ]+' | head -1 || true)
echo
echo "Done. Set these in backend/.env (see .env.example):"
echo "  ANTHROPIC_BASE_URL=${gateway:-<your onecli gateway url>}"
echo "  ANTHROPIC_AUTH_TOKEN=placeholder"
```

Run `chmod +x backend/scripts/setup-claude-auth.sh`.

- [ ] **Step 9: Create `backend/.env.example`**

```
# Server
PORT=3000
DB_PATH=./data/portfolio.db

# Claude auth via OneCLI gateway (run scripts/setup-claude-auth.sh once).
# The real subscription token lives in the OneCLI vault, never here.
ANTHROPIC_BASE_URL=http://localhost:8080
ANTHROPIC_AUTH_TOKEN=placeholder
```

- [ ] **Step 10: Final verification**

Run: `npx tsc --noEmit && npm run build && npm test`
Expected: clean, 182 passing. Then the boot smoke check from Plan 2 Task 11 (server must still boot; the ANTHROPIC warning printing is expected when env is unset).

- [ ] **Step 11: Commit**

```bash
git add backend/src/api backend/src/agent backend/src/cli.ts backend/src/index.ts backend/scripts backend/.env.example backend/test/api-agent.test.ts backend/test/api-helper.ts
git commit -m "feat: agent routes, CLI check-in, scheduler wiring, OneCLI auth setup"
```

---

## Done Criteria

- Full suite green (~182 tests); build compiles; server boots with schedulers wired.
- A check-in is fully exercisable three ways: scheduled (cron), API (`POST /api/rounds/:id/checkin`), CLI (`npm run cli -- checkin <id>` — the live path once `setup-claude-auth.sh` + env are configured).
- Spec coverage: §4.1 auth (OneCLI script, env-only config, SDK constrained runner), §4.2 check-in contract (snapshot, four tools, guardrail-validated, failure-skip), §4.3 daily summaries + rolling history + abstract compression, §2.4–2.5 personas with config overrides.
- The Agent SDK is imported in exactly one file; every behavior around it is tested with the scripted fake.
- Deferred: research briefing content (phase 3 of the spec's roadmap), frontend + Docker (Plan 4).
