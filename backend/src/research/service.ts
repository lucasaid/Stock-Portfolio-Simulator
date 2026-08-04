import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { AgentRunner } from '../agent/types.js';
import type { RoundService } from '../rounds/service.js';
import type { UsageGateService } from '../agent/usage-gate.js';
import { buildResearchPrompt, RESEARCH_SYSTEM_PROMPT } from './prompt.js';

export interface ResearchDeps {
  db: DB;
  rounds: RoundService;
  /** Optional so existing tests keep compiling; when absent every research run is always allowed. */
  usageGate?: UsageGateService;
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
    const { rounds } = this.deps;
    const round = rounds.get(roundId);
    if (TERMINAL.includes(round.status)) {
      return { status: 'skipped', detail: `round is ${round.status}` };
    }

    if (this.deps.usageGate) {
      const gate = await this.deps.usageGate.check();
      if (!gate.allowed) {
        logEvent(this.deps.db, 'warn', 'usage_gated', gate.reason!, roundId);
        return { status: 'skipped', detail: gate.reason! };
      }
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
