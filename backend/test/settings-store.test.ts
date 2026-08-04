import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings/store.js';

describe('SettingsStore', () => {
  let db: DB;
  let store: SettingsStore;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    store = new SettingsStore(db);
  });

  it('returns defaults when nothing is stored', () => {
    expect(store.get('roundDefaults')).toEqual(DEFAULT_SETTINGS.roundDefaults);
    expect(store.get('lookAndFeel').theme).toBe('system');
  });

  it('persists and merges stored values over defaults', () => {
    store.set('lookAndFeel', { ...store.get('lookAndFeel'), theme: 'dark' });
    const laf = store.get('lookAndFeel');
    expect(laf.theme).toBe('dark');
    expect(laf.timezone).toBe(DEFAULT_SETTINGS.lookAndFeel.timezone); // untouched keys keep defaults
  });

  it('round defaults are usable to build a RoundConfig', () => {
    const d = store.get('roundDefaults');
    expect(d.startingBalanceCents).toBeGreaterThan(0);
    expect(d.guardrails).toHaveProperty('stopLossPct');
  });

  it('returns all settings namespaces', () => {
    const all = store.all();
    expect(Object.keys(all).sort()).toEqual([
      'integrations', 'lookAndFeel', 'notifications', 'roundDefaults', 'usageGate',
    ]);
  });

  it('returns usage gate defaults', () => {
    const gate = store.get('usageGate');
    expect(gate).toEqual({ enabled: true, sessionThresholdPct: 80, weeklyThresholdPct: 90 });
  });

  it('does not let mutation of a returned object corrupt defaults', () => {
    const d = store.get('roundDefaults');
    d.watchlist.push('HACK');
    expect(store.get('roundDefaults').watchlist).not.toContain('HACK');
  });
});
