import type { DB } from '../db/connection.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, type RoundConfig } from '../engine/types.js';

export interface NtfySettings {
  url: string;
  topic: string;
  enabled: boolean;
}

export interface IntegrationSettings {
  ntfy: NtfySettings;
  pollIntervalMinutes: number;
}

export interface LookAndFeelSettings {
  theme: 'light' | 'dark' | 'system';
  accent: string;
  chartStyle: 'line' | 'candles';
  timezone: string;
}

/** Per-event-kind on/off switches for ntfy (spec §8). */
export type NotificationToggles = Record<string, boolean>;

export interface Settings {
  roundDefaults: Omit<RoundConfig, 'name'>;
  integrations: IntegrationSettings;
  lookAndFeel: LookAndFeelSettings;
  notifications: NotificationToggles;
}

export const DEFAULT_SETTINGS: Settings = {
  roundDefaults: {
    startingBalanceCents: 5_000,
    profitGoalCents: 100_000,
    markets: ['US'],
    watchlist: ['AAPL', 'MSFT'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS,
    fees: DEFAULT_FEES,
    model: 'claude-sonnet-5',
    checkinCron: ['30 23 * * 1-5'], // ~US open, AEST evening
  },
  integrations: {
    ntfy: { url: 'https://ntfy.sh', topic: '', enabled: false },
    pollIntervalMinutes: 5,
  },
  lookAndFeel: {
    theme: 'system',
    accent: '#6E56CF',
    chartStyle: 'line',
    timezone: 'Australia/Sydney',
  },
  notifications: {
    trade: true,
    skim: true,
    goal: true,
    stop_loss: true,
    drawdown: true,
    busted: true,
    error: true,
  },
};

export class SettingsStore {
  constructor(private db: DB) {}

  get<K extends keyof Settings>(key: K): Settings[K] {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    const defaults = structuredClone(DEFAULT_SETTINGS[key]);
    if (!row) return defaults;
    return { ...defaults, ...(JSON.parse(row.value_json) as Partial<Settings[K]>) };
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  all(): Settings {
    return {
      roundDefaults: this.get('roundDefaults'),
      integrations: this.get('integrations'),
      lookAndFeel: this.get('lookAndFeel'),
      notifications: this.get('notifications'),
    };
  }
}
