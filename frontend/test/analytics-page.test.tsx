import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsPage } from '../src/pages/AnalyticsPage';
import { renderWithProviders } from './render';
import { analyticsSummaryFixture, server } from './server';

const comparisonProps = vi.fn();
vi.mock('../src/components/charts/ComparisonChart', () => ({
  ComparisonChart: (props: Record<string, unknown>) => {
    comparisonProps(props);
    return <div data-testid="comparison" />;
  },
}));

describe('cross-round analytics page', () => {
  it('shows aggregate totals across every round', async () => {
    renderWithProviders(<AnalyticsPage />);

    expect(await screen.findByTestId('total-net')).toHaveTextContent('+$3.00');
    expect(screen.getByTestId('total-closed')).toHaveTextContent('3');
    expect(screen.getByTestId('total-win-rate')).toHaveTextContent('66.7%');
  });

  it('lists a comparison row per round', async () => {
    renderWithProviders(<AnalyticsPage />);

    const table = await screen.findByTestId('round-comparison');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(analyticsSummaryFixture.rounds.length);
    expect(rows[0]).toHaveTextContent('first run');
    expect(rows[0]).toHaveTextContent('$0.90');
  });

  it('links each row to the round', async () => {
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByRole('link', { name: 'first run' })).toHaveAttribute('href', '/rounds/1');
  });

  it('overlays the selected rounds, defaulting to all of them', async () => {
    renderWithProviders(<AnalyticsPage />);
    await screen.findByTestId('comparison');

    const first = comparisonProps.mock.calls.at(-1)![0] as { roundIds: number[] };
    expect(first.roundIds).toEqual([1, 2]);

    await userEvent.click(screen.getByRole('checkbox', { name: /paused run/i }));

    const after = comparisonProps.mock.calls.at(-1)![0] as { roundIds: number[] };
    expect(after.roundIds).toEqual([1]);
  });

  it('shows an empty state when no rounds exist', async () => {
    server.use(
      http.get('/api/analytics/summary', () =>
        HttpResponse.json({ rounds: [], totals: { ...analyticsSummaryFixture.totals, closed: 0, totalNetCents: 0 } }),
      ),
    );
    renderWithProviders(<AnalyticsPage />);

    expect(await screen.findByText(/no rounds to analyse/i)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    server.use(http.get('/api/analytics/summary', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    renderWithProviders(<AnalyticsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
