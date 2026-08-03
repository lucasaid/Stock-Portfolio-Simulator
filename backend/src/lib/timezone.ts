/**
 * Timezone helpers. The product's day is the Sydney day (spec §6.1 sets the
 * display timezone), but SQLite stores every timestamp as a UTC ISO string, so
 * "one day of activity" has to be expressed as a UTC window.
 */

/** Milliseconds the zone is ahead of UTC at this instant (DST-aware). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour` can come back as 24 for midnight in some engines; normalise it.
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asIfUtc - instant.getTime();
}

/** The UTC instant of local midnight starting `day` (YYYY-MM-DD) in `timeZone`. */
function zonedMidnightUtc(day: string, timeZone: string): number {
  const naive = Date.parse(`${day}T00:00:00Z`);
  // Correct by the offset, then re-measure at the corrected instant: on a DST
  // boundary the offset before and after midnight can differ.
  const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
  return naive - zoneOffsetMs(new Date(firstPass), timeZone);
}

/**
 * Half-open UTC window `[from, to)` covering one calendar day in `timeZone`.
 * Half-open matters: consecutive days must neither overlap nor leave a gap, and
 * DST days are genuinely 23 or 25 hours long.
 */
export function zonedDayRangeUtc(day: string, timeZone: string): [string, string] {
  const start = zonedMidnightUtc(day, timeZone);
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const end = zonedMidnightUtc(nextDay, timeZone);
  return [new Date(start).toISOString(), new Date(end).toISOString()];
}
