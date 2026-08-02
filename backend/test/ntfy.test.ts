import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { logEvent } from '../src/db/events.js';
import { migrate } from '../src/db/migrate.js';
import { NotificationDispatcher, NtfyNotifier } from '../src/notify/ntfy.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings/store.js';

describe('NtfyNotifier', () => {
  it('POSTs to url/topic with title, priority and tags', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const notifier = new NtfyNotifier(
      () => ({ url: 'https://ntfy.example', topic: 'trades', enabled: true }),
      fetchFn as unknown as typeof fetch,
    );
    await notifier.send('Trade executed', 'bought AAPL', 3, ['chart_with_upwards_trend']);
    expect(fetchFn).toHaveBeenCalledWith('https://ntfy.example/trades', {
      method: 'POST',
      body: 'bought AAPL',
      headers: { Title: 'Trade executed', Priority: '3', Tags: 'chart_with_upwards_trend' },
    });
  });

  it('does nothing when disabled or unconfigured', async () => {
    const fetchFn = vi.fn();
    const notifier = new NtfyNotifier(
      () => ({ url: 'https://ntfy.example', topic: '', enabled: false }),
      fetchFn as unknown as typeof fetch,
    );
    await notifier.send('x', 'y', 3);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never throws on network failure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('net down'));
    const notifier = new NtfyNotifier(
      () => ({ url: 'https://ntfy.example', topic: 't', enabled: true }),
      fetchFn as unknown as typeof fetch,
    );
    await expect(notifier.send('x', 'y', 3)).resolves.toBeUndefined();
  });
});

describe('NotificationDispatcher', () => {
  let db: DB;
  let settings: SettingsStore;
  let sent: { title: string; message: string; priority: number }[];
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    settings = new SettingsStore(db);
    settings.set('integrations', {
      ...DEFAULT_SETTINGS.integrations,
      ntfy: { url: 'https://ntfy.example', topic: 't', enabled: true },
    });
    sent = [];
    const fetchFn = (async (url: unknown, init: { body: string; headers: Record<string, string> }) => {
      sent.push({ title: init.headers.Title!, message: init.body, priority: Number(init.headers.Priority) });
      return { ok: true };
    }) as unknown as typeof fetch;
    dispatcher = new NotificationDispatcher(db, settings, new NtfyNotifier(() => settings.get('integrations').ntfy, fetchFn));
  });

  it('sends mapped notifications for new events only', async () => {
    logEvent(db, 'info', 'trade', 'round 1 buy 2 AAPL @ 10.0000 AUD', 1); // pre-start: skipped
    dispatcher.resetCursor();
    logEvent(db, 'info', 'skim', 'round 1 pocketed 2000 cents', 1);
    logEvent(db, 'warn', 'stop_loss', 'round 1 stop-loss on AAPL', 1);
    logEvent(db, 'info', 'irrelevant_kind', 'ignored');
    const count = await dispatcher.dispatchNew();
    expect(count).toBe(2);
    expect(sent.map((s) => s.title)).toEqual(['Profit pocketed', 'Stop-loss fired']);
    expect(sent[0]!.priority).toBe(4);
  });

  it('maps round_status messages to goal/busted/drawdown rules', async () => {
    dispatcher.resetCursor();
    logEvent(db, 'info', 'round_status', 'round 1 → goal_reached: profit goal reached', 1);
    logEvent(db, 'info', 'round_status', 'round 2 → busted: cash and holdings exhausted', 2);
    logEvent(db, 'info', 'round_status', 'round 3 → paused: drawdown pause breached', 3);
    logEvent(db, 'info', 'round_status', 'round 4 → paused: operator pause', 4); // no rule → skipped
    const count = await dispatcher.dispatchNew();
    expect(count).toBe(3);
    expect(sent.map((s) => s.priority)).toEqual([5, 5, 4]);
  });

  it('respects per-kind toggles', async () => {
    settings.set('notifications', { ...settings.get('notifications'), skim: false });
    dispatcher.resetCursor();
    logEvent(db, 'info', 'skim', 'round 1 pocketed 100 cents', 1);
    expect(await dispatcher.dispatchNew()).toBe(0);
  });

  it('is idempotent across calls (cursor advances)', async () => {
    dispatcher.resetCursor();
    logEvent(db, 'info', 'skim', 'x', 1);
    expect(await dispatcher.dispatchNew()).toBe(1);
    expect(await dispatcher.dispatchNew()).toBe(0);
  });
});
