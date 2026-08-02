import { describe, expect, it } from 'vitest';
import { isMarketOpen } from '../src/market/hours.js';

// 2026-08-03 is a Monday. All instants below are expressed in UTC.
describe('isMarketOpen', () => {
  it('ASX open Monday 11:00 Sydney (AEST = UTC+10 in August)', () => {
    expect(isMarketOpen('ASX', new Date('2026-08-03T01:00:00Z'))).toBe(true);
  });

  it('ASX closed Monday 09:59 Sydney (pre-open)', () => {
    expect(isMarketOpen('ASX', new Date('2026-08-02T23:59:00Z'))).toBe(false);
  });

  it('ASX closed Monday 16:00 Sydney (close)', () => {
    expect(isMarketOpen('ASX', new Date('2026-08-03T06:00:00Z'))).toBe(false);
  });

  it('ASX closed on Saturday Sydney time', () => {
    expect(isMarketOpen('ASX', new Date('2026-08-01T01:00:00Z'))).toBe(false);
  });

  it('US open Monday 10:00 New York (EDT = UTC-4 in August)', () => {
    expect(isMarketOpen('US', new Date('2026-08-03T14:00:00Z'))).toBe(true);
  });

  it('US closed Monday 09:29 New York (pre-open)', () => {
    expect(isMarketOpen('US', new Date('2026-08-03T13:29:00Z'))).toBe(false);
  });

  it('US closed Monday 16:00 New York (close)', () => {
    expect(isMarketOpen('US', new Date('2026-08-03T20:00:00Z'))).toBe(false);
  });
});
