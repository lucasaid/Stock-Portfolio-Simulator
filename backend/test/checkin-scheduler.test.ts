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
