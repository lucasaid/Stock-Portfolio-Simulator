import { describe, expect, it } from 'vitest';
import { buildScanPrompt, parseScanResponse, SCAN_SYSTEM_PROMPT } from '../src/market-scan/prompt.js';

const candidates = [
  { symbol: 'AAPL', name: 'Apple Inc.', changePct: 2.1 },
  { symbol: 'NVDA', name: 'NVIDIA Corp', changePct: -1.4 },
];

describe('buildScanPrompt', () => {
  it('lists every candidate symbol', () => {
    const prompt = buildScanPrompt({
      roundName: 'r', markets: ['US'], tradingStyle: 'swing', mode: 'bootstrap',
      held: [], currentWatchlist: [], candidates,
    });
    expect(prompt).toContain('AAPL');
    expect(prompt).toContain('NVDA');
  });

  it('bootstrap mode asks for a one-time, small starter set', () => {
    const prompt = buildScanPrompt({
      roundName: 'r', markets: ['US'], tradingStyle: 'swing', mode: 'bootstrap',
      held: [], currentWatchlist: [], candidates,
    });
    expect(prompt).toMatch(/one-time|no further scans/i);
  });

  it('manage mode shows the current watchlist and allows dropping names', () => {
    const prompt = buildScanPrompt({
      roundName: 'r', markets: ['US'], tradingStyle: 'swing', mode: 'manage',
      held: ['AAPL'], currentWatchlist: ['AAPL', 'MSFT'], candidates,
    });
    expect(prompt).toContain('MSFT');
    expect(prompt).toMatch(/drop|remove/i);
  });

  it('names held positions so they are not silently dropped', () => {
    const prompt = buildScanPrompt({
      roundName: 'r', markets: ['US'], tradingStyle: 'swing', mode: 'manage',
      held: ['AAPL'], currentWatchlist: [], candidates,
    });
    expect(prompt).toMatch(/held[\s\S]*AAPL/i);
  });
});

describe('SCAN_SYSTEM_PROMPT', () => {
  it('forbids picking outside the candidate list', () => {
    expect(SCAN_SYSTEM_PROMPT).toMatch(/only.*candidate list|candidate list.*only/i);
  });
  it('is advisory and asks for JSON-only output', () => {
    expect(SCAN_SYSTEM_PROMPT).toMatch(/do not trade|cannot trade/i);
    expect(SCAN_SYSTEM_PROMPT).toMatch(/json/i);
  });
});

describe('parseScanResponse', () => {
  it('parses a bare JSON object', () => {
    expect(parseScanResponse('{"watchlist": ["AAPL", "msft"]}')).toEqual({ watchlist: ['AAPL', 'MSFT'] });
  });

  it('parses JSON wrapped in a fenced code block with surrounding prose', () => {
    const text = 'Here is my pick:\n```json\n{"watchlist": ["BHP.AX"]}\n```\nDone.';
    expect(parseScanResponse(text)).toEqual({ watchlist: ['BHP.AX'] });
  });

  it('returns null for prose with no JSON', () => {
    expect(parseScanResponse('I could not decide.')).toBeNull();
  });

  it('returns null when watchlist is missing or not a string array', () => {
    expect(parseScanResponse('{"symbols": ["AAPL"]}')).toBeNull();
    expect(parseScanResponse('{"watchlist": "AAPL"}')).toBeNull();
    expect(parseScanResponse('{"watchlist": [1, 2]}')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(parseScanResponse('{"watchlist": [')).toBeNull();
  });
});
