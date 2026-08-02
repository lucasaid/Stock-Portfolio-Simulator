import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { OrderForm } from '../src/pages/round/OrderForm';
import { renderWithProviders } from './render';
import { roundDetailFixture, server } from './server';

function renderForm(status: 'active' | 'paused' | 'goal_reached' = 'active') {
  return renderWithProviders(
    <OrderForm roundId={1} status={status} positions={roundDetailFixture.positions} watchlist={['AAPL', 'MSFT']} />,
  );
}

describe('manual order form', () => {
  it('sends a buy in integer cents', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/rounds/:id/orders', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ status: 'filled', reason: null, skimCents: 0 }, { status: 201 });
      }),
    );
    renderForm();

    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.type(screen.getByLabelText(/amount/i), '12.34');
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ symbol: 'AAPL', side: 'buy', amountCents: 1234 });
  });

  it('sends a sell quantity, including "all"', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/rounds/:id/orders', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ status: 'filled', reason: null, skimCents: 1000 }, { status: 201 });
      }),
    );
    renderForm();

    await userEvent.selectOptions(screen.getByLabelText(/side/i), 'sell');
    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.click(screen.getByLabelText(/sell everything/i));
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ symbol: 'AAPL', side: 'sell', quantity: 'all' });
  });

  it('reports the skim after a profitable sell', async () => {
    server.use(
      http.post('/api/rounds/:id/orders', () =>
        HttpResponse.json({ status: 'filled', reason: null, skimCents: 2000 }, { status: 201 }),
      ),
    );
    renderForm();

    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.type(screen.getByLabelText(/amount/i), '5');
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    expect(await screen.findByText(/pocketed \$20\.00/i)).toBeInTheDocument();
  });

  it('surfaces a rejection reason from the backend', async () => {
    server.use(http.post('/api/rounds/:id/orders', () => HttpResponse.json({ error: 'quote is stale' }, { status: 409 })));
    renderForm();

    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.type(screen.getByLabelText(/amount/i), '5');
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('quote is stale');
  });

  it('blocks a zero or unparseable amount before it reaches the money path', async () => {
    renderForm();

    await userEvent.type(screen.getByLabelText(/symbol/i), 'AAPL');
    await userEvent.type(screen.getByLabelText(/amount/i), '0');
    expect(screen.getByRole('button', { name: /place order/i })).toBeDisabled();
  });

  it('disables the whole form on a terminal round', () => {
    renderForm('goal_reached');
    expect(screen.getByRole('button', { name: /place order/i })).toBeDisabled();
    expect(screen.getByText(/goal_reached round cannot trade/i)).toBeInTheDocument();
  });

  it('stays enabled for a paused round because the operator may still trade', () => {
    renderForm('paused');
    expect(screen.getByLabelText(/symbol/i)).toBeEnabled();
  });
});
