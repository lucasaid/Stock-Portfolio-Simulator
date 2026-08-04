import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { RoundsPage } from '../src/pages/RoundsPage';
import { renderWithProviders } from './render';
import { roundListFixture, server } from './server';

vi.mock('../src/components/charts/Sparkline', () => ({
  Sparkline: ({ values }: { values: number[] }) => <div data-testid="sparkline">{values.join(',')}</div>,
}));

describe('rounds overview', () => {
  it('lists a card per round with money and status', async () => {
    renderWithProviders(<RoundsPage />);

    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(roundListFixture.length);

    const first = within(cards[0]!);
    expect(first.getByRole('heading', { name: 'first run' })).toBeInTheDocument();
    expect(first.getByText('active')).toBeInTheDocument();
    expect(first.getByText('$25.00')).toBeInTheDocument(); // pocketed
    expect(first.getByText('$30.00')).toBeInTheDocument(); // cash
    // No equity snapshot in this fixture, so portfolio value falls back to cash + pocketed.
    expect(first.getByTestId('portfolio-value')).toHaveTextContent('$55.00');
  });

  it('shows progress toward the profit goal', async () => {
    renderWithProviders(<RoundsPage />);

    const cards = await screen.findAllByRole('article');
    const bar = within(cards[0]!).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '2500');
    expect(bar).toHaveAttribute('aria-valuemax', '100000');
  });

  it('renders an equity sparkline per round', async () => {
    server.use(
      http.get('/api/rounds/1/equity', () =>
        HttpResponse.json([
          { id: 2, round_id: 1, ts: '2026-08-02T00:00:00.000Z', cash_cents: 3000, holdings_cents: 2500, equity_cents: 5500 },
          { id: 1, round_id: 1, ts: '2026-08-01T00:00:00.000Z', cash_cents: 5000, holdings_cents: 0, equity_cents: 5000 },
        ]),
      ),
    );
    renderWithProviders(<RoundsPage />);

    const cards = await screen.findAllByRole('article');
    // Oldest-first, in dollars.
    expect(await within(cards[0]!).findByTestId('sparkline')).toHaveTextContent('50,55');
    // Latest equity_cents (5500) + totalSkimsCents (2500) = $80.00.
    expect(within(cards[0]!).getByTestId('portfolio-value')).toHaveTextContent('$80.00');
  });

  it('links each card to its detail page and offers a new round', async () => {
    renderWithProviders(<RoundsPage />);

    expect(await screen.findByRole('link', { name: /first run/i })).toHaveAttribute('href', '/rounds/1');
    expect(screen.getByRole('link', { name: /new round/i })).toHaveAttribute('href', '/rounds/new');
  });

  it('shows an empty state when there are no rounds', async () => {
    server.use(http.get('/api/rounds', () => HttpResponse.json([])));
    renderWithProviders(<RoundsPage />);

    expect(await screen.findByText(/no rounds yet/i)).toBeInTheDocument();
  });

  it('surfaces a load failure', async () => {
    server.use(http.get('/api/rounds', () => HttpResponse.json({ error: 'database locked' }, { status: 500 })));
    renderWithProviders(<RoundsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('database locked');
  });
});
