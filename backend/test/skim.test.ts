import { describe, expect, it } from 'vitest';
import { computeSkimCents } from '../src/engine/skim.js';
import { cents } from '../src/engine/types.js';

describe('computeSkimCents', () => {
  it("skims the excess over starting balance (spec §2.2 worked example: $70 cash on $50 start → $20 skim)", () => {
    expect(computeSkimCents(cents(70), cents(50))).toBe(cents(20));
  });

  it('skims nothing at exactly the starting balance', () => {
    expect(computeSkimCents(cents(50), cents(50))).toBe(0);
  });

  it('skims nothing below the starting balance', () => {
    expect(computeSkimCents(cents(35), cents(50))).toBe(0);
  });
});
