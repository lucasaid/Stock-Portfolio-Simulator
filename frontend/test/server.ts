import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { RoundDetail, RoundListItem, Settings } from '../src/api/types';

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
  },
  integrations: { ntfy: { url: 'https://ntfy.sh', topic: 'stake', enabled: false }, pollIntervalMinutes: 5 },
  lookAndFeel: { theme: 'system', accent: '#6E56CF', chartStyle: 'line', timezone: 'Australia/Sydney' },
  notifications: { trade: true, skim: true, goal: true, stop_loss: true, drawdown: true, busted: true, error: true },
};

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
  http.get('/api/events', () => HttpResponse.json([])),
  http.get('/api/settings', () => HttpResponse.json(settingsFixture)),
  http.put('/api/settings/:namespace', () => HttpResponse.json({ ok: true })),
  http.get('/api/market/symbols', () => HttpResponse.json([])),
  http.get('/api/market/quotes', () => HttpResponse.json({})),
  http.post('/api/kill', () => HttpResponse.json({ paused: 2 })),
];

export const server = setupServer(...handlers);
