import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { SettingsStore } from '../settings/store.js';
import type { UsageChecker, UsageSnapshot } from './usage-checker.js';

export interface UsageGateDeps {
  db: DB;
  settings: SettingsStore;
}

export interface UsageStatus {
  snapshot: UsageSnapshot;
  enabled: boolean;
  sessionThresholdPct: number;
  weeklyThresholdPct: number;
  sessionGated: boolean;
  weeklyGated: boolean;
}

/** Bounds subprocess overhead across multiple schedulers ticking close together. Not user-configurable. */
const CACHE_TTL_MS = 60_000;

/**
 * Sits in front of every AI call site (check-ins, research, market-scan, CLI checkin).
 * Fail-open: a broken usage check (parse error, binary missing, onecli down, timeout — all
 * surface as an all-null UsageSnapshot from the UsageChecker) never blocks a run; it only
 * logs a warn-level `usage_check_failed` event so the failure stays visible without stopping
 * the app from trading/researching.
 */
export class UsageGateService {
  private cached: { snapshot: UsageSnapshot; checkedAt: number } | null = null;

  constructor(private deps: UsageGateDeps, private checker: UsageChecker) {}

  /** Full status for the /api/usage route (settings page + shell banner). */
  async status(): Promise<UsageStatus> {
    const settings = this.deps.settings.get('usageGate');
    const { snapshot, fresh } = await this.snapshot();

    if (fresh && snapshot.sessionPct === null && snapshot.weeklyPct === null) {
      logEvent(this.deps.db, 'warn', 'usage_check_failed', 'usage check returned no data — failing open');
    }

    const sessionGated = snapshot.sessionPct !== null && snapshot.sessionPct >= settings.sessionThresholdPct;
    const weeklyGated = snapshot.weeklyPct !== null && snapshot.weeklyPct >= settings.weeklyThresholdPct;
    return {
      snapshot,
      enabled: settings.enabled,
      sessionThresholdPct: settings.sessionThresholdPct,
      weeklyThresholdPct: settings.weeklyThresholdPct,
      sessionGated,
      weeklyGated,
    };
  }

  /** Called by every AI call site before starting an agent run. */
  async check(): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.status();
    if (!status.enabled) return { allowed: true };
    if (!status.sessionGated && !status.weeklyGated) return { allowed: true };

    const reasons: string[] = [];
    if (status.sessionGated) {
      reasons.push(
        `session usage ${status.snapshot.sessionPct}% >= ${status.sessionThresholdPct}% threshold ` +
          `(resets ${status.snapshot.sessionResetsAt ?? 'unknown'})`,
      );
    }
    if (status.weeklyGated) {
      reasons.push(
        `weekly usage ${status.snapshot.weeklyPct}% >= ${status.weeklyThresholdPct}% threshold ` +
          `(resets ${status.snapshot.weeklyResetsAt ?? 'unknown'})`,
      );
    }
    return { allowed: false, reason: reasons.join('; ') };
  }

  private async snapshot(): Promise<{ snapshot: UsageSnapshot; fresh: boolean }> {
    const now = Date.now();
    if (this.cached && now - this.cached.checkedAt < CACHE_TTL_MS) {
      return { snapshot: this.cached.snapshot, fresh: false };
    }
    const snapshot = await this.checker.checkUsage();
    this.cached = { snapshot, checkedAt: now };
    return { snapshot, fresh: true };
  }
}
