import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ToolsPage } from '../src/pages/ToolsPage';
import { renderWithProviders } from './render';
import { optimizerRunsFixture, server } from './server';

describe('ToolsPage', () => {
  it('renders run history from the optimizer', async () => {
    renderWithProviders(<ToolsPage />);
    expect(await screen.findByText(/Every check-in journals the same phrase/)).toBeInTheDocument();
  });

  it('sends the web-search checkbox state when running', async () => {
    let sentBody: unknown;
    server.use(
      http.post('/api/optimizer/run', async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ status: 'success', detail: 'ok' });
      }),
    );
    renderWithProviders(<ToolsPage />);
    await screen.findByText(/Every check-in journals the same phrase/);

    await userEvent.click(screen.getByLabelText(/enable web search/i));
    await userEvent.click(screen.getByRole('button', { name: /run optimizer/i }));

    await waitFor(() => expect(sentBody).toEqual({ webSearch: true }));
  });

  it('shows an empty state with no runs yet', async () => {
    server.use(http.get('/api/optimizer', () => HttpResponse.json([])));
    renderWithProviders(<ToolsPage />);
    expect(await screen.findByText(/no optimizer runs yet/i)).toBeInTheDocument();
  });

  it('renders an error-status run with the loss class', async () => {
    server.use(
      http.get('/api/optimizer', () =>
        HttpResponse.json([{ ...optimizerRunsFixture[0]!, status: 'error', output: '', detail: 'optimizer run failed (error_max_turns)' }]),
      ),
    );
    renderWithProviders(<ToolsPage />);
    const row = await screen.findByText(/optimizer run failed/i);
    expect(row.closest('section')).toHaveClass('loss');
  });
});
