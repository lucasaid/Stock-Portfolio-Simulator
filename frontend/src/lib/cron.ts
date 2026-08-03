import { CronExpressionParser } from 'cron-parser';
import { formatTs } from './format';

/** Same timezone the backend scheduler uses (agent/checkin-scheduler.ts). */
const TIMEZONE = 'Australia/Sydney';

export interface CronPreset {
  label: string;
  expression: string;
}

/** A small, fixed set of common schedules — the textarea remains the raw/advanced escape hatch. */
export const CRON_PRESETS: CronPreset[] = [
  { label: 'ASX open, weekdays', expression: '10 10 * * 1-5' },
  { label: 'US open (AEST evening), weekdays', expression: '30 23 * * 1-5' },
  { label: 'Hourly during ASX+US sessions, weekdays', expression: '0 10-23 * * 1-5' },
  { label: 'Once daily at ASX close, weekdays', expression: '10 16 * * 1-5' },
];

/**
 * Human-readable next-fire time for one cron expression, or null when it can't be
 * parsed — callers show "can't parse this schedule" instead of crashing on invalid input.
 */
export function nextRunLabel(expression: string, now = new Date()): string | null {
  try {
    const interval = CronExpressionParser.parse(expression, { currentDate: now, tz: TIMEZONE });
    return formatTs(interval.next().toDate().toISOString(), TIMEZONE);
  } catch {
    return null;
  }
}
