import type { DB } from '../db/connection.js';
import { recentEvents, latestEventId, type EventRow } from '../api/events-routes.js';
import type { NtfySettings, SettingsStore } from '../settings/store.js';

export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

/** Fire-and-forget ntfy publisher (spec §8). Never throws. */
export class NtfyNotifier {
  constructor(
    private config: () => NtfySettings,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(title: string, message: string, priority: NtfyPriority, tags: string[] = []): Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.url || !cfg.topic) return;
    const headers: Record<string, string> = { Title: title, Priority: String(priority) };
    if (tags.length > 0) headers.Tags = tags.join(',');
    try {
      await this.fetchFn(`${cfg.url.replace(/\/$/, '')}/${cfg.topic}`, { method: 'POST', body: message, headers });
    } catch {
      // Notifications are best-effort; a down ntfy server must never break trading.
    }
  }
}

interface NotifyRule {
  toggle: string;
  priority: NtfyPriority;
  title: string;
  tags: string[];
}

/** Map an event_log row to a notification, or null to skip (spec §8 priority mapping). */
export function ruleFor(event: EventRow): NotifyRule | null {
  switch (event.kind) {
    case 'trade':
      return { toggle: 'trade', priority: 3, title: 'Trade executed', tags: ['chart_with_upwards_trend'] };
    case 'skim':
      return { toggle: 'skim', priority: 4, title: 'Profit pocketed', tags: ['moneybag'] };
    case 'stop_loss':
      return { toggle: 'stop_loss', priority: 4, title: 'Stop-loss fired', tags: ['warning'] };
    case 'poll_failed':
      return { toggle: 'error', priority: 5, title: 'Market poll failed', tags: ['rotating_light'] };
    case 'kill_switch':
      return { toggle: 'error', priority: 5, title: 'Kill switch engaged', tags: ['octagonal_sign'] };
    case 'round_status':
      if (event.message.includes('goal_reached')) return { toggle: 'goal', priority: 5, title: 'Profit goal reached', tags: ['tada'] };
      if (event.message.includes('busted')) return { toggle: 'busted', priority: 5, title: 'Round busted', tags: ['skull'] };
      if (event.message.includes('drawdown')) return { toggle: 'drawdown', priority: 4, title: 'Drawdown pause', tags: ['warning'] };
      return null;
    default:
      return null;
  }
}

/** Tails event_log and forwards notifiable events to ntfy. */
export class NotificationDispatcher {
  private cursor: number;
  constructor(
    private db: DB,
    private settings: SettingsStore,
    private notifier: NtfyNotifier,
  ) {
    this.cursor = latestEventId(db);
  }

  /** Test hook / restart semantics: start tailing from the current end of the log. */
  resetCursor(): void {
    this.cursor = latestEventId(this.db);
  }

  async dispatchNew(): Promise<number> {
    const rows = recentEvents(this.db, this.cursor);
    const toggles = this.settings.get('notifications');
    let sentCount = 0;
    for (const row of rows) {
      this.cursor = row.id;
      const rule = ruleFor(row);
      if (!rule || toggles[rule.toggle] === false) continue;
      await this.notifier.send(rule.title, row.message, rule.priority, rule.tags);
      sentCount += 1;
    }
    return sentCount;
  }

  start(intervalMs = 5000): () => void {
    const timer = setInterval(() => {
      void this.dispatchNew();
    }, intervalMs);
    return () => clearInterval(timer);
  }
}
