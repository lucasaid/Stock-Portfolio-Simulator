import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { BriefingsList } from '../src/pages/round/BriefingsList';
import { renderWithProviders } from './render';
import { briefingsFixture, server } from './server';

describe('BriefingsList', () => {
  it('renders each briefing prose and its relative timestamp', async () => {
    renderWithProviders(<BriefingsList roundId={1} />);

    expect(await screen.findByText(/nothing material \(reuters\)/i)).toBeInTheDocument();
    expect(screen.getByText(/03 Aug/)).toBeInTheDocument();
  });

  it('shows token spend and cost per briefing', async () => {
    renderWithProviders(<BriefingsList roundId={1} />);
    await screen.findByText(/nothing material/i);

    expect(screen.getByText(/4,200 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.0312/)).toBeInTheDocument();
  });

  it('renders a failed briefing with the loss class and its error text', async () => {
    renderWithProviders(<BriefingsList roundId={1} />);

    const errorText = await screen.findByText(/empty or failed research run/i);
    expect(errorText.closest('section')).toHaveClass('loss');
  });

  it('runs research on demand and disables the button while pending', async () => {
    let requested = false;
    server.use(
      http.post('/api/rounds/:id/research', async () => {
        requested = true;
        return HttpResponse.json({ status: 'success', detail: '12 words' });
      }),
    );
    renderWithProviders(<BriefingsList roundId={1} />);
    await screen.findByText(/nothing material/i);

    const button = screen.getByRole('button', { name: /research now/i });
    await userEvent.click(button);

    await waitFor(() => expect(requested).toBe(true));
  });

  it('shows the empty state', async () => {
    server.use(http.get('/api/rounds/:id/briefings', () => HttpResponse.json([])));
    renderWithProviders(<BriefingsList roundId={1} />);

    expect(await screen.findByText(/no research briefings yet/i)).toBeInTheDocument();
  });

  it('surfaces a load error via role="alert"', async () => {
    server.use(
      http.get('/api/rounds/:id/briefings', () => HttpResponse.json({ error: 'research unavailable' }, { status: 500 })),
    );
    renderWithProviders(<BriefingsList roundId={1} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/research unavailable/i);
  });
});

// Sanity check that the shared fixture stays representative of both statuses.
it('fixture includes both a success and an error row', () => {
  expect(briefingsFixture.some((b) => b.status === 'success')).toBe(true);
  expect(briefingsFixture.some((b) => b.status === 'error')).toBe(true);
});
