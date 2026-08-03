import { describe, expect, it } from 'vitest';
import { zonedDayRangeUtc } from '../src/lib/timezone.js';

const SYD = 'Australia/Sydney';

describe('zonedDayRangeUtc', () => {
  it('maps a Sydney day to its UTC window during AEST (UTC+10)', () => {
    // Winter: Sydney is UTC+10, so the day starts at 14:00 UTC the day before.
    const [from, to] = zonedDayRangeUtc('2026-08-03', SYD);
    expect(from).toBe('2026-08-02T14:00:00.000Z');
    expect(to).toBe('2026-08-03T14:00:00.000Z');
  });

  it('maps a Sydney day to its UTC window during AEDT (UTC+11)', () => {
    // Summer: Sydney is UTC+11, so the day starts at 13:00 UTC the day before.
    const [from, to] = zonedDayRangeUtc('2026-01-15', SYD);
    expect(from).toBe('2026-01-14T13:00:00.000Z');
    expect(to).toBe('2026-01-15T13:00:00.000Z');
  });

  it('handles the day DST starts (23-hour day)', () => {
    // AEDT begins on the first Sunday of October 2026 (the 4th): 02:00 -> 03:00.
    const [from, to] = zonedDayRangeUtc('2026-10-04', SYD);
    expect(Date.parse(to) - Date.parse(from)).toBe(23 * 3_600_000);
  });

  it('handles the day DST ends (25-hour day)', () => {
    // AEST resumes on the first Sunday of April 2026 (the 5th): 03:00 -> 02:00.
    const [from, to] = zonedDayRangeUtc('2026-04-05', SYD);
    expect(Date.parse(to) - Date.parse(from)).toBe(25 * 3_600_000);
  });

  it('is a half-open range so consecutive days never overlap or gap', () => {
    const [, firstEnd] = zonedDayRangeUtc('2026-08-03', SYD);
    const [secondStart] = zonedDayRangeUtc('2026-08-04', SYD);
    expect(firstEnd).toBe(secondStart);
  });

  it('falls back to a plain UTC day for UTC itself', () => {
    const [from, to] = zonedDayRangeUtc('2026-08-03', 'UTC');
    expect(from).toBe('2026-08-03T00:00:00.000Z');
    expect(to).toBe('2026-08-04T00:00:00.000Z');
  });

  it('puts a US market close on the Sydney day the operator experiences', () => {
    // US close 2026-08-03 20:00 UTC is 2026-08-04 06:00 in Sydney.
    const usClose = Date.parse('2026-08-03T20:00:00.000Z');
    const [from, to] = zonedDayRangeUtc('2026-08-04', SYD);
    expect(usClose).toBeGreaterThanOrEqual(Date.parse(from));
    expect(usClose).toBeLessThan(Date.parse(to));
  });
});
