import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { MarketsPage } from '../src/pages/MarketsPage';
import { renderWithProviders } from './render';
import { server } from './server';

const priceChartProps = vi.fn();
vi.mock('../src/components/charts/PriceChart', () => ({
  PriceChart: (props: Record<string, unknown>) => {
    priceChartProps(props);
    return <div data-testid="price-chart" />;
  },
}));

const symbols = [
  { symbol: 'AAPL', market: 'US', name: null, archived: 0, first_seen_at: null, last_polled_at: null },
  { symbol: 'BHP.AX', market: 'ASX', name: null, archived: 1, first_seen_at: null, last_polled_at: null },
];

const history = {
  symbol: 'AAPL', range: '1M', interval: '1d', currency: 'USD', stale: false,
  bars: [
    { ts: '2026-08-01T00:00:00.000Z', open: 9, high: 11, low: 8, close: 10, volume: 100 },
    { ts: '2026-08-02T00:00:00.000Z', open: 10, high: 12, low: 9, close: 11, volume: 120 },
  ],
};

describe('markets page', () => {
  it('lists tracked symbols and separates archived ones', async () => {
    server.use(http.get('/api/market/symbols', () => HttpResponse.json(symbols)));
    renderWithProviders(<MarketsPage />);

    expect(await screen.findByRole('button', { name: 'AAPL' })).toBeInTheDocument();
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
  });

  it('charts the selected symbol over the chosen range', async () => {
    let requestedRange = '';
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', ({ request }) => {
        requestedRange = new URL(request.url).searchParams.get('range') ?? '';
        return HttpResponse.json(history);
      }),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '3M' }));
    await waitFor(() => expect(requestedRange).toBe('3M'));
  });

  it('toggles between candles and line', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json(history)),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    await waitFor(() => expect(priceChartProps).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /candles/i }));
    await waitFor(() => {
      const last = priceChartProps.mock.calls.at(-1)![0] as { style: string };
      expect(last.style).toBe('candles');
    });
  });

  it('passes a moving-average window through when enabled', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json(history)),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    await userEvent.selectOptions(screen.getByLabelText(/moving average/i), '20');

    await waitFor(() => {
      const last = priceChartProps.mock.calls.at(-1)![0] as { movingAverage?: number };
      expect(last.movingAverage).toBe(20);
    });
  });

  it('shows the % change over the loaded range', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json(history)),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    // close 10 → 11
    expect(await screen.findByText('+10.0%')).toBeInTheDocument();
  });

  it('marks the chart with trades on that symbol from every round', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json(history)),
      http.get('/api/rounds/1/trades', () =>
        HttpResponse.json([
          { id: 1, order_id: 1, round_id: 1, symbol: 'AAPL', side: 'buy', quantity: 2, price_aud: 10, gross_cents: 2000, fee_cents: 0, executed_at: '2026-08-01T02:00:00.000Z' },
          { id: 2, order_id: 2, round_id: 1, symbol: 'MSFT', side: 'buy', quantity: 1, price_aud: 30, gross_cents: 3000, fee_cents: 0, executed_at: '2026-08-01T02:00:00.000Z' },
        ]),
      ),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    await waitFor(() => {
      const last = priceChartProps.mock.calls.at(-1)![0] as { trades: { symbol: string }[] };
      expect(last.trades).toHaveLength(1);
      expect(last.trades[0]!.symbol).toBe('AAPL');
    });
  });

  it('tracks a new symbol', async () => {
    let tracked: string | null = null;
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.post('/api/market/symbols', async ({ request }) => {
        tracked = ((await request.json()) as { symbol: string }).symbol;
        return HttpResponse.json({ symbol: 'TSLA' }, { status: 201 });
      }),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.type(await screen.findByLabelText(/track a symbol/i), 'tsla');
    await userEvent.click(screen.getByRole('button', { name: /^track$/i }));

    await waitFor(() => expect(tracked).toBe('tsla'));
  });

  it('flags stale history', async () => {
    server.use(
      http.get('/api/market/symbols', () => HttpResponse.json(symbols)),
      http.get('/api/market/history', () => HttpResponse.json({ ...history, stale: true })),
    );
    renderWithProviders(<MarketsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'AAPL' }));
    expect(await screen.findByText(/last known prices/i)).toBeInTheDocument();
  });
});
