import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { RoundDetailPage } from '../src/pages/RoundDetailPage';
import { renderWithProviders } from './render';
import { roundDetailFixture, server } from './server';

vi.mock('../src/components/charts/EquityChart', () => ({
  EquityChart: ({ points }: { points: unknown[] }) => <div data-testid="equity-chart">{points.length}</div>,
}));

function renderDetail() {
  return renderWithProviders(<RoundDetailPage roundId={1} />);
}

describe('round detail', () => {
  it('shows the headline numbers', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'first run' })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByTestId('cash')).toHaveTextContent('$30.00');
    expect(screen.getByTestId('pocketed')).toHaveTextContent('$25.00');
    expect(screen.getByTestId('bankroll')).toHaveTextContent('$50.00');
    // No equity snapshot yet in this fixture, so portfolio value falls back to cash + pocketed.
    expect(screen.getByTestId('portfolio-value')).toHaveTextContent('$55.00');
  });

  it('shows portfolio value as the latest equity snapshot plus pocketed profit', async () => {
    server.use(
      http.get('/api/rounds/1/equity', () =>
        HttpResponse.json([
          { id: 1, round_id: 1, ts: '2026-08-01T00:00:00.000Z', cash_cents: 5000, holdings_cents: 0, equity_cents: 5000 },
          { id: 2, round_id: 1, ts: '2026-08-02T00:00:00.000Z', cash_cents: 3000, holdings_cents: 2500, equity_cents: 5500 },
        ]),
      ),
    );
    renderDetail();

    // Latest equity_cents (5500) + totalSkimsCents (2500) = $80.00.
    expect(await screen.findByTestId('portfolio-value')).toHaveTextContent('$80.00');
  });

  it('lists open positions with cost basis and live P/L', async () => {
    server.use(
      http.get('/api/market/quotes', () =>
        HttpResponse.json({
          AAPL: { symbol: 'AAPL', market: 'US', price: 12, currency: 'USD', ts: '2026-08-02T03:00:00.000Z', stale: false },
        }),
      ),
    );
    renderDetail();

    const row = await screen.findByRole('row', { name: /AAPL/ });
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(within(row).getByText('$20.00')).toBeInTheDocument();
  });

  it('links a held symbol through to its Markets chart', async () => {
    renderDetail();

    const row = await screen.findByRole('row', { name: /AAPL/ });
    expect(within(row).getByRole('link', { name: 'AAPL' })).toHaveAttribute('href', '/markets?symbol=AAPL');
  });

  it('shows a "Held companies" chart panel with a card per open position, linking to Markets', async () => {
    renderDetail();

    const panel = await screen.findByTestId('held-companies-panel');
    expect(within(panel).getByRole('heading', { name: 'Held companies' })).toBeInTheDocument();
    expect(await within(panel).findByRole('link', { name: /AAPL/ })).toHaveAttribute('href', '/markets?symbol=AAPL');
  });

  it('shows no-positions copy in the holdings panel when nothing is held', async () => {
    server.use(
      http.get('/api/rounds/:id', () => HttpResponse.json({ ...roundDetailFixture, positions: [] })),
    );
    renderDetail();

    expect(await screen.findByText(/no open positions to chart/i)).toBeInTheDocument();
  });

  it('offers only the transitions the backend allows for an active round', async () => {
    renderDetail();

    expect(await screen.findByRole('button', { name: /^pause$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /take over/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^resume$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /archive/i })).not.toBeInTheDocument();
  });

  it('offers resume and archive for a paused round', async () => {
    server.use(
      http.get('/api/rounds/:id', () =>
        HttpResponse.json({ ...roundDetailFixture, round: { ...roundDetailFixture.round, status: 'paused' } }),
      ),
    );
    renderDetail();

    expect(await screen.findByRole('button', { name: /^resume$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /archive/i })).toBeEnabled();
  });

  it('posts the status action the operator clicked', async () => {
    let action: string | null = null;
    server.use(
      http.post('/api/rounds/:id/status', async ({ request }) => {
        action = ((await request.json()) as { action: string }).action;
        return HttpResponse.json({ status: 'paused' });
      }),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /^pause$/i }));
    await waitFor(() => expect(action).toBe('pause'));
  });

  it('surfaces a rejected transition', async () => {
    server.use(
      http.post('/api/rounds/:id/status', () =>
        HttpResponse.json({ error: 'cannot pause a busted round' }, { status: 409 }),
      ),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /^pause$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot pause a busted round');
  });

  it('runs a manual check-in', async () => {
    let ran = false;
    server.use(
      http.post('/api/rounds/:id/checkin', () => {
        ran = true;
        return HttpResponse.json({ status: 'success' });
      }),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /check in now/i }));
    await waitFor(() => expect(ran).toBe(true));
  });

  it('renders the pocketed staircase from skim ledger entries', async () => {
    server.use(
      http.get('/api/rounds/:id/ledger', () =>
        HttpResponse.json([
          { id: 3, round_id: 1, type: 'skim', amount_cents: -1500, balance_after_cents: 5000, ref_order_id: 2, note: 'profit pocketed', created_at: '2026-08-02T04:00:00.000Z' },
          { id: 2, round_id: 1, type: 'skim', amount_cents: -1000, balance_after_cents: 5000, ref_order_id: 1, note: 'profit pocketed', created_at: '2026-08-01T04:00:00.000Z' },
          { id: 1, round_id: 1, type: 'buy', amount_cents: -2000, balance_after_cents: 3000, ref_order_id: 1, note: 'buy AAPL', created_at: '2026-08-01T02:00:00.000Z' },
        ]),
      ),
    );
    renderDetail();

    const staircase = await screen.findByTestId('skim-staircase');
    // Cumulative, oldest first: $10.00 then $25.00.
    expect(within(staircase).getAllByRole('listitem')[0]).toHaveTextContent('$10.00');
    expect(within(staircase).getAllByRole('listitem')[1]).toHaveTextContent('$25.00');
  });

  it('switches tabs', async () => {
    renderDetail();

    await userEvent.click(await screen.findByRole('tab', { name: /journal/i }));
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/journal/i);
  });

  it('links a sold (no-longer-held) symbol in the trades tab through to its Markets chart', async () => {
    server.use(
      http.get('/api/rounds/:id/trades', () =>
        HttpResponse.json([
          {
            id: 1, order_id: 1, round_id: 1, symbol: 'MSFT', side: 'sell', quantity: 1,
            price_aud: 30, gross_cents: 3000, fee_cents: 0, executed_at: '2026-08-01T02:00:00.000Z',
          },
        ]),
      ),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('tab', { name: /trades/i }));
    expect(await screen.findByRole('link', { name: 'MSFT' })).toHaveAttribute('href', '/markets?symbol=MSFT');
  });
});

describe('USD position valuation', () => {
  it('converts a USD quote at the AUD/USD rate for unrealised P/L', async () => {
    server.use(
      http.get('/api/market/quotes', () =>
        HttpResponse.json({
          AAPL: { symbol: 'AAPL', market: 'US', price: 13, currency: 'USD', ts: '2026-08-02T03:00:00.000Z', stale: false },
        }),
      ),
      http.get('/api/market/fx', () => HttpResponse.json({ audUsd: 0.65 })),
    );
    renderDetail();

    // 2 shares @ USD 13 / 0.65 = AUD 40.00 against a $20.00 cost basis.
    const row = await screen.findByRole('row', { name: /AAPL/ });
    await waitFor(() => expect(within(row).getByText('+$20.00')).toBeInTheDocument());
    // "Last" column shows the raw USD quote plus its AUD equivalent (13 / 0.65 = 20.00).
    expect(within(row).getByText(/≈ \$20\.00 AUD/)).toBeInTheDocument();
  });

  it('shows a dash rather than a wrong number when the FX rate is unavailable', async () => {
    server.use(
      http.get('/api/market/quotes', () =>
        HttpResponse.json({
          AAPL: { symbol: 'AAPL', market: 'US', price: 13, currency: 'USD', ts: '2026-08-02T03:00:00.000Z', stale: false },
        }),
      ),
      http.get('/api/market/fx', () => HttpResponse.json({ error: 'FX rate unavailable' }, { status: 502 })),
    );
    renderDetail();

    const row = await screen.findByRole('row', { name: /AAPL/ });
    // Columns: symbol, qty, cost basis, last, unrealised, stop.
    await waitFor(() => expect(within(row).getAllByRole('cell')[4]).toHaveTextContent('—'));
    expect(within(row).queryByText(/\+\$/)).not.toBeInTheDocument();
  });
});
