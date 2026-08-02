import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { RoundDetailPage } from '../src/pages/RoundDetailPage';
import { renderWithProviders } from './render';
import { server } from './server';

vi.mock('../src/components/charts/EquityChart', () => ({ EquityChart: () => <div /> }));

const trades = [
  { id: 2, order_id: 2, round_id: 1, symbol: 'AAPL', side: 'sell', quantity: 2, price_aud: 20, gross_cents: 4000, fee_cents: 30, executed_at: '2026-08-02T02:00:00.000Z' },
  { id: 1, order_id: 1, round_id: 1, symbol: 'AAPL', side: 'buy', quantity: 2, price_aud: 10, gross_cents: 2000, fee_cents: 30, executed_at: '2026-08-01T02:00:00.000Z' },
];

describe('round history panels', () => {
  it('shows trades newest first with fees', async () => {
    server.use(http.get('/api/rounds/:id/trades', () => HttpResponse.json(trades)));
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /trades/i }));
    const rows = within(screen.getByRole('tabpanel')).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('sell');
    expect(rows[0]).toHaveTextContent('$40.00');
    expect(rows[0]).toHaveTextContent('$0.30');
  });

  it('shows an empty trades state', async () => {
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /trades/i }));
    expect(screen.getByText(/no trades yet/i)).toBeInTheDocument();
  });

  it('colour-codes ledger entries and labels skims', async () => {
    server.use(
      http.get('/api/rounds/:id/ledger', () =>
        HttpResponse.json([
          { id: 2, round_id: 1, type: 'skim', amount_cents: -2500, balance_after_cents: 5000, ref_order_id: 2, note: 'profit pocketed', created_at: '2026-08-02T02:00:00.000Z' },
          { id: 1, round_id: 1, type: 'deposit', amount_cents: 5000, balance_after_cents: 5000, ref_order_id: null, note: 'starting balance', created_at: '2026-08-01T00:00:00.000Z' },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /ledger/i }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('skim')).toBeInTheDocument();
    expect(within(panel).getByText('-$25.00')).toBeInTheDocument();
    expect(within(panel).getByText('+$50.00')).toBeInTheDocument();
  });

  it('shows journal entries with their author', async () => {
    server.use(
      http.get('/api/rounds/:id/journal', () =>
        HttpResponse.json([
          { id: 2, checkin_id: 4, author: 'agent', note: 'Held AAPL; momentum intact.', created_at: '2026-08-02T02:00:00.000Z' },
          { id: 1, checkin_id: null, author: 'operator', note: 'Manual buy to seed the round.', created_at: '2026-08-01T02:00:00.000Z' },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /journal/i }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(/momentum intact/)).toBeInTheDocument();
    expect(within(panel).getByText('agent')).toBeInTheDocument();
    expect(within(panel).getByText('operator')).toBeInTheDocument();
  });

  it('renders the daily summary narrative and digest', async () => {
    server.use(
      http.get('/api/rounds/:id/summaries', () =>
        HttpResponse.json([
          {
            day: '2026-08-01',
            digest_json: JSON.stringify({ trades: 2, skimsCents: 2500, feesCents: 60, tokensUsed: 1800, events: [], journals: [] }),
            narrative: 'I sold AAPL into strength and pocketed the difference.',
            created_at: '2026-08-02T08:10:00.000Z',
          },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /summaries/i }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(/sold AAPL into strength/)).toBeInTheDocument();
    expect(within(panel).getByText(/2 trades/)).toBeInTheDocument();
    expect(within(panel).getByText(/\$25\.00 pocketed/)).toBeInTheDocument();
    expect(within(panel).getByText(/1,800 tokens/)).toBeInTheDocument();
  });

  it('separates the lifetime abstract from dated summaries', async () => {
    server.use(
      http.get('/api/rounds/:id/summaries', () =>
        HttpResponse.json([
          { day: 'abstract', digest_json: '{}', narrative: 'Lifetime: patient swing trading.', created_at: '2026-08-02T08:10:00.000Z' },
          {
            day: '2026-08-01',
            digest_json: JSON.stringify({ trades: 1, skimsCents: 0, feesCents: 30, tokensUsed: 900, events: [], journals: [] }),
            narrative: 'Quiet day.',
            created_at: '2026-08-02T08:10:00.000Z',
          },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /summaries/i }));
    expect(screen.getByRole('heading', { name: /lifetime abstract/i })).toBeInTheDocument();
    expect(screen.getByText(/patient swing trading/)).toBeInTheDocument();
  });

  it('lists check-ins with token spend and parsed actions', async () => {
    server.use(
      http.get('/api/rounds/:id/checkins', () =>
        HttpResponse.json([
          { id: 4, ts: '2026-08-02T02:00:00.000Z', status: 'success', tokens_used: 1800, actions_json: '[{"tool":"place_order"},{"tool":"write_journal"}]' },
          { id: 3, ts: '2026-08-01T02:00:00.000Z', status: 'error', tokens_used: null, actions_json: '[]' },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /check-ins/i }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('place_order, write_journal')).toBeInTheDocument();
    expect(within(panel).getByText('1,800')).toBeInTheDocument();
    expect(within(panel).getByText('error')).toBeInTheDocument();
  });

  it('survives an unparseable actions payload', async () => {
    server.use(
      http.get('/api/rounds/:id/checkins', () =>
        HttpResponse.json([
          { id: 5, ts: '2026-08-02T02:00:00.000Z', status: 'success', tokens_used: 10, actions_json: 'not json' },
        ]),
      ),
    );
    renderWithProviders(<RoundDetailPage roundId={1} />);

    await userEvent.click(await screen.findByRole('tab', { name: /check-ins/i }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('—');
  });
});
