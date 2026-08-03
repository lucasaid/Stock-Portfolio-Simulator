import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ConfigPanel } from '../src/pages/round/ConfigPanel';
import { renderWithProviders } from './render';
import { roundDetailFixture, server } from './server';

function renderPanel() {
  return renderWithProviders(<ConfigPanel roundId={1} config={roundDetailFixture.config} />);
}

describe('config panel', () => {
  it('pre-fills from the current config', () => {
    renderPanel();

    expect(screen.getByLabelText(/profit goal/i)).toHaveValue('1000.00');
    expect(screen.getByLabelText(/watchlist/i)).toHaveValue('AAPL');
    expect(screen.getByLabelText(/stop-loss %/i)).toHaveValue('10');
    expect(screen.getByLabelText(/risk profile/i)).toHaveValue('balanced');
  });

  it('never offers the starting balance', () => {
    renderPanel();
    expect(screen.queryByLabelText(/starting balance/i)).not.toBeInTheDocument();
  });

  it('patches only the fields that changed, in cents', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch('/api/rounds/:id/config', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ changed: 1 });
      }),
    );
    renderPanel();

    const goal = screen.getByLabelText(/profit goal/i);
    await userEvent.clear(goal);
    await userEvent.type(goal, '20');
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ profitGoalCents: 2000 });
  });

  it('sends the whole guardrail object so the deep-merge cannot strip a key', async () => {
    let body: { guardrails?: Record<string, unknown> } | null = null;
    server.use(
      http.patch('/api/rounds/:id/config', async ({ request }) => {
        body = (await request.json()) as { guardrails?: Record<string, unknown> };
        return HttpResponse.json({ changed: 1 });
      }),
    );
    renderPanel();

    const stop = screen.getByLabelText(/stop-loss %/i);
    await userEvent.clear(stop);
    await userEvent.type(stop, '5');
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() => expect(body?.guardrails).toBeDefined());
    expect(body!.guardrails).toEqual({
      stopLossPct: 5, maxPositionPct: 40, drawdownPausePct: 50, stopLossWhenPaused: true,
    });
  });

  it('treats a blank guardrail as disabled (null), not zero', async () => {
    let body: { guardrails?: Record<string, unknown> } | null = null;
    server.use(
      http.patch('/api/rounds/:id/config', async ({ request }) => {
        body = (await request.json()) as { guardrails?: Record<string, unknown> };
        return HttpResponse.json({ changed: 1 });
      }),
    );
    renderPanel();

    await userEvent.clear(screen.getByLabelText(/stop-loss %/i));
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() => expect(body?.guardrails).toBeDefined());
    expect(body!.guardrails!.stopLossPct).toBeNull();
  });

  it('splits the watchlist on commas and upper-cases it', async () => {
    let body: { watchlist?: string[] } | null = null;
    server.use(
      http.patch('/api/rounds/:id/config', async ({ request }) => {
        body = (await request.json()) as { watchlist?: string[] };
        return HttpResponse.json({ changed: 1 });
      }),
    );
    renderPanel();

    const watchlist = screen.getByLabelText(/watchlist/i);
    await userEvent.clear(watchlist);
    await userEvent.type(watchlist, 'aapl, bhp.ax , ');
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() => expect(body?.watchlist).toBeDefined());
    expect(body!.watchlist).toEqual(['AAPL', 'BHP.AX']);
  });

  it('explains what each guardrail does', () => {
    renderPanel();
    expect(screen.getByText(/sell automatically if the price falls/i)).toBeInTheDocument();
    expect(screen.getByText(/cap how much of the starting balance/i)).toBeInTheDocument();
    expect(screen.getByText(/pause the round/i)).toBeInTheDocument();
  });

  it('blocks a save with no changes', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /save config/i })).toBeDisabled();
  });

  it('shows a next-run preview for the configured cron schedule', () => {
    renderPanel();
    expect(screen.getByText(/next run/i)).toBeInTheDocument();
  });

  it('adds a preset cron line without discarding the existing schedule', async () => {
    let body: { checkinCron?: string[] } | null = null;
    server.use(
      http.patch('/api/rounds/:id/config', async ({ request }) => {
        body = (await request.json()) as { checkinCron?: string[] };
        return HttpResponse.json({ changed: 1 });
      }),
    );
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /once daily at asx close/i }));
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() => expect(body?.checkinCron).toBeDefined());
    expect(body!.checkinCron).toEqual(['30 23 * * 1-5', '10 16 * * 1-5']);
  });

  it('flags an unparseable cron line instead of crashing', async () => {
    renderPanel();
    const textarea = screen.getByLabelText(/check-in schedule/i);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'not a cron expression');

    expect(await screen.findByText(/can't parse this schedule/i)).toBeInTheDocument();
  });

  it('reports a rejected patch', async () => {
    server.use(
      http.patch('/api/rounds/:id/config', () =>
        HttpResponse.json({ error: 'startingBalanceCents cannot change mid-round' }, { status: 400 }),
      ),
    );
    renderPanel();

    const goal = screen.getByLabelText(/profit goal/i);
    await userEvent.clear(goal);
    await userEvent.type(goal, '20');
    await userEvent.click(screen.getByRole('button', { name: /save config/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('cannot change mid-round');
  });
});
