import type { Market, TradingStyle } from '../engine/types.js';
import type { ScanCandidate } from '../market/candidates.js';

export interface ScanPromptInput {
  roundName: string;
  markets: Market[];
  tradingStyle: TradingStyle;
  mode: 'bootstrap' | 'manage';
  held: string[];
  currentWatchlist: string[];
  candidates: ScanCandidate[];
}

export const SCAN_SYSTEM_PROMPT = [
  'You are the market scout for a small paper-trading agent. You choose which symbols the round',
  'pays attention to. You cannot trade, set stops, or change any other configuration — you have no',
  'trading tools, and your output is read by a separate process, never executed as instructions.',
  '',
  'Pick ONLY from the candidate list given to you, and only from that list. Do not propose a ticker',
  'that is not on it, even one you believe exists and would be a good pick — an invented or',
  'misremembered ticker breaks the round permanently once traded, so the candidate list is a hard',
  'boundary, not a suggestion.',
  '',
  'Respond with a single fenced JSON code block and nothing else:',
  '```json',
  '{"watchlist": ["SYM1", "SYM2"]}',
  '```',
  'No prose outside the code block.',
].join('\n');

export function buildScanPrompt(input: ScanPromptInput): string {
  const candidateLines = input.candidates
    .map((c) => `${c.symbol}${c.name ? ` (${c.name})` : ''}${c.changePct != null ? ` ${c.changePct.toFixed(1)}%` : ''}`)
    .join('\n');

  const sections = [
    `Round "${input.roundName}" trades ${input.markets.join(' and ')} in a ${input.tradingStyle} style.`,
    input.held.length === 0 ? 'Currently held: none.' : `Currently held: ${input.held.join(', ')}.`,
  ];

  if (input.mode === 'bootstrap') {
    sections.push(
      'This round has no watchlist yet. Choose a small, sensible starting set (roughly 3-8 symbols)',
      'from the candidates below. This is a ONE-TIME choice — there will be no further scans, so',
      'favour names you can justify holding for a while over anything narrowly of-the-moment.',
    );
  } else {
    sections.push(
      input.currentWatchlist.length === 0
        ? 'The current watchlist is empty.'
        : `Current watchlist: ${input.currentWatchlist.join(', ')}.`,
      'You may keep, add, or drop symbols freely based on the candidates below — this is a',
      'recurring weekly scan, so it is fine to drop or remove names that no longer look interesting.',
    );
  }

  sections.push(
    "Candidates (symbol, name, today's % move):",
    candidateLines,
    'This is a qualitative shortlist, not a quantitative screen — use your judgement, not just the % move.',
  );

  return sections.join('\n');
}

/** Extracts {"watchlist": [...]} from a response that may wrap it in prose or a fenced code block. */
export function parseScanResponse(text: string): { watchlist: string[] } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null && 'watchlist' in parsed &&
      Array.isArray((parsed as { watchlist: unknown }).watchlist) &&
      (parsed as { watchlist: unknown[] }).watchlist.every((s) => typeof s === 'string')
    ) {
      return { watchlist: (parsed as { watchlist: string[] }).watchlist.map((s) => s.trim().toUpperCase()) };
    }
    return null;
  } catch {
    return null;
  }
}
