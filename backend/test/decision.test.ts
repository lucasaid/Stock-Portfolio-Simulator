import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { ResearchService } from '../src/research/service.js';
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

  it('refuses a concurrent check-in for the same round', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowRunner = {
      run: async () => {
        await gate;
        return { status: 'success' as const, subtype: 'success', text: '', inputTokens: 1, outputTokens: 1, costUsd: 0 };
      },
    };
    const decision = new DecisionService({ db, rounds, market }, slowRunner);
    const first = decision.runCheckin(id);
    const second = await decision.runCheckin(id);
    expect(second.status).toBe('skipped');
    expect(second.detail).toMatch(/already running/);
    release();
    expect((await first).status).toBe('success');
    expect(db.prepare('SELECT COUNT(*) AS c FROM checkins WHERE round_id = ?').get(id)).toEqual({ c: 1 });
  });

  it('clears the in-flight guard so a later check-in can run', async () => {
    const decision = new DecisionService({ db, rounds, market }, new FakeAgentRunner([], 'done'));
    expect((await decision.runCheckin(id)).status).toBe('success');
    expect((await decision.runCheckin(id)).status).toBe('success');
    expect(db.prepare('SELECT COUNT(*) AS c FROM checkins WHERE round_id = ?').get(id)).toEqual({ c: 2 });
  });

  it('feeds a fresh research briefing into the snapshot', async () => {
    const research = new ResearchService({ db, rounds }, new FakeAgentRunner([], 'AAPL: nothing material (Reuters).'));
    await research.runBriefing(id);

    const captured: string[] = [];
    const runner = {
      run: async (request: { prompt: string }) => {
        captured.push(request.prompt);
        return { status: 'success' as const, subtype: 'success', text: 'ok', inputTokens: 1, outputTokens: 1, costUsd: 0 };
      },
    };
    await new DecisionService({ db, rounds, market, research }, runner).runCheckin(id);

    expect(captured[0]).toContain('AAPL: nothing material (Reuters).');
    expect(captured[0]).toMatch(/untrusted research briefing/i);
  });

  it('ignores a stale research briefing rather than feeding it in', async () => {
    const research = new ResearchService({ db, rounds }, new FakeAgentRunner([], 'stale briefing text'));
    await research.runBriefing(id);
    db.prepare("UPDATE research_briefings SET created_at = '2020-01-01T00:00:00.000Z' WHERE round_id = ?").run(id);

    const captured: string[] = [];
    const runner = {
      run: async (request: { prompt: string }) => {
        captured.push(request.prompt);
        return { status: 'success' as const, subtype: 'success', text: 'ok', inputTokens: 1, outputTokens: 1, costUsd: 0 };
      },
    };
    await new DecisionService({ db, rounds, market, research }, runner).runCheckin(id);

    expect(captured[0]).not.toContain('stale briefing text');
    expect(captured[0]).toContain('Research briefing: none available for this check-in.');
  });
});
