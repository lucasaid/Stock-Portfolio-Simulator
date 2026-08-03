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
  // The Sydney date, not the UTC one: digests bucket by the product's timezone,
  // and the two differ for ~10 hours of every day.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());

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

  it('records compressedThrough in the abstract digest after folding', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const insert = db.prepare(
      "INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, ?, '{}', ?, ?)",
    );
    for (let i = 1; i <= 8; i++) {
      insert.run(id, `2026-07-${String(i).padStart(2, '0')}`, `day ${i} note`, new Date().toISOString());
    }
    const runner = new FakeAgentRunner([], 'Compressed history.');
    await runDailySummaries({ db, rounds }, runner, today);
    const abstract = db.prepare("SELECT digest_json FROM daily_summaries WHERE round_id = ? AND day = 'abstract'").get(id) as {
      digest_json: string;
    };
    // 8 seeded (2026-07-01..08) + today's new row = 9 dated rows. The newest 7
    // (today, 07-08..07-03) stay out of the fold; 07-02 and 07-01 age out, so
    // the newest folded day is 07-02.
    expect(JSON.parse(abstract.digest_json)).toMatchObject({ compressedThrough: '2026-07-02' });
  });

  it('does not re-call the runner for compression when nothing has newly aged out', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const insert = db.prepare(
      "INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, ?, '{}', ?, ?)",
    );
    // Only 5 backlog days: even after two more active days are summarized below,
    // the round never exceeds the newest-7 window, so nothing ever ages out.
    for (let i = 1; i <= 5; i++) {
      insert.run(id, `2026-07-${String(i).padStart(2, '0')}`, `day ${i} note`, new Date().toISOString());
    }
    const runner = new FakeAgentRunner([], 'Compressed history.');

    // First run: today's trade brings the total to 6 dated rows — still under 8, no fold.
    await runDailySummaries({ db, rounds }, runner, today);
    const compressionCallsAfterFirst = runner.requests.filter((r) => r.prompt.includes('Existing summary:')).length;
    expect(compressionCallsAfterFirst).toBe(0);

    // Second run, a different day, driven by a check-in (not a real trade, since the
    // system clock can't be moved) — brings the total to 7 dated rows. Still no row
    // is pushed out of the newest-7 window, so no additional compression call.
    const otherDay = '2026-08-03';
    db.prepare(
      "INSERT INTO checkins (round_id, ts, snapshot_json, actions_json, tokens_used, status) VALUES (?, ?, '{}', '[]', 10, 'success')",
    ).run(id, `${otherDay}T10:00:00.000Z`);
    await runDailySummaries({ db, rounds }, runner, otherDay);
    const compressionCallsAfterSecond = runner.requests.filter((r) => r.prompt.includes('Existing summary:')).length;
    expect(compressionCallsAfterSecond).toBe(0);
  });

  it('records the narrative call token spend on the summary row', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    await runDailySummaries({ db, rounds }, new FakeAgentRunner([], 'A quiet day.'), today);
    const row = db.prepare('SELECT digest_json FROM daily_summaries WHERE round_id = ? AND day = ?').get(id, today) as {
      digest_json: string;
    };
    const digest = JSON.parse(row.digest_json) as { narrativeTokens: number; narrativeCostUsd: number; trades: number };
    expect(digest.narrativeTokens).toBe(1200); // fake runner: 1000 in + 200 out
    expect(digest.narrativeCostUsd).toBe(0);
    expect(digest.trades).toBe(1); // deterministic digest fields survive
  });

  it('records zero narrative tokens when the runner fails', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const runner = {
      run: async () => {
        throw new Error('down');
      },
    };
    await runDailySummaries({ db, rounds }, runner, today);
    const row = db.prepare('SELECT digest_json FROM daily_summaries WHERE round_id = ? AND day = ?').get(id, today) as {
      digest_json: string;
    };
    expect((JSON.parse(row.digest_json) as { narrativeTokens: number }).narrativeTokens).toBe(0);
  });

  it('records compression token spend alongside compressedThrough', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), q(10), 1, 'agent');
    const insert = db.prepare(
      "INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, ?, '{}', ?, ?)",
    );
    for (let i = 1; i <= 8; i++) {
      insert.run(id, `2026-07-${String(i).padStart(2, '0')}`, `day ${i} note`, new Date().toISOString());
    }
    await runDailySummaries({ db, rounds }, new FakeAgentRunner([], 'Compressed history.'), today);
    const abstract = db
      .prepare("SELECT digest_json FROM daily_summaries WHERE round_id = ? AND day = 'abstract'")
      .get(id) as { digest_json: string };
    const parsed = JSON.parse(abstract.digest_json) as { compressedThrough: string; compressionTokens: number };
    expect(parsed.compressedThrough).toBeTruthy();
    expect(parsed.compressionTokens).toBe(1200);
  });

  it('buckets a US overnight session into the Sydney day the operator lived through', () => {
    // 2026-08-03 20:00 UTC is the US afternoon session; in Sydney it is already
    // 06:00 on the 4th. Bucketing by UTC put it on the 3rd — a day early.
    db.prepare(
      `INSERT INTO orders (id, round_id, client_order_id, symbol, side, status, placed_by, created_at)
       VALUES (900, ?, 'overnight', 'AAPL', 'buy', 'filled', 'agent', '2026-08-03T20:00:00.000Z')`,
    ).run(id);
    db.prepare(
      `INSERT INTO trades (order_id, round_id, symbol, side, quantity, price_aud, gross_cents, fee_cents, executed_at)
       VALUES (900, ?, 'AAPL', 'buy', 1, 10, 1000, 0, '2026-08-03T20:00:00.000Z')`,
    ).run(id);

    expect(buildDailyDigest(db, id, '2026-08-04').trades).toBe(1);
    expect(buildDailyDigest(db, id, '2026-08-03').trades).toBe(0);
  });
});
