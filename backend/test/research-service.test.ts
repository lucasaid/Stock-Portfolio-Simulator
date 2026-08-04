import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { ResearchService } from '../src/research/service.js';
import { RoundService } from '../src/rounds/service.js';
import { FakeAgentRunner } from './agent-helper.js';
import { SettingsStore } from '../src/settings/store.js';
import { UsageGateService } from '../src/agent/usage-gate.js';
import { FakeUsageChecker } from './usage-helper.js';

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

  it('skips the run when the usage gate blocks it', async () => {
    const settings = new SettingsStore(db);
    const usageGate = new UsageGateService(
      { db, settings },
      new FakeUsageChecker({ sessionPct: 10, sessionResetsAt: null, weeklyPct: 95, weeklyResetsAt: null }),
    );
    const runner = new FakeAgentRunner([], 'should not run');
    const outcome = await new ResearchService({ db, rounds, usageGate }, runner).runBriefing(id);

    expect(outcome.status).toBe('skipped');
    expect(outcome.detail).toContain('weekly usage 95%');
    expect(runner.requests).toHaveLength(0);
    const events = db.prepare("SELECT kind FROM event_log WHERE round_id = ? AND kind = 'usage_gated'").all(id);
    expect(events).toHaveLength(1);
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
