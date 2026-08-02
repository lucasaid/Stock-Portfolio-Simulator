import { describe, expect, it } from 'vitest';
import { RISK_PROMPTS, STYLE_PROMPTS, buildSystemPrompt } from '../src/agent/personas.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';

function config(overrides: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'p', startingBalanceCents: cents(50), profitGoalCents: cents(1000), markets: ['US'],
    watchlist: ['AAPL'], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS, fees: DEFAULT_FEES, model: 'claude-sonnet-5',
    checkinCron: ['0 8 * * 1-5'], ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('has a block for every risk profile and trading style', () => {
    for (const key of ['conservative', 'balanced', 'aggressive', 'custom'] as const) {
      expect(RISK_PROMPTS[key]).toBeTruthy();
    }
    for (const key of ['day', 'swing', 'long'] as const) {
      expect(STYLE_PROMPTS[key]).toBeTruthy();
    }
  });

  it('assembles base rules + selected persona blocks', () => {
    const prompt = buildSystemPrompt(config({ riskProfile: 'aggressive', tradingStyle: 'day' }));
    expect(prompt).toContain(RISK_PROMPTS.aggressive);
    expect(prompt).toContain(STYLE_PROMPTS.day);
    expect(prompt).toMatch(/paper[- ]trading/i);
    expect(prompt).toMatch(/write_journal/);
  });

  it('prefers config overrides over presets', () => {
    const prompt = buildSystemPrompt(config({ riskPrompt: 'CUSTOM RISK RULES', stylePrompt: 'CUSTOM STYLE' }));
    expect(prompt).toContain('CUSTOM RISK RULES');
    expect(prompt).toContain('CUSTOM STYLE');
    expect(prompt).not.toContain(RISK_PROMPTS.balanced);
  });
});
