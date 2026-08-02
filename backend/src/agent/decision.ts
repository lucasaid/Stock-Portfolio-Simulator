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
