import { dueRoundIdsForCron } from '../agent/checkin-scheduler.js';
import type { DB } from '../db/connection.js';
import type { ResearchService } from './service.js';

/** Rounds whose researchCron fired in (previousTick, now]. Old rounds with no researchCron read as "none". */
export function dueResearchRoundIds(db: DB, previousTick: Date, now: Date): number[] {
  return dueRoundIdsForCron(db, previousTick, now, (config) => config.researchCron ?? [], 'bad_research_cron');
}

/**
 * Minute tick: run due research passes sequentially. Mirrors
 * `startCheckinScheduler`'s catch-up-coalescing behaviour (one run after a
 * laptop wake, not five) and its never-overlap guard. Returns a stop function.
 */
export function startResearchScheduler(
  db: DB,
  research: ResearchService,
  intervalMs = 60_000,
): () => void {
  let previousTick = new Date();
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap research batches
    const now = new Date();
    const due = dueResearchRoundIds(db, previousTick, now);
    previousTick = now;
    if (due.length === 0) return;
    running = true;
    void (async () => {
      for (const roundId of due) {
        await research.runBriefing(roundId); // never throws
      }
      running = false;
    })();
  }, intervalMs);
  return () => clearInterval(timer);
}
