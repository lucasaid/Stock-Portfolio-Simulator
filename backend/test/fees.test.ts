import { describe, expect, it } from 'vitest';
import { applySlippage, tradeFeeCents, usdToAud } from '../src/engine/fees.js';
import { DEFAULT_FEES, cents } from '../src/engine/types.js';

describe('tradeFeeCents', () => {
  it('charges the flat ASX brokerage', () => {
    expect(tradeFeeCents('ASX', cents(20), DEFAULT_FEES)).toBe(300);
  });

  it('charges FX bps on US notional (70bps of $100 = $0.70)', () => {
    expect(tradeFeeCents('US', cents(100), DEFAULT_FEES)).toBe(70);
  });

  it('rounds US fees up so fees are never understated', () => {
    expect(tradeFeeCents('US', 1, DEFAULT_FEES)).toBe(1);
  });
});

describe('applySlippage', () => {
  it('worsens the price against the trader on both sides (50bps)', () => {
    expect(applySlippage(100, 'buy', 50)).toBeCloseTo(100.5);
    expect(applySlippage(100, 'sell', 50)).toBeCloseTo(99.5);
  });

  it('is a no-op at 0 bps', () => {
    expect(applySlippage(100, 'buy', 0)).toBe(100);
  });
});

describe('usdToAud', () => {
  it('converts using USD-per-AUD rate (USD$65 at 0.65 = AUD$100)', () => {
    expect(usdToAud(65, 0.65)).toBeCloseTo(100);
  });
});
