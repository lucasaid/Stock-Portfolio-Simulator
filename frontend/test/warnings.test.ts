import { describe, expect, it } from 'vitest';
import { roundWarnings } from '../src/pages/round/warnings';

const base = {
  startingBalanceCents: 5000,
  profitGoalCents: 100000,
  markets: ['US'] as ('ASX' | 'US')[],
  tradingStyle: 'swing' as const,
  guardrails: { stopLossPct: 10, maxPositionPct: 40, drawdownPausePct: 50, stopLossWhenPaused: true },
  fees: { asxFlatCents: 300, usFxBps: 70, slippageBps: 0 },
  watchlist: ['AAPL'],
  checkinCron: ['30 23 * * 1-5'],
};

describe('roundWarnings', () => {
  it('is quiet for a sensible config', () => {
    expect(roundWarnings({ ...base, profitGoalCents: 10000 })).toEqual([]);
  });

  it('warns when ASX brokerage eats a large share of the bankroll', () => {
    const warnings = roundWarnings({ ...base, markets: ['ASX'], startingBalanceCents: 5000 });
    expect(warnings.join(' ')).toMatch(/brokerage/i);
  });

  it('warns hardest about day trading ASX on a tiny bankroll', () => {
    const warnings = roundWarnings({ ...base, markets: ['ASX'], tradingStyle: 'day', startingBalanceCents: 5000 });
    expect(warnings.join(' ')).toMatch(/day trading/i);
    expect(warnings.length).toBeGreaterThan(1);
  });

  it('warns when the profit goal dwarfs the bankroll', () => {
    const warnings = roundWarnings({ ...base, startingBalanceCents: 5000, profitGoalCents: 100000 });
    expect(warnings.join(' ')).toMatch(/bankroll/i);
  });

  it('warns when every guardrail is disabled', () => {
    const warnings = roundWarnings({
      ...base,
      guardrails: { stopLossPct: null, maxPositionPct: null, drawdownPausePct: null, stopLossWhenPaused: true },
    });
    expect(warnings.join(' ')).toMatch(/no guardrails/i);
  });

  it('warns on an empty watchlist', () => {
    expect(roundWarnings({ ...base, watchlist: [] }).join(' ')).toMatch(/watchlist/i);
  });

  it('warns when no check-in is scheduled', () => {
    expect(roundWarnings({ ...base, checkinCron: [] }).join(' ')).toMatch(/check-in/i);
  });

  it('warns when max position allows the whole bankroll in one symbol', () => {
    const warnings = roundWarnings({ ...base, guardrails: { ...base.guardrails, maxPositionPct: 100 } });
    expect(warnings.join(' ')).toMatch(/single symbol/i);
  });

  it('does not divide by zero on a zero bankroll', () => {
    expect(() => roundWarnings({ ...base, startingBalanceCents: 0 })).not.toThrow();
  });
});
