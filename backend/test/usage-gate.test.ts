import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { SettingsStore } from '../src/settings/store.js';
import { UsageGateService } from '../src/agent/usage-gate.js';
import { FakeUsageChecker } from './usage-helper.js';

describe('UsageGateService', () => {
  let db: DB;
  let settings: SettingsStore;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    settings = new SettingsStore(db);
  });

  it('allows when disabled, even over threshold', async () => {
    settings.set('usageGate', { enabled: false, sessionThresholdPct: 80, weeklyThresholdPct: 90 });
    const checker = new FakeUsageChecker({ sessionPct: 99, sessionResetsAt: null, weeklyPct: 99, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    expect((await gate.check()).allowed).toBe(true);
  });

  it('allows when both percentages are under their thresholds', async () => {
    const checker = new FakeUsageChecker({ sessionPct: 10, sessionResetsAt: null, weeklyPct: 10, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    expect((await gate.check()).allowed).toBe(true);
  });

  it('blocks when session usage meets or exceeds its threshold', async () => {
    const checker = new FakeUsageChecker({
      sessionPct: 80, sessionResetsAt: 'Aug 4 at 3:20am (Australia/Melbourne)', weeklyPct: 5, weeklyResetsAt: null,
    });
    const gate = new UsageGateService({ db, settings }, checker);

    const result = await gate.check();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('session usage 80%');
    expect(result.reason).toContain('resets Aug 4 at 3:20am (Australia/Melbourne)');
  });

  it('blocks when weekly usage meets or exceeds its threshold', async () => {
    const checker = new FakeUsageChecker({ sessionPct: 5, sessionResetsAt: null, weeklyPct: 90, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    const result = await gate.check();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('weekly usage 90%');
  });

  it('fails open on a null snapshot and logs a warn event', async () => {
    const checker = new FakeUsageChecker(); // defaults to all-null
    const gate = new UsageGateService({ db, settings }, checker);

    expect((await gate.check()).allowed).toBe(true);
    const events = db.prepare("SELECT level, kind FROM event_log WHERE kind = 'usage_check_failed'").all();
    expect(events).toHaveLength(1);
    expect((events[0] as { level: string }).level).toBe('warn');
  });

  it('caches the snapshot within the TTL instead of re-checking every call', async () => {
    const checker = new FakeUsageChecker({ sessionPct: 10, sessionResetsAt: null, weeklyPct: 10, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    await gate.check();
    await gate.check();
    await gate.status();

    expect(checker.calls).toBe(1);
  });

  it('status() reports the gated booleans and configured thresholds for the API', async () => {
    const checker = new FakeUsageChecker({ sessionPct: 85, sessionResetsAt: null, weeklyPct: 20, weeklyResetsAt: null });
    const gate = new UsageGateService({ db, settings }, checker);

    const status = await gate.status();
    expect(status.enabled).toBe(true);
    expect(status.sessionThresholdPct).toBe(80);
    expect(status.weeklyThresholdPct).toBe(90);
    expect(status.sessionGated).toBe(true);
    expect(status.weeklyGated).toBe(false);
    expect(status.snapshot.sessionPct).toBe(85);
  });
});
