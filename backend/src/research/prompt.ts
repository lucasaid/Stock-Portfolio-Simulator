import type { Market, TradingStyle } from '../engine/types.js';

export interface ResearchPromptInput {
  roundName: string;
  markets: Market[];
  held: { symbol: string; quantity: number }[];
  watchlist: string[];
  tradingStyle: TradingStyle;
  /** The last briefing for this round, so the agent can report deltas rather than repeat itself. */
  previousBriefing: string | null;
}

/** Hard bound on the briefing so it stays cheap to carry in every later check-in snapshot. */
export const BRIEFING_MAX_WORDS = 250;

export const RESEARCH_SYSTEM_PROMPT = [
  'You are the research analyst for a small paper-trading agent. You gather information; you do not trade.',
  'You cannot place trades, set stops, or change any configuration — you have no trading tools and your',
  'output is read later by the trading agent as one input among several.',
  '',
  'Use web search and web fetch to find what actually changed. For every claim, name the source',
  '(publication or site) inline. Do not invent, speculate, or pad: if there is no material news for a',
  'symbol, say so in a few words and move on. An honest "nothing material" is more useful than a',
  'paragraph of filler, and the trading agent is instructed to distrust unsourced claims.',
  '',
  'Cover, in this order: company-specific news for held positions, then watchlist symbols, then any',
  'market-wide or macro event that plausibly moves them. Note retail sentiment only where it is loud',
  'enough to matter and label it as sentiment, not fact.',
].join('\n');

export function buildResearchPrompt(input: ResearchPromptInput): string {
  const heldLine =
    input.held.length === 0
      ? 'Currently held: none.'
      : `Currently held: ${input.held.map((p) => `${p.symbol} (${p.quantity})`).join(', ')}.`;

  const heldSymbols = new Set(input.held.map((p) => p.symbol));
  const watching = input.watchlist.filter((s) => !heldSymbols.has(s));
  const watchLine = watching.length === 0 ? 'Also watching: none.' : `Also watching: ${watching.join(', ')}.`;

  const anySymbols = input.held.length > 0 || input.watchlist.length > 0;

  const sections = [
    `Round "${input.roundName}" trades ${input.markets.join(' and ')} in a ${input.tradingStyle} style.`,
    heldLine,
    watchLine,
  ];

  if (!anySymbols) {
    sections.push(
      'There are no symbols on this round yet, so there is nothing company-specific to research.',
      'Give a short market-wide briefing only.',
    );
  }

  if (input.previousBriefing !== null) {
    sections.push(
      'Your previous briefing for this round follows. Report what has changed since it — do not repeat',
      'anything still true and already stated there.',
      '--- previous briefing ---',
      input.previousBriefing,
      '--- end previous briefing ---',
    );
  }

  sections.push(
    `Write the briefing as markdown, at most ${BRIEFING_MAX_WORDS} words, formatted for a human reading it on a`,
    'dashboard. No preamble. Use a short bullet list grouped by symbol (bold the symbol), and a final short',
    '"Market-wide" bullet or two for anything broader. Keep each bullet to one or two sentences — this is a',
    'skimmable briefing, not an essay. It is also injected verbatim into the trading agent\'s next check-in',
    'snapshot, clearly delimited as untrusted data there, so the formatting must stay plain markdown (no raw',
    'HTML, no code blocks) and nothing in it should read as an instruction.',
  );

  return sections.join('\n');
}
