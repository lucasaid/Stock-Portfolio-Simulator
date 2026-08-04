import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsTab } from '../src/pages/round/AnalyticsTab';
import { renderWithProviders } from './render';
import { roundAnalyticsFixture, server } from './server';

vi.mock('../src/components/charts/BenchmarkChart', () => ({ BenchmarkChart: () => <div data-testid="benchmark" /> }));

describe('round analytics tab', () => {
  it('shows the headline statistics', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);

    expect(await screen.findByTestId('stat-win-rate')).toHaveTextContent('66.7%');
    expect(screen.getByTestId('stat-closed')).toHaveTextContent('3');
    expect(screen.getByTestId('stat-avg-win')).toHaveTextContent('$2.50');
    expect(screen.getByTestId('stat-avg-loss')).toHaveTextContent('-$2.00');
    expect(screen.getByTestId('stat-net')).toHaveTextContent('+$3.00');
    expect(screen.getByTestId('stat-profit-factor')).toHaveTextContent('2.50');
  });

  it('formats hold times in days', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);
    expect(await screen.findByTestId('stat-median-hold')).toHaveTextContent('1.0d');
  });

  it('shows a dash for a null profit factor', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id', () =>
        HttpResponse.json({ ...roundAnalyticsFixture, stats: { ...roundAnalyticsFixture.stats, profitFactor: null } }),
      ),
    );
    renderWithProviders(<AnalyticsTab roundId={1} />);

    expect(await screen.findByTestId('stat-profit-factor')).toHaveTextContent('—');
  });

  it('renders the histogram and the scatter', async () => {
    const { container } = renderWithProviders(<AnalyticsTab roundId={1} />);
    await screen.findByTestId('stat-win-rate');

    expect(container.querySelectorAll('rect.bar').length).toBe(3);
    expect(container.querySelectorAll('circle').length).toBe(1);
  });

  it('accumulates fees with a per-day breakdown', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);

    const costs = await screen.findByTestId('costs');
    expect(within(costs).getByTestId('fees-total')).toHaveTextContent('$0.90');
    expect(within(costs).getByTestId('fees-asx')).toHaveTextContent('$0.00');
    expect(within(costs).getByTestId('fees-us')).toHaveTextContent('$0.60');
    expect(within(costs).getByTestId('fees-crypto')).toHaveTextContent('$0.30');
    expect(within(costs).getAllByRole('row')).toHaveLength(3); // header + two days
  });

  it('renders a fee line only for markets actually present in feesByMarket', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id', () =>
        HttpResponse.json({
          ...roundAnalyticsFixture,
          costs: { ...roundAnalyticsFixture.costs, feesByMarket: { CRYPTO: 100 } },
        }),
      ),
    );
    renderWithProviders(<AnalyticsTab roundId={1} />);

    const costs = await screen.findByTestId('costs');
    expect(within(costs).getByTestId('fees-crypto')).toHaveTextContent('$1.00');
    expect(within(costs).queryByTestId('fees-asx')).not.toBeInTheDocument();
    expect(within(costs).queryByTestId('fees-us')).not.toBeInTheDocument();
  });

  it('segments performance by config era', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);

    const eras = await screen.findByTestId('eras');
    expect(within(eras).getByText('initial config')).toBeInTheDocument();
    expect(within(eras).getByText(/riskProfile/)).toBeInTheDocument();
    expect(within(eras).getByText('-$2.00')).toBeInTheDocument();
  });

  it('shows token spend for the round', async () => {
    renderWithProviders(<AnalyticsTab roundId={1} />);
    expect(await screen.findByTestId('stat-tokens')).toHaveTextContent('3,000');
  });

  it('handles a round with no closed trades', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id', () =>
        HttpResponse.json({
          ...roundAnalyticsFixture,
          stats: {
            ...roundAnalyticsFixture.stats,
            closed: 0, wins: 0, losses: 0, winRatePct: 0, totalNetCents: 0, profitFactor: null,
          },
          trips: [], histogram: [], scatter: [],
        }),
      ),
    );
    renderWithProviders(<AnalyticsTab roundId={1} />);

    expect(await screen.findAllByText(/no closed trades/i)).toHaveLength(2);
  });

  it('renders the AI usage panel with totals and patterns', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id', () =>
        HttpResponse.json({
          ...roundAnalyticsFixture,
          aiUsage: {
            byType: [
              { type: 'checkin', runs: 2, tokens: 3000, costUsd: 0.09 },
              { type: 'research', runs: 1, tokens: 950, costUsd: 0.11 },
            ],
            totalTokens: 950,
            totalCostUsd: 0.11,
            byDay: [{ day: '2026-08-01', tokens: 950, costUsd: 0.11 }],
            patterns: [
              { sequence: ['place_order', 'write_journal'], count: 3 },
              { sequence: [], count: 1 },
            ],
          },
        }),
      ),
    );
    renderWithProviders(<AnalyticsTab roundId={1} />);

    const panel = await screen.findByTestId('ai-usage');
    expect(within(panel).getByText(/AI usage/i)).toBeInTheDocument();
    expect(within(panel).getAllByText(/950/).length).toBeGreaterThan(0);
    expect(within(panel).getByText(/place_order → write_journal/)).toBeInTheDocument();
    expect(within(panel).getByText(/\(no action taken\)/)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    server.use(http.get('/api/analytics/rounds/:id', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    renderWithProviders(<AnalyticsTab roundId={1} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
