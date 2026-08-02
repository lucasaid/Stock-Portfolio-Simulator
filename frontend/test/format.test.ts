import { describe, expect, it } from 'vitest';
import { dollarsToCents, formatCents, formatPct, formatQty, signedCents } from '../src/lib/format';

describe('format', () => {
  it('formats cents as AUD dollars', () => {
    expect(formatCents(5000)).toBe('$50.00');
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-2550)).toBe('-$25.50');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
  });

  it('always shows a sign for deltas', () => {
    expect(signedCents(500)).toBe('+$5.00');
    expect(signedCents(-500)).toBe('-$5.00');
    expect(signedCents(0)).toBe('$0.00');
  });

  it('converts dollar input to integer cents without float drift', () => {
    expect(dollarsToCents('50')).toBe(5000);
    expect(dollarsToCents('50.10')).toBe(5010);
    expect(dollarsToCents('0.07')).toBe(7);
    expect(dollarsToCents('1.005')).toBe(101);
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
  });

  it('formats percentages and quantities', () => {
    expect(formatPct(12.345)).toBe('12.3%');
    expect(formatPct(null)).toBe('off');
    expect(formatQty(3)).toBe('3');
    expect(formatQty(3.5)).toBe('3.5');
    expect(formatQty(0.123456)).toBe('0.1235');
  });
});

describe('dollarsToCents edge cases', () => {
  it('rounds sub-cent input half-up without binary float drift', () => {
    expect(dollarsToCents('1.005')).toBe(101);
    expect(dollarsToCents('1.004')).toBe(100);
    expect(dollarsToCents('0.005')).toBe(1);
    expect(dollarsToCents('2.675')).toBe(268);
  });

  it('rejects input that is not a plain non-negative decimal', () => {
    expect(dollarsToCents('1e3')).toBeNull();
    expect(dollarsToCents('$50')).toBeNull();
    expect(dollarsToCents('1,000')).toBeNull();
    expect(dollarsToCents('Infinity')).toBeNull();
    expect(dollarsToCents(' 50 ')).toBe(5000);
  });
});
