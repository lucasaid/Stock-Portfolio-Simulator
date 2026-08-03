import { beforeEach, describe, expect, it } from 'vitest';
import { dueResearchRoundIds } from '../src/research/scheduler.js';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { RoundService } from '../src/rounds/service.js';

function config(cron: string[], overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'sched', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS, fees: { asxFlatCents: 0, usFxBps: 0, slippageBps: 0 },
    model: 'claude-sonnet-5', checkinCron: ['0 8 * * 1-5'], researchCron: cron, ...overrides,
  };
}

describe('dueResearchRoundIds', () => {
  let db: DB;
  let rounds: RoundService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
  });

  // 07:00 Sydney on Mon 2026-08-03 == 21:00 UTC on 2026-08-02 (AEST, UTC+10).
  const before = new Date('2026-08-02T20:59:30Z');
  const after = new Date('2026-08-02T21:00:30Z');

  it('returns a round whose researchCron fired inside the window', () => {
    const id = rounds.create(config(['0 7 * * 1-5']));
    expect(dueResearchRoundIds(db, before, after)).toEqual([id]);
  });

  it('does not return rounds whose researchCron did not fire', () => {
    rounds.create(config(['0 8 * * 1-5']));
    expect(dueResearchRoundIds(db, before, after)).toEqual([]);
  });

  it('ignores non-active rounds', () => {
    const id = rounds.create(config(['0 7 * * 1-5']));
    rounds.setStatus(id, 'paused', 'test');
    expect(dueResearchRoundIds(db, before, after)).toEqual([]);
  });

  it('treats a config with no researchCron field as "no research", never crashing', () => {
    const id = rounds.create(config(['0 7 * * 1-5']));
    const row = db.prepare('SELECT config_json FROM rounds WHERE id = ?').get(id) as { config_json: string };
    const stripped = JSON.parse(row.config_json) as Record<string, unknown>;
    delete stripped.researchCron;
    db.prepare('UPDATE rounds SET config_json = ? WHERE id = ?').run(JSON.stringify(stripped), id);

    expect(() => dueResearchRoundIds(db, before, after)).not.toThrow();
    expect(dueResearchRoundIds(db, before, after)).toEqual([]);
  });

  it('skips invalid cron expressions without throwing and flags them in the event log', () => {
    rounds.create(config(['not a cron']));
    expect(dueResearchRoundIds(db, before, after)).toEqual([]);
    const event = db.prepare("SELECT kind FROM event_log WHERE kind = 'bad_research_cron'").get();
    expect(event).toBeTruthy();
  });
});
