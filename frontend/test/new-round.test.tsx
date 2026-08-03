import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { NewRoundPage } from '../src/pages/NewRoundPage';
import { renderWithProviders } from './render';
import { roundDetailFixture, server } from './server';

describe('new round wizard', () => {
  it('pre-fills from the global round defaults', async () => {
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    expect(screen.getByLabelText(/profit goal/i)).toHaveValue('1000.00');
    expect(screen.getByLabelText(/watchlist/i)).toHaveValue('AAPL, MSFT');
  });

  it('requires a name', async () => {
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    expect(screen.getByRole('button', { name: /create round/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/round name/i), 'second run');
    expect(screen.getByRole('button', { name: /create round/i })).toBeEnabled();
  });

  it('shows a live foot-gun warning', async () => {
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    await userEvent.selectOptions(screen.getByLabelText(/trading style/i), 'day');
    await userEvent.click(screen.getByLabelText('ASX'));

    expect(await screen.findByText(/day trading/i)).toBeInTheDocument();
  });

  it('creates the round in cents and navigates to it', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/rounds', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 42 }, { status: 201 });
      }),
    );
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    await userEvent.type(screen.getByLabelText(/round name/i), 'second run');
    const balance = screen.getByLabelText(/starting balance/i);
    await userEvent.clear(balance);
    await userEvent.type(balance, '75.50');
    await userEvent.click(screen.getByRole('button', { name: /create round/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ name: 'second run', startingBalanceCents: 7550, profitGoalCents: 100000 });
    expect(await screen.findByText(/round created/i)).toBeInTheDocument();
  });

  it('offers carry-over from a finished round', async () => {
    server.use(
      http.get('/api/rounds', () =>
        HttpResponse.json([
          { id: 3, name: 'finished run', status: 'goal_reached', starting_balance_cents: 5000, cash_cents: 5000, profit_goal_cents: 100000, totalSkimsCents: 100000 },
        ]),
      ),
      http.get('/api/rounds/:id', () =>
        HttpResponse.json({
          ...roundDetailFixture,
          config: { ...roundDetailFixture.config, name: 'finished run' },
        }),
      ),
    );
    renderWithProviders(<NewRoundPage />);

    await userEvent.selectOptions(await screen.findByLabelText(/carry over/i), '3');
    await waitFor(() => expect(screen.getByLabelText(/round name/i)).toHaveValue('finished run #2'));
  });

  it('reports a create failure', async () => {
    server.use(http.post('/api/rounds', () => HttpResponse.json({ error: 'name is required' }, { status: 400 })));
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    await userEvent.type(screen.getByLabelText(/round name/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: /create round/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('name is required');
  });
});

describe('new round guardrail toggles', () => {
  it('sends stopLossWhenPaused from the wizard checkbox', async () => {
    let body: { guardrails?: Record<string, unknown> } | null = null;
    server.use(
      http.post('/api/rounds', async ({ request }) => {
        body = (await request.json()) as { guardrails?: Record<string, unknown> };
        return HttpResponse.json({ id: 7 }, { status: 201 });
      }),
    );
    renderWithProviders(<NewRoundPage />);

    await waitFor(() => expect(screen.getByLabelText(/starting balance/i)).toHaveValue('50.00'));
    await userEvent.type(screen.getByLabelText(/round name/i), 'stops off');
    await userEvent.click(screen.getByLabelText(/keep firing stop-losses while paused/i));
    await userEvent.click(screen.getByRole('button', { name: /create round/i }));

    await waitFor(() => expect(body?.guardrails).toBeDefined());
    expect(body!.guardrails!.stopLossWhenPaused).toBe(false);
  });
});
