import type { Market } from '../engine/types.js';

const ZONES: Record<Market, string> = { ASX: 'Australia/Sydney', US: 'America/New_York' };
// Session bounds in minutes-since-midnight local time. [open, close)
const SESSIONS: Record<Market, [number, number]> = { ASX: [600, 960], US: [570, 960] };

/**
 * Weekday/session check in the exchange's own timezone. Public holidays are
 * intentionally ignored (spec §11: acceptable paper-mode simplification —
 * polls on a holiday just return unchanged prices).
 */
export function isMarketOpen(market: Market, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONES[market],
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const [open, close] = SESSIONS[market];
  return minutes >= open && minutes < close;
}
