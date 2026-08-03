import { describe, expect, it } from 'vitest';
import { buildResearchPrompt, RESEARCH_SYSTEM_PROMPT } from '../src/research/prompt.js';

describe('buildResearchPrompt', () => {
  const input = {
    roundName: 'first run',
    markets: ['US', 'ASX'] as ('US' | 'ASX')[],
    held: [{ symbol: 'AAPL', quantity: 2 }],
    watchlist: ['AAPL', 'BHP.AX'],
    tradingStyle: 'swing' as const,
    previousBriefing: null,
  };

  it('names every held and watched symbol', () => {
    const prompt = buildResearchPrompt(input);
    expect(prompt).toContain('AAPL');
    expect(prompt).toContain('BHP.AX');
  });

  it('marks which symbols are actually held', () => {
    const prompt = buildResearchPrompt(input);
    expect(prompt).toMatch(/held[\s\S]*AAPL/i);
  });

  it('asks for a compact briefing with a length bound', () => {
    expect(buildResearchPrompt(input)).toMatch(/\b(\d+)\s*words?\b/i);
  });

  it('includes the previous briefing so the agent can report only what changed', () => {
    const prompt = buildResearchPrompt({ ...input, previousBriefing: 'Yesterday: AAPL flat on no news.' });
    expect(prompt).toContain('Yesterday: AAPL flat on no news.');
    expect(prompt).toMatch(/changed|new since/i);
  });

  it('omits the previous-briefing section entirely when there is none', () => {
    expect(buildResearchPrompt(input)).not.toMatch(/previous briefing/i);
  });

  it('handles an empty watchlist without producing a dangling list', () => {
    const prompt = buildResearchPrompt({ ...input, watchlist: [], held: [] });
    expect(prompt).not.toMatch(/:\s*\n\s*\n/);
    expect(prompt).toMatch(/no symbols/i);
  });

  it('tells the agent it is advisory and cannot trade', () => {
    expect(RESEARCH_SYSTEM_PROMPT).toMatch(/cannot (place|make) (any )?trades?|no trading|advisory/i);
  });

  it('forbids invented facts and requires a source per claim', () => {
    expect(RESEARCH_SYSTEM_PROMPT).toMatch(/source/i);
    expect(RESEARCH_SYSTEM_PROMPT).toMatch(/do not (invent|speculate|fabricate)/i);
  });
});
