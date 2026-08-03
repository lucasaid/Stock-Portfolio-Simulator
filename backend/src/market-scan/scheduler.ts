import type { DB } from '../db/connection.js';
import type { RoundConfig } from '../engine/types.js';
import type { MarketScanService } from './service.js';

const WEEKLY_MS = 7 * 24 * 3_600_000;

/**
 * Rounds due for a scan right now. Not cron-based (unlike check-ins/research) — a
 * fixed rule: weekly for autoWatchlist:true, or a one-time bootstrap when off with
 * an empty watchlist. A prior scan row of ANY status (success or error) satisfies
 * the bootstrap case and resets the weekly clock — a persistently-failing scan must
 * not spin every tick; an operator can always retrigger by hand via the API.
 */
export function dueMarketScanRoundIds(db: DB, now: Date): number[] {
  const rows = db.prepare("SELECT id, config_json FROM rounds WHERE status = 'active'").all() as {
    id: number;
    config_json: string;
  }[];
  const due: number[] = [];
  for (const row of rows) {
    const config = JSON.parse(row.config_json) as RoundConfig;
    const last = db
      .prepare('SELECT created_at FROM market_scans WHERE round_id = ? ORDER BY id DESC LIMIT 1')
      .get(row.id) as { created_at: string } | undefined;

    if (config.autoWatchlist === true) {
      if (!last || now.getTime() - Date.parse(last.created_at) >= WEEKLY_MS) due.push(row.id);
    } else if (config.watchlist.length === 0 && !last) {
      due.push(row.id);
    }
  }
  return due;
}

/** Minute tick, mirroring startCheckinScheduler/startResearchScheduler's never-overlap guard. */
export function startMarketScanScheduler(db: DB, scans: MarketScanService, intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    const due = dueMarketScanRoundIds(db, new Date());
    if (due.length === 0) return;
    running = true;
    void (async () => {
      for (const roundId of due) await scans.runScan(roundId); // never throws
      running = false;
    })();
  }, intervalMs);
  return () => clearInterval(timer);
}
