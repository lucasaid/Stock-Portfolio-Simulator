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
