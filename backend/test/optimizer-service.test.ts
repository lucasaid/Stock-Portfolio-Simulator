import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { OptimizerService } from '../src/optimizer/service.js';
import { SettingsStore } from '../src/settings/store.js';
import { FakeAgentRunner } from './agent-helper.js';

function seedRound(db: DB, name: string): number {
  const now = new Date().toISOString();
  return Number(
    db.prepare(
      `INSERT INTO rounds (name, status, starting_balance_cents, cash_cents, profit_goal_cents, config_json, created_at, updated_at)
       VALUES (?, 'active', 5000, 5000, 100000, '{}', ?, ?)`,
    ).run(name, now, now).lastInsertRowid,
  );
}

function seedCheckin(db: DB, roundId: number, ts: string): void {
  db.prepare(
    `INSERT INTO checkins (round_id, ts, snapshot_json, actions_json, status, tokens_used, cost_usd)
     VALUES (?, ?, '{}', '[{"tool":"write_journal","args":{},"ok":true,"detail":"ok"}]', 'success', 100, 0.01)`,
  ).run(roundId, ts);
}

describe('OptimizerService', () => {
  let db: DB;
  let settings: SettingsStore;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    settings = new SettingsStore(db);
  });

  it('never throws and records an error row when the runner fails', async () => {
    const failing = new FakeAgentRunner([], '', { status: 'error', subtype: 'error_max_turns' });
    const svc = new OptimizerService({ db, settings }, failing);
    const outcome = await svc.run(false);
    expect(outcome.status).toBe('error');
    const rows = svc.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('error');
  });

  it("records a success row with the runner's tokens/cost and output text", async () => {
    const runner = new FakeAgentRunner([], '## Findings\n...\n## Implementation prompt\n...', {
      status: 'success', inputTokens: 400, outputTokens: 100, costUsd: 0.03,
    });
    const svc = new OptimizerService({ db, settings }, runner);
    const outcome = await svc.run(true);
    expect(outcome.status).toBe('success');
    const rows = svc.list();
    expect(rows[0]!.tokens_used).toBe(500);
    expect(rows[0]!.cost_usd).toBeCloseTo(0.03);
    expect(rows[0]!.web_search_enabled).toBe(true);
    expect(rows[0]!.output).toContain('Implementation prompt');
  });

  it('caps input to the most recent 200 check-ins across all rounds', async () => {
    const roundId = seedRound(db, 'round A');
    for (let i = 0; i < 250; i++) {
      seedCheckin(db, roundId, new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60_000).toISOString());
    }
    const runner = new FakeAgentRunner([], 'ok');
    const svc = new OptimizerService({ db, settings }, runner);
    await svc.run(false);
    const sentPrompt = runner.requests[0]!.prompt;
    // The oldest seeded check-in (i=0) must have been excluded by the 200-row cap.
    expect(sentPrompt).not.toContain('2026-01-01T00:00:00.000Z');
    // The most recent one must be present.
    expect(sentPrompt).toContain(new Date(Date.parse('2026-01-01T00:00:00Z') + 249 * 60_000).toISOString());
  });

  it('rejects a second concurrent run while one is in flight', async () => {
    let resolveRun!: () => void;
    const slow = {
      async run() {
        await new Promise<void>((resolve) => { resolveRun = resolve; });
        return { status: 'success' as const, subtype: 'success', text: 'ok', inputTokens: 1, outputTokens: 1, costUsd: 0 };
      },
    };
    const svc = new OptimizerService({ db, settings }, slow);
    const first = svc.run(false);
    const second = await svc.run(false);
    expect(second).toEqual({ status: 'skipped', detail: 'an optimizer run is already in progress' });
    resolveRun();
    await first;
  });

  it('never queries the database when the usage gate blocks the run', async () => {
    const gate = { check: async () => ({ allowed: false, reason: 'session usage at 95%' }) };
    const runner = new FakeAgentRunner([], 'should not be called');
    const svc = new OptimizerService({ db, settings, usageGate: gate as never }, runner);
    const outcome = await svc.run(false);
    expect(outcome).toEqual({ status: 'skipped', detail: 'session usage at 95%' });
    expect(runner.requests).toHaveLength(0);
    expect(svc.list()).toHaveLength(0);
  });
});
