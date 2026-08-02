import { CronExpressionParser } from 'cron-parser';
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { RoundConfig } from '../engine/types.js';
import type { DecisionService } from './decision.js';

const TIMEZONE = 'Australia/Sydney';

/** Rounds whose checkinCron fired in (previousTick, now]. Pure given the DB. */
export function dueRoundIds(db: DB, previousTick: Date, now: Date): number[] {
  const rows = db.prepare("SELECT id, config_json FROM rounds WHERE status = 'active'").all() as {
    id: number;
    config_json: string;
  }[];
  const due: number[] = [];
  for (const row of rows) {
    const config = JSON.parse(row.config_json) as RoundConfig;
    for (const expression of config.checkinCron) {
      try {
        const interval = CronExpressionParser.parse(expression, { currentDate: now, tz: TIMEZONE });
        const previous = interval.prev().toDate();
        if (previous > previousTick && previous <= now) {
          due.push(row.id);
          break;
        }
      } catch {
        logEvent(db, 'warn', 'bad_cron', `round ${row.id}: invalid checkin cron "${expression}"`, row.id);
      }
    }
  }
  return due;
}

/** Minute tick: run due check-ins sequentially. Returns a stop function. */
export function startCheckinScheduler(
  db: DB,
  decision: DecisionService,
  intervalMs = 60_000,
): () => void {
  let previousTick = new Date();
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap check-in batches
    const now = new Date();
    const due = dueRoundIds(db, previousTick, now);
    previousTick = now;
    if (due.length === 0) return;
    running = true;
    void (async () => {
      for (const roundId of due) {
        await decision.runCheckin(roundId); // never throws
      }
      running = false;
    })();
  }, intervalMs);
  return () => clearInterval(timer);
}
