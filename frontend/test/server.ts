import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type {
  AnalyticsSummary, BenchmarkResult, DecisionOutcome, ReplaySweepEntry, RoundAnalytics, RoundTripStats,
} from '../src/api/analytics';
import type { BriefingRow, RoundDetail, RoundListItem, ScanRow, Settings } from '../src/api/types';

export const roundListFixture: RoundListItem[] = [
  {
    id: 1, name: 'first run', status: 'active',
    starting_balance_cents: 5000, cash_cents: 3000, profit_goal_cents: 100000, totalSkimsCents: 2500,
  },
  {
    id: 2, name: 'paused run', status: 'paused',
    starting_balance_cents: 5000, cash_cents: 5000, profit_goal_cents: 100000, totalSkimsCents: 0,
  },
];

export const roundDetailFixture: RoundDetail = {
  round: {
    ...roundListFixture[0]!,
    config_json: '{}',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
  },
  config: {
    name: 'first run',
    startingBalanceCents: 5000,
    profitGoalCents: 100000,
    markets: ['US'],
    watchlist: ['AAPL'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: { stopLossPct: 10, maxPositionPct: 40, drawdownPausePct: 50, stopLossWhenPaused: true },
    fees: { asxFlatCents: 300, usFxBps: 70, slippageBps: 0 },
    model: 'claude-sonnet-5',
    checkinCron: ['30 23 * * 1-5'],
    researchCron: ['0 7 * * 1-5'],
    autoWatchlist: false,
  },
  positions: [
    {
      id: 7, round_id: 1, symbol: 'AAPL', market: 'US', quantity: 2,
      cost_basis_cents: 2000, stop_loss_price: null,
      opened_at: '2026-08-01T02:00:00.000Z', closed_at: null,
    },
  ],
  totalSkimsCents: 2500,
};

export const settingsFixture: Settings = {
  roundDefaults: {
    startingBalanceCents: 5000,
    profitGoalCents: 100000,
    markets: ['US'],
    watchlist: ['AAPL', 'MSFT'],
    riskProfile: 'balanced',
    tradingStyle: 'swing',
    guardrails: { stopLossPct: 10, maxPositionPct: 40, drawdownPausePct: 50, stopLossWhenPaused: true },
    fees: { asxFlatCents: 300, usFxBps: 70, slippageBps: 0 },
    model: 'claude-sonnet-5',
    checkinCron: ['30 23 * * 1-5'],
    researchCron: ['0 7 * * 1-5'],
    autoWatchlist: false,
  },
  integrations: {
    ntfy: { url: 'https://ntfy.sh', topic: 'stake', enabled: false },
    pollIntervalMinutes: 5,
    benchmarkSymbol: 'IVV',
  },
  lookAndFeel: { theme: 'system', accent: '#6E56CF', chartStyle: 'line', timezone: 'Australia/Sydney' },
  notifications: { trade: true, skim: true, goal: true, stop_loss: true, drawdown: true, busted: true, error: true },
  usageGate: { enabled: true, sessionThresholdPct: 80, weeklyThresholdPct: 90 },
};

export const statsFixture: RoundTripStats = {
  closed: 3, wins: 2, losses: 1, winRatePct: 66.66666666666666,
  avgWinCents: 250, avgLossCents: -200, bestCents: 400, worstCents: -200,
  totalNetCents: 300, totalFeesCents: 90, profitFactor: 2.5,
  avgHoldMs: 115_200_000, medianHoldMs: 86_400_000, avgReturnPct: 8.3,
};

export const roundAnalyticsFixture: RoundAnalytics = {
  roundId: 1,
  stats: statsFixture,
  trips: [
    {
      symbol: 'AAPL', quantity: 1, openedAt: '2026-08-01T00:00:00.000Z', closedAt: '2026-08-02T00:00:00.000Z',
      costCents: 1000, proceedsCents: 1400, feesCents: 30, netCents: 370, returnPct: 37, holdMs: 86_400_000,
    },
  ],
  histogram: [
    { fromPct: -5, toPct: 0, count: 1 },
    { fromPct: 0, toPct: 5, count: 1 },
    { fromPct: 35, toPct: 40, count: 1 },
  ],
  scatter: [{ symbol: 'AAPL', holdMs: 86_400_000, returnPct: 37, netCents: 370, closedAt: '2026-08-02T00:00:00.000Z' }],
  costs: {
    totalFeesCents: 90, usFeesCents: 90, asxFeesCents: 0,
    byDay: [{ day: '2026-08-01', feesCents: 60 }, { day: '2026-08-02', feesCents: 30 }],
  },
  checkins: [
    {
      id: 2, ts: '2026-08-02T02:00:00.000Z', status: 'success', tokensUsed: 1800,
      actions: ['place_order', 'write_journal'], reasoning: ['Took profit into strength.'],
    },
    {
      id: 1, ts: '2026-08-01T02:00:00.000Z', status: 'success', tokensUsed: 1200,
      actions: ['write_journal'], reasoning: ['Nothing worth trading.'],
    },
  ],
  tokenTotals: { checkinTokens: 3000, checkins: 2 },
  eras: [
    { label: 'initial config', from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z', stats: statsFixture },
    {
      label: 'riskProfile → "aggressive"', from: '2026-08-02T00:00:00.000Z', to: null,
      stats: { ...statsFixture, closed: 1, wins: 0, losses: 1, winRatePct: 0, totalNetCents: -200 },
    },
  ],
};

export const benchmarkFixture: BenchmarkResult = {
  symbol: 'IVV',
  points: [
    { ts: '2026-08-01T00:00:00.000Z', equityCents: 5000, benchmarkCents: 5000 },
    { ts: '2026-08-02T00:00:00.000Z', equityCents: 5400, benchmarkCents: 5200 },
  ],
  roundReturnPct: 8,
  benchmarkReturnPct: 4,
};

export const decisionsFixture: DecisionOutcome[] = [
  {
    at: '2026-08-02T02:00:00.000Z', decision: 'sell', symbol: 'AAPL', priceAud: 14,
    forward: [{ bars: 1, pricePct: 2 }, { bars: 5, pricePct: 9.4 }, { bars: 20, pricePct: null }],
    verdict: 'sold early',
  },
  {
    at: '2026-08-01T02:00:00.000Z', decision: 'pass', symbol: 'AAPL', priceAud: 10,
    forward: [{ bars: 1, pricePct: -1 }, { bars: 5, pricePct: -6 }, { bars: 20, pricePct: null }],
    verdict: 'passing avoided -6.0%',
  },
];

export const replaySweepFixture: ReplaySweepEntry[] = [
  {
    label: 'no stop-loss', stopLossPct: null, actual: false,
    result: {
      finalCashCents: 5000, skimmedCents: 500, feesCents: 30, stopLossFirings: [],
      pausedAt: null, skippedTrades: 0, equityCurve: [], insufficientHistory: false,
    },
  },
  {
    label: '5% stop-loss', stopLossPct: 5, actual: false,
    result: {
      finalCashCents: 5000, skimmedCents: 200, feesCents: 30,
      stopLossFirings: [{ symbol: 'AAPL', at: '2026-08-02T00:00:00.000Z', stopPrice: 9.5, quantity: 1, proceedsCents: 950 }],
      pausedAt: null, skippedTrades: 0, equityCurve: [], insufficientHistory: false,
    },
  },
  {
    label: '10% stop-loss', stopLossPct: 10, actual: true,
    result: {
      finalCashCents: 5000, skimmedCents: 400, feesCents: 30, stopLossFirings: [],
      pausedAt: null, skippedTrades: 0, equityCurve: [], insufficientHistory: false,
    },
  },
  {
    label: '15% stop-loss', stopLossPct: 15, actual: false,
    result: {
      finalCashCents: 5000, skimmedCents: 400, feesCents: 30, stopLossFirings: [],
      pausedAt: null, skippedTrades: 0, equityCurve: [], insufficientHistory: false,
    },
  },
  {
    label: '20% stop-loss', stopLossPct: 20, actual: false,
    result: {
      finalCashCents: 5000, skimmedCents: 400, feesCents: 30, stopLossFirings: [],
      pausedAt: null, skippedTrades: 0, equityCurve: [], insufficientHistory: false,
    },
  },
];

export const analyticsSummaryFixture: AnalyticsSummary = {
  rounds: [
    {
      id: 1, name: 'first run', status: 'active', stats: statsFixture,
      costs: { totalFeesCents: 90 }, tokenTotals: { checkinTokens: 3000, checkins: 2 },
    },
    {
      id: 2, name: 'paused run', status: 'paused',
      stats: { ...statsFixture, closed: 0, wins: 0, losses: 0, winRatePct: 0, totalNetCents: 0, profitFactor: null },
      costs: { totalFeesCents: 0 }, tokenTotals: { checkinTokens: 0, checkins: 0 },
    },
  ],
  totals: statsFixture,
};

export const briefingsFixture: BriefingRow[] = [
  {
    id: 2, created_at: '2026-08-02T21:00:00.000Z', status: 'success',
    briefing: 'AAPL: nothing material (Reuters). Market steady ahead of CPI print.',
    tokens_used: 4200, cost_usd: 0.0312,
  },
  {
    id: 1, created_at: '2026-08-01T21:00:00.000Z', status: 'error',
    briefing: 'empty or failed research run (error_max_turns)',
    tokens_used: 1800, cost_usd: 0.0104,
  },
];

export const scansFixture: ScanRow[] = [
  {
    id: 2, created_at: '2026-08-02T21:00:00.000Z', status: 'success',
    watchlist_json: '["AAPL","MSFT","NVDA"]', added_json: '["NVDA"]', removed_json: '[]',
    detail: 'added NVDA on continued AI capex momentum', tokens_used: 3100, cost_usd: 0.0201,
  },
  {
    id: 1, created_at: '2026-08-01T21:00:00.000Z', status: 'error',
    watchlist_json: null, added_json: '[]', removed_json: '[]',
    detail: 'empty or failed scan run (error_max_turns)', tokens_used: 900, cost_usd: 0.0052,
  },
];

export const handlers = [
  http.get('/api/auth/me', () => HttpResponse.json({ username: 'chris' })),
  http.post('/api/auth/login', () => HttpResponse.json({ ok: true })),
  http.post('/api/auth/logout', () => HttpResponse.json({ ok: true })),
  http.post('/api/auth/password', () => HttpResponse.json({ ok: true })),
  http.get('/api/rounds', () => HttpResponse.json(roundListFixture)),
  http.get('/api/rounds/:id', () => HttpResponse.json(roundDetailFixture)),
  http.get('/api/rounds/:id/equity', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/trades', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/ledger', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/journal', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/summaries', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/checkins', () => HttpResponse.json([])),
  http.get('/api/rounds/:id/briefings', () => HttpResponse.json(briefingsFixture)),
  http.post('/api/rounds/:id/research', () => HttpResponse.json({ status: 'success', detail: '12 words' })),
  http.get('/api/rounds/:id/scans', () => HttpResponse.json(scansFixture)),
  http.post('/api/rounds/:id/scan', () => HttpResponse.json({ status: 'success', detail: '8 words' })),
  http.get('/api/events', () => HttpResponse.json([])),
  http.get('/api/settings', () => HttpResponse.json(settingsFixture)),
  http.put('/api/settings/:namespace', () => HttpResponse.json({ ok: true })),
  http.get('/api/market/symbols', () => HttpResponse.json([])),
  http.get('/api/market/quotes', () => HttpResponse.json({})),
  http.get('/api/market/fx', () => HttpResponse.json({ audUsd: 0.65 })),
  http.get('/api/market/history', ({ request }) =>
    HttpResponse.json({
      symbol: new URL(request.url).searchParams.get('symbol') ?? '',
      range: '1M', interval: '1d', currency: 'USD', stale: false,
      bars: [
        { ts: '2026-08-01T00:00:00.000Z', open: 9, high: 11, low: 8, close: 10, volume: 100 },
        { ts: '2026-08-02T00:00:00.000Z', open: 10, high: 12, low: 9, close: 11, volume: 120 },
      ],
    }),
  ),
  http.post('/api/kill', () => HttpResponse.json({ paused: 2 })),
  // Specific analytics routes come before the generic /rounds/:id — msw matches in order.
  http.get('/api/analytics/rounds/:id/benchmark', () => HttpResponse.json(benchmarkFixture)),
  http.get('/api/analytics/rounds/:id/decisions', () => HttpResponse.json(decisionsFixture)),
  http.get('/api/analytics/rounds/:id', () => HttpResponse.json(roundAnalyticsFixture)),
  http.get('/api/analytics/summary', () => HttpResponse.json(analyticsSummaryFixture)),
  http.get('/api/replay/rounds/:id/sweep', () => HttpResponse.json(replaySweepFixture)),
];

export const server = setupServer(...handlers);
