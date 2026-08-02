import { describe, expect, it } from 'vitest';
import { clipBuy, drawdownBreached, stopLossTriggered } from '../src/engine/guardrails.js';
import { cents } from '../src/engine/types.js';

describe('clipBuy', () => {
  const base = { cashCents: cents(50), heldCostCents: 0, startingBalanceCents: cents(50), maxPositionPct: 40 as number | null };

  it('allows a buy inside all limits', () => {
    expect(clipBuy({ ...base, requestedCents: cents(15) }))
      .toEqual({ allowedCents: cents(15), clipped: false, rejected: false, reason: null });
  });

  it('clips to max position size (40% of $50 = $20)', () => {
    const r = clipBuy({ ...base, requestedCents: cents(30) });
    expect(r.allowedCents).toBe(cents(20));
    expect(r.clipped).toBe(true);
    expect(r.rejected).toBe(false);
  });

  it('counts existing holdings toward the cap', () => {
    const r = clipBuy({ ...base, heldCostCents: cents(15), requestedCents: cents(10) });
    expect(r.allowedCents).toBe(cents(5));
    expect(r.clipped).toBe(true);
  });

  it('rejects when the cap is already reached', () => {
    const r = clipBuy({ ...base, heldCostCents: cents(20), requestedCents: cents(5) });
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe('max position size reached');
  });

  it('clips to available cash', () => {
    const r = clipBuy({ ...base, maxPositionPct: null, cashCents: cents(8), requestedCents: cents(10) });
    expect(r.allowedCents).toBe(cents(8));
    expect(r.clipped).toBe(true);
  });

  it('rejects non-finite inputs instead of silently allowing NaN', () => {
    expect(clipBuy({ ...base, requestedCents: Number.NaN })).toMatchObject({ rejected: true, allowedCents: 0 });
    expect(clipBuy({ ...base, cashCents: Number.NaN, requestedCents: cents(10) })).toMatchObject({ rejected: true });
  });

  it('rejects when there is no cash', () => {
    const r = clipBuy({ ...base, cashCents: 0, requestedCents: cents(10) });
    expect(r.rejected).toBe(true);
  });

  it('ignores the cap when maxPositionPct is null', () => {
    const r = clipBuy({ ...base, maxPositionPct: null, requestedCents: cents(50) });
    expect(r.allowedCents).toBe(cents(50));
    expect(r.rejected).toBe(false);
  });
});

describe('stopLossTriggered', () => {
  it('triggers on pct drop from avg cost', () => {
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 8.9, stopLossPct: 10, stopPrice: null })).toBe(true);
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 9.1, stopLossPct: 10, stopPrice: null })).toBe(false);
  });

  it('triggers on an explicit stop price', () => {
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 9.5, stopLossPct: null, stopPrice: 9.5 })).toBe(true);
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 9.6, stopLossPct: null, stopPrice: 9.5 })).toBe(false);
  });

  it('never triggers when both are disabled', () => {
    expect(stopLossTriggered({ avgCostPrice: 10, currentPrice: 0.01, stopLossPct: null, stopPrice: null })).toBe(false);
  });
});

describe('drawdownBreached', () => {
  it('breaches when equity has lost more than the threshold (50% of $50 → below $25)', () => {
    expect(drawdownBreached(cents(24), cents(50), 50)).toBe(true);
    expect(drawdownBreached(cents(25), cents(50), 50)).toBe(false);
  });

  it('is disabled when null', () => {
    expect(drawdownBreached(0, cents(50), null)).toBe(false);
  });
});
